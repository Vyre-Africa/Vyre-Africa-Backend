import prisma from '../config/prisma.client';
import logger from '../config/logger';
// import { toDecimal, generateRef } from '../utils/decimal.util'; // same helpers used in virtualAccount.service.ts — adjust import path if these actually live elsewhere
import {
    createCounterparty,
    createPaymentDetail,
    createFxQuote,
    initiateSameCurrencyTransfer,
    initiateCrossCurrencyTransfer,
    getAccount,
} from './nuvion.service';
import { Decimal } from 'decimal.js';
import { ulid } from 'ulid';
import { generalQueue } from '../workers/general.worker';
import virtualAccountService from './virtualAccount.service';
import notificationService from './notification.service';
import walletService from './wallet.service';

// ── Retry policy ──────────────────────────────────────────────────────────
// Bounded retry ONLY for transient failures (timeout, 5xx, network error),
// using the IDENTICAL unique_reference (and fx_quote_id, for cross-
// currency) on every attempt — safe specifically because Nuvion's docs
// confirm /transfers is idempotent on unique_reference: "Resubmitting the
// same reference returns the original transfer rather than creating a
// duplicate." No new rate, no re-pricing, nothing the user didn't already
// see. The moment a quote expires or Nuvion gives a real rejection (not a
// timeout), retrying stops immediately.
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

function toDecimal(value: number | string | Decimal): Decimal {
    return new Decimal(value.toString());
}


function isTransientError(error: any): boolean {
    const httpStatus = error?.httpStatus;
    if (!httpStatus) return true;
    return httpStatus >= 500;
}

async function withBoundedRetry<T>(
    fn: () => Promise<{ success: boolean; error?: string; httpStatus?: number; [key: string]: any }>,
    context: string
): Promise<{ success: boolean; error?: string; result?: T }> {
    let lastError: any;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        const result = await fn();
        if (result.success) return { success: true, result: result as T };
        lastError = result;
        if (!isTransientError(result) || attempt === MAX_RETRY_ATTEMPTS) {
            logger.error(`[NuvionPayout] ${context} failed permanently after ${attempt} attempt(s)`, { error: result.error });
            return { success: false, error: result.error };
        }
        logger.warn(`[NuvionPayout] ${context} attempt ${attempt} failed transiently, retrying in ${RETRY_DELAY_MS}ms`, { error: result.error });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    return { success: false, error: lastError?.error ?? 'Unknown error after retries' };
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
 
    if (!beneficiary.nuvionRecipientCountry || !beneficiary.nuvionRecipientEmail || !beneficiary.nuvionRecipientAddressLine1) {
        throw new Error('This beneficiary is missing required details — please complete their profile before sending a payout');
    }
    if (!paymentMethod.accountNumber) throw new Error('This payment method has no account number set');
 
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
        metadata: { payoutProvider: 'NUVION', beneficiaryId, beneficiaryPaymentDetailId: paymentDetailId, narration },
    });
 
    const transferRequest = await prisma.transferRequest.create({
        data: {
            idempotencyKey: sharedReference, type: 'BANK', bank: beneficiary.bank ?? undefined,
            currencyId: fromCurrency, amount: transaction.amount, userId, status: 'PENDING',
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
 
export async function blockCryptoPayout(params: BlockCryptoPayoutParams): Promise<{ transferRequestId: string }> {
    const { userId, beneficiaryId, paymentDetailId, cryptoCurrencyId, amount, narration } = params;
 
    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary || beneficiary.userId !== userId) throw new Error('Beneficiary not found or does not belong to this user');
 
    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
    if (!paymentMethod || paymentMethod.beneficiaryId !== beneficiaryId) throw new Error('Payment method not found for this beneficiary');
 
    if (!beneficiary.nuvionRecipientCountry || !beneficiary.nuvionRecipientEmail || !beneficiary.nuvionRecipientAddressLine1) {
        throw new Error('This beneficiary is missing required details — please complete their profile before sending a payout');
    }
 
    const cryptoCurrency = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
    if (!cryptoCurrency) throw new Error('Unknown source currency');
 
    const nuvionStablecoinCode = cryptoCurrency.ISO === 'USDC' ? 'USC' : cryptoCurrency.ISO === 'USDT' ? 'UST' : null;
    if (!nuvionStablecoinCode) throw new Error(`${cryptoCurrency.ISO} is not supported for global payouts yet`);
 
    const nuvionChain = VYRE_TO_NUVION_CHAIN[cryptoCurrency.chain!];
    if (!nuvionChain) throw new Error(`${cryptoCurrency.chain} is not a supported chain for global payouts`);
 
    const wallet = await prisma.wallet.findFirst({ where: { userId, currencyId: cryptoCurrencyId } });
    if (!wallet) throw new Error('Wallet not found');
    if (toDecimal(wallet.availableBalance).lt(toDecimal(amount))) throw new Error('Insufficient balance');
 
    const treasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: nuvionStablecoinCode, isActive: true, chain: nuvionChain },
    });
    if (!treasury || !treasury.walletAddress) throw new Error(`No active treasury float for ${nuvionStablecoinCode} on ${cryptoCurrency.chain}`);
 
    if (!treasury.lastKnownAvailable || toDecimal(treasury.lastKnownAvailable).lt(toDecimal(amount))) {
        logger.error(`[NUVION FLOAT LOW] Treasury ${treasury.id} (${nuvionStablecoinCode}/${nuvionChain}) has insufficient float — lastKnownAvailable: ${treasury.lastKnownAvailable}`);
        throw new Error('This payout amount is temporarily unavailable — please try a smaller amount or try again shortly');
    }
 
    const sharedReference = generateRef('NVPAY');
 
    const transferRequest = await prisma.transferRequest.create({
        data: {
            idempotencyKey: sharedReference, type: 'CRYPTO',
            currencyId: nuvionStablecoinCode, amount: toDecimal(amount), userId, status: 'PENDING',
        } as any,
    });
 
    await prisma.nuvionTreasuryAccount.update({
        where: { id: treasury.id },
        data: { lastKnownAvailable: { decrement: toDecimal(amount) } as any },
    });
 
    await generalQueue.add('Nuvion_Payout_Process', {
        transferRequestId: transferRequest.id, sharedReference, narration, isCryptoSourced: true,
        beneficiaryId, beneficiaryPaymentDetailId: paymentDetailId,
        replenishUserId: userId, replenishCurrencyId: cryptoCurrencyId,
        treasuryAccountId: treasury.id, treasuryWalletAddress: treasury.walletAddress,
    });
 
    await notificationService.queue({
        userId, title: 'Transfer initiated', type: 'GENERAL',
        content: `Your ${amount} ${cryptoCurrency.ISO} transfer is being processed. We'll let you know once it's complete.`,
    });
 
    logger.info(`[NuvionPayout] Crypto payout queued (float-funded, no debit yet): TransferRequest ${transferRequest.id}`);
    return { transferRequestId: transferRequest.id };
}


// ═══════════════════════════════════════════════════════════════════════
// PHASE 2 — slow, runs in the background worker
// ═══════════════════════════════════════════════════════════════════════

export async function processNuvionPayoutJob(jobData: {
    transferRequestId: string; sharedReference: string; narration: string; isCryptoSourced?: boolean;
    transactionId?: string; blockId?: string; beneficiaryId?: string; beneficiaryPaymentDetailId?: string;
    replenishUserId?: string; replenishCurrencyId?: string;
    treasuryAccountId?: string; treasuryWalletAddress?: string;
}) {
    const { transferRequestId, sharedReference, narration, isCryptoSourced } = jobData;
 
    const transferRequest = await prisma.transferRequest.findUnique({ where: { id: transferRequestId } });
    if (!transferRequest) {
        logger.error(`[NuvionPayout] processNuvionPayoutJob — TransferRequest ${transferRequestId} not found`);
        return;
    }
    if (transferRequest.status !== 'PENDING') {
        logger.info(`[NuvionPayout] TransferRequest ${transferRequestId} already ${transferRequest.status} — skipping reprocess`);
        return;
    }
 
    let beneficiaryId: string | undefined;
    let beneficiaryPaymentDetailId: string | undefined;
 
    if (isCryptoSourced) {
        beneficiaryId = jobData.beneficiaryId;
        beneficiaryPaymentDetailId = jobData.beneficiaryPaymentDetailId;
    } else {
        const transaction = await prisma.virtualTransaction.findUnique({ where: { id: jobData.transactionId } });
        const meta = transaction?.metadata as any;
        beneficiaryId = meta?.beneficiaryId;
        beneficiaryPaymentDetailId = meta?.beneficiaryPaymentDetailId;
    }
 
    const beneficiary = beneficiaryId ? await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } }) : null;
    const paymentMethod = beneficiaryPaymentDetailId ? await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: beneficiaryPaymentDetailId } }) : null;
 
    if (!beneficiary || !paymentMethod) {
        await failPayout(jobData, 'Beneficiary or payment method record missing');
        return;
    }
 
    const toCurrency = paymentMethod.currency;
    const isCrossCurrency = transferRequest.currencyId !== toCurrency;
    const decimalAmount = toDecimal(transferRequest.amount);
 
    const treasury = isCryptoSourced
        ? await prisma.nuvionTreasuryAccount.findUnique({ where: { id: jobData.treasuryAccountId } })
        : await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: transferRequest.currencyId!, isActive: true } });
 
    if (!treasury) {
        await failPayout(jobData, 'Treasury account no longer active');
        return;
    }
 
    try {
        let counterpartyId = beneficiary.nuvionCounterpartyId;
        let paymentDetailNuvionId = paymentMethod.nuvionPaymentDetailId;
 
        if (!counterpartyId) {
            const accountName = (beneficiary.bank as any)?.accountName as string;
            if (!accountName) throw new Error('Beneficiary has no registered name');
            const [firstName, ...lastNameParts] = accountName.trim().split(' ');
            const lastName = lastNameParts.join(' ') || firstName;
 
            const counterparty = await createCounterparty({
                type: 'individual',
                profile: {
                    first_name: firstName, last_name: lastName, relationship: 'vendor',
                    email: beneficiary.nuvionRecipientEmail!,
                    address: {
                        line1: beneficiary.nuvionRecipientAddressLine1!, city: beneficiary.nuvionRecipientAddressCity!,
                        state_or_province: beneficiary.nuvionRecipientAddressState!, postal_code: beneficiary.nuvionRecipientAddressPostal!,
                        country: beneficiary.nuvionRecipientCountry!,
                    },
                },
            });
            if (!counterparty.success || !counterparty.id) throw new Error(`Failed to create Nuvion counterparty: ${counterparty.error}`);
            counterpartyId = counterparty.id;
            await prisma.beneficiary.update({ where: { id: beneficiary.id }, data: { nuvionCounterpartyId: counterpartyId } });
        }
 
        if (!paymentDetailNuvionId) {
            const paymentDetail = await createPaymentDetail({
                payment_method: 'bank-transfer', currency: toCurrency,
                account_holder_name: paymentMethod.accountName ?? (beneficiary.bank as any)?.accountName,
                counterparty_id: counterpartyId, country: beneficiary.nuvionRecipientCountry!,
                account_number: String(paymentMethod.accountNumber),
                ...(paymentMethod.bankName && { bank_name: paymentMethod.bankName }),
                ...(paymentMethod.bankCode && { bank_code: paymentMethod.bankCode }),
                ...(paymentMethod.swiftCode && { swift_bic: paymentMethod.swiftCode }),
                ...(paymentMethod.iban && { iban: paymentMethod.iban }),
                ...(paymentMethod.routingNumber && { routing_number: paymentMethod.routingNumber }),
                ...(paymentMethod.sortCode && { sort_code: paymentMethod.sortCode }),
            });
            if (!paymentDetail.success || !paymentDetail.id) throw new Error(`Failed to create Nuvion payment detail: ${paymentDetail.error}`);
            paymentDetailNuvionId = paymentDetail.id;
            await prisma.beneficiaryPaymentDetail.update({ where: { id: paymentMethod.id }, data: { nuvionPaymentDetailId: paymentDetailNuvionId } });
        }
 
        let nuvionTransferId: string;
        let fxQuoteId: string | undefined;
        let fxRate: number | undefined;
 
        if (isCrossCurrency) {
            const quote = await createFxQuote({
                to_currency: toCurrency, from_currency: transferRequest.currencyId!,
                amount_from: decimalAmount.toNumber(), account_id: treasury.nuvionAccountId,
                counterparty_id: counterpartyId, payment_detail_id: paymentDetailNuvionId,
            });
            if (!quote.success || !quote.id) throw Object.assign(new Error(quote.error ?? 'FX quote failed'), { httpStatus: quote.httpStatus });
            fxQuoteId = quote.id; fxRate = quote.rate;
 
            const transferAttempt = await withBoundedRetry(
                () => initiateCrossCurrencyTransfer({
                    account_id: treasury.nuvionAccountId, payment_detail_id: paymentDetailNuvionId!,
                    counterparty_id: counterpartyId!, fx_quote_id: quote.id!, narration,
                    payment_type: 'bank-transfer', unique_reference: sharedReference,
                }), 'cross-currency transfer'
            );
            if (!transferAttempt.success) throw new Error(transferAttempt.error);
            nuvionTransferId = (transferAttempt.result as any).id;
        } else {
            const transferAttempt = await withBoundedRetry(
                () => initiateSameCurrencyTransfer({
                    account_id: treasury.nuvionAccountId, payment_detail_id: paymentDetailNuvionId!,
                    counterparty_id: counterpartyId!, amount: decimalAmount.toNumber(), currency: transferRequest.currencyId!,
                    narration, payment_type: 'bank-transfer', unique_reference: sharedReference,
                }), 'same-currency transfer'
            );
            if (!transferAttempt.success) throw new Error(transferAttempt.error);
            nuvionTransferId = (transferAttempt.result as any).id;
        }
 
        await prisma.transferRequest.update({
            where: { id: transferRequestId },
            data: { status: 'PROCESSING', reference: nuvionTransferId, nuvionFxQuoteId: fxQuoteId, nuvionFxRate: fxRate ? toDecimal(fxRate) : undefined } as any,
        });
 
        if (isCryptoSourced) {
            await generalQueue.add('Nuvion_Treasury_Replenish', {
                transferRequestId,
                replenishUserId: jobData.replenishUserId,
                replenishCurrencyId: jobData.replenishCurrencyId,
                treasuryAccountId: jobData.treasuryAccountId,
                treasuryWalletAddress: jobData.treasuryWalletAddress,
                amount: decimalAmount.toString(),
            });
            logger.info(`[NuvionPayout] Queued treasury replenishment for TransferRequest ${transferRequestId}`);
        }
 
        logger.info(`[NuvionPayout] TransferRequest ${transferRequestId} submitted — Nuvion transfer ${nuvionTransferId}, awaiting outflows webhook`);
 
    } catch (error: any) {
        await failPayout(jobData, error.message);
    }
}

async function failPayout(jobData: any, reason: string) {
    const { transferRequestId, isCryptoSourced } = jobData;
 
    if (isCryptoSourced) {
        if (jobData.treasuryAccountId) {
            const tr = await prisma.transferRequest.findUnique({ where: { id: transferRequestId }, select: { amount: true } });
            await prisma.nuvionTreasuryAccount.update({
                where: { id: jobData.treasuryAccountId },
                data: { lastKnownAvailable: { increment: toDecimal(tr?.amount ?? 0) } as any },
            });
        }
        await prisma.transferRequest.update({ where: { id: transferRequestId }, data: { status: 'FAILED', errorMessage: reason } });
 
        const tr = await prisma.transferRequest.findUnique({ where: { id: transferRequestId } });
        if (tr) {
            await notificationService.queue({
                userId: tr.userId, title: 'Transfer unsuccessful', type: 'GENERAL',
                content: `Your transfer could not be completed. No funds were debited. Please try again or contact support.`,
            });
        }
    } else {
        const failed = await virtualAccountService.failBankWithdrawal({ transactionId: jobData.transactionId, blockId: jobData.blockId, reason });
        await prisma.transferRequest.update({ where: { id: transferRequestId }, data: { status: 'FAILED', errorMessage: reason } });
 
        const account = await prisma.virtualAccount.findUnique({ where: { id: failed.fromAccountId! } });
        if (account) {
            await notificationService.queue({
                userId: account.userId, title: 'Transfer unsuccessful', type: 'GENERAL',
                content: `Your ${failed.currency} ${failed.amount} transfer could not be completed. The funds have been returned to your balance. Please try again or contact support.`,
            });
        }
    }
 
    logger.error(`[NuvionPayout] TransferRequest ${transferRequestId} failed at submission`, { error: reason, isCryptoSourced });
}
 
// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 — treasury replenishment. Only for crypto-sourced payouts,
// after submission already succeeded. Calls the REAL, existing
// blockchain_Transfer — same public entry point every other crypto
// withdrawal in this app already uses (currency lookup, wallet lookup,
// minimum-withdrawal validation, admin pooling, fee calc, transaction
// record, notification — all handled internally, exactly as designed).
// ═══════════════════════════════════════════════════════════════════════
 
export async function handleTreasuryReplenishment(jobData: {
    transferRequestId: string; replenishUserId: string; replenishCurrencyId: string;
    treasuryAccountId: string; treasuryWalletAddress: string; amount: string;
}) {
    const { transferRequestId, replenishUserId, replenishCurrencyId, treasuryAccountId, treasuryWalletAddress, amount } = jobData;
 
    try {
        await walletService.blockchain_Transfer({
            userId: replenishUserId,
            currencyId: replenishCurrencyId,
            amount,
            address: treasuryWalletAddress,
        });
 
        logger.info(`[NuvionPayout] Treasury replenishment submitted via blockchain_Transfer — treasury: ${treasuryAccountId}`);
 
        const treasury = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: treasuryAccountId } });
        if (treasury) {
            const account = await getAccount(treasury.nuvionAccountId);
            if (account.success && account.balance) {
                await prisma.nuvionTreasuryAccount.update({
                    where: { id: treasuryAccountId },
                    data: { lastKnownAvailable: account.balance.available, lastSyncedAt: new Date() },
                });
                logger.info(`Treasury ${treasuryAccountId} balance re-synced: ${account.balance.available}`);
            }
        }
 
    } catch (error: any) {
        // CRITICAL — recipient already paid, user's crypto was never
        // debited. Real financial exposure. Needs real alerting
        // (Slack/PagerDuty), not just this log line.
        logger.error(`[NUVION REPLENISHMENT FAILED — FINANCIAL EXPOSURE] TransferRequest ${transferRequestId}, treasury ${treasuryAccountId}, amount ${amount}`, { error: error.message });
    }
}

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
        if (!beneficiary.nuvionRecipientCountry || !beneficiary.nuvionRecipientEmail || !beneficiary.nuvionRecipientAddressLine1) {
            throw new Error('This beneficiary is missing required details (country, email, or address) — please complete their profile before sending a payout');
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
                email: beneficiary.nuvionRecipientEmail,
                address: {
                    line1: beneficiary.nuvionRecipientAddressLine1,
                    city: beneficiary.nuvionRecipientAddressCity!,
                    state_or_province: beneficiary.nuvionRecipientAddressState!,
                    postal_code: beneficiary.nuvionRecipientAddressPostal!,
                    country: beneficiary.nuvionRecipientCountry,
                },
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
        });
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
                currencyId: fromCurrency,
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
            if (!transferAttempt.success) throw new Error(transferAttempt.error);
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
            if (!transferAttempt.success) throw new Error(transferAttempt.error);
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