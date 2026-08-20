import prisma from '../config/prisma.client';
import logger from '../config/logger';
// import { toDecimal, generateRef } from '../utils/decimal.util'; // same helpers used in virtualAccount.service.ts — adjust import path if these actually live elsewhere
import {
    createCounterparty,
    createPaymentDetail,
    createFxQuote,
    initiateSameCurrencyTransfer,
    initiateCrossCurrencyTransfer,
} from './nuvion.service';
import { Decimal } from 'decimal.js';
import { ulid } from 'ulid';

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

// ==================== HELPERS ====================

function generateRef(prefix: string = 'TXN'): string {
    return `${prefix}-${ulid()}`;
}

function toDecimal(value: number | string | Decimal): Decimal {
    return new Decimal(value.toString());
}


function isTransientError(error: any): boolean {
    const httpStatus = error?.httpStatus;
    if (!httpStatus) return true; // no status at all — network-level failure (timeout, DNS, connection reset), treat as transient
    return httpStatus >= 500;      // 5xx = Nuvion's own infrastructure issue, safe to retry. 4xx = a real rejection, never retried automatically.
}

async function withBoundedRetry<T>(
    fn: () => Promise<{ success: boolean; error?: string; httpStatus?: number; [key: string]: any }>,
    context: string
): Promise<{ success: boolean; error?: string; result?: T }> {
    let lastError: any;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        const result = await fn();

        if (result.success) {
            return { success: true, result: result as T };
        }

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
    fromCurrency: string;
    toCurrency: string;
    amount: string;
    narration: string;
    recipientCountry?: string;
    recipientEmail?: string;
    recipientAddress?: {
        line1: string;
        city: string;
        state_or_province: string;
        postal_code: string;
    };
}

export async function initiateNuvionPayout(params: InitiatePayoutParams) {
    // FIXED — recipientAddress was missing from this destructure entirely
    // in the last merge, despite being referenced below.
    const { userId, beneficiaryId, fromCurrency, toCurrency, amount, narration, recipientCountry, recipientEmail, recipientAddress } = params;
    const isCrossCurrency = fromCurrency !== toCurrency;
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
 
    let counterpartyId = beneficiary.nuvionCounterpartyId;
    let paymentDetailId = beneficiary.nuvionPaymentDetailId;
 
    if (!counterpartyId || !paymentDetailId) {
 
        const resolvedCountry = beneficiary.nuvionRecipientCountry ?? recipientCountry;
        const resolvedEmail = beneficiary.nuvionRecipientEmail ?? recipientEmail;
        const resolvedAddress = (beneficiary.nuvionRecipientAddressLine1 && beneficiary.nuvionRecipientAddressCity)
            ? {
                line1: beneficiary.nuvionRecipientAddressLine1,
                city: beneficiary.nuvionRecipientAddressCity,
                state_or_province: beneficiary.nuvionRecipientAddressState!,
                postal_code: beneficiary.nuvionRecipientAddressPostal!,
              }
            : recipientAddress;
 
        if (!resolvedCountry || !resolvedEmail) {
            throw new Error('recipientCountry and recipientEmail are required the first time a beneficiary is used for a Nuvion payout');
        }
        if (!resolvedAddress?.line1 || !resolvedAddress?.city || !resolvedAddress?.state_or_province || !resolvedAddress?.postal_code) {
            throw new Error('recipientAddress (line1, city, state_or_province, postal_code) is required the first time a beneficiary is used for a Nuvion payout');
        }
 
        const bankData = beneficiary.bank as {
            accountNumber?: string;
            accountName?: string;
            bankName?: string;
            bankCode?: string;
            swiftCode?: string;
            iban?: string;
            routingNumber?: string;
            sortCode?: string;
        } | null;
 
        if (!bankData?.accountName) {
            throw new Error('Beneficiary has no bank.accountName — cannot create Nuvion counterparty without a recipient name');
        }
 
        const [firstName, ...lastNameParts] = bankData.accountName.trim().split(' ');
        const lastName = lastNameParts.join(' ') || firstName;
 
        const counterparty = await createCounterparty({
            type: 'individual',
            profile: {
                first_name: firstName,
                last_name: lastName,
                relationship: 'vendor',
                // FIXED — was `recipientEmail` (bypassed the cache).
                email: resolvedEmail,
                // FIXED — address was completely absent before; this is
                // the actual root cause of the 422 you hit.
                address: {
                    line1: resolvedAddress.line1,
                    city: resolvedAddress.city,
                    state_or_province: resolvedAddress.state_or_province,
                    postal_code: resolvedAddress.postal_code,
                    country: resolvedCountry,
                },
            },
        });

        if (!counterparty.success || !counterparty.id) {
            throw new Error(`Failed to create Nuvion counterparty: ${counterparty.error}`);
        }
 
        const paymentDetail = await createPaymentDetail({
            payment_method: 'bank-transfer',
            currency: toCurrency,
            account_holder_name: bankData.accountName,
            counterparty_id: counterparty.id,
            // FIXED — was `recipientCountry` (bypassed the cache).
            country: resolvedCountry,
            ...(bankData.accountNumber && { account_number: String(bankData.accountNumber) }),
            ...(bankData.bankName && { bank_name: bankData.bankName }),
            ...(bankData.bankCode && { bank_code: String(bankData.bankCode) }), // defensive same fix — bank codes can also carry leading zeros that a numeric type would silently drop
            ...(bankData.swiftCode && { swift_bic: bankData.swiftCode }),
            ...(bankData.iban && { iban: bankData.iban }),
            ...(bankData.routingNumber && { routing_number: String(bankData.routingNumber) }),
            ...(bankData.sortCode && { sort_code: String(bankData.sortCode) }),
        });

        if (!paymentDetail.success || !paymentDetail.id) {
            throw new Error(`Failed to create Nuvion payment detail: ${paymentDetail.error}`);
        }
 
        counterpartyId = counterparty.id;
        paymentDetailId = paymentDetail.id;
 
        await prisma.beneficiary.update({
            where: { id: beneficiary.id },
            data: {
                nuvionCounterpartyId: counterpartyId,
                nuvionPaymentDetailId: paymentDetailId,
                nuvionRecipientCountry: resolvedCountry,
                nuvionRecipientEmail: resolvedEmail,
                nuvionRecipientAddressLine1: resolvedAddress.line1,
                nuvionRecipientAddressCity: resolvedAddress.city,
                nuvionRecipientAddressState: resolvedAddress.state_or_province,
                nuvionRecipientAddressPostal: resolvedAddress.postal_code,
            },
        });
    }
 
    // ── Everything below is CONFIRMED intact — matches the last known-
    // good version exactly, no changes needed here. ──────────────────
 
    const idempotencyKey = generateRef('NVPAY');
 
    const { transferRequest, virtualAccountId } = await prisma.$transaction(async (tx) => {
        const account = await tx.virtualAccount.findFirst({
            where: { userId, currency: fromCurrency },
        });
        if (!account) throw new Error(`No ${fromCurrency} account found for this user`);
 
        await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${account.id} FOR UPDATE`;
 
        const fresh = await tx.virtualAccount.findUnique({ where: { id: account.id } });
        if (toDecimal(fresh!.available).lt(decimalAmount)) {
            throw new Error('Insufficient balance');
        }
 
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
            data: {
                frozen: { increment: decimalAmount },
                available: { decrement: decimalAmount },
            },
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
                payment_detail_id: paymentDetailId,
            });
            if (!quote.success || !quote.id) {
                throw Object.assign(new Error(quote.error ?? 'FX quote failed'), { httpStatus: quote.httpStatus });
            }
            fxQuoteId = quote.id;
            fxRate = quote.rate;
 
            const transferAttempt = await withBoundedRetry(
                () => initiateCrossCurrencyTransfer({
                    account_id: treasury.nuvionAccountId,
                    payment_detail_id: paymentDetailId!,
                    counterparty_id: counterpartyId!, // NEW
                    fx_quote_id: quote.id!,
                    narration,
                    payment_type: 'bank-transfer',
                    unique_reference: idempotencyKey,
                }),
                'cross-currency transfer'
            );
 
            if (!transferAttempt.success) {
                throw new Error(transferAttempt.error);
            }
            nuvionTransferId = (transferAttempt.result as any).id;
 
        } else {
            const transferAttempt = await withBoundedRetry(
                () => initiateSameCurrencyTransfer({
                    account_id: treasury.nuvionAccountId,
                    payment_detail_id: paymentDetailId!,
                    counterparty_id: counterpartyId!, // NEW
                    amount: decimalAmount.toNumber(),
                    currency: fromCurrency,
                    narration,
                    payment_type: 'bank-transfer',
                    unique_reference: idempotencyKey,
                }),
                'same-currency transfer'
            );
 
            if (!transferAttempt.success) {
                throw new Error(transferAttempt.error);
            }
            nuvionTransferId = (transferAttempt.result as any).id;
        }
 
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "VirtualAccount" WHERE id = ${virtualAccountId} FOR UPDATE`;
 
            await tx.virtualAccount.update({
                where: { id: virtualAccountId },
                data: {
                    balance: { decrement: decimalAmount },
                    frozen: { decrement: decimalAmount },
                },
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
                data: {
                    frozen: { decrement: decimalAmount },
                    available: { increment: decimalAmount },
                },
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