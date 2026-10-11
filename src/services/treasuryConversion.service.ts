// services/treasuryConversion.service.ts
//
// STEPS 5 AND 6 of a crypto-sourced global payout (see the lifecycle at the top
// of treasuryReplenishment.service.ts):
//
//   5. Nuvion tells us the stablecoin deposit has arrived (webhook).
//   6. We convert it into the USD treasury, which makes the float whole again.
//
// Every stablecoin-to-fiat payout is paid out of the USD treasury, so until
// this step finishes the USD treasury is short by that payout.
import { Decimal } from 'decimal.js';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { generalQueue } from '../workers/general.worker';
import { createFxQuote, initiateCrossCurrencyTransfer } from './nuvion.service';
import {
  alertOps, transition, resyncTreasury, sweepReplenishments,
} from './treasuryReplenishment.service';

// ═══════════════════════════════════════════════════════════════════════
// THE RECORD
//
// The deposit and conversion columns live on model TreasuryReplenishment (see
// treasury-models.prisma), the same row the sending step uses. TransferRequest,
// the payout's own record, is not used here at all.
//
// NuvionTreasuryAccount (the USD treasury row). The conversion is an internal
// transfer to the USD account, so Nuvion needs a payee for it. Set these once,
// with scripts/setup-book-payee.ts:
//   conversionCounterpartyId   String?
//   conversionPaymentDetailId  String?
//
// NuvionDepositEvent (also in treasury-models.prisma) is what makes a webhook
// delivered twice get acted on once.
// ═══════════════════════════════════════════════════════════════════════

export const CONVERSION_JOB = 'Nuvion_Treasury_Convert';

const MAX_CONVERSION_ATTEMPTS = 6;

// The reference sent to Nuvion as unique_reference. Nuvion's /transfers is
// idempotent on it, so the SAME reference is used on every attempt of one
// conversion, which is what makes a retry safe even after a timeout.
//
// A higher generation (NVCONV-<id>-r1, -r2...) is only for redoing a conversion
// that Nuvion RECORDED as failed or reversed: resubmitting that reference would
// just hand back the failed original forever.
export const conversionReference = (transferRequestId: string, generation = 0) =>
  generation > 0 ? `NVCONV-${transferRequestId}-r${generation}` : `NVCONV-${transferRequestId}`;
const DEPOSIT_OVERDUE_HOURS = 2;
const STALE_DEPOSITED_MINUTES = 5;   // deposit confirmed but the conversion job never ran
const STALE_RETRY_MINUTES = 5;       // waiting to retry, nothing picked it up
const STALE_CONVERTING_MINUTES = 10; // started, never finished

// How far a deposit may differ from the amount we sent and still be accepted
// as that transfer, when there is no transaction hash to match on. Covers a
// small fee taken on the way. Anything further off is treated as unknown and
// goes to a person instead of being converted on a guess.
const AMOUNT_TOLERANCE = new Decimal('0.005'); // 0.5%

const OPEN_FOR_DEPOSIT = ['SUBMITTED', 'DEPOSIT_OVERDUE'];

// ───────────────────────────────────────────────────────────────────────
// STEP 5: the deposit webhook
// ───────────────────────────────────────────────────────────────────────

// What the webhook controller must hand over. It maps Nuvion's raw payload to
// this, AFTER the webhook's signature has been verified. I have not seen a
// real deposit payload, so that mapping is the one piece I could not write.
export interface DepositEvent {
  eventId: string;          // Nuvion's id for this event, used to ignore repeats
  accountId: string;        // the Nuvion account that received the deposit
  currency: string;         // Nuvion's code, e.g. USC or UST
  amount: string;           // what actually arrived
  txHash?: string | null;   // the on-chain hash, if the event carries one
  raw?: unknown;
}

// Turns Nuvion's raw inflows.completed payload into the shape above. Confirmed
// against a real one:
//
//   { event: 'inflows.completed', data: {
//       id: '01M4DSTE5B1835W3AJ9DDJQ982',          <- the event id, for ignoring repeats
//       amount: 1000, currency: 'USC',             <- MINOR UNITS: 1000 is 10.00
//       applicable_fee: 3,                          <- also minor units: 3 cents
//       account_id: '01M0T7QZHBRAMKY93TC38Y3EJS',  <- the stablecoin account credited
//       status: 'successful', type: 'inflow', payment_type: 'stablecoin-transfer',
//       unique_reference: '3bd5755578fa...',        <- NOT the chain hash: 64 hex, no 0x
//       meta: { provider_reference: '0x7008be7f...' },  <- this IS the chain hash
//       narration: 'Transaction from 0xb45f...',    <- the SENDER address, not the hash
//       account: { display_name: 'Master-Base', meta: { asset_type: 'stablecoin', network: 'base' } },
//   } }
//
// The two things that would quietly break the flow, and are handled here:
//   1. AMOUNT IS IN MINOR UNITS. Everything downstream works in whole units, and
//      createFxQuote multiplies by 100 again on the way out. Passed through as
//      1000 it would match no replenishment, and if it ever did convert it would
//      try to convert 1000 instead of 10.
//   2. THE CHAIN HASH IS meta.provider_reference. `unique_reference` looks like a
//      hash but is a different value, and matching a deposit on it would never
//      find the row, which records what blockchain_Transfer returned.
export function depositEventFromNuvion(payload: any): DepositEvent | null {
  const d = payload?.data ?? payload;
  if (!d?.id || !d?.account_id) return null;

  // Only a completed inflow. A pending or failed one must not start a conversion.
  const completed = (payload?.event ?? '') === 'inflows.completed' || d.type === 'inflow';
  if (!completed || d.status !== 'successful') return null;

  const minor = Number(d.amount);
  if (!Number.isFinite(minor)) return null;

  return {
    eventId: String(d.id),
    accountId: String(d.account_id),
    currency: String(d.currency),
    amount: new Decimal(minor).dividedBy(100).toString(),
    txHash: d.meta?.provider_reference ?? null,
    raw: payload,
  };
}

export async function enqueueConversion(transferRequestId: string, generation: number | string = 0) {
  return generalQueue.add(CONVERSION_JOB, { transferRequestId }, {
    jobId: `convert_${transferRequestId}_${generation}`,
    attempts: MAX_CONVERSION_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
  });
}

// Finds the replenishment this deposit belongs to and claims it, so the same
// deposit can never satisfy two of them. Returns its id, or null.
//
// Several replenishments in flight can have exactly the same amount, so the
// order of preference matters:
//   1. The transaction hash. Exact, and the only reliable way.
//   2. Failing that, same currency and an amount within tolerance, taking
//      the closest and then the oldest. Only rows that have NO hash of their
//      own are considered: a row with a known hash can only match by that hash.
async function claimReplenishmentForDeposit(event: DepositEvent): Promise<string | null> {
  // The same event may be redelivered after a crash. If it already claimed a
  // row, that row is the answer.
  const already = await prisma.treasuryReplenishment.findFirst({
    where: { depositEventId: event.eventId },
    select: { transferRequestId: true },
  });
  if (already) return already.transferRequestId;

  const amount = new Decimal(event.amount);
  const claimData = {
    status: 'DEPOSITED',
    statusUpdatedAt: new Date(),
    depositEventId: event.eventId,
    depositedAt: new Date(),
    depositedAmount: event.amount,
    depositAccountId: event.accountId,
    depositCurrency: event.currency,
  };

  // Only the call whose update actually changes the row gets it.
  const tryClaim = async (transferRequestId: string) => {
    const res = await prisma.treasuryReplenishment.updateMany({
      where: { transferRequestId, status: { in: OPEN_FOR_DEPOSIT } },
      data: claimData,
    });
    return res.count === 1;
  };

  if (event.txHash) {
    const byHash = await prisma.treasuryReplenishment.findFirst({
      where: {
        txRef: { equals: event.txHash, mode: 'insensitive' },
        status: { in: OPEN_FOR_DEPOSIT },
      },
      select: { transferRequestId: true },
    });
    if (byHash && (await tryClaim(byHash.transferRequestId))) return byHash.transferRequestId;
  }

  const candidates = await prisma.treasuryReplenishment.findMany({
    where: {
      status: { in: OPEN_FOR_DEPOSIT },
      nuvionCurrency: event.currency,
      txRef: null,
    },
    orderBy: { sentAt: 'asc' },
    select: { transferRequestId: true, amount: true },
    take: 100,
  });

  const ranked = candidates
    .map((c) => {
      const expected = new Decimal((c.amount ?? 0).toString());
      return { transferRequestId: c.transferRequestId, expected, diff: amount.minus(expected).abs() };
    })
    .filter((c) => c.expected.gt(0) && c.diff.lte(c.expected.times(AMOUNT_TOLERANCE)))
    // Closest first. The sort is stable, so ties keep their oldest-first order.
    .sort((a, b) => a.diff.comparedTo(b.diff));

  for (const c of ranked) {
    if (await tryClaim(c.transferRequestId)) return c.transferRequestId;
  }

  // Nothing left to claim. Before calling this unmatched, check whether a
  // concurrent delivery of this SAME event claimed it a moment ago. Nuvion
  // retries a webhook that is slow to answer, so this really happens, and
  // without this check the later deliveries raise a false "matches nothing"
  // alarm about a deposit that matched perfectly.
  const raced = await prisma.treasuryReplenishment.findFirst({
    where: { depositEventId: event.eventId },
    select: { transferRequestId: true },
  });
  return raced?.transferRequestId ?? null;
}

// Call this from the Nuvion webhook when a stablecoin deposit is CONFIRMED,
// and only after the webhook's signature has been verified.
export async function handleDepositConfirmed(event: DepositEvent): Promise<'DUPLICATE' | 'MATCHED' | 'UNMATCHED'> {
  // 1. Ignore a repeat of an event we already finished with. An event that
  //    was recorded but never finished (we crashed part way) is picked up again.
  try {
    await prisma.nuvionDepositEvent.create({
      data: {
        id: event.eventId,
        accountId: event.accountId,
        currency: event.currency,
        amount: event.amount,
        txHash: event.txHash ?? null,
        status: 'RECEIVED',
        payload: (event.raw ?? {}) as any,
      },
    });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err;
    const existing = await prisma.nuvionDepositEvent.findUnique({ where: { id: event.eventId } });
    if (existing?.status !== 'RECEIVED') return 'DUPLICATE';
  }

  // 2. Which replenishment is this?
  const transferRequestId = await claimReplenishmentForDeposit(event);

  if (!transferRequestId) {
    // Only the delivery that actually moves the event out of RECEIVED records
    // it and raises the alert, so a repeat can neither overwrite a MATCHED
    // event nor alert twice.
    const marked = await prisma.nuvionDepositEvent.updateMany({
      where: { id: event.eventId, status: 'RECEIVED' },
      data: { status: 'UNMATCHED' },
    });
    if (marked.count === 0) return 'DUPLICATE';

    // Was anything even waiting? inflows.completed fires for every deposit,
    // including a manual top-up, and alerting on those would train everyone to
    // ignore the alert. Only a deposit that arrived while a replenishment WAS
    // waiting is worth waking someone for.
    const waiting = await prisma.treasuryReplenishment.count({
      where: { status: { in: OPEN_FOR_DEPOSIT } },
    });

    if (waiting === 0) {
      logger.info('[Conversion] A stablecoin deposit arrived with no replenishment waiting. Probably a manual top-up, leaving it alone.', {
        eventId: event.eventId, accountId: event.accountId, amount: event.amount,
      });
      return 'UNMATCHED';
    }

    // Deliberately NOT converted. A deposit we cannot tie to one of our own
    // transfers might be someone else's money, or a wrong amount.
    await alertOps('Stablecoin deposit matches no replenishment - NOT converted', {
      eventId: event.eventId, accountId: event.accountId, currency: event.currency,
      amount: event.amount, txHash: event.txHash ?? 'none',
      waitingReplenishments: waiting,
      note: 'Something WAS waiting for a deposit, so check whether this is it with a different amount. If it is not ours, ignore it.',
    });
    return 'UNMATCHED';
  }

  await prisma.nuvionDepositEvent.updateMany({
    where: { id: event.eventId, status: 'RECEIVED' },
    data: { status: 'MATCHED', matchedTransferRequestId: transferRequestId },
  });

  // 3. Queue the conversion. The webhook must answer quickly. If Redis is down
  //    right now the row is already DEPOSITED, and the sweeper queues it.
  try {
    await enqueueConversion(transferRequestId, 0);
  } catch (err: any) {
    logger.error('[Conversion] Deposit recorded but the conversion could not be queued. The sweeper will do it.', {
      transferRequestId, error: err?.message,
    });
  }
  return 'MATCHED';
}

// ───────────────────────────────────────────────────────────────────────
// STEP 6: convert the stablecoin into the USD treasury
// ───────────────────────────────────────────────────────────────────────
//
// Retrying this step can never double-convert, because Nuvion REFUSES a repeated
// unique_reference. Confirmed live: the second attempt comes back "A record with
// this unique_reference, entity_id already exists".
//
// ⚠️ But it does NOT return the original transfer, whatever the docs say. So a
// retry cannot recover the first transfer's id or status. That refusal is proof
// the transfer EXISTS, so it is treated as CONVERT_UNVERIFIED, never as a
// failure: calling it a failure would invite a fresh reference, which really
// would convert a second time.

// Nuvion's answer when the reference has been used before. Proof our transfer
// exists, not a failure.
//
// MEASURED on 8 October, on both initiateCrossCurrencyTransfer and
// initiateSameCurrencyTransfer: HTTP 409 with
//   {"status":"error","message":"A record with this unique_reference, entity_id
//    already exists...","type":"error_duplicate_resource"}
//
// The code is matched first, because prose can change without notice. The text
// is only a fallback for a shape we have not seen.
const looksLikeDuplicateReference = (res: { httpStatus?: number; rawData?: any; error?: string }) => {
  if (res?.rawData?.type === 'error_duplicate_resource') return true;
  if (res?.httpStatus === 409) return true;
  return /unique_reference.*already exists|already exists.*unique_reference/i.test(res?.error ?? '');
};

const isRetryableHttp = (status?: number) =>
  status === undefined || status >= 500 || status === 429 || status === 408;

// A deposit can be confirmed a moment before the balance can be spent, so an
// "insufficient funds" answer right after a confirmed deposit is worth retrying.
const looksLikeNotYetAvailable = (message?: string) =>
  /insufficient|not (yet )?available|pending/i.test(message ?? '');

async function retryOrFail(
  transferRequestId: string,
  attempt: number,
  reason: string,
  retryable: boolean,
  context: Record<string, unknown>
) {
  if (retryable && attempt < MAX_CONVERSION_ATTEMPTS) {
    await transition(transferRequestId, 'CONVERT_RETRY', { note: reason });
    logger.warn(`[Conversion] Attempt ${attempt} failed, will retry`, { transferRequestId, reason });
    throw new Error(reason); // tells BullMQ to retry with backoff
  }

  await transition(transferRequestId, 'CONVERT_FAILED', { note: reason });
  await alertOps('Conversion FAILED - the USD treasury is short', {
    transferRequestId, attempt, reason, ...context,
    note: 'The stablecoin is at Nuvion but has NOT been converted into the USD treasury.',
  });
}

export async function handleTreasuryConversion(jobData: { transferRequestId: string }) {
  const { transferRequestId } = jobData;

  // CLAIM. Only one run at a time can convert a given transfer.
  const claim = await prisma.treasuryReplenishment.updateMany({
    where: { transferRequestId, status: { in: ['DEPOSITED', 'CONVERT_RETRY'] } },
    data: {
      status: 'CONVERTING',
      conversionAttempts: { increment: 1 },
      statusUpdatedAt: new Date(),
    },
  });
  if (claim.count === 0) {
    logger.info(`[Conversion] ${transferRequestId} already handled or in flight, skipping`);
    return;
  }

  const row: any = await prisma.treasuryReplenishment.findUnique({
    where: { transferRequestId },
    select: { conversionAttempts: true, conversionGeneration: true, depositAccountId: true, depositCurrency: true, depositedAmount: true },
  });
  const attempt: number = row?.conversionAttempts ?? 1;

  // The USD treasury is the destination, same one the payouts are paid from.
  const usd: any = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true } });
  const counterpartyId: string | undefined = usd?.conversionCounterpartyId;
  const paymentDetailId: string | undefined = usd?.conversionPaymentDetailId;

  if (!usd || !counterpartyId || !paymentDetailId) {
    await retryOrFail(transferRequestId, attempt,
      'The USD treasury has no internal-transfer payee set up (conversionCounterpartyId / conversionPaymentDetailId)',
      false, { amount: row?.depositedAmount?.toString() });
    return;
  }
  if (!row?.depositAccountId || !row?.depositCurrency || !row?.depositedAmount) {
    await retryOrFail(transferRequestId, attempt, 'The deposit details were not recorded on this transfer', false, {});
    return;
  }

  const amount = new Decimal(row.depositedAmount.toString());
  const reference = conversionReference(transferRequestId, row?.conversionGeneration ?? 0); // the SAME on every attempt, on purpose

  // 1. A fresh quote every attempt: they expire within minutes.
  const quote: any = await createFxQuote({
    from_currency: row.depositCurrency,
    to_currency: 'USD',
    amount_from: amount.toNumber(),
    account_id: row.depositAccountId,
    counterparty_id: counterpartyId,
    payment_detail_id: paymentDetailId,
  });
  if (!quote.success || !quote.id) {
    await retryOrFail(transferRequestId, attempt, quote.error ?? 'FX quote failed',
      isRetryableHttp(quote.httpStatus) || looksLikeNotYetAvailable(quote.error),
      { amount: amount.toString(), currency: row.depositCurrency });
    return;
  }

  // 2. The transfer itself.
  const transfer: any = await initiateCrossCurrencyTransfer({
    account_id: row.depositAccountId,
    payment_detail_id: paymentDetailId,
    counterparty_id: counterpartyId,
    fx_quote_id: quote.id,
    narration: 'Treasury replenishment',
    payment_type: 'book-transfer' as any,
    unique_reference: reference,
  });
  if (!transfer.success) {
    // "already exists" means a transfer with OUR reference is already at Nuvion:
    // an earlier attempt got through and we lost the answer. The money has very
    // likely moved. Never retry, and never reuse this reference.
    if (looksLikeDuplicateReference(transfer)) {
      await transition(transferRequestId, 'CONVERT_UNVERIFIED', {
        note: `A transfer with reference ${reference} already exists at Nuvion. Outcome unknown.`,
      });
      await alertOps('Conversion ALREADY EXISTS at Nuvion - check before doing anything', {
        transferRequestId, reference, amount: amount.toString(), currency: row.depositCurrency,
        note: 'An earlier attempt reached Nuvion and its answer was lost. Find this reference in the dashboard. ' +
          'If it succeeded, markReplenishmentResolved. Only if it FAILED there, retryConversion(id, { freshReference: true, confirmedOriginalFailed: true }). ' +
          'A fresh reference on a transfer that actually went through would convert a second time.',
      });
      return;
    }
    await retryOrFail(transferRequestId, attempt, transfer.error ?? 'Conversion transfer failed',
      isRetryableHttp(transfer.httpStatus) || looksLikeNotYetAvailable(transfer.error),
      { amount: amount.toString(), currency: row.depositCurrency, reference });
    return;
  }

  // Nuvion can ACCEPT the request and still report the transfer itself as failed
  // or reversed. Recording that as converted would leave the USD treasury short
  // with nothing to say so. Retrying the same reference would only return the
  // same failed transfer, so this is a failure for a person: after fixing the
  // cause, retryConversion(id, { freshReference: true }).
  if (transfer.status === 'failed' || transfer.status === 'reversed') {
    await retryOrFail(transferRequestId, attempt,
      `Nuvion accepted the request but reports the conversion transfer as ${transfer.status}` +
      `${transfer.status_reason ? `: ${transfer.status_reason}` : ''}`,
      false,
      { amount: amount.toString(), currency: row.depositCurrency, reference, nuvionTransferId: transfer.id,
        howToRedo: 'retryConversion(id, { freshReference: true })' });
    return;
  }

  // The service divides the fee by 100 without checking it exists, so a missing
  // fee arrives as NaN, which `?? 0` does not catch, and Postgres would happily
  // store it. Keep only a real number.
  const fee = Number(transfer.applicable_fee);

  // 3. Record it. If this write fails, the row stays CONVERTING, the sweeper
  //    moves it to CONVERT_RETRY, and the retry gets the original transfer
  //    back from Nuvion (same reference) and records it then.
  await transition(transferRequestId, 'CONVERTED', {
    conversionTransferId: transfer.id,
    conversionFeeUsd: Number.isFinite(fee) ? fee : 0,
    convertedAt: new Date(),
    note: null,
  });

  logger.info(`[Conversion] ${transferRequestId} converted ${amount.toString()} ${row.depositCurrency} into the USD treasury (transfer ${transfer.id})`);

  // The USD treasury just got its money back, so refresh the figure the
  // payouts check against. Best effort: it never affects the result above.
  await resyncTreasury(usd.id);
}

// ───────────────────────────────────────────────────────────────────────
// THE SWEEPER for the steps after the send. Run this one: it also runs the
// sweeper for the sending step.
// ───────────────────────────────────────────────────────────────────────

export async function sweepTreasury() {
  await sweepReplenishments();
  await sweepConversions();
}

export async function sweepConversions() {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  // A deposit that never confirmed. Mark it once, so the alert is not repeated
  // on every sweep. It stays matchable: if the deposit turns up later, it is
  // still picked up.
  const overdue: any[] = await prisma.treasuryReplenishment.findMany({
    where: {
      status: 'SUBMITTED',
      sentAt: { lt: new Date(Date.now() - DEPOSIT_OVERDUE_HOURS * 3_600_000) },
    },
    select: { transferRequestId: true, amount: true, txRef: true, nuvionCurrency: true },
    take: 50,
  });
  for (const r of overdue) {
    await transition(r.transferRequestId, 'DEPOSIT_OVERDUE', { note: `No deposit confirmation after ${DEPOSIT_OVERDUE_HOURS} hours` });
    await alertOps('Deposit not confirmed - check the chain and Nuvion', {
      transferRequestId: r.transferRequestId,
      amount: r.amount?.toString() ?? 'unknown',
      currency: r.nuvionCurrency ?? 'unknown',
      txHash: r.txRef ?? 'unknown',
      note: 'The crypto was sent but Nuvion has not reported it arriving. The USD treasury is still short.',
    });
  }

  // Conversions that stalled. Safe to re-queue every one of them, because the
  // conversion is idempotent on its reference.
  const stalled: any[] = await prisma.treasuryReplenishment.findMany({
    where: {
      OR: [
        { status: 'DEPOSITED', statusUpdatedAt: { lt: minutesAgo(STALE_DEPOSITED_MINUTES) } },
        { status: 'CONVERT_RETRY', statusUpdatedAt: { lt: minutesAgo(STALE_RETRY_MINUTES) } },
        { status: 'CONVERTING', statusUpdatedAt: { lt: minutesAgo(STALE_CONVERTING_MINUTES) } },
      ],
    },
    select: { transferRequestId: true, status: true, conversionAttempts: true },
    take: 50,
  });

  for (const r of stalled) {
    if ((r.conversionAttempts ?? 0) >= MAX_CONVERSION_ATTEMPTS) {
      await transition(r.transferRequestId, 'CONVERT_FAILED', { note: 'Gave up after repeated attempts' });
      await alertOps('Conversion FAILED - the USD treasury is short', {
        transferRequestId: r.transferRequestId, attempts: r.conversionAttempts,
        note: 'The stablecoin is at Nuvion but has NOT been converted into the USD treasury.',
      });
      continue;
    }
    try {
      if (r.status === 'CONVERTING') await transition(r.transferRequestId, 'CONVERT_RETRY');
      // A fresh generation each time, so an old job still sitting in Redis
      // cannot make this add a no-op. A duplicate is harmless: the claim
      // lets only one run.
      await enqueueConversion(r.transferRequestId, `sweep${Date.now()}`);
      logger.info(`[sweeper] Re-queued conversion for ${r.transferRequestId}`);
    } catch (err: any) {
      logger.error('[sweeper] Could not re-queue conversion', { transferRequestId: r.transferRequestId, error: err?.message });
    }
  }

  logger.info(`[sweeper] Conversion sweep done: ${overdue.length} deposit(s) overdue, ${stalled.length} conversion(s) re-queued`);
}

// ───────────────────────────────────────────────────────────────────────
// FOR OPS
// ───────────────────────────────────────────────────────────────────────

// After fixing the cause (for example the internal-transfer payee was missing).
// Safe at any time, because the conversion is idempotent on its reference.
// Same reference (the default) is right for a timeout, a crash, or a fixed
// configuration: nothing was recorded at Nuvion, or it returns the original.
// Pass { freshReference: true } ONLY when Nuvion recorded the first transfer as
// failed or reversed, because resubmitting that reference returns the failure.
export async function retryConversion(
  transferRequestId: string,
  opts: { freshReference?: boolean; confirmedOriginalFailed?: boolean } = {}
) {
  const row: any = await prisma.treasuryReplenishment.findUnique({
    where: { transferRequestId },
    select: { status: true, conversionGeneration: true },
  });
  if (!['CONVERT_FAILED', 'CONVERT_UNVERIFIED'].includes(row?.status)) {
    throw new Error(`Cannot retry a conversion from status ${row?.status}`);
  }
  // From CONVERT_UNVERIFIED a transfer with the old reference IS at Nuvion. The
  // same reference would just be refused again, and a fresh one would convert a
  // second time unless the original really failed. So say that you checked.
  if (row.status === 'CONVERT_UNVERIFIED' && !(opts.freshReference && opts.confirmedOriginalFailed)) {
    throw new Error(
      'A transfer with the original reference already exists at Nuvion. Check it in the dashboard first. ' +
      'If it succeeded, use markReplenishmentResolved instead. If it FAILED there, call this with ' +
      '{ freshReference: true, confirmedOriginalFailed: true }.'
    );
  }
  await transition(transferRequestId, 'DEPOSITED', {
    conversionAttempts: 0,
    ...(opts.freshReference ? { conversionGeneration: (row.conversionGeneration ?? 0) + 1 } : {}),
  });
  await enqueueConversion(transferRequestId, `retry${Date.now()}`);
}