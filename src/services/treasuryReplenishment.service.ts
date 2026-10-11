// services/treasuryReplenishment.ts
//
// THE FULL LIFECYCLE of a crypto-sourced global payout, and who owns each step:
//
//   1. Freeze the user's crypto                    blockCryptoPayout
//   2. Pay the recipient from the USD treasury     processNuvionPayoutJob
//   3. Nuvion says it completed: commit the hold   finalizeCryptoPayout
//   4. Send the crypto on-chain to the Nuvion
//      stablecoin wallet                           THIS FILE
//   5. Nuvion confirms the deposit (webhook)       treasuryConversion.ts
//   6. Convert the stablecoin into the USD
//      treasury, which makes it whole again        treasuryConversion.ts
//
// This file does step 4 and stops at SUBMITTED. The USD treasury is NOT whole
// yet at that point: the deposit still has to arrive and be converted.
//
// It also owns the replenishment RECORD (model TreasuryReplenishment): opening
// it, cancelling it, and the helpers every step uses to move it along. The
// payout's own record, TransferRequest, is not used for any of this.
import axios from 'axios';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { generalQueue } from '../workers/general.worker';
import walletService from './wallet.service';
import { getAccount } from './nuvion.service';

// ═══════════════════════════════════════════════════════════════════════
// THE RECORD: model TreasuryReplenishment (see treasury-models.prisma)
//
// One row per crypto-sourced payout. It holds the ids of the hold that froze
// the user's crypto, and every step of topping the USD treasury back up. The
// payout's own record, TransferRequest, is never touched by any of it except
// for its own status. The two are linked by a plain transferRequestId column,
// not a @relation, so TransferRequest's model needs no change at all.
//
// The row is opened when the crypto is frozen (openReplenishment, called from
// blockCryptoPayout). The statuses are listed in treasury-models.prisma.
// ═══════════════════════════════════════════════════════════════════════

// Must match the case in your worker (see the wiring notes in nuvionPayout-patch.md).
export const REPLENISHMENT_JOB = 'Nuvion_Treasury_Replenish';
export const REPLENISHMENT_SWEEP_JOB = 'Nuvion_Treasury_Sweep';

const MAX_ATTEMPTS = 5;
const STALE_PENDING_MINUTES = 10;    // queued but never ran (lost job)
const STALE_RETRY_MINUTES = 5;       // waiting to retry but nothing picked it up
const STALE_SUBMITTING_MINUTES = 15; // started, never finished

// WHERE THE MONEY IS (crypto-sourced payouts):
//   1. At submission the user's crypto is FROZEN (initiateGlobalPayoutBlock).
//   2. When Nuvion reports the payout complete, the hold is COMMITTED
//      (completeGlobalPayoutBlock). The user is now debited for good and the
//      crypto sits with the admin account.
//   3. Only then does this replenishment run, sending from the admin account
//      to the Nuvion STABLECOIN wallet.
// So replenishUserId is the ADMIN user (the account holding the committed
// funds), never the end user. And treasuryWalletAddress is the stablecoin
// wallet's deposit address on the same chain as the crypto, never the USD
// treasury (that is fiat and has no crypto address).
export interface ReplenishmentJob {
  transferRequestId: string;
  replenishUserId: string; // the account that holds the committed funds: admin
  replenishCurrencyId: string;
  treasuryAccountId: string; // the Nuvion STABLECOIN treasury row the crypto is sent to
  usdTreasuryAccountId: string; // the USD treasury row this tops back up
  treasuryWalletAddress: string;
  amount: string;
  nuvionCurrency?: string; // USC or UST, so the deposit can be matched later
}

export type Status =
  | 'PENDING' | 'SUBMITTING' | 'SUBMITTED' | 'RETRY'
  | 'FAILED' | 'MANUAL_REVIEW' | 'RESOLVED_MANUALLY'
  | 'DEPOSIT_OVERDUE' | 'DEPOSITED' | 'CONVERTING' | 'CONVERT_RETRY'
  | 'CONVERTED' | 'CONVERT_FAILED' | 'CONVERT_UNVERIFIED';

class ReplenishmentError extends Error {}

// ───────────────────────────────────────────────────────────────────────
// Small helpers (exported, because the conversion step uses them too)
// ───────────────────────────────────────────────────────────────────────

// Every status change goes through here, so statusUpdatedAt is always kept
// honest. The sweepers depend on it. The id is the PAYOUT's id (transferRequestId).
export async function transition(transferRequestId: string, status: Status, extra: Record<string, any> = {}) {
  return prisma.treasuryReplenishment.update({
    where: { transferRequestId },
    data: { status, statusUpdatedAt: new Date(), ...extra },
  });
}

// Posts to a Slack compatible webhook if OPS_ALERT_WEBHOOK_URL is set, and
// always logs. It never throws, so an alert problem can never break a handler.
export async function alertOps(title: string, details: Record<string, unknown>) {
  logger.error(`[${title}]`, details);

  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!url) return;

  const lines = Object.entries(details).map(([k, v]) => `• ${k}: ${v}`).join('\n');
  try {
    await axios.post(url, { text: `*${title}*\n${lines}` }, { timeout: 5000 });
  } catch (err: any) {
    logger.error('alertOps: could not reach the alert webhook', { error: err?.message });
  }
}

// Refreshes a treasury's balance from Nuvion. Best effort: a failure here is
// logged and never affects anything else.
export async function resyncTreasury(treasuryAccountId: string) {
  try {
    const treasury = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: treasuryAccountId } });
    if (!treasury) return;

    const account = await getAccount(treasury.nuvionAccountId);
    if (account.success && account.balance) {
      await prisma.nuvionTreasuryAccount.update({
        where: { id: treasuryAccountId },
        data: { lastKnownAvailable: account.balance.available, lastSyncedAt: new Date() },
      });
      logger.info(`Treasury ${treasuryAccountId} balance re-synced: ${account.balance.available}`);
    }
  } catch (error: any) {
    logger.warn('Treasury balance re-sync failed. Nothing else is affected.', {
      treasuryAccountId, error: error?.message,
    });
  }
}

// What kind of failure was it? "Safe to retry" and "might have sent the money"
// must never be confused.
//   RETRYABLE  the connection was never made, so nothing can have been sent
//   TERMINAL   refused before any money moved, and retrying will not help
//   AMBIGUOUS  anything else. It may or may not have gone through.
//
// ⚠️ This reads the error TEXT, because I cannot see what blockchain_Transfer
// throws. If it throws typed errors or codes, switch to those. The rule that
// protects you is the last line: anything not recognised is AMBIGUOUS and goes
// to a person, never to an automatic retry.
function classify(error: any): 'RETRYABLE' | 'TERMINAL' | 'AMBIGUOUS' {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (/econnrefused|enotfound|eai_again/.test(text)) return 'RETRYABLE';
  // 'Withdrawal amount below minimum' is thrown by transferfeeService before
  // anything is sent; 'returned nothing' is the missing-Wallet case above;
  // 'no deposit address' comes from transferCryptoToExternal. None is retryable.
  if (/insufficient|minimum|invalid address|not found|returned nothing|no deposit address/.test(text)) return 'TERMINAL';
  return 'AMBIGUOUS';
}

// ───────────────────────────────────────────────────────────────────────
// The outflows.completed webhook calls this, through
// scheduleReplenishmentForPayout. Not the queue directly.
// ───────────────────────────────────────────────────────────────────────

export async function enqueueReplenishment(job: ReplenishmentJob, generation: number | string = 0) {
  return generalQueue.add(REPLENISHMENT_JOB, job, {
    // Same transfer and generation means the same job, so a duplicate add is
    // ignored instead of running twice.
    jobId: `replenish_${job.transferRequestId}_${generation}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
  });
}

// Writes the intent to the DATABASE first, and only then queues it. If Redis
// is down at that moment (which has happened), the row still says PENDING and
// the sweeper queues it later.
//
// It also records the amount and currency being sent, which the deposit
// webhook uses later to recognise this transfer when it arrives.
//
// Never throws: by now the payout has succeeded, so failing here would be wrong.
// Automatic by default. Set NUVION_MANUAL_SEND=true and requests are still
// created and tracked, but the on-chain send waits for a person to run
// sendReplenishmentNow. Useful for the first few while you watch them go
// through; flip it back and nothing else changes.
export const MANUAL_SEND = () => process.env.NUVION_MANUAL_SEND === 'true';

export async function scheduleReplenishment(job: ReplenishmentJob) {
  // One row per payout, and transferRequestId is unique, so a webhook delivered
  // twice cannot schedule the same crypto twice. The second create is refused by
  // the database (P2002) rather than by a check that could race.
  try {
    await prisma.treasuryReplenishment.create({
      data: {
        transferRequestId: job.transferRequestId,
        cryptoCurrencyId: job.replenishCurrencyId,
        usdTreasuryAccountId: job.usdTreasuryAccountId,
        status: 'PENDING',
        statusUpdatedAt: new Date(),
        payload: job as any,
        amount: job.amount,
        nuvionCurrency: job.nuvionCurrency ?? null,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      logger.info(`[Replenishment] ${job.transferRequestId} is already scheduled, skipping`);
      return;
    }
    throw err;
  }

  if (MANUAL_SEND()) {
    logger.info(
      `[Replenishment] ${job.transferRequestId} is ready but NUVION_MANUAL_SEND is on, so nothing was queued. ` +
      `Run sendReplenishmentNow('${job.transferRequestId}') to send it.`,
    );
    return;
  }

  try {
    await enqueueReplenishment(job, 0);
  } catch (err: any) {
    logger.error('Replenishment saved but could not be queued. The sweeper will pick it up.', {
      transferRequestId: job.transferRequestId,
      error: err?.message,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────
// THE HANDLER: step 4, send the crypto on-chain
// ───────────────────────────────────────────────────────────────────────

export async function handleTreasuryReplenishment(jobData: ReplenishmentJob) {
  const {
    transferRequestId, replenishUserId, replenishCurrencyId,
    treasuryAccountId, treasuryWalletAddress, amount,
  } = jobData;

  // 1. CLAIM. One atomic update decides who gets to send. A retried job, a
  //    duplicate job and the sweeper can all arrive together, and only one of
  //    them can move the row to SUBMITTING. That is what stops a double send.
  const claim = await prisma.treasuryReplenishment.updateMany({
    where: { transferRequestId, status: { in: ['PENDING', 'RETRY'] } },
    data: {
      status: 'SUBMITTING',
      sendAttempts: { increment: 1 },
      statusUpdatedAt: new Date(),
    },
  });

  if (claim.count === 0) {
    logger.info(`[NuvionPayout] Replenishment for ${transferRequestId} already handled or in flight, skipping`);
    return;
  }

  const row = await prisma.treasuryReplenishment.findUnique({
    where: { transferRequestId },
    select: { sendAttempts: true },
  });
  const attempt = row?.sendAttempts ?? 1;

  // 2. CHECK BEFORE SENDING, using the SAME lookups the real call chain uses.
  //
  //    blockchain_Transfer finds the sender's WALLET by (userId, currencyId):
  //        const wallet = await prisma.wallet.findFirst({ userId, currencyId });
  //        if (!wallet) return;            <- undefined, no throw
  //    and the transfer beneath it reads the VirtualAccount by THAT wallet's id:
  //        account = virtualAccount.findUnique({ id: virtualAccountId })
  //        if (!wallet?.depositAddress) throw 'No deposit address found'
  //        if (account.available < amount + fee) throw 'Insufficient balance'
  //
  //    So the wallet is looked up by currencyId, not by ISO and chain. Checking
  //    an account found some other way could pass while the wallet the send
  //    actually needs is missing, which is the silent case above.
  const adminWallet = await prisma.wallet.findFirst({
    where: { userId: replenishUserId, currencyId: replenishCurrencyId },
    select: { id: true, depositAddress: true, derivationKey: true },
  });

  if (!adminWallet) {
    await transition(transferRequestId, 'FAILED', {
      note: 'The sending account has no Wallet row for this currency, so blockchain_Transfer would return undefined and send nothing',
    });
    await alertOps('Replenishment FAILED - FINANCIAL EXPOSURE', {
      reason: 'No Wallet row for the sending account',
      transferRequestId, sendingUserId: replenishUserId, currencyId: replenishCurrencyId, treasuryAccountId, amount,
      note: 'The recipient has been paid and the user has been debited, but the Nuvion treasury has NOT been topped up.',
    });
    return;
  }

  if (!adminWallet.depositAddress) {
    await transition(transferRequestId, 'FAILED', {
      note: `The sending wallet ${adminWallet.id} has no depositAddress, so the transfer would throw`,
    });
    await alertOps('Replenishment FAILED - FINANCIAL EXPOSURE', {
      reason: 'The sending wallet has no depositAddress',
      transferRequestId, walletId: adminWallet.id, treasuryAccountId, amount,
      note: 'The recipient has been paid and the user has been debited, but the Nuvion treasury has NOT been topped up.',
    });
    return;
  }

  //    The spendable balance lives on the VirtualAccount that shares the
  //    wallet's id, which is the row completeGlobalPayoutBlock credited.
  //    Wallet.availableBalance is a synced copy and is NOT what the send reads.
  const sendingAccount = await prisma.virtualAccount.findUnique({
    where: { id: adminWallet.id },
    select: { available: true, status: true },
  });

  if (sendingAccount && Number(sendingAccount.available) < Number(amount)) {
    await transition(transferRequestId, 'FAILED', {
      note: `The sending account holds ${sendingAccount.available}, below ${amount}`,
    });
    await alertOps('Replenishment FAILED - FINANCIAL EXPOSURE', {
      reason: 'The sending account does not hold enough crypto',
      transferRequestId, sendingUserId: replenishUserId, walletId: adminWallet.id, treasuryAccountId, amount,
      available: String(sendingAccount.available),
      note: 'The recipient has been paid and the user has been debited, but the Nuvion treasury has NOT been topped up. ' +
        'Note the send also takes a withdrawal fee on top, so the real requirement is slightly higher.',
    });
    return;
  }

  if (!sendingAccount) {
    logger.warn('[Replenishment] The sending wallet has no matching VirtualAccount, so no balance pre-check was possible. Sending anyway; blockchain_Transfer does its own check.', {
      transferRequestId, walletId: adminWallet.id,
    });
  }

  // 3. SEND. Only the transfer itself is in this try block.
  let result: any;
  try {
    result = await walletService.blockchain_Transfer({
      userId: replenishUserId,
      currencyId: replenishCurrencyId,
      amount,
      address: treasuryWalletAddress,
    });

    // blockchain_Transfer returns UNDEFINED, without throwing, when the sending
    // user has no Wallet row for that currency:
    //
    //     const wallet = await prisma.wallet.findFirst({ userId, currencyId });
    //     if (!wallet) return;
    //
    // Treating that as success would mark this SUBMITTED and leave it waiting
    // forever for a deposit that was never sent. The admin having a
    // VirtualAccount is NOT enough: createUserAccounts makes those with no Wallet.
    if (!result) {
      throw new ReplenishmentError(
        'blockchain_Transfer returned nothing. The sending account has no Wallet row for this currency, so nothing was sent.'
      );
    }

    // Or if it reports failure by RETURNING { success: false } rather than throwing.
    if (result.success === false) {
      throw new ReplenishmentError(result.msg ?? 'blockchain_Transfer reported failure');
    }
  } catch (error: any) {
    await handleSendFailure(jobData, attempt, error);
    return;
  }

  // 4. RECORD IT STRAIGHT AWAY. If recording fails, the money has moved but the
  //    row still says SUBMITTING. That status is never retried automatically,
  //    so nothing is sent twice, and the sweeper raises it to a person.
  //
  //    blockchain_Transfer returns the Transaction row that executeTransfer
  //    created, and on that row `reference` holds the ON-CHAIN HASH while `id`
  //    holds the internal CWD reference:
  //
  //        id:        result.reference,   // CWD-xxxxx
  //        reference: result.txHash,      // the chain hash
  //
  //    So the hash is result.reference. A Prisma Transaction row has no txHash
  //    property at all, which is why reading one gave null on every send.
  const txHash: string | null = result?.reference ?? null;

  if (!txHash) {
    logger.warn(
      '[Replenishment] no hash on the transfer record, so the deposit will have to be matched by amount',
      { transferRequestId },
    );
  }

  try {
    await transition(transferRequestId, 'SUBMITTED', {
      sentAt: new Date(),
      txRef: txHash,
      note: null,
    });
  } catch (error: any) {
    await alertOps('Replenishment SENT but not recorded', {
      transferRequestId, treasuryAccountId, amount, txHash: txHash ?? 'unknown',
      error: error?.message,
      note: 'Funds moved. Do NOT retry. Mark it resolved once you have checked.',
    });
  }

  // Nothing else to do here. The USD treasury is NOT whole yet: the deposit
  // still has to arrive and be converted (treasuryConversion.ts). Reading the
  // balance now would only show the old figure.
  logger.info(`[NuvionPayout] Crypto sent to the Nuvion stablecoin wallet for ${transferRequestId}, waiting for the deposit`);
}

async function handleSendFailure(job: ReplenishmentJob, attempt: number, error: any) {
  const { transferRequestId, replenishUserId, treasuryAccountId, amount } = job;
  const message = error?.message ?? String(error);
  const kind = classify(error);

  const context = {
    transferRequestId, sendingUserId: replenishUserId, treasuryAccountId, amount,
    attempt, error: message,
  };

  // Nothing was sent and it might work next time: let the queue try again with
  // backoff. Throwing is what tells BullMQ to retry.
  if (kind === 'RETRYABLE' && attempt < MAX_ATTEMPTS) {
    await transition(transferRequestId, 'RETRY', { note: message });
    logger.warn(`[NuvionPayout] Replenishment attempt ${attempt} failed before sending, will retry`, context);
    throw error;
  }

  // We cannot tell whether it went out. Retrying could send it twice, so a
  // person checks the chain first.
  if (kind === 'AMBIGUOUS') {
    await transition(transferRequestId, 'MANUAL_REVIEW', { note: message });
    await alertOps('Replenishment UNCERTAIN - check the chain before retrying', {
      ...context,
      note: 'It may or may not have been sent. Do not retry until you have checked.',
    });
    return;
  }

  // Definitely not sent and not going to fix itself (or we ran out of retries).
  await transition(transferRequestId, 'FAILED', { note: message });
  await alertOps('Replenishment FAILED - FINANCIAL EXPOSURE', {
    ...context,
    note: 'The recipient has been paid and the user has been debited, but the Nuvion treasury has NOT been topped up.',
  });
}

// For when a replenishment cannot even be scheduled, for example the stablecoin
// wallet address is not on file. The payout itself has already completed, so
// this must not throw. It records the problem and tells a person.
export async function flagReplenishmentBlocked(
  transferRequestId: string,
  reason: string,
  details: Record<string, unknown> = {}
) {
  // There may be no row yet: this is called when the crypto could not even be
  // worked out, which happens before scheduling. Write one either way, so the
  // payout is never left with no record of why it was not replenished.
  try {
    const marked = await prisma.treasuryReplenishment.updateMany({
      where: { transferRequestId },
      data: { status: 'FAILED', note: reason, statusUpdatedAt: new Date() },
    });
    if (marked.count === 0) {
      await prisma.treasuryReplenishment.create({
        data: {
          transferRequestId,
          cryptoCurrencyId: String(details.cryptoCurrencyId ?? 'unknown'),
          usdTreasuryAccountId: String(details.usdTreasuryAccountId ?? 'unknown'),
          status: 'FAILED',
          statusUpdatedAt: new Date(),
          note: reason,
        },
      });
    }
  } catch (err: any) {
    logger.error('flagReplenishmentBlocked: could not record the status', { transferRequestId, error: err?.message });
  }
  await alertOps('Replenishment could not be scheduled - FINANCIAL EXPOSURE', {
    transferRequestId,
    reason,
    ...details,
    note: 'The recipient has been paid and the user has been debited, but the Nuvion treasury has NOT been topped up.',
  });
}

// ───────────────────────────────────────────────────────────────────────
// THE SWEEPER for the sending step. treasuryConversion.ts has one for the
// steps after it, and sweepTreasury there runs both.
// ───────────────────────────────────────────────────────────────────────

export async function sweepReplenishments() {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  // Queued but never ran, or waiting to retry with nobody picking it up. Both
  // happen when the job was lost, for example during a Redis outage.
  const stuck = await prisma.treasuryReplenishment.findMany({
    where: {
      OR: [
        { status: 'PENDING', statusUpdatedAt: { lt: ago(STALE_PENDING_MINUTES) } },
        { status: 'RETRY', statusUpdatedAt: { lt: ago(STALE_RETRY_MINUTES) } },
      ],
    },
    select: { transferRequestId: true, payload: true },
    take: 50,
  });

  for (const r of stuck) {
    if (!r.payload) {
      await alertOps('Replenishment has no saved payload', { transferRequestId: r.transferRequestId });
      continue;
    }
    try {
      // A fresh generation each time. If an old job with the same id is still
      // sitting in Redis (say, failed and kept), re-adding it would be ignored
      // and this row would stay stuck. A duplicate job is harmless, because
      // the claim above lets only one of them send.
      await enqueueReplenishment(r.payload as unknown as ReplenishmentJob, `sweep${Date.now()}`);
      logger.info(`[sweeper] Re-queued replenishment for ${r.transferRequestId}`);
    } catch (err: any) {
      logger.error('[sweeper] Could not re-queue replenishment', { transferRequestId: r.transferRequestId, error: err?.message });
    }
  }

  // Started but never finished. It could have been sent, so never retry it
  // automatically. Raise it to a person.
  const hung = await prisma.treasuryReplenishment.findMany({
    where: { status: 'SUBMITTING', statusUpdatedAt: { lt: ago(STALE_SUBMITTING_MINUTES) } },
    select: { transferRequestId: true, payload: true },
    take: 50,
  });

  for (const r of hung) {
    const p = r.payload as unknown as ReplenishmentJob | null;
    await transition(r.transferRequestId, 'MANUAL_REVIEW', { note: 'Stuck in SUBMITTING, outcome unknown' });
    await alertOps('Replenishment stuck mid-send - check the chain before retrying', {
      transferRequestId: r.transferRequestId,
      treasuryAccountId: p?.treasuryAccountId ?? 'unknown',
      amount: p?.amount ?? 'unknown',
      note: 'The worker may have died after sending. Do not retry until you have checked.',
    });
  }

  logger.info(`[sweeper] Replenishment sweep done: re-queued ${stuck.length}, escalated ${hung.length}`);
}

// ───────────────────────────────────────────────────────────────────────
// FOR OPS. Wrap these in an admin endpoint or run them from a script.
// ───────────────────────────────────────────────────────────────────────

// Try again after fixing the cause (for example the admin wallet was
// refilled). From MANUAL_REVIEW you must say you checked the chain.
export async function retryReplenishment(transferRequestId: string, opts: { confirmedNotSent?: boolean } = {}) {
  const row = await prisma.treasuryReplenishment.findUnique({
    where: { transferRequestId },
    select: { status: true, payload: true },
  });

  if (!row?.payload) throw new Error('No replenishment payload saved for this transfer');
  if (!['FAILED', 'MANUAL_REVIEW'].includes(row.status)) {
    throw new Error(`Cannot retry from status ${row.status}`);
  }
  if (row.status === 'MANUAL_REVIEW' && !opts.confirmedNotSent) {
    throw new Error('Check on chain that nothing was sent, then pass { confirmedNotSent: true }.');
  }

  await transition(transferRequestId, 'PENDING', { sendAttempts: 0 });
  // A fresh generation so the queue does not treat it as a duplicate of the old job.
  await enqueueReplenishment(row.payload as unknown as ReplenishmentJob, `retry${Date.now()}`);
}

// Send one now, by hand. For manual mode, or to push a request the sweeper has
// not reached yet. Only touches rows that have NOT been sent: anything already
// SUBMITTED or beyond is refused, so this can never send the same crypto twice.
export async function sendReplenishmentNow(transferRequestId: string) {
  const row = await prisma.treasuryReplenishment.findUnique({
    where: { transferRequestId },
    select: { status: true, payload: true, amount: true, nuvionCurrency: true },
  });
  if (!row) throw new Error(`No replenishment record for ${transferRequestId}`);
  if (!row.payload) throw new Error('That record has no saved payload, so there is nothing to send');
  if (!['PENDING', 'RETRY'].includes(row.status)) {
    throw new Error(
      `Cannot send from status ${row.status}. Only PENDING and RETRY can be sent. ` +
      'FAILED and MANUAL_REVIEW go through retryReplenishment, which asks you to confirm nothing was sent.'
    );
  }

  logger.info(`[Replenishment] Sending ${row.amount} ${row.nuvionCurrency} for ${transferRequestId} by hand`);
  await enqueueReplenishment(row.payload as unknown as ReplenishmentJob, `manual${Date.now()}`);
  return { queued: true, amount: row.amount, currency: row.nuvionCurrency };
}

// What is waiting to be sent: the list to work from in manual mode.
export async function listPendingReplenishments() {
  return prisma.treasuryReplenishment.findMany({
    where: { status: { in: ['PENDING', 'RETRY'] } },
    orderBy: { statusUpdatedAt: 'asc' },
    select: { transferRequestId: true, status: true, amount: true, nuvionCurrency: true, statusUpdatedAt: true, note: true },
    take: 100,
  });
}

// Ops did it by hand (for example sent the crypto manually). Closes it out.
export async function markReplenishmentResolved(transferRequestId: string, note: string) {
  await transition(transferRequestId, 'RESOLVED_MANUALLY', { note: note });
}