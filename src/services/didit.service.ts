import axios, { AxiosInstance } from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import config from '../config/env.config';
import logger from '../config/logger';

// Vyre's OWN, direct Didit relationship — separate from Contro's use of
// Didit entirely. Different API key, different base URL, different
// webhook destination.
const diditApi: AxiosInstance = axios.create({
    baseURL: 'https://verification.didit.me', // CONFIRMED — same host used across every real example in the docs
    headers: {
        'x-api-key': config.DIDIT_API_KEY,
        'Content-Type': 'application/json',
    },
    timeout: 15000,
});

function handleDiditError(context: string, error: any) {
    const httpStatus = error?.response?.status;
    const data = error?.response?.data;
    logger.error(`Didit call failed [${context}]:`, { httpStatus, data });
    return {
        error: data?.detail ?? data?.message ?? JSON.stringify(data) ?? error?.message ?? 'Unknown error',
        httpStatus,
        rawData: data,
    };
}

// ─── Create Session ─────────────────────────────────────────────────────
// CONFIRMED shape. Idempotent on (workflow_id, vendor_data) for unfinished
// sessions on the workflow's current published version — calling this
// again for a user who already has an in-progress session safely returns
// the SAME session rather than creating a duplicate.

export interface DiditSessionResult {
    success: boolean;
    session_id?: string;
    session_kind?: 'user' | 'business';
    session_number?: number;
    session_token?: string;
    url?: string; // CONFIRMED field name — NOT "verification_url"
    status?: string;
    workflow_id?: string;
    workflow_version?: number;
    vendor_data?: string;
    metadata?: Record<string, any>;
    callback?: string;
    error?: string;
    httpStatus?: number;
    rawData?: any;
}

export async function createDiditSession({
    vendorData,
    callback,
    metadata,
}: {
    vendorData: string; // Vyre's own userId — the link back to our own user record, same role as Contro's externalUserId
    callback?: string;
    metadata?: Record<string, any>;
}): Promise<DiditSessionResult> {
    try {
        const res = await diditApi.post('/v3/session/', {
            workflow_id: config.DIDIT_WORKFLOW_ID,
            vendor_data: vendorData,
            callback,
            callback_method: 'both', // per docs: use 'both' if the callback sometimes fails to fire — safer default
            metadata,
        });
        logger.info('Didit session created', { vendorData, rawData: res.data });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleDiditError('createDiditSession', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Retrieve Decision ──────────────────────────────────────────────────
// CONFIRMED: every per-feature result is a PLURAL ARRAY. Explicitly and
// repeatedly warned against in the docs — id_verifications[], NOT
// id_verification. Do not "simplify" this to a singular object even
// though one example earlier looked that way; the OpenAPI spec and the
// dedicated reference page both insist on the array form.

export interface DiditDecisionResult {
    success: boolean;
    session_id?: string;
    session_kind?: 'user' | 'business';
    status?: string;
    id_verifications?: any[];
    nfc_verifications?: any[];
    liveness_checks?: any[];
    face_matches?: any[];
    aml_screenings?: any[];
    phone_verifications?: any[];
    email_verifications?: any[];
    ip_analyses?: any[];
    document_verifications?: any[];
    warnings?: any[];
    error?: string;
    httpStatus?: number;
    rawData?: any;
}

export async function getDiditDecision(sessionId: string): Promise<DiditDecisionResult> {
    try {
        const res = await diditApi.get(`/v3/session/${sessionId}/decision/`);
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleDiditError('getDiditDecision', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Mint Share Token (Stage 3 — the Contro bridge) ─────────────────────
// CONFIRMED shape. Mint FRESH, on-demand, right before handing off to
// Contro — never store and reuse, given the short default TTL (1 hour)
// and the docs' own emphasis elsewhere that tokens are effectively
// single-use in spirit (matches the exact caution already built into
// Contro's own kycSource:"didit" docs: "mint a fresh token for every
// submission").

export interface ShareTokenResult {
    success: boolean;
    share_token?: string;
    for_application_id?: string;
    session_kind?: 'user' | 'business';
    error?: string;
    httpStatus?: number;
    rawData?: any;
}

export async function mintDiditShareToken({
    sessionId,
    forApplicationId,
    ttlInSeconds = 3600, // CONFIRMED default — explicit here rather than relying on Didit's own default, so it's visible and adjustable
}: {
    sessionId: string;
    forApplicationId: string; // Contro's Didit application ID — needs to come from Contro directly
    ttlInSeconds?: number;
}): Promise<ShareTokenResult> {
    try {
        const res = await diditApi.post(`/v3/session/${sessionId}/share/`, {
            for_application_id: forApplicationId,
            ttl_in_seconds: ttlInSeconds,
        });
        logger.info('Didit share token minted', { sessionId, forApplicationId });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleDiditError('mintDiditShareToken', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Webhook Destination Management ─────────────────────────────────────
// CONFIRMED: NOT idempotent — repeated POSTs create separate destinations.
// Never call createWebhookDestination blindly; always list first and
// check for an existing one with the same URL, same discipline as every
// duplicate-row bug already found and fixed elsewhere this session.

export async function listWebhookDestinations() {
    try {
        const res = await diditApi.get('/v3/webhook/destinations/');
        return { success: true, destinations: res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleDiditError('listWebhookDestinations', error);
        return { success: false, error: msg, httpStatus, rawData, destinations: [] };
    }
}

export async function createWebhookDestination({
    label,
    url,
    subscribedEvents,
}: {
    label: string;
    url: string;
    subscribedEvents: string[]; // CONFIRMED enum: status.updated | data.updated | user.status.updated | user.data.updated | business.status.updated | business.data.updated | activity.created | transaction.created | transaction.status.updated | travel_rule.status.updated
}) {
    try {
        const res = await diditApi.post('/v3/webhook/destinations/', {
            label,
            url,
            webhook_version: 'v3',
            subscribed_events: subscribedEvents,
        });
        // CONFIRMED: secret_shared_key is returned ONCE, here, on creation —
        // this is the actual HMAC secret. Must be captured and stored now.
        logger.info('Didit webhook destination created — SAVE THIS SECRET NOW', { label, url });
        return { success: true, ...res.data, rawData: res.data };
    } catch (error: any) {
        const { error: msg, httpStatus, rawData } = handleDiditError('createWebhookDestination', error);
        return { success: false, error: msg, httpStatus, rawData };
    }
}

// ─── Webhook signature verification ─────────────────────────────────────
// CONFIRMED: HMAC-SHA256 over the RAW request body. Headers X-Signature
// and X-Timestamp. 5-minute freshness window against replay attacks —
// this is a REAL, distinct check from signature validity itself; a
// perfectly valid signature on a stale (>5min old) timestamp must still
// be rejected.

export function verifyDiditWebhookSignature(
    rawBody: string,
    signature: string,
    timestamp: string,
    secret: string
): { valid: boolean; reason?: string } {
    const currentTime = Math.floor(Date.now() / 1000);
    const incomingTime = parseInt(timestamp, 10);

    if (!incomingTime || Math.abs(currentTime - incomingTime) > 300) {
        return { valid: false, reason: 'stale_timestamp' };
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(signature, 'utf8');

    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: true };
}