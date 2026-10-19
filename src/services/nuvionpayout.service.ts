import prisma from '../config/prisma.client';
import logger from '../config/logger';
import {
    createCounterparty,
    createPaymentDetail,
    createFxQuote,
    initiateSameCurrencyTransfer,
    initiateCrossCurrencyTransfer,
    listCounterpartyPaymentDetails
} from './nuvion.service';
import { Decimal } from 'decimal.js';
import { ulid } from 'ulid';
import { generalQueue } from '../workers/general.worker';
import virtualAccountService from './virtualAccount.service';
import notificationService from './notification.service';
import { scheduleReplenishment, flagReplenishmentBlocked } from './treasuryReplenishment.service';
import { resolveTreasury, thresholdFor, normaliseChain } from '../config/nuvionTreasury.config';
import config from '../config/env.config';
// ADDRESS_EXEMPT_CURRENCIES is still EMPTY — measured 13 Oct and again 19
// Oct, live Nuvion refuses an NG counterparty with no address block AND one
// with no email. The address is REQUIRED on every rail, so it is always sent.
//
// What changed on 19 Oct is who fills it in. On the six African rails Nuvion
// has confirmed the field is not validated and a Vyre placeholder is
// acceptable, so the user is no longer asked for something we cannot verify
// and they often do not know. See ADDRESS_PLACEHOLDER_CURRENCIES.
import {
    addressRequiredFor,
    addressCollectedFromUser,
    emailCollectedFromUser,
    ADDRESS_PLACEHOLDER_CURRENCIES,
} from './recipientparse.service';
import { missingFieldsFrom, learnRequirements, confirmRequirements } from './nuvionRequirements';
import { schemeToSend, bankCountryFor, VALID_SCHEMES, feeSchemeFor } from './railRequirements';

// The real replenishment handler lives in its own file now. Re-exported from
// here so general.worker.ts keeps importing it from the same place and nothing
// has to change there.
export { handleTreasuryReplenishment } from './treasuryReplenishment.service';

// ── The counterparty address ──────────────────────────────────────────────
//
// Nuvion requires an address block on every counterparty. On the African
// rails it does not validate the contents, and has authorised a Vyre
// placeholder there (19 Oct 2026 — see ADDRESS_PLACEHOLDER_CURRENCIES for
// the standing note and the written-confirmation TODO).
//
// This is the ONE place the block is built, so the rules hold everywhere:
//   1. A real recipient address always wins. The placeholder is a fallback,
//      never an overwrite — substituting it over data we hold would destroy
//      good data and weaken screening on a rail that may later be screened.
//   2. All-or-nothing. A real line1 welded to a placeholder postcode is an
//      address that belongs to nobody and reads as a data-quality fault, so
//      either the whole block is theirs or the whole block is Vyre's.
//   3. Vyre's own address, never the sender's and never an invented one. The
//      placeholder is not a claim about the recipient; reusing the sender's
//      real address would be a false statement about a person to a regulated
//      counterparty, which is why it was never an option.
//   4. Never a partially-populated block. `undefined` survives in an object
//      and vanishes in JSON.stringify, which is exactly how every
//      counterparty here went to Nuvion with no postal code for weeks. A
//      missing placeholder value throws instead.

/**
 * The counterparty address as Nuvion actually accepts it.
 *
 * MEASURED 13 Oct: `line1 + city + country` was accepted, and both
 * `state_or_province` and `postal_code` were accepted as ABSENT. So those two
 * are optional, and this type says so.
 *
 * The declaration in nuvion.service.ts had all five as required-when-present,
 * which is stricter than Nuvion. That is not a harmless inaccuracy: it is
 * what pushed the old code into `!` assertions over three nullable columns,
 * and a `!` silences the compiler without making the value present — so
 * `undefined` went into the object, JSON.stringify dropped the key, and every
 * counterparty on that path went to Nuvion with no postal code for weeks.
 *
 * Relax that declaration to match (see address-fields-change.md) rather than
 * casting this through `any`, or the next person to touch it hits the same
 * wall and reaches for the same `!`.
 */
export type NuvionCounterpartyAddress = {
    line1: string;
    city: string;
    country: string;
    state_or_province?: string;
    postal_code?: string;
};

const PLACEHOLDER_ADDRESS_ENV = {
    line1: 'VYRE_PLACEHOLDER_ADDRESS_LINE1',
    city: 'VYRE_PLACEHOLDER_ADDRESS_CITY',
    state_or_province: 'VYRE_PLACEHOLDER_ADDRESS_STATE',
    postal_code: 'VYRE_PLACEHOLDER_ADDRESS_POSTAL',
    country: 'VYRE_PLACEHOLDER_ADDRESS_COUNTRY',
} as const;

/**
 * Vyre's placeholder address, read from env.
 *
 * NOT hardcoded, and deliberately not defaulted to something plausible. A
 * made-up street address that looks real is indistinguishable from real data
 * once it is sitting in a regulated counterparty's records — the one thing
 * this must not become. Set these to Vyre Africa Limited's actual registered
 * office so the block is coherent and truthful about whose address it is.
 *
 * `country` is Vyre's own, not the recipient's: the block is Vyre's address,
 * and an internally coherent foreign address is less likely to trip anything
 * than a Nigerian street in a Kenyan city.
 */
function placeholderAddress(currency: string): NuvionCounterpartyAddress {
    const out: Record<string, string> = {};
    const missing: string[] = [];

    for (const [field, envVar] of Object.entries(PLACEHOLDER_ADDRESS_ENV)) {
        const v = process.env[envVar]?.trim();
        if (!v) missing.push(envVar);
        else out[field] = v;
    }

    if (missing.length) {
        // Loud, and before the API call. Sending a half-built block would be
        // refused by Nuvion with a required-field error that points at the
        // recipient rather than at this misconfiguration.
        throw new Error(
            `Cannot build the placeholder recipient address for ${currency}: ${missing.join(', ')} not set. ` +
            `These must be Vyre Africa Limited's registered office before any African-rail payout can be created.`,
        );
    }

    // Built explicitly rather than returned as the loose record: every one of
    // the five is guaranteed present by the throw above, and naming them here
    // means the compiler checks that against the type instead of taking a
    // cast's word for it.
    return {
        line1: out.line1,
        city: out.city,
        country: out.country,
        state_or_province: out.state_or_province,
        postal_code: out.postal_code,
    };
}

/**
 * The address block to send, plus whether the USER supplied it.
 *
 * `userSupplied: false` means the block is Vyre's placeholder, which matters
 * to the caller: a requirement we satisfied ourselves must not be recorded
 * as a requirement to put to the next user in this corridor.
 */
export function counterpartyAddressFor(
    beneficiary: {
        nuvionRecipientAddressLine1?: string | null;
        nuvionRecipientAddressCity?: string | null;
        nuvionRecipientAddressState?: string | null;
        nuvionRecipientAddressPostal?: string | null;
        nuvionRecipientCountry?: string | null;
    },
    currency?: string,
): { address: NuvionCounterpartyAddress; userSupplied: boolean } | null {
    if (!addressRequiredFor(currency)) return null;

    const line1 = beneficiary.nuvionRecipientAddressLine1?.trim();
    const city = beneficiary.nuvionRecipientAddressCity?.trim();
    const country = beneficiary.nuvionRecipientCountry?.trim();

    // line1 + city + country is the measured minimum Nuvion accepts.
    if (line1 && city && country) {
        const address: NuvionCounterpartyAddress = { line1, city, country };
        const state = beneficiary.nuvionRecipientAddressState?.trim();
        const postal = beneficiary.nuvionRecipientAddressPostal?.trim();
        if (state) address.state_or_province = state;
        if (postal) address.postal_code = postal;
        return { address, userSupplied: true };
    }

    if (ADDRESS_PLACEHOLDER_CURRENCIES.includes(currency ?? '')) {
        return { address: placeholderAddress(currency!), userSupplied: false };
    }

    // Everything else is screened on this field, so an incomplete address is
    // still a hard stop rather than something to paper over.
    return null;
}

/**
 * The counterparty email, and whether the user supplied it.
 *
 * DIFFERENT FROM THE ADDRESS IN ONE WAY THAT MATTERS. Nuvion's confirmation
 * covered the address; the email is Vyre's own extension of it. An address in
 * a record is inert, but an email RECEIVES MAIL — so any recipient
 * notification Nuvion sends now arrives at Vyre rather than at the recipient.
 * That is a product decision, made knowingly, not a side effect to discover
 * later.
 *
 * Why a Vyre-controlled address and not a generated one: a fabricated
 * `john.smith@gmail.com` can be a real stranger's inbox, and would send them
 * another person's payment notifications. A Vyre address cannot land anywhere
 * it should not.
 *
 * UNIQUENESS. If VYRE_PLACEHOLDER_EMAIL contains `{id}`, the beneficiary id
 * is substituted, giving every counterparty a distinct address that still
 * routes to Vyre — e.g. `beneficiary+{id}@vyre.africa`. Prefer this. A single
 * shared address across every counterparty invites Nuvion to treat them as
 * one person if it ever dedupes on email, and makes inbound mail impossible
 * to trace back to a payout. Plain-address mode is supported because some
 * validators reject `+`; if Nuvion's does, that is worth knowing before this
 * ships at volume.
 */
export function counterpartyEmailFor(
    beneficiary: { nuvionRecipientEmail?: string | null; id?: string | null },
    currency?: string,
): { email: string; userSupplied: boolean } | null {
    const real = beneficiary.nuvionRecipientEmail?.trim();
    // A real email always wins, on every rail. Same rule as the address: the
    // placeholder is a fallback, never an overwrite.
    if (real) return { email: real, userSupplied: true };

    if (!ADDRESS_PLACEHOLDER_CURRENCIES.includes(currency ?? '')) return null;

    const template = process.env.VYRE_PLACEHOLDER_EMAIL?.trim();
    if (!template) {
        throw new Error(
            `Cannot build the placeholder recipient email for ${currency}: VYRE_PLACEHOLDER_EMAIL not set. ` +
            `Use a Vyre-controlled address, ideally containing {id} for per-beneficiary uniqueness ` +
            `(e.g. beneficiary+{id}@vyre.africa).`,
        );
    }

    const id = beneficiary.id?.trim();
    if (template.includes('{id}') && !id) {
        // Substituting nothing would collapse every counterparty onto one
        // address — the exact failure the template exists to avoid — so this
        // refuses rather than quietly degrading to the shared form.
        throw new Error('VYRE_PLACEHOLDER_EMAIL contains {id} but the beneficiary has no id yet');
    }

    return { email: id ? template.replace('{id}', id) : template, userSupplied: false };
}

// ── Retry policy ──────────────────────────────────────────────────────────
// Bounded retry ONLY for transient failures (timeout, 5xx, network error),
// using the IDENTICAL unique_reference (and fx_quote_id, for cross-
// currency) on every attempt. Safe because Nuvion REFUSES a reference it
// has seen before rather than creating a second transfer.
//
// MEASURED 8 Oct, on both initiateCrossCurrencyTransfer and
// initiateSameCurrencyTransfer: HTTP 409 with type "error_duplicate_resource".
// It does NOT return the original transfer, whatever the docs say, so a retry
// cannot recover the first attempt's id or status. That refusal is proof the
// transfer EXISTS, and the catch below treats it that way: the request is
// marked PROCESSING and the outflows webhook decides the outcome. Treating it
// as a failure would refund the user while Nuvion pays the recipient.
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

// CONFIRMED chain-name mapping — Nuvion's lowercase short codes vs this
// codebase's AllSupportedChains uppercase full names.
const NUVION_TO_VYRE_CHAIN: Record<string, string> = { eth: 'ETHEREUM', base: 'BASE', matic: 'POLYGON', sol: 'SOLANA' };
const VYRE_TO_NUVION_CHAIN: Record<string, string> = { ETHEREUM: 'eth', BASE: 'base', POLYGON: 'matic', SOLANA: 'sol' };

// ==================== HELPERS ====================

function generateRef(prefix: string = 'TXN'): string {
    return `${prefix}-${ulid()}`;
}

export function toDecimal(value: number | string | Decimal): Decimal {
    return new Decimal(value.toString());
}

const ISO_TO_NUVION_CODE: Record<string, string> = {
    USDC: 'USC',
    USDT: 'UST',
};

export function toNuvionCurrencyCode(iso: string): string {
    return ISO_TO_NUVION_CODE[iso] ?? iso;
}

function isTransientError(error: any): boolean {
    const httpStatus = error?.httpStatus;
    if (!httpStatus) return true;
    return httpStatus >= 500;
}

// Nuvion refuses a unique_reference it has seen before. MEASURED 8 Oct on both
// transfer calls: HTTP 409 with type "error_duplicate_resource", the same code
// ensureNuvionCounterpartyAndPaymentDetail already keys off for payment details.
//
// This is NOT a failure. It is proof the transfer EXISTS at Nuvion. The
// original's id cannot be recovered from it, which does not matter: the
// outflows webhook finds the request by idempotencyKey.
function isDuplicateReferenceError(res: { httpStatus?: number; rawData?: any; error?: string }): boolean {
    if (res?.rawData?.type === 'error_duplicate_resource') return true;
    const validations = res?.rawData?.validations;
    if (Array.isArray(validations) && validations.some(
        (v: any) => (Object.values(v ?? {})[0] as any)?.type === 'error_duplicate_resource'
    )) return true;
    return res?.httpStatus === 409 && /unique_reference/i.test(res?.error ?? '');
}

// Carries that fact on the thrown error, so the one catch below can act on it.
function transferFailure(res: any): Error {
    const err: any = new Error(res?.error ?? 'Transfer failed');
    err.alreadyAtNuvion = isDuplicateReferenceError(res);
    return err;
}

async function withBoundedRetry<T>(
    fn: () => Promise<{ success: boolean; error?: string; httpStatus?: number; [key: string]: any }>,
    context: string
): Promise<{success: boolean; error?: string; result?: T; httpStatus?: number; rawData?: any  }> {
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        const result = await fn();
        if (result.success) return { success: true, result: result as T, rawData: result.rawData };
        lastError = result;
        if (!isTransientError(result) || attempt === MAX_RETRY_ATTEMPTS) {
            logger.error(`[NuvionPayout] ${context} failed permanently after ${attempt} attempt(s)`, { error: result.error });
            return { success: false, error: result.error, httpStatus: result.httpStatus, rawData: result.rawData };
        }
        logger.warn(`[NuvionPayout] ${context} attempt ${attempt} failed transiently, retrying in ${RETRY_DELAY_MS}ms`, { error: result.error });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    return { success: false, error: lastError?.error ?? 'Unknown error after retries', httpStatus: lastError?.httpStatus, rawData: lastError?.rawData };

}

// ── Main entry point ─────────────────────────────────────────────────────

export interface InitiatePayoutParams {
    userId: string;
    beneficiaryId: string;
    paymentDetailId: string; // NEW — which of the beneficiary's payment methods to send to
    fromCurrency: string;
    amount: string;
    narration: string;
}

export interface BlockPayoutParams {
    userId: string;
    beneficiaryId: string;
    paymentDetailId: string;
    fromCurrency: string;
    amount: string;
    narration: string;
}

export async function blockNuvionPayout(params: BlockPayoutParams): Promise<{ transferRequestId: string }> {
    const { userId, beneficiaryId, paymentDetailId, fromCurrency, amount, narration } = params;

    const treasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: fromCurrency, isActive: true } });
    if (!treasury) throw new Error(`No active Nuvion treasury account configured for ${fromCurrency}`);

    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary || beneficiary.userId !== userId) throw new Error('Beneficiary not found or does not belong to this user');

    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
    if (!paymentMethod || paymentMethod.beneficiaryId !== beneficiaryId) throw new Error('Payment method not found for this beneficiary');

    // if (!beneficiary.nuvionRecipientCountry || !beneficiary.nuvionRecipientEmail || !beneficiary.nuvionRecipientAddressLine1) {
    //     throw new Error('This beneficiary is missing required details — please complete their profile before sending a payout');
    // }

    // Country is always needed — it drives the rail and the bank country, and
    // nothing can stand in for it. The email is only required from the USER
    // on the rails where Vyre does not supply it.
    if (!beneficiary.nuvionRecipientCountry) {
    throw new Error('This recipient is missing required details — please complete their profile before sending');
    }

    if (emailCollectedFromUser(paymentMethod.currency) && !beneficiary.nuvionRecipientEmail) {
    throw new Error('This recipient needs an email address for payouts in ' + paymentMethod.currency);
    }
    
    // Only the rails where the USER owns this field. On the African rails
    // Vyre's placeholder fills it, so a recipient with no address on file is
    // no longer blocked from being paid — the whole point of the change.
    if (addressCollectedFromUser(paymentMethod.currency) && !beneficiary.nuvionRecipientAddressLine1) {
    throw new Error('This recipient needs a full address for payouts in ' + paymentMethod.currency);
    }


    if (!paymentMethod.accountNumber) throw new Error('This payment method has no account number set');

    const vyreCurrency = await prisma.currency.findFirst({ where: { ISO: fromCurrency } });
    if (!vyreCurrency) throw new Error(`No Vyre Currency record found for ${fromCurrency}`);

    const sharedReference = generateRef('NVPAY');

    const { transaction, block } = await virtualAccountService.initiateBankWithdrawal({
        userId,
        currency: fromCurrency,
        amount,
        bankDetails: {
            accountNumber: paymentMethod.accountNumber,
            bankCode: paymentMethod.bankCode ?? '',
            accountName: paymentMethod.accountName ?? (beneficiary.bank as any)?.accountName ?? '',
        },
        reference: sharedReference,
        metadata: {
            payoutProvider: 'NUVION', beneficiaryId, beneficiaryPaymentDetailId: paymentDetailId, narration,
            treasuryAccountId: treasury.id, // NEW — for symmetry with the crypto path
        },
    });

    const transferRequest = await prisma.transferRequest.create({
        data: {
            idempotencyKey: sharedReference, type: 'BANK', bank: beneficiary.bank ?? undefined,
            currencyId: vyreCurrency.id,
            amount: transaction.amount, userId, status: 'PENDING',
            beneficiaryId, // NEW — real column, was previously only in VirtualTransaction.metadata
            beneficiaryPaymentDetailId: paymentDetailId, // NEW
        } as any,
    });

    await generalQueue.add('Nuvion_Payout_Process', {
        transferRequestId: transferRequest.id, transactionId: transaction.id, blockId: block.id,
        sharedReference, narration, isCryptoSourced: false,
    });

    await notificationService.queue({
        userId, title: 'Transfer initiated', type: 'GENERAL',
        content: `Your ${fromCurrency} ${amount} transfer is being processed. We'll let you know once it's complete.`,
    });

    logger.info(`[NuvionPayout] Fiat payout blocked, queued: TransferRequest ${transferRequest.id}`);
    return { transferRequestId: transferRequest.id };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 1b — CRYPTO source. Pre-funded float model: no debit here at
// all. Takes cryptoCurrencyId only — no chainKey needed from the caller,
// blockchain_Transfer (used later at replenishment) derives chain
// internally from currencyId.
// ═══════════════════════════════════════════════════════════════════════

export interface BlockCryptoPayoutParams {
    userId: string; beneficiaryId: string; paymentDetailId: string;
    cryptoCurrencyId: string; amount: string; narration: string;
}

export async function blockCryptoPayout(params: BlockCryptoPayoutParams): Promise<{
    transferRequestId: string;
    estimatedFee: number;
    vyreFee: number;
    totalDebit: string;
}> {
    const { userId, beneficiaryId, paymentDetailId, cryptoCurrencyId, amount, narration } = params;

    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary || beneficiary.userId !== userId) throw new Error('Beneficiary not found or does not belong to this user');

    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
    if (!paymentMethod || paymentMethod.beneficiaryId !== beneficiaryId) throw new Error('Payment method not found for this beneficiary');

    // if (!beneficiary.nuvionRecipientCountry || !beneficiary.nuvionRecipientEmail || !beneficiary.nuvionRecipientAddressLine1) {
    //     throw new Error('This beneficiary is missing required details — please complete their profile before sending a payout');
    // }

    // Country is always needed — it drives the rail and the bank country, and
    // nothing can stand in for it. The email is only required from the USER
    // on the rails where Vyre does not supply it.
    if (!beneficiary.nuvionRecipientCountry) {
    throw new Error('This recipient is missing required details — please complete their profile before sending');
    }

    if (emailCollectedFromUser(paymentMethod.currency) && !beneficiary.nuvionRecipientEmail) {
    throw new Error('This recipient needs an email address for payouts in ' + paymentMethod.currency);
    }

    // Only the rails where the USER owns this field. On the African rails
    // Vyre's placeholder fills it, so a recipient with no address on file is
    // no longer blocked from being paid — the whole point of the change.
    if (addressCollectedFromUser(paymentMethod.currency) && !beneficiary.nuvionRecipientAddressLine1) {
    throw new Error('This recipient needs a full address for payouts in ' + paymentMethod.currency);
    }

    const cryptoCurrency = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
    if (!cryptoCurrency) throw new Error('Unknown source currency');
    if (!['USDC', 'USDT'].includes(cryptoCurrency.ISO)) {
        throw new Error(`${cryptoCurrency.ISO} is not supported for global payouts yet`);
    }

    // Nuvion-facing payout is ALWAYS routed through the USD treasury
    // directly — no chain-specific stablecoin treasury involved. The
    // user's actual stablecoin, on its own chain, is what gets frozen
    // below; USD is purely the Nuvion-side routing currency.
    const usdTreasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: 'USD', isActive: true },
    });
    if (!usdTreasury) throw new Error('No active USD treasury account configured');

    // ── Fee calculation — three genuinely distinct components ──
    // 1. amount             — what the recipient actually receives
    // 2. estimatedNuvionFee — Nuvion's own pass-through cost (our best
    //                         estimate; only confirmed real for 'wire' so far)
    // 3. vyreFee            — Vyre's own margin/revenue, never touches Nuvion
    // Priced off the RAIL, not off whatever is stored in `scheme` — which is
    // null for a single-rail currency and, for EUR, deliberately never sent.
    // estimateNuvionFee(null) returns default: 7, which is the whole reason
    // every Naira payout was quoted ~$7 against a real ~$0.04.
    const feeScheme = feeSchemeFor(paymentMethod.currency, paymentMethod.scheme, paymentMethod.paymentMethod);
    const estimatedNuvionFee = estimateNuvionFee(feeScheme ?? paymentMethod.scheme);
    const vyreFee = calculateVyreFee(amount);
    const totalDebit = toDecimal(amount).plus(estimatedNuvionFee).plus(vyreFee); // frozen from the USER
    const treasuryDraw = toDecimal(amount).plus(estimatedNuvionFee); // ACTUALLY drawn from Nuvion's real USD float — excludes vyreFee entirely

    if (!usdTreasury.lastKnownAvailable || toDecimal(usdTreasury.lastKnownAvailable).lt(treasuryDraw)) {
        logger.error(`[NUVION USD FLOAT LOW] Treasury ${usdTreasury.id} has insufficient float for ${treasuryDraw} (amount + Nuvion fee) — lastKnownAvailable: ${usdTreasury.lastKnownAvailable}`);
        throw new Error('This payout amount is temporarily unavailable — please try a smaller amount or try again shortly');
    }

    const usdVyreCurrency = await prisma.currency.findFirst({ where: { ISO: 'USD' } });
    if (!usdVyreCurrency) throw new Error('No Vyre Currency record found for USD');

    const sharedReference = generateRef('NVPAY');

    // Real freeze via the block mechanism — funds stay frozen (not
    // double-spendable) but aren't permanently moved until Nuvion
    // confirms success via webhook. Freezes the FULL total (amount +
    // both fees), not just the send amount.
    const { transaction, block } = await virtualAccountService.initiateGlobalPayoutBlock({
        userId,
        currencyId: cryptoCurrencyId,
        amount: totalDebit.toString(),
        reference: sharedReference,
        metadata: {
            payoutProvider: 'NUVION',
            beneficiaryId,
            beneficiaryPaymentDetailId: paymentDetailId,
            narration,
            treasuryAccountId: usdTreasury.id,
            sendAmount: amount,
            estimatedNuvionFee,
            vyreFee,
            // REQUIRED by the replenishment: the payout's own currencyId is USD
            // (the Nuvion-facing routing currency), so this is the only record
            // of which stablecoin was actually frozen and has to be sent on.
            // Without it scheduleReplenishmentForPayout cannot resolve anything
            // and every payout is flagged as blocked.
            cryptoCurrencyId,
        },
    });

    const transferRequest = await prisma.transferRequest.create({
        data: {
            idempotencyKey: sharedReference,
            type: 'CRYPTO',
            currencyId: usdVyreCurrency.id, // real Vyre Currency FK for USD — the Nuvion-facing routing currency
            amount: toDecimal(amount), // the SEND amount only — what the recipient actually gets
            estimatedFeeUsd: toDecimal(estimatedNuvionFee),
            vyreFeeUsd: toDecimal(vyreFee),
            userId,
            status: 'PENDING',
            beneficiaryId,
            beneficiaryPaymentDetailId: paymentDetailId,
        } as any,
    });

    // Only amount + Nuvion's fee draw down the real treasury float —
    // vyreFee never leaves Vyre's own system, so it must never decrement
    // Nuvion's real balance.
    await prisma.nuvionTreasuryAccount.update({
        where: { id: usdTreasury.id },
        data: { lastKnownAvailable: { decrement: treasuryDraw } as any },
    });

    await generalQueue.add('Nuvion_Payout_Process', {
        transferRequestId: transferRequest.id,
        transactionId: transaction.id,
        blockId: block.id,
        sharedReference,
        narration,
        isCryptoSourced: true,
    });

    await notificationService.queue({
        userId,
        title: 'Transfer initiated',
        type: 'GENERAL',
        content: `Sending ${amount} ${cryptoCurrency.ISO}. Network fee: ~$${estimatedNuvionFee}. Service fee: $${vyreFee}. Total: ${totalDebit.toString()} ${cryptoCurrency.ISO}.`,
    });

    logger.info(`[NuvionPayout] Crypto payout blocked (routed via USD treasury) — amount ${amount} + Nuvion fee ${estimatedNuvionFee} + Vyre fee ${vyreFee} = ${totalDebit}, queued: TransferRequest ${transferRequest.id}`);

    return {
        transferRequestId: transferRequest.id,
        estimatedFee: estimatedNuvionFee,
        vyreFee,
        totalDebit: totalDebit.toString(),
    };
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — slow, runs in the background worker
// ═══════════════════════════════════════════════════════════════════════

export async function processNuvionPayoutJob(jobData: {
    transferRequestId: string; transactionId: string; blockId: string;
    sharedReference: string; narration: string; isCryptoSourced?: boolean;
    fxQuoteId?: string;
}) {
    const { transferRequestId, transactionId, blockId, sharedReference, narration, isCryptoSourced, fxQuoteId: preSuppliedFxQuoteId } = jobData;

    const transferRequest = await prisma.transferRequest.findUnique({
        where: { id: transferRequestId },
        include: { currency: true }
    });

    if (!transferRequest) {
        logger.error(`[NuvionPayout] processNuvionPayoutJob — TransferRequest ${transferRequestId} not found`);
        return;
    }
    if (transferRequest.status !== 'PENDING') {
        logger.info(`[NuvionPayout] TransferRequest ${transferRequestId} already ${transferRequest.status} — skipping reprocess`);
        return;
    }

    const nuvionCurrencyCode = toNuvionCurrencyCode(transferRequest.currency.ISO);

    const beneficiaryId = transferRequest.beneficiaryId;
    const beneficiaryPaymentDetailId = transferRequest.beneficiaryPaymentDetailId;

    const transaction = await prisma.virtualTransaction.findUnique({ where: { id: transactionId } });
    const meta = transaction?.metadata as any;
    const treasuryAccountId = meta?.treasuryAccountId;

    const beneficiary = beneficiaryId ? await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } }) : null;
    const paymentMethod = beneficiaryPaymentDetailId ? await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: beneficiaryPaymentDetailId } }) : null;

    if (!beneficiary || !paymentMethod) {
        await failPayout({ transferRequestId, transactionId, blockId, isCryptoSourced }, 'Beneficiary or payment method record missing');
        return;
    }

    const toCurrency = paymentMethod.currency;
    const isCrossCurrency = nuvionCurrencyCode !== toCurrency;
    const decimalAmount = toDecimal(transferRequest.amount);

    const treasury = treasuryAccountId
        ? await prisma.nuvionTreasuryAccount.findUnique({ where: { id: treasuryAccountId } })
        : null;

    if (!treasury) {
        await failPayout({ transferRequestId, transactionId, blockId, isCryptoSourced }, 'Treasury account no longer active');
        return;
    }

    try {
        // CHANGED — replaces ~80 lines of duplicated counterparty/payment
        // detail creation logic with a single call to the shared function.
        // Any future fix to this logic now only needs to happen once.
        const { counterpartyId, paymentDetailNuvionId } = await ensureNuvionCounterpartyAndPaymentDetail(beneficiary, paymentMethod);

        let nuvionTransferId: string;
        let fxQuoteId: string | undefined;
        let fxRate: number | undefined;
        let realFee = 0;

        if (isCrossCurrency) {
            // NOTE: nothing currently passes fxQuoteId into this job, so the
            // branch below always creates a fresh quote. That is deliberate:
            // the quote encodes the AMOUNT as well as the rate, and re-quoting
            // from transferRequest.amount guarantees Nuvion sends exactly what
            // the user was frozen for. Honouring a client-supplied quote would
            // break that guarantee.
            let fxQuoteToUse = preSuppliedFxQuoteId;

            if (!fxQuoteToUse) {
                const quote = await createFxQuote({
                    to_currency: toCurrency, from_currency: nuvionCurrencyCode,
                    amount_from: decimalAmount.toNumber(), account_id: treasury.nuvionAccountId,
                    counterparty_id: counterpartyId, payment_detail_id: paymentDetailNuvionId,
                });
                if (!quote.success || !quote.id) throw Object.assign(new Error(quote.error ?? 'FX quote failed'), { httpStatus: quote.httpStatus });
                fxQuoteToUse = quote.id; fxRate = quote.rate;
            } else {
                logger.info(`[NuvionPayout] Reusing pre-fetched quote ${fxQuoteToUse} for TransferRequest ${transferRequestId}`);
            }
            fxQuoteId = fxQuoteToUse;

            const transferAttempt = await withBoundedRetry(
                () => initiateCrossCurrencyTransfer({
                    account_id: treasury.nuvionAccountId, payment_detail_id: paymentDetailNuvionId,
                    counterparty_id: counterpartyId, fx_quote_id: fxQuoteToUse!, narration,
                    payment_type: paymentMethod.paymentMethod as any, unique_reference: sharedReference,
                }), 'cross-currency transfer'
            );

            if (!transferAttempt.success && preSuppliedFxQuoteId && /expired|invalid.*quote/i.test(transferAttempt.error ?? '')) {
                logger.warn(`[NuvionPayout] Pre-fetched quote ${preSuppliedFxQuoteId} appears expired — creating a fresh one for TransferRequest ${transferRequestId}`);

                const freshQuote = await createFxQuote({
                    to_currency: toCurrency, from_currency: nuvionCurrencyCode,
                    amount_from: decimalAmount.toNumber(), account_id: treasury.nuvionAccountId,
                    counterparty_id: counterpartyId, payment_detail_id: paymentDetailNuvionId,
                });
                if (!freshQuote.success || !freshQuote.id) throw Object.assign(new Error(freshQuote.error ?? 'FX quote failed'), { httpStatus: freshQuote.httpStatus });
                fxQuoteId = freshQuote.id; fxRate = freshQuote.rate;

                const retryAttempt = await withBoundedRetry(
                    () => initiateCrossCurrencyTransfer({
                        account_id: treasury.nuvionAccountId, payment_detail_id: paymentDetailNuvionId,
                        counterparty_id: counterpartyId, fx_quote_id: freshQuote.id!, narration,
                        payment_type: paymentMethod.paymentMethod as any, unique_reference: sharedReference,
                    }), 'cross-currency transfer (retry with fresh quote)'
                );

                if (!retryAttempt.success) throw transferFailure(retryAttempt);
                nuvionTransferId = (retryAttempt.result as any).id;
                realFee = (retryAttempt.result as any).applicable_fee ?? 0;
            } else {
                if (!transferAttempt.success) throw transferFailure(transferAttempt);
                nuvionTransferId = (transferAttempt.result as any).id;
                realFee = (transferAttempt.result as any).applicable_fee ?? 0;
            }
        } else {
            const transferAttempt = await withBoundedRetry(
                () => initiateSameCurrencyTransfer({
                    account_id: treasury.nuvionAccountId, payment_detail_id: paymentDetailNuvionId,
                    counterparty_id: counterpartyId, amount: decimalAmount.toNumber(),
                    currency: nuvionCurrencyCode,
                    narration, payment_type: paymentMethod.paymentMethod as any, unique_reference: sharedReference,
                }), 'same-currency transfer'
            );
            if (!transferAttempt.success) throw transferFailure(transferAttempt);
            nuvionTransferId = (transferAttempt.result as any).id;
            realFee = (transferAttempt.result as any).applicable_fee ?? 0;
        }

        const realFeeUsd = toDecimal(realFee);
        const estimatedFeeUsd = toDecimal(transferRequest.estimatedFeeUsd ?? 0);

        if (realFeeUsd.lt(estimatedFeeUsd)) {
            const refundAmount = estimatedFeeUsd.minus(realFeeUsd);
            const txn = await prisma.virtualTransaction.findUnique({ where: { id: transactionId } });
            if (txn?.fromAccountId) {
                await prisma.virtualAccount.update({
                    where: { id: txn.fromAccountId },
                    data: { available: { increment: refundAmount } as any, frozen: { decrement: refundAmount } as any },
                });
                await prisma.block.update({ where: { id: blockId }, data: { amount: { decrement: refundAmount } as any } });
                logger.info(`[NuvionPayout] Fee reconciliation — estimated $${estimatedFeeUsd}, actual $${realFeeUsd}, refunded $${refundAmount} to user`);
            }
        } else if (realFeeUsd.gt(estimatedFeeUsd)) {
            logger.error(`[NUVION FEE UNDERESTIMATE] TransferRequest ${transferRequestId} — estimated $${estimatedFeeUsd}, actual $${realFeeUsd}. Vyre absorbing the ${realFeeUsd.minus(estimatedFeeUsd)} difference.`);
        }

        await prisma.transferRequest.update({
            where: { id: transferRequestId },
            data: {
                status: 'PROCESSING', reference: nuvionTransferId,
                nuvionFxQuoteId: fxQuoteId, nuvionFxRate: fxRate ? toDecimal(fxRate) : undefined,
                actualFeeUsd: realFeeUsd,
            } as any,
        });

        // pendingManualTopupUsd is NOT touched here any more.
        //
        // It moved to scheduleReplenishmentForPayout, which runs when the
        // payout actually COMPLETES and only for amounts below the chain
        // threshold. Two reasons:
        //   - incrementing here as well would double count, since above-
        //     threshold payouts are replenished automatically instead
        //   - this ran at SUBMISSION, so a payout that later failed was
        //     counted and never backed out, over-reporting the figure

    } catch (error: any) {
        // Nuvion refused the reference because it has seen it before, which means
        // an earlier attempt DID get through and we lost the answer. Failing here
        // would release the hold and refund the user while Nuvion pays the
        // recipient. The webhook already decides both outcomes: outflows.completed
        // commits, outflows.failed releases the funds back to the user. So just
        // mark it PROCESSING and let the webhook be the authority.
        if (error?.alreadyAtNuvion) {
            // updateMany, not update: the webhook may have landed already while
            // this job was still retrying. Only a request still PENDING moves.
            const moved = await prisma.transferRequest.updateMany({
                where: { id: transferRequestId, status: 'PENDING' },
                data: { status: 'PROCESSING' },
            });

            // No counter increment here either, for the same reason as above:
            // completion decides, not submission.

            logger.warn(
                `[NuvionPayout] TransferRequest ${transferRequestId}: Nuvion already has reference ${sharedReference}, ` +
                `so the transfer EXISTS. ${moved.count === 1 ? 'Marked PROCESSING' : 'The webhook already moved it'}; ` +
                `the outflows webhook will complete it or release the funds.`,
            );
            return;
        }

        await failPayout({ transferRequestId, transactionId, blockId, isCryptoSourced }, error.message);
    }
}

async function failPayout(jobData: { transferRequestId: string; transactionId: string; blockId: string; isCryptoSourced?: boolean }, reason: string) {
    const { transferRequestId, transactionId, blockId, isCryptoSourced } = jobData;

    // UNIFIED — both paths now call a "fail the block" function with the
    // exact same shape, just a different underlying function depending
    // on which rail sourced the payout.
    let failedAccount;

    if (isCryptoSourced) {
        const failed = await virtualAccountService.failGlobalPayoutBlock({ transactionId, blockId, reason });
        const transaction = await prisma.virtualTransaction.findUnique({ where: { id: transactionId } });
        failedAccount = transaction?.fromAccountId
            ? await prisma.virtualAccount.findUnique({ where: { id: transaction.fromAccountId } })
            : null;
    } else {
        const failed = await virtualAccountService.failBankWithdrawal({ transactionId, blockId, reason });
        failedAccount = failed.fromAccountId
            ? await prisma.virtualAccount.findUnique({ where: { id: failed.fromAccountId } })
            : null;
    }

    // Only the call that actually flips the status restores the float, so it
    // can never be restored twice if this is reached more than once.
    const marked = await prisma.transferRequest.updateMany({
        where: { id: transferRequestId, status: { not: 'FAILED' } },
        data: { status: 'FAILED', errorMessage: reason },
    });
    if (isCryptoSourced && marked.count === 1) await restoreTreasuryFloat(transactionId);

    if (failedAccount) {
        await notificationService.queue({
            userId: failedAccount.userId, title: 'Transfer unsuccessful', type: 'GENERAL',
            content: `Your transfer could not be completed. The funds have been returned to your balance. Please try again or contact support.`,
        });
    }

    logger.error(`[NuvionPayout] TransferRequest ${transferRequestId} failed at submission`, { error: reason, isCryptoSourced });
}

// nuvionPayout.service.ts — new shared function, extracted from what
// was previously inline inside processNuvionPayoutJob's try block.

export async function ensureNuvionCounterpartyAndPaymentDetail(
    beneficiary: any,
    paymentMethod: any
): Promise<{ counterpartyId: string; paymentDetailNuvionId: string }> {
    let counterpartyId = beneficiary.nuvionCounterpartyId;

    if (!counterpartyId) {
        const accountName = (beneficiary.bank as any)?.accountName as string;
        if (!accountName) throw new Error('Beneficiary has no registered name');
        const [firstName, ...lastNameParts] = accountName.trim().split(' ');
        const lastName = lastNameParts.join(' ') || firstName;

        // Both person-level fields go through their helpers, so the rules —
        // real value always wins, placeholder only on the African rails, never
        // a missing key — hold identically for each.
        const emailBlock = counterpartyEmailFor(beneficiary, paymentMethod.currency);
        if (!emailBlock) {
            throw new Error('This recipient needs an email address for payouts in ' + paymentMethod.currency);
        }

        const profile: any = {
            first_name: firstName, last_name: lastName, relationship: 'vendor',
            email: emailBlock.email,
        };
        // Built in one place now — counterpartyAddressFor() prefers a real
        // recipient address, falls back to Vyre's placeholder on the African
        // rails, and omits every empty key rather than letting
        // JSON.stringify silently drop it. That dropped-key bug is why every
        // counterparty created here went to Nuvion with no postal code for
        // weeks, from a misspelled column name.
        const addressBlock = counterpartyAddressFor(beneficiary, paymentMethod.currency);
        if (addressBlock) profile.address = addressBlock.address;

        const counterparty = await createCounterparty({
            type: 'individual',
            profile,
        });

        // NEW — read Nuvion's answer instead of maintaining a table of what
        // each country needs. A required-field refusal names the fields, so
        // it is recorded against this corridor and the next person who pays
        // into it is asked for them up front. See nuvionRequirements.ts.
        const corridor = {
            country: beneficiary.nuvionRecipientCountry,
            currency: paymentMethod.currency,
            paymentMethod: paymentMethod.paymentMethod,
        };

        if (!counterparty.success || !counterparty.id) {
            const missing = missingFieldsFrom(counterparty.rawData);
            if (missing.length) {
                learnRequirements(corridor, missing.map((m) => m.field));
                logger.warn('[NuvionPayout] Nuvion wants fields we did not send', {
                    corridor, fields: missing.map((m) => m.nuvionPath),
                });
                // The field names travel with the error so a caller can ask
                // for exactly those rather than showing "payout failed".
                throw Object.assign(
                    new Error(`This recipient needs: ${missing.map((m) => m.field).join(', ')}`),
                    { needsFields: missing.map((m) => m.field), rawData: counterparty.rawData },
                );
            }
            throw Object.assign(
                new Error(`Failed to create Nuvion counterparty: ${counterparty.error}`),
                { rawData: counterparty.rawData },
            );
        }

        // A set that worked is recorded as sufficient — never as minimal. One
        // success proves nothing about the fields we happened to include.
        //
        // Records only what the USER had to supply. A placeholder address is a
        // requirement we satisfied ourselves, and recording it here would be
        // actively harmful: confirmRequirements seeds a corridor it has not
        // seen before, requirementsFor then returns those fields, and the
        // frontend would start demanding an address again on the very rails
        // this change exists to stop asking about — re-learned from our own
        // placeholder on the first successful African payout.
        confirmRequirements(corridor, [
            ...(addressBlock?.userSupplied
                ? Object.keys(addressBlock.address).map((k) => `address.${k}`)
                : []),
            ...(emailBlock.userSupplied ? ['email'] : []),
        ]);

        counterpartyId = counterparty.id;
        await prisma.beneficiary.update({ where: { id: beneficiary.id }, data: { nuvionCounterpartyId: counterpartyId } });
    }

    let paymentDetailNuvionId = paymentMethod.nuvionPaymentDetailId;

    if (!paymentDetailNuvionId) {
        // Country is the BANK's country, not the beneficiary's own
        // residence — GBP/USD map to their known single country;
        // everything else falls back to bankAddressCountry, then the
        // beneficiary's own country (correct for African bank-code
        // markets, where the bank IS in the recipient's own country).
        // From Nuvion's own rail table now, which fixes the country for 20-odd
        // currencies rather than special-casing two. Falls back to the bank's
        // own address, then the recipient's country — correct for the African
        // bank-code markets, where the bank IS in the recipient's country.
        const bankCountry =
            bankCountryFor(paymentMethod.currency, paymentMethod.scheme, paymentMethod.paymentMethod) ||
            paymentMethod.bankAddressCountry ||
            beneficiary.nuvionRecipientCountry!;

        const basePayload = {
            payment_method: paymentMethod.paymentMethod,
            currency: paymentMethod.currency,
            account_holder_name: paymentMethod.accountName ?? (beneficiary.bank as any)?.accountName,
            counterparty_id: counterpartyId,
            country: bankCountry,
        };

        let railPayload: Record<string, any> = {};

        // The scheme Nuvion should receive. Sent even where Nuvion does not
        // require it — a currency with one rail — because that is what makes
        // the fee estimate land on the right row. NGN's rail is `nip`, and
        // NUVION_FEE_ESTIMATES_USD.nip is 0.5 against a `default` of 7: the
        // reason every Naira payout has been quoted ~$7 and refunded ~$6.96 is
        // that nothing ever set this.
        const scheme = schemeToSend(paymentMethod.currency, paymentMethod.scheme, paymentMethod.paymentMethod);
        if (paymentMethod.scheme && !VALID_SCHEMES.has(paymentMethod.scheme)) {
            // Refuse an unrecognised scheme here rather than letting Nuvion do
            // it: our message can name the field, theirs names a type code.
            throw new Error(`"${paymentMethod.scheme}" is not a payment scheme Nuvion accepts`);
        }

        switch (paymentMethod.paymentMethod) {
            case 'book-transfer':
                railPayload = { account_number: String(paymentMethod.accountNumber) };
                break;
            case 'momo-transfer':
                // scheme here is the NETWORK (mpesa, mtn, airtel, …), and the
                // phone number is the destination.
                railPayload = { scheme, phone_number: paymentMethod.accountNumber };
                break;
            case 'stablecoin-transfer':
                railPayload = { blockchain_network: paymentMethod.bankCode, wallet_address: paymentMethod.accountNumber };
                break;
            case 'bank-transfer':
            default:
                railPayload = {
                    // CAD interac_email is the one rail with NO account
                    // number at all — an email address is the destination.
                    // CAD interac_email: an email address IS the destination,
                    // and Nuvion wants it as `email`. It is stored in
                    // accountNumber because that column is NOT NULL and the
                    // email is this rail's account identifier — the same
                    // reasoning as putting an IBAN there.
                    ...(paymentMethod.scheme === 'interac_email'
                        ? { email: String(paymentMethod.accountNumber) }
                        : { account_number: String(paymentMethod.accountNumber) }),
                    scheme,
                    ...(paymentMethod.accountType && { account_type: paymentMethod.accountType }),
                    ...(paymentMethod.bankName && { bank_name: paymentMethod.bankName }),
                    ...(paymentMethod.bankCode && { bank_code: paymentMethod.bankCode }),
                    ...(paymentMethod.swiftCode && { swift_bic: paymentMethod.swiftCode }),
                    ...(paymentMethod.iban && { iban: paymentMethod.iban }),
                    ...(paymentMethod.routingNumber && { routing_number: paymentMethod.routingNumber }),
                    ...(paymentMethod.sortCode && { sort_code: paymentMethod.sortCode }),
                    // NEW, from Nuvion's rail table. These had no column and no
                    // payload key before it arrived, so AUD, CAD and HKD could
                    // not have worked at all:
                    //   branch_code              AUD BECS, HKD CHATS
                    //   bank_institution_number  CAD, 3 digits
                    //   transit_number           CAD, 5 digits
                    ...((paymentMethod as any).branchCode && { branch_code: (paymentMethod as any).branchCode }),
                    ...((paymentMethod as any).institutionNumber && { bank_institution_number: (paymentMethod as any).institutionNumber }),
                    ...((paymentMethod as any).transitNumber && { transit_number: (paymentMethod as any).transitNumber }),
                    ...(paymentMethod.bankAddressLine1 && {
                        bank_address: {
                            line1: paymentMethod.bankAddressLine1, city: paymentMethod.bankAddressCity,
                            state: paymentMethod.bankAddressState, postal_code: paymentMethod.bankAddressPostal,
                            country: paymentMethod.bankAddressCountry,
                        },
                    }),
                };
                break;
        }

        const paymentDetail = await createPaymentDetail({ ...basePayload, ...railPayload } as any);

        if (!paymentDetail.success) {
            // Self-healing fallback — if this failed specifically
            // because a payment detail with this account number already
            // exists (partial-failure retry, or a race between
            // concurrent requests), find the real one and link to it
            // instead of failing outright.
            const isDuplicate = (paymentDetail.rawData?.validations ?? []).some(
                (v: any) => Object.values(v)[0] && (Object.values(v)[0] as any).type === 'error_duplicate_resource'
            );

            if (isDuplicate) {
                logger.warn(`[NuvionPayout] Payment detail creation hit a duplicate for account ${paymentMethod.accountNumber} — looking up the existing one instead of failing.`);

                const list = await listCounterpartyPaymentDetails(counterpartyId);
                const existing = list.success
                    ? list.paymentDetails?.find((pd: any) => pd.account_number === String(paymentMethod.accountNumber))
                    : null;

                if (existing) {
                    paymentDetailNuvionId = existing.id;
                    await prisma.beneficiaryPaymentDetail.update({ where: { id: paymentMethod.id }, data: { nuvionPaymentDetailId: paymentDetailNuvionId } });
                    logger.info(`[NuvionPayout] Self-healed — linked to existing payment detail ${paymentDetailNuvionId}`);
                } else {
                    throw Object.assign(new Error(`Payment detail creation reported a duplicate, but no matching existing record was found for account ${paymentMethod.accountNumber}`), { rawData: paymentDetail.rawData });
                }
            } else {
                // Same learning path for the ACCOUNT fields, which differ by
                // rail far more than the person fields do.
                const missing = missingFieldsFrom(paymentDetail.rawData);
                if (missing.length) {
                    learnRequirements(
                        { country: beneficiary.nuvionRecipientCountry, currency: paymentMethod.currency, paymentMethod: paymentMethod.paymentMethod },
                        missing.map((m) => m.field),
                    );
                    throw Object.assign(
                        new Error(`This account needs: ${missing.map((m) => m.field).join(', ')}`),
                        { needsFields: missing.map((m) => m.field), rawData: paymentDetail.rawData },
                    );
                }

                // NOT a missing field — a wrong one. The most common is an
                // account number Nuvion will not accept for that bank code,
                // which deserves its own message rather than "payout failed":
                // it is the single most useful error in the whole flow.
                const invalidAccount = (paymentDetail.rawData?.validations ?? []).some(
                    (v: any) => (Object.values(v ?? {})[0] as any)?.type === 'error_counterparty_account_number_invalid',
                );
                if (invalidAccount) {
                    throw Object.assign(
                        new Error("That account number isn't valid for that bank. Please check both and try again."),
                        { invalidAccountNumber: true, rawData: paymentDetail.rawData },
                    );
                }

                throw Object.assign(new Error(`Failed to create Nuvion payment detail: ${paymentDetail.error}`), { rawData: paymentDetail.rawData });
            }
        } else {
            paymentDetailNuvionId = paymentDetail.id!;
            await prisma.beneficiaryPaymentDetail.update({ where: { id: paymentMethod.id }, data: { nuvionPaymentDetailId: paymentDetailNuvionId } });
        }
    }

    return { counterpartyId, paymentDetailNuvionId };
}

// Gives back the float a payout had reserved. blockCryptoPayout takes
// amount + Nuvion fee off lastKnownAvailable the moment it freezes the user's
// funds, and nothing ever put it back when the payout then failed, so the
// estimate drifted lower with every failure.
//
// The caller must make sure it only runs once per payout (see failPayout,
// which only calls it for the request that actually flipped the status).
//
// For a payout that fails LATER, at the outflows.failed webhook rather than at
// submission, re-sync the treasury from Nuvion instead of calling this: a
// re-sync is idempotent, while a second call here would invent float.
export async function restoreTreasuryFloat(transactionId: string) {
  const txn = await prisma.virtualTransaction.findUnique({ where: { id: transactionId } });
  const meta = txn?.metadata as any;
  if (!meta?.treasuryAccountId) return;

  const draw = toDecimal(meta.sendAmount ?? 0).plus(toDecimal(meta.estimatedNuvionFee ?? 0));
  if (draw.lte(0)) return;

  await prisma.nuvionTreasuryAccount.update({
    where: { id: meta.treasuryAccountId },
    data: { lastKnownAvailable: { increment: draw } as any },
  });
  logger.info(`[NuvionPayout] Restored $${draw.toString()} of reserved float to treasury ${meta.treasuryAccountId}`);
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 — treasury replenishment.
//
// The handler itself now lives in treasuryReplenishment.service.ts, where it
// has the state machine, the atomic claim that stops a double send, the
// three-way failure classification and the sweeper. It is re-exported at the
// top of this file, so general.worker.ts keeps importing it from here.
//
// scheduleReplenishmentForPayout, below, is what outflows.completed calls.
// ═══════════════════════════════════════════════════════════════════════

// ── Legacy, superseded ──────────────────────────────────────────────────
// failSubmission and releaseAndFail predate the block mechanism. failPayout
// above replaced both. Nothing calls them; kept for reference.

async function failSubmission(transferRequestId: string, transactionId: string, blockId: string, reason: string) {
    const failed = await virtualAccountService.failBankWithdrawal({ transactionId, blockId, reason });

    await prisma.transferRequest.update({
        where: { id: transferRequestId },
        data: { status: 'FAILED', errorMessage: reason },
    });

    const account = await prisma.virtualAccount.findUnique({ where: { id: failed.fromAccountId! } });
    if (account) {
        await notificationService.queue({
            userId: account.userId,
            title: 'Transfer unsuccessful',
            type: 'GENERAL',
            content: `Your ${failed.currency} ${failed.amount} transfer could not be completed. The funds have been returned to your balance. Please try again or contact support.`,
        });
    }

    logger.error(`[NuvionPayout] TransferRequest ${transferRequestId} failed at submission, block released`, { error: reason });
}

async function releaseAndFail(transferRequestId: string, userId: string, currency: string, amount: any, errorMessage: string) {
    await prisma.$transaction(async (tx) => {
        const account = await tx.virtualAccount.findFirst({ where: { userId, currency } });
        if (account) {
            await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${account.id} FOR UPDATE`;
            await tx.virtualAccount.update({
                where: { id: account.id },
                data: { frozen: { decrement: amount }, available: { increment: amount } },
            });
        }
        await tx.transferRequest.update({
            where: { id: transferRequestId },
            data: { status: 'FAILED', errorMessage },
        });
    }, { isolationLevel: 'Serializable' });

    logger.error(`[NuvionPayout] Transfer ${transferRequestId} failed, block released`, { error: errorMessage });
}

// ── Legacy entry point, pre-block design ────────────────────────────────
// Superseded by blockNuvionPayout + processNuvionPayoutJob. The controller
// imports it but never calls it, and no TransferRequest in the database has
// its shape (type BANK with payoutProvider NUVION and no VirtualTransaction).
//
// Kept and corrected rather than deleted. Two fixes applied, so that if it is
// ever called it behaves like the live path rather than failing:
//   - currencyId was being set to an ISO code ('USD') on a column that is a
//     foreign key to Currency.id, which throws on create
//   - the two transfer attempts threw a bare Error, so a duplicate-reference
//     409 released the user's funds while Nuvion paid the recipient
//
// It still debits the user before the webhook confirms, and creates no
// VirtualTransaction, so outflows.completed cannot complete anything it
// creates. Use blockNuvionPayout instead.
export async function initiateNuvionPayout(params: InitiatePayoutParams) {
    const { userId, beneficiaryId, paymentDetailId, fromCurrency, amount, narration } = params;
    const decimalAmount = toDecimal(amount);

    if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');

    const treasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: fromCurrency, isActive: true },
    });
    if (!treasury) throw new Error(`No active Nuvion treasury account configured for ${fromCurrency}`);

    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary || beneficiary.userId !== userId) {
        throw new Error('Beneficiary not found or does not belong to this user');
    }

    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
    if (!paymentMethod || paymentMethod.beneficiaryId !== beneficiaryId) {
        throw new Error('Payment method not found for this beneficiary');
    }

    // FIXED — currencyId is a foreign key to Currency.id, not an ISO code.
    // Setting it to fromCurrency ('USD') threw a foreign-key violation on the
    // create below, before Nuvion was ever contacted.
    const vyreCurrency = await prisma.currency.findFirst({ where: { ISO: fromCurrency } });
    if (!vyreCurrency) throw new Error(`No Vyre Currency record found for ${fromCurrency}`);

    // toCurrency DERIVED from the selected payment method — no separate
    // input, no chance of a mismatch between the selected account and
    // the currency actually requested.
    const toCurrency = paymentMethod.currency;
    const isCrossCurrency = fromCurrency !== toCurrency;

    let counterpartyId = beneficiary.nuvionCounterpartyId; // ONE per beneficiary — identity, shared across all their payment methods
    let paymentDetailNuvionId = paymentMethod.nuvionPaymentDetailId; // per PAYMENT METHOD, not per beneficiary

    // Counterparty (identity) — create once per beneficiary, regardless
    // of how many payment methods they end up having.
    if (!counterpartyId) {
        if (!beneficiary.nuvionRecipientCountry) {
            throw new Error('This beneficiary is missing required details (country) — please complete their profile before sending a payout');
        }
        // Address and email both go through the same helpers as the main path,
        // so the African placeholders apply here too. This legacy function is
        // still reachable, and leaving it on the old guards would mean a
        // beneficiary who can be paid through one path is refused through the
        // other.
        const legacyAddress = counterpartyAddressFor(beneficiary, paymentMethod.currency);
        if (!legacyAddress) {
            throw new Error('This beneficiary needs a full address for payouts in ' + paymentMethod.currency);
        }
        const legacyEmail = counterpartyEmailFor(beneficiary, paymentMethod.currency);
        if (!legacyEmail) {
            throw new Error('This beneficiary needs an email address for payouts in ' + paymentMethod.currency);
        }
        if (!(beneficiary.bank as any)?.accountName) {
            throw new Error('Beneficiary has no registered name — cannot create Nuvion counterparty');
        }

        const accountName = (beneficiary.bank as any).accountName as string;
        const [firstName, ...lastNameParts] = accountName.trim().split(' ');
        const lastName = lastNameParts.join(' ') || firstName;

        const counterparty = await createCounterparty({
            type: 'individual',
            profile: {
                first_name: firstName,
                last_name: lastName,
                relationship: 'vendor',
                email: legacyEmail.email,
                // Was four non-null assertions over three nullable columns —
                // `!` silences the compiler without making the value present,
                // so a missing state or postal went out as undefined and was
                // dropped by JSON.stringify.
                address: legacyAddress.address,
            },
        });
        if (!counterparty.success || !counterparty.id) {
            throw new Error(`Failed to create Nuvion counterparty: ${counterparty.error}`);
        }

        counterpartyId = counterparty.id;
        await prisma.beneficiary.update({ where: { id: beneficiary.id }, data: { nuvionCounterpartyId: counterpartyId } });
    }

    // Payment detail — create once per PAYMENT METHOD (not per
    // beneficiary), since each one is a genuinely distinct Nuvion object.
    if (!paymentDetailNuvionId) {
        if (!paymentMethod.accountNumber) {
            throw new Error('This payment method has no account number set');
        }

        const paymentDetail = await createPaymentDetail({
            payment_method: 'bank-transfer',
            currency: toCurrency,
            account_holder_name: paymentMethod.accountName ?? (beneficiary.bank as any)?.accountName,
            counterparty_id: counterpartyId,
            country: beneficiary.nuvionRecipientCountry!,
            account_number: String(paymentMethod.accountNumber),
            ...(paymentMethod.bankName && { bank_name: paymentMethod.bankName }),
            ...(paymentMethod.bankCode && { bank_code: paymentMethod.bankCode }),
            ...(paymentMethod.swiftCode && { swift_bic: paymentMethod.swiftCode }),
            ...(paymentMethod.iban && { iban: paymentMethod.iban }),
            ...(paymentMethod.routingNumber && { routing_number: paymentMethod.routingNumber }),
            ...(paymentMethod.sortCode && { sort_code: paymentMethod.sortCode }),
        } as any);
        if (!paymentDetail.success || !paymentDetail.id) {
            throw new Error(`Failed to create Nuvion payment detail: ${paymentDetail.error}`);
        }

        paymentDetailNuvionId = paymentDetail.id;
        await prisma.beneficiaryPaymentDetail.update({
            where: { id: paymentMethod.id },
            data: { nuvionPaymentDetailId: paymentDetailNuvionId },
        });
    }

    // ── Everything below is UNCHANGED in shape — block-then-commit-or-
    // reverse, retry logic, cross/same-currency branching. Just now
    // referencing paymentDetailNuvionId instead of a beneficiary-level id. ──

    const idempotencyKey = generateRef('NVPAY');

    const { transferRequest, virtualAccountId } = await prisma.$transaction(async (tx) => {
        const account = await tx.virtualAccount.findFirst({ where: { userId, currency: fromCurrency } });
        if (!account) throw new Error(`No ${fromCurrency} account found for this user`);

        await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${account.id} FOR UPDATE`;

        const fresh = await tx.virtualAccount.findUnique({ where: { id: account.id } });
        if (toDecimal(fresh!.available).lt(decimalAmount)) throw new Error('Insufficient balance');

        const transferRequest = await tx.transferRequest.create({
            data: {
                idempotencyKey,
                type: 'BANK',
                bank: beneficiary.bank ?? undefined,
                currencyId: vyreCurrency.id, // FIXED — was fromCurrency, an ISO code on an id column
                amount: decimalAmount,
                userId,
                status: 'PENDING',
                payoutProvider: 'NUVION',
            },
        });

        await tx.virtualAccount.update({
            where: { id: account.id },
            data: { frozen: { increment: decimalAmount }, available: { decrement: decimalAmount } },
        });

        return { transferRequest, virtualAccountId: account.id };
    }, { isolationLevel: 'Serializable' });

    try {
        let nuvionTransferId: string;
        let fxQuoteId: string | undefined;
        let fxRate: number | undefined;

        if (isCrossCurrency) {
            const quote = await createFxQuote({
                to_currency: toCurrency,
                from_currency: fromCurrency,
                amount_from: decimalAmount.toNumber(),
                account_id: treasury.nuvionAccountId,
                counterparty_id: counterpartyId,
                payment_detail_id: paymentDetailNuvionId,
            });
            if (!quote.success || !quote.id) {
                throw Object.assign(new Error(quote.error ?? 'FX quote failed'), { httpStatus: quote.httpStatus });
            }
            fxQuoteId = quote.id;
            fxRate = quote.rate;

            const transferAttempt = await withBoundedRetry(
                () => initiateCrossCurrencyTransfer({
                    account_id: treasury.nuvionAccountId,
                    payment_detail_id: paymentDetailNuvionId!,
                    counterparty_id: counterpartyId!,
                    fx_quote_id: quote.id!,
                    narration,
                    payment_type: 'bank-transfer',
                    unique_reference: idempotencyKey,
                }),
                'cross-currency transfer'
            );
            // FIXED — was `throw new Error(transferAttempt.error)`, which lost
            // the duplicate-reference signal and let the catch below refund a
            // user whose recipient Nuvion was about to pay.
            if (!transferAttempt.success) throw transferFailure(transferAttempt);
            nuvionTransferId = (transferAttempt.result as any).id;

        } else {
            const transferAttempt = await withBoundedRetry(
                () => initiateSameCurrencyTransfer({
                    account_id: treasury.nuvionAccountId,
                    payment_detail_id: paymentDetailNuvionId!,
                    counterparty_id: counterpartyId!,
                    amount: decimalAmount.toNumber(),
                    currency: fromCurrency,
                    narration,
                    payment_type: 'bank-transfer',
                    unique_reference: idempotencyKey,
                }),
                'same-currency transfer'
            );
            if (!transferAttempt.success) throw transferFailure(transferAttempt);
            nuvionTransferId = (transferAttempt.result as any).id;
        }

        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${virtualAccountId} FOR UPDATE`;
            await tx.virtualAccount.update({
                where: { id: virtualAccountId },
                data: { balance: { decrement: decimalAmount }, frozen: { decrement: decimalAmount } },
            });
            await tx.transferRequest.update({
                where: { id: transferRequest.id },
                data: {
                    status: 'PROCESSING',
                    reference: nuvionTransferId,
                    nuvionFxQuoteId: fxQuoteId,
                    nuvionFxRate: fxRate ? toDecimal(fxRate) : undefined,
                },
            });
        }, { isolationLevel: 'Serializable' });

        logger.info(`[NuvionPayout] Transfer ${transferRequest.id} succeeded — Nuvion transfer ${nuvionTransferId}`);
        return { success: true, transferRequestId: transferRequest.id, nuvionTransferId };

    } catch (error: any) {
        // FIXED — a duplicate-reference refusal means the transfer EXISTS at
        // Nuvion. Releasing the funds here would refund the user while the
        // recipient gets paid. Leave the hold in place and mark it PROCESSING.
        if (error?.alreadyAtNuvion) {
            await prisma.transferRequest.updateMany({
                where: { id: transferRequest.id, status: 'PENDING' },
                data: { status: 'PROCESSING' },
            });
            logger.warn(
                `[NuvionPayout] Transfer ${transferRequest.id}: Nuvion already has reference ${idempotencyKey}, ` +
                'so the transfer EXISTS. Marked PROCESSING, funds left frozen.',
            );
            return { success: true, transferRequestId: transferRequest.id, nuvionTransferId: undefined };
        }

        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${virtualAccountId} FOR UPDATE`;
            await tx.virtualAccount.update({
                where: { id: virtualAccountId },
                data: { frozen: { decrement: decimalAmount }, available: { increment: decimalAmount } },
            });
            await tx.transferRequest.update({
                where: { id: transferRequest.id },
                data: { status: 'FAILED', errorMessage: error.message },
            });
        }, { isolationLevel: 'Serializable' });

        logger.error(`[NuvionPayout] Transfer ${transferRequest.id} failed, block released`, { error: error.message });
        throw new Error(`Nuvion payout failed: ${error.message}`);
    }
}

export const NUVION_FEE_ESTIMATES_USD: Record<string, number> = {
    wire: 5,              // CONFIRMED — real $5 fee, same-currency USD Wire
    fps: 6.9,             // CONFIRMED — real $6.90 fee, but specifically CROSS-CURRENCY (USD→GBP). May differ for same-currency GBP FPS if ever tested.
    ach: 3,                // ⚠️ still unconfirmed
    rtp: 3,                // ⚠️ unconfirmed — and this specific routing number is blocked regardless
    sepa: 1,                // ⚠️ unconfirmed
    swift: 15,              // ⚠️ unconfirmed, and confirmed unusable for US-addressed banks specifically
    nip: 0.5,               // ⚠️ unconfirmed
    'book-transfer': 0,     // CONFIRMED — real 0 fee, measured 8 Oct on a USC→USD book transfer
    default: 7,              // CHANGED — raised from 5 to 7, since our one other confirmed cross-currency data point ($6.90) came in well above the old default
};

export function estimateNuvionFee(scheme: string | null | undefined): number {
    if (!scheme) return NUVION_FEE_ESTIMATES_USD.default;
    return NUVION_FEE_ESTIMATES_USD[scheme] ?? NUVION_FEE_ESTIMATES_USD.default;
}

// Called from outflows.completed, for a CRYPTO payout, right after it commits
// the hold and marks the request COMPLETED.
//
// The user is debited by now and the recipient has been paid from the USD
// treasury, so NOTHING here may throw: a problem must never make the webhook
// retry a payout that succeeded.
//
// Three outcomes:
//   - big enough, and the pair is supported  -> a replenishment request is created and queued
//   - below the chain threshold              -> pendingManualTopupUsd instead, nothing sent
//   - the pair has no treasury               -> recorded as blocked and ops told
export async function scheduleReplenishmentForPayout(transferRequestId: string) {
  try {
    const tr: any = await prisma.transferRequest.findUnique({ where: { id: transferRequestId } });
    if (!tr) return;

    const txn = await prisma.virtualTransaction.findFirst({ where: { reference: tr.idempotencyKey } });
    const meta = txn?.metadata as any;

    const usdTreasuryAccountId: string | undefined = meta?.treasuryAccountId;
    const cryptoCurrencyId: string | undefined = meta?.cryptoCurrencyId;

    if (!usdTreasuryAccountId || !cryptoCurrencyId) {
      await flagReplenishmentBlocked(transferRequestId, 'The payout transaction records no treasury or crypto currency', {
        usdTreasuryAccountId: usdTreasuryAccountId ?? 'missing',
        cryptoCurrencyId: cryptoCurrencyId ?? 'missing',
      });
      return;
    }

    const cryptoCurrency: any = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
    if (!cryptoCurrency) {
      await flagReplenishmentBlocked(transferRequestId, 'Could not find the crypto currency that was frozen', { cryptoCurrencyId });
      return;
    }

    // What the treasury is owed: what the recipient got, plus what Nuvion
    // actually charged. Vyre's own fee stays with Vyre.
    const amount = toDecimal(tr.amount).plus(toDecimal(tr.actualFeeUsd ?? tr.estimatedFeeUsd ?? 0));

    // ── Is it worth sending on its own? ──
    // Below the chain's threshold the gas can exceed the value, and
    // blockchain_Transfer refuses anything under the chain minimum anyway. The
    // crypto stays with the admin and the amount goes on the counter that
    // already drives manual top-ups, so nothing goes unaccounted for.
    const threshold = thresholdFor(cryptoCurrency.chain);
    if (amount.lt(threshold)) {
      await prisma.nuvionTreasuryAccount.update({
        where: { id: usdTreasuryAccountId },
        data: { pendingManualTopupUsd: { increment: amount } as any },
      });

      const updated = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: usdTreasuryAccountId } });
      const pending = toDecimal(updated?.pendingManualTopupUsd ?? 0);

      logger.info(
        `[Replenishment] ${transferRequestId}: ${amount} is below the ${threshold} threshold for ` +
        `${normaliseChain(cryptoCurrency.chain)}, so it goes on pendingManualTopupUsd instead of being sent. ` +
        `Pending now: $${pending.toString()}`,
      );

      if (pending.gte(toDecimal('1000'))) {
        logger.warn(`[NUVION MANUAL TOPUP NEEDED] USD treasury has $${pending.toString()} pending — please top up via Nuvion's dashboard using accumulated USDC/USDT.`);
      }
      return;
    }

    // ── Where it goes ──
    // From the static map, never a query that could match two rows or none.
    const target = await resolveTreasury(cryptoCurrency.ISO, cryptoCurrency.chain);
    if (!target.ok || !target.treasuryRowId || !target.address) {
      await flagReplenishmentBlocked(transferRequestId, target.reason ?? `Could not resolve a treasury for ${target.key}`, {
        pair: target.key, amount: amount.toString(), cryptoCurrencyId, usdTreasuryAccountId,
      });
      return;
    }

    await scheduleReplenishment({
      transferRequestId,
      replenishUserId: config.Admin_Id,          // holds the committed funds
      replenishCurrencyId: cryptoCurrencyId,
      treasuryAccountId: target.treasuryRowId,   // the stablecoin treasury row
      usdTreasuryAccountId,                      // the USD treasury this tops up
      treasuryWalletAddress: target.address,     // from the row, written by Nuvion's own webhook
      amount: amount.toString(),
      nuvionCurrency: toNuvionCurrencyCode(cryptoCurrency.ISO),
    });

    logger.info(`[Replenishment] ${transferRequestId}: queued ${amount} ${cryptoCurrency.ISO} to ${target.key} (${target.address})`);
  } catch (error: any) {
    await flagReplenishmentBlocked(transferRequestId, `Could not schedule: ${error?.message}`);
  }
}

export const VYRE_GLOBAL_PAYOUT_FEE = {
    percentage: 0.01, // 1% — placeholder, adjust to whatever Vyre's actual pricing is
    flatUsd: 1,        // $1 flat, added on top of the percentage
    minUsd: 2,         // never charge less than this, regardless of amount
    maxUsd: 25,        // cap, so a very large payout doesn't generate an absurd fee
};

export function calculateVyreFee(amount: string): number {
    const amountNum = Number(amount);
    const raw = amountNum * VYRE_GLOBAL_PAYOUT_FEE.percentage + VYRE_GLOBAL_PAYOUT_FEE.flatUsd;
    return Math.min(Math.max(raw, VYRE_GLOBAL_PAYOUT_FEE.minUsd), VYRE_GLOBAL_PAYOUT_FEE.maxUsd);
}