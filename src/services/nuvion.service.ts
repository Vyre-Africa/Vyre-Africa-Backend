import axios, { AxiosInstance } from 'axios';
import config from '../config/env.config';
import logger from '../config/logger';

const nuvionApi: AxiosInstance = axios.create({
    baseURL: config.NUVION_BASE_URL || 'https://api.nuvion.dev',
    headers: {
        Authorization: `Bearer ${config.NUVION_API_KEY}`,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

function handleNuvionError(context: string, error: any) {
    const httpStatus = error?.response?.status;
    const data = error?.response?.data;
    logger.error(`Nuvion call failed [${context}]:`, { httpStatus, data });
    return {
        error: data?.error?.message ?? data?.message ?? data?.error ?? error?.message ?? 'Unknown error',
        httpStatus,
        rawData: data,
    };
}

const VYRE_ENTITY_ID = config.NUVION_ENTITY_ID as string;

// --------- Banks-------------//
export interface BankCodeResult {
    success: boolean;
    banks?: { bank_code: string; bank_name: string; swift_bic: string | null }[];
    error?: string; httpStatus?: number; rawData?: any;
}
 
export async function getBankCodes(country: string): Promise<BankCodeResult> {
    try {
        const res = await nuvionApi.get(`/bank-codes/${country}`);
        // CONFIRMED response shape from Nuvion's docs — flat array under data
        return { success: true, banks: res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('getBankCodes', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Counterparties ─────────────────────────────────────────────────────

export interface CounterpartyResult {
    success: boolean;
    id?: string;
    type?: 'individual' | 'business';
    nickname?: string;
    status?: 'active' | 'inactive';
    error?: string;
    httpStatus?: number;
    rawData?: any;
}

export async function createCounterparty(payload: {
    type: 'individual' | 'business';
    profile: {
        first_name: string; last_name: string; relationship?: string; email: string;
        address: { line1: string; city: string; state_or_province: string; postal_code: string; country: string };
    };
    nickname?: string; meta?: Record<string, string>;
}): Promise<CounterpartyResult> {
    try {
        const res = await nuvionApi.post('/counterparties', { entity_id: VYRE_ENTITY_ID, ...payload });
        logger.info('Nuvion counterparty created', { rawData: res.data });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('createCounterparty', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

export async function getCounterparty(counterpartyId: string): Promise<CounterpartyResult> {
    try {
        const res = await nuvionApi.get(`/counterparties/${counterpartyId}`, { params: { entity_id: VYRE_ENTITY_ID } });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('getCounterparty', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

export async function deactivateCounterparty(counterpartyId: string) {
    try {
        const res = await nuvionApi.post(`/counterparties/${counterpartyId}/deactivate`, { entity_id: VYRE_ENTITY_ID });
        logger.info('Nuvion counterparty deactivated', { counterpartyId });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        if (error?.response?.status === 409) {
            logger.info(`Counterparty ${counterpartyId} was already inactive`);
            return { success: true, alreadyInactive: true };
        }
        const { error: msg, httpStatus, rawData } = handleNuvionError('deactivateCounterparty', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Payment Details ────────────────────────────────────────────────────

export interface PaymentDetailResult {
    success: boolean; id?: string; payment_method?: string; currency?: string;
    scheme?: string; error?: string; httpStatus?: number; rawData?: any;
}

export async function createPaymentDetail(payload: {
    payment_method: 'bank-transfer' | 'momo-transfer' | 'stablecoin-transfer' | 'book-transfer';
    currency: string; account_holder_name: string; counterparty_id: string;
    country?: string; scheme?: string; bank_address?: Record<string, any>;
    [railSpecificField: string]: any;
}): Promise<PaymentDetailResult> {
    try {
        const res = await nuvionApi.post('/payment-details', { entity_id: VYRE_ENTITY_ID, ...payload });
        logger.info('Nuvion payment detail created', { rawData: res.data });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('createPaymentDetail', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

export async function getPaymentDetail(paymentDetailId: string): Promise<PaymentDetailResult> {
    try {
        const res = await nuvionApi.get(`/payment-details/${paymentDetailId}`);
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('getPaymentDetail', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── FX Quotes ──────────────────────────────────────────────────────────

export interface FxQuoteResult {
    success: boolean; id?: string; to?: string; from?: string; rate?: number;
    error?: string; httpStatus?: number; rawData?: any;
}

export async function createFxQuote(payload: {
    to_currency: string; from_currency: string; amount_to?: number; amount_from?: number;
    account_id: string; counterparty_id: string; payment_detail_id: string;
}): Promise<FxQuoteResult> {
    const hasTo = payload.amount_to !== undefined;
    const hasFrom = payload.amount_from !== undefined;
    if (hasTo === hasFrom) {
        return { success: false, error: 'Exactly one of amount_to or amount_from must be provided, not both or neither' };
    }
    try {
        const res = await nuvionApi.post('/fx-quotes', payload);
        logger.info('Nuvion FX quote created', { rawData: res.data });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('createFxQuote', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Transfers ──────────────────────────────────────────────────────────

export interface TransferResult {
    success: boolean; id?: string; status?: 'pending' | 'processing' | 'completed' | 'failed' | 'reversed';
    status_reason?: string; applicable_fee?: number; error?: string; httpStatus?: number; rawData?: any;
}

export async function initiateSameCurrencyTransfer(payload: {
    account_id: string; payment_detail_id: string; counterparty_id: string;
    amount: number; currency: string; narration: string;
    payment_type: 'bank-transfer' | 'momo-transfer' | 'stablecoin-transfer' | 'book-transfer';
    unique_reference: string; meta?: Record<string, any>;
}): Promise<TransferResult> {
    try {
        const res = await nuvionApi.post('/transfers', payload);
        logger.info('Nuvion transfer initiated (same-currency)', { rawData: res.data });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('initiateSameCurrencyTransfer', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}


export async function initiateCrossCurrencyTransfer(payload: {
    account_id: string; payment_detail_id: string; counterparty_id: string; fx_quote_id: string;
    narration: string; payment_type: 'bank-transfer' | 'momo-transfer' | 'stablecoin-transfer' | 'book-transfer';
    unique_reference: string; meta?: Record<string, any>;
}): Promise<TransferResult> {
    try {
        const res = await nuvionApi.post('/transfers', payload);
        logger.info('Nuvion transfer initiated (cross-currency)', { rawData: res.data });
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('initiateCrossCurrencyTransfer', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

export async function getTransfer(transferId: string): Promise<TransferResult> {
    try {
        const res = await nuvionApi.get(`/transfers/${transferId}`);
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('getTransfer', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Pooled Treasury Accounts ───────────────────────────────────────────

export interface AccountResult {
    success: boolean; id?: string; type?: string; currency?: string;
    balance?: { available: number; current: number }; error?: string; httpStatus?: number; rawData?: any;
}

export async function createTreasuryAccount(payload: {
    type: 'checking' | 'operational' | 'safeguard'; currency: string; display_name: string; meta?: Record<string, string>;
}): Promise<AccountResult> {
    try {
        const res = await nuvionApi.post('/accounts', { entity_id: VYRE_ENTITY_ID, ...payload });
        logger.info('Nuvion treasury account created', { rawData: res.data });
        return { success: true, ...res.data.data.account, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('createTreasuryAccount', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

export async function getAccount(accountId: string): Promise<AccountResult> {
    try {
        const res = await nuvionApi.get(`/accounts/${accountId}`);
        return { success: true, ...res.data.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('getAccount', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Stablecoin Wallets ─────────────────────────────────────────────────
 
export interface TreasuryWalletResult {
    success: boolean; id?: string; account_number?: string; status?: 'pending' | 'active';
    chain?: string; error?: string; httpStatus?: number; rawData?: any;
}
 
export async function createTreasuryWallet(payload: {
    account_id: string; chain: 'eth' | 'base' | 'matic' | 'sol'; terminate_after?: number;
}): Promise<TreasuryWalletResult> {
    try {
        const res = await nuvionApi.post('/account-details', {
            entity_id: VYRE_ENTITY_ID,
            account_id: payload.account_id,
            chain: payload.chain,
            config: { outflow_enabled: true, inflow_enabled: true, outflow_allowed_counterparties: [], inflow_allowed_counterparties: [] },
            ...(payload.terminate_after && { terminate_after: payload.terminate_after }),
        });
        logger.info('Nuvion stablecoin wallet issuance requested', { rawData: res.data });
        return { success: true, ...res.data.data.account_details, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleNuvionError('createTreasuryWallet', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Webhook signature verification ─────────────────────────────────────

export function verifyNuvionWebhookSignature(_rawBody: string, _signatureHeader: string, _secret: string): boolean {
    throw new Error('Nuvion webhook signature scheme not yet confirmed — do not use this function until the real signing scheme is documented or tested');
}