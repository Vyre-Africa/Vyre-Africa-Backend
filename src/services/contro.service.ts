import axios, { AxiosInstance } from 'axios';
import config from '../config/env.config';
import logger from '../config/logger';

// CONFIRMED via live curl + live test run: stg-api.contro.dev is the real
// sandbox host (api.contro.me returned 403 for a sk_test_ key — that's
// the genuine production host correctly rejecting sandbox credentials).
// The OpenAPI spec's two-server model was accurate; the SDK docs'
// "no base URL changes needed" claim was wrong — moot anyway since
// @contro/partner-sdk doesn't exist on the public npm registry.
const controAxios: AxiosInstance = axios.create({
    baseURL: config.CONTRO_ENV === 'production'
        ? 'https://api.contro.me/v1'
        : 'https://stg-api.contro.dev/v1',
    headers: {
        'x-contro-api-key': config.CONTRO_API_KEY,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

// Contro's documented error shape is INCONSISTENT — most endpoints return
// { success: false, error: "string" }, but the 409 duplicate-email case
// returns { success: false, error: { code, message, existingCardholderId } }.
// Confirmed live. Every function below routes errors through this.
function handleControError(context: string, error: any) {
    const body = error?.response?.data ?? error;
    const status = error?.response?.status;

    let message: string;
    let code: string | undefined;
    let existingCardholderId: string | undefined;

    if (typeof body?.error === 'string') {
        message = body.error;
    } else if (typeof body?.error === 'object' && body?.error !== null) {
        message = body.error.message ?? 'Unknown error';
        code = body.error.code;
        existingCardholderId = body.error.existingCardholderId;
    } else {
        message = error?.message ?? 'Unknown error';
    }

    logger.error(`Contro call failed [${context}]:`, { status, message, code, rawData: body });
    return { error: message, code, existingCardholderId, status, rawData: body };
}

// ─── KYC Sessions ───────────────────────────────────────────────────────
// CONFIRMED by Contro directly: they migrated KYC providers from Sumsub
// to Didit — session.url pointing at verification.didit.me is expected,
// correct behavior, not a docs bug on our observation end. Their prose
// docs (flow diagrams, the "Sumsub share token" page) simply haven't
// been updated to reflect this migration — treat any Contro doc page
// mentioning Sumsub as stale.

export interface KycSessionResult {
    success: boolean;
    id?: string;
    status?: 'creating' | 'pending' | 'completed' | 'expired' | 'failed';
    url?: string;
    expiresAt?: string;
    error?: string;
    rawData?: any;
}

export async function createKycSession(externalUserId: string): Promise<KycSessionResult> {
    try {
        const res = await controAxios.post('/partner/kyc-sessions', { externalUserId });
        logger.info('Contro KYC session created', { externalUserId, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('createKycSession', error);
        return { success: false, error: msg, rawData };
    }
}

export async function getKycSession(sessionId: string): Promise<KycSessionResult> {
    try {
        const res = await controAxios.get(`/partner/kyc-sessions/${sessionId}`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('getKycSession', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Cardholders ────────────────────────────────────────────────────────
// kycSource: 'web' — CONFIRMED correct value (not "web_link", a typo in
// Contro's own SDK docs example, caught by cross-referencing their strict
// OpenAPI enum).

export interface CardholderResult {
    success: boolean;
    id?: string;
    externalUserId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    kycSource?: string;
    kycStatus?: 'pending' | 'approved' | 'rejected';
    status?: 'active' | 'suspended' | 'closed';
    error?: string;
    rawData?: any;
}

export async function createCardholder(payload:
    | {
        externalUserId: string;
        kycSource: 'web';
        kycSessionId: string;
        email: string;
        phoneNumber: string;
      }
    | {
        externalUserId: string;
        kycSource: 'didit';
        diditShareToken: string;
        email: string;
        phoneNumber: string;
      }
): Promise<CardholderResult> {
    try {
        const res = await controAxios.post('/partner/cardholders', payload);
        logger.info('Contro cardholder created', { externalUserId: payload.externalUserId, kycSource: payload.kycSource, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, code, existingCardholderId, rawData } = handleControError('createCardholder', error);
        if (code === 'EMAIL_ALREADY_REGISTERED' && existingCardholderId) {
            logger.warn('Cardholder already exists — self-healing', { existingCardholderId });
            return getCardholder(existingCardholderId);
        }
        return { success: false, error: msg, rawData };
    }
}
 

export async function getCardholder(cardholderId: string): Promise<CardholderResult> {
    try {
        const res = await controAxios.get(`/partner/cardholders/${cardholderId}`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('getCardholder', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Program-level KYC ──────────────────────────────────────────────────
// IMPORTANT distinction, confirmed live: cardholder.kycStatus (account
// level) and program-level KYC are SEPARATE. A cardholder can show
// kycStatus: "approved" immediately, while program KYC still needs
// polling and took ~6 seconds even in "auto-approve" sandbox mode. Don't
// use cardholder.kycStatus alone to decide whether a card can be issued.

export async function initiateProgramKyc(cardholderId: string, cardProgramId: string) {
    try {
        const res = await controAxios.post(`/partner/cardholders/${cardholderId}/kyc`, { cardProgramId });
        logger.info('Contro program KYC initiated', { cardholderId, cardProgramId, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('initiateProgramKyc', error);
        return { success: false, error: msg, rawData };
    }
}

export async function getProgramKycStatus(cardholderId: string, cardProgramId: string) {
    try {
        const res = await controAxios.get(`/partner/cardholders/${cardholderId}/kyc`, {
            params: { cardProgramId },
        });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('getProgramKycStatus', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Cards ──────────────────────────────────────────────────────────────

export interface CardResult {
    success: boolean;
    id?: string;
    status?: string; // NOT a strict union — confirmed live that "pending" is
                      // a real value NOT in Contro's documented OpenAPI enum
                      // (created|active|frozen|cancelled). Kept loose
                      // deliberately so an undocumented real value never
                      // silently breaks type-checking.
    type?: string;
    brand?: string;
    nameOnCard?: string | null;
    last4?: string | null;
    programId?: string | null;
    spendControl?: any;
    error?: string;
    rawData?: any;
}

export async function issueCard({
    cardholderId,
    programId,
    idempotencyKey,
}: {
    cardholderId: string;
    programId: string;
    idempotencyKey: string; // ALWAYS pass a stable, deterministic key derived from user+context — confirmed supported specifically to prevent double-issuance on retry
}): Promise<CardResult> {
    try {
        const res = await controAxios.post('/partner/cards', { cardholderId, programId, idempotencyKey });
        logger.info('Contro card issued', { cardholderId, programId, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('issueCard', error);
        return { success: false, error: msg, rawData };
    }
}

export async function activateCard(cardId: string) {
    try {
        const res = await controAxios.post(`/partner/cards/${cardId}/activate`);
        logger.info('Contro card activation requested', { cardId, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('activateCard', error);
        return { success: false, error: msg, rawData };
    }
}

export async function getCard(cardId: string): Promise<CardResult> {
    try {
        const res = await controAxios.get(`/partner/cards/${cardId}`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('getCard', error);
        return { success: false, error: msg, rawData };
    }
}

export async function freezeCard(cardId: string) {
    try {
        const res = await controAxios.post(`/partner/cards/${cardId}/freeze`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('freezeCard', error);
        return { success: false, error: msg, rawData };
    }
}

export async function unfreezeCard(cardId: string) {
    try {
        const res = await controAxios.post(`/partner/cards/${cardId}/unfreeze`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('unfreezeCard', error);
        return { success: false, error: msg, rawData };
    }
}

export async function cancelCard(cardId: string) {
    try {
        const res = await controAxios.post(`/partner/cards/${cardId}/cancel`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('cancelCard', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Spend control — THE actual ledger mechanism ───────────────────────
// Since Contro uses ONE pooled partner balance (confirmed — no
// per-cardholder balance concept exists anywhere in their API), THIS is
// how Vyre enforces "how much can this specific user spend" — not a
// funding/transfer step. Call this whenever a user's real Vyre wallet
// balance changes, to keep their card's cap in sync.
//
// ⚠️ STILL UNRESOLVED: sandbox confirmed does NOT implement this
// ("Provider sandbox does not implement spend-control updates"), and
// Contro's KYC-provider/SDK answers didn't address this question.
// PRACTICAL PLAN, given sandbox genuinely cannot validate this: this
// function must be smoke-tested with a real, tiny live production card
// and a real, tiny cap BEFORE being trusted for actual users — add this
// explicitly to the pre-launch checklist. Built defensively below
// (never throws past this function) specifically because we already
// know this call can fail for reasons unrelated to a malformed request.

export async function updateSpendControl(
    cardId: string,
    spendControl: {
        sales?: { perTransaction?: number; daily?: number; monthly?: number; allTime?: number };
        cash?: { perTransaction?: number; daily?: number; monthly?: number; allTime?: number };
    }
) {
    try {
        const res = await controAxios.patch(`/partner/cards/${cardId}/limits`, { spendControl });
        logger.info('Contro spend control updated', { cardId, spendControl, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('updateSpendControl', error);
        // Deliberately NOT re-throwing — a caller syncing a user's cap
        // after a wallet-balance change should be able to record "sync
        // failed, retry later" rather than crash whatever triggered it.
        return { success: false, error: msg, rawData };
    }
}

// ─── Transactions ───────────────────────────────────────────────────────

export async function listCardTransactions(cardId: string, params?: { page?: number; limit?: number }) {
    try {
        const res = await controAxios.get(`/partner/cards/${cardId}/transactions`, { params });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('listCardTransactions', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Webhook signature verification ─────────────────────────────────────
// CONFIRMED from webhooks.md: HMAC-SHA256, header format
// "t={timestamp},v1={hmac}", computed over "{timestamp}.{rawBody}".

import { createHmac, timingSafeEqual } from 'crypto';

export function verifyControWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
    try {
        const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=', 2)));
        const timestamp = parts.t;
        const receivedHmac = parts.v1;

        if (!timestamp || !receivedHmac) return false;

        const expected = createHmac('sha256', secret)
            .update(`${timestamp}.${rawBody}`)
            .digest('hex');

        const receivedBuf = Buffer.from(receivedHmac, 'hex');
        const expectedBuf = Buffer.from(expected, 'hex');

        return receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf);
    } catch (error) {
        logger.error('Contro webhook signature verification error', error);
        return false;
    }
}

export async function revealHtml(cardId: string, options?: { stylesheetUrl?: string; copyPan?: boolean }) {
    try {
        const res = await controAxios.post(`/partner/cards/${cardId}/reveal-html`, {
            stylesheetUrl: options?.stylesheetUrl,
            copyPan: options?.copyPan ?? true,
        });
        // CONFIRMED flat response shape from Contro's docs: { accessUrl: "..." }
        // — Contro's responses are flat throughout (unlike Nuvion's nested
        // { data: {...} } wrapper), consistent with every other Contro
        // function in this file.
        return { success: true, accessUrl: res.data.accessUrl, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleControError('revealHtml', error);
        return { success: false, error: msg, rawData };
    }
}