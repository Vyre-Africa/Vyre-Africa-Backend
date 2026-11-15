// ─────────────────────────────────────────────────────────────────────────────
// src/services/apns.service.ts
//
// Direct APNs for Live Activity pushes. Ported from Spondle with four changes:
//
//   1. `production` comes from config instead of being hardcoded true. Spondle's
//      provider was pinned to production while the log line read
//      config.apns.production — so it could print "sandbox environment" while
//      talking to the production gateway. A dev build registers against APNs
//      SANDBOX, so on Vyre's current build that combination returns
//      BadDeviceToken for every push, with a log telling you you're on sandbox.
//
//   2. Payload builders are pure exported functions, so 00-payload.ts can
//      compile and assert them offline with no key, no device and no network.
//      Every Live Activity field goes through `as any` (node-apn's typings do
//      not know them), so nothing type-checks that `event` actually reaches the
//      wire. Verified empirically on @parse/node-apn 8.2.0: it does. Run
//      `npm ls @parse/node-apn` — if your version differs, run 00-payload.ts
//      before trusting it, because a dropped field produces a push APNs accepts
//      and the device ignores, which looks identical to "nothing happened".
//
//   3. isRetryable's substring matching is replaced by a verdict classifier
//      that knows Apple's semantic reasons. Spondle treats every failure the
//      same, so a 429 is as fatal as a dead token, and a dead token is never
//      cleared — it gets retried on every future activity, forever.
//
//   4. A size guard. The 4096-byte cap applies to the SERIALISED payload, and
//      uiJsonData is a JSON string nested inside JSON, so its quotes are
//      escaped: measured ×1.18 over an 83-byte envelope. Failing here with the
//      byte count beats Apple's PayloadTooLarge with no clue which layout did it.
// ─────────────────────────────────────────────────────────────────────────────

import apn from '@parse/node-apn';
import config from '../config/env.config';
import logger from '../config/logger';

// ─── The two render modes ───────────────────────────────────────────────────
//
// Voltra supports two ways of driving an activity, and they differ at the APNs
// layer in exactly three fields. Everything else is shared.
//
//                  │ static (server-rendered)   │ dynamic (@experimental)
//   ───────────────┼────────────────────────────┼──────────────────────────────
//   attributes-type│ VoltraAttributes (shared)  │ Voltra<Id>LiveActivityAttributes
//   attributes     │ { name }                   │ { name, deepLinkUrl? }
//   content-state  │ { uiJsonData } — whole UI  │ { props } — plain data
//
// STATIC ships the rendered view tree in every push. The card can be
// redesigned server-side with no app release, but the layout must exist on both
// sides and each push carries the UI (~780B for Vyre's card, 19% of the cap).
//
// DYNAMIC bundles the definition in the app via app.json `liveActivities:
// [{ id, entry }]` and sends only props. Payloads shrink to almost nothing and
// the layout lives in one place — but a redesign needs an app release, and it
// is marked @experimental in 2.4.0.
//
// Both are supported here so the choice is per-subject and reversible.

/** Shared by every static activity; `activityName` is a field inside it. */
const VOLTRA_ATTRIBUTES_TYPE = 'VoltraAttributes';

/**
 * Mirrors @use-voltra/core's getDynamicLiveActivityAttributesType. Inlined
 * rather than imported so this file has no Voltra dependency — the backend's
 * only Voltra import is the renderer, in liveActivity.service.ts.
 *
 *   'vyre_activity' → 'VoltraVyreActivityLiveActivityAttributes'
 *
 * The plugin generates one such struct per definition, which is why dynamic
 * activities are distinct ActivityKit types while static ones all share one.
 */
export function dynamicAttributesType(definitionId: string): string {
    const upperCamel = definitionId
        .split('_')
        .filter(Boolean)
        .map((s) => `${s[0].toUpperCase()}${s.slice(1)}`)
        .join('');
    return `Voltra${upperCamel}LiveActivityAttributes`;
}

/** Which mode an activity is started in, and what its attributes carry. */
export type ActivityIdentity =
    | { mode: 'static'; activityName: string }
    | {
          mode: 'dynamic';
          /** Must equal the `id` in app.json's `liveActivities` entry. */
          definitionId: string;
          activityName: string;
          /** The generated struct has `deepLinkUrl: String?`. */
          deepLinkUrl?: string;
      };

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

/** APNs hard limit on the serialised payload. */
export const MAX_PAYLOAD_BYTES = 4096;

/**
 * Ceiling for the rendered uiJsonData.
 *
 * Measured against Voltra 2.4.0, which compresses and base64-encodes the view
 * tree: the output contains ZERO quote characters, so there is no escaping cost
 * at all and the envelope is a flat 83 bytes. (An earlier draft assumed raw
 * JSON and derived a ×1.22 escaping factor from quote density — that applies to
 * a hand-built tree, not to anything Voltra actually emits.)
 *
 * Voltra enforces its own limit inside renderLiveActivityToString and THROWS:
 *   "[Voltra] Compressed payload size 3808B exceeds safe budget 3345B
 *    (ActivityKit hard cap 4096B)"
 * so 3300 sits just under theirs and this check is a backstop, not the gate.
 * The caller must still catch that throw.
 *
 * Note the size is CONTENT-dependent because the tree is compressed: 5000
 * characters of repeated text cost nothing, while 2500 characters of random ids
 * blow the budget. It cannot be predicted from the layout's complexity, only
 * measured per render.
 */
export const MAX_LAYOUT_BYTES = 3300;

// ─── Verdicts ───────────────────────────────────────────────────────────────

export type ApnsVerdict =
    | 'sent'
    | 'retry'          // transient; same connection is fine
    | 'retry-reconnect'// HTTP/2 session is sick; rebuild it
    | 'terminal'       // our fault, retrying changes nothing
    | 'prune-token';   // token is dead; CALLER MUST CLEAR IT

export type ApnsResult = {
    success: boolean;
    verdict: ApnsVerdict;
    /** Apple's `reason`, when Apple answered. */
    reason?: string;
    error?: string;
};

/** Apple reasons meaning the token will never work again. */
const PRUNE_REASONS = new Set([
    'BadDeviceToken',
    'Unregistered',
    'DeviceTokenNotForTopic',
]);

/** Apple reasons worth another go. */
const RETRY_REASONS = new Set([
    'TooManyRequests',       // 429 — activity budget or rate limit
    'InternalServerError',   // 500
    'ServiceUnavailable',    // 503
    'IdleTimeout',
    'ExpiredProviderToken',  // node-apn re-signs the JWT on the next attempt
]);

/** Connection-level failures. node-apn wraps these; only strings are available. */
const RECONNECT_PATTERNS = [
    'pending stream has been canceled',
    'stream ended unexpectedly',
    'socket disconnected',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'GOAWAY',
];

function classify(reason: string | undefined, errorMsg: string | undefined): ApnsVerdict {
    if (reason && PRUNE_REASONS.has(reason)) return 'prune-token';
    if (reason && RETRY_REASONS.has(reason)) return 'retry';

    const haystack = (errorMsg ?? '').toLowerCase();
    if (RECONNECT_PATTERNS.some((p) => haystack.includes(p.toLowerCase()))) {
        return 'retry-reconnect';
    }

    // Everything Apple names that is not above (PayloadTooLarge, BadTopic,
    // TopicDisallowed, InvalidPushType, MissingTopic, …) is our bug.
    return 'terminal';
}

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Pure payload builders ──────────────────────────────────────────────────
//
// No credentials, no I/O. 00-payload.ts imports these directly.

export type LiveActivityOptions = {
    /** Unix SECONDS. After this, iOS greys the activity as out of date. */
    staleDate?: number;
    /** Unix SECONDS. iOS removes the activity at this time no matter what. */
    dismissalDate?: number;
    /**
     * 10 for a state change the user cares about, 5 for routine churn. Apple
     * throttles activities that burn their budget at 10; Vyre sends roughly
     * four pushes per transfer, so 10 is affordable.
     */
    priority?: 5 | 10;
};

function baseNotification(options?: LiveActivityOptions): apn.Notification {
    const n = new apn.Notification();
    n.topic = `${config.apns.bundleId}.push-type.liveactivity`;
    n.pushType = 'liveactivity';
    n.priority = options?.priority ?? 10;
    n.expiry = Math.floor(Date.now() / 1000) + 3600;
    (n as any).timestamp = Math.floor(Date.now() / 1000);
    return n;
}

function applyDates(n: apn.Notification, options?: LiveActivityOptions): void {
    if (options?.staleDate) (n as any).staleDate = options.staleDate;
    if (options?.dismissalDate) (n as any).dismissalDate = options.dismissalDate;
}

export function buildStartNotification(params: {
    identity: ActivityIdentity;
    /** `{ uiJsonData }` for static, `{ props }` for dynamic. */
    contentState: Record<string, any>;
    alert: { title: string; body: string; sound?: string };
    options?: LiveActivityOptions;
}): apn.Notification {
    const n = baseNotification(params.options);

    (n as any).event = 'start';
    (n as any).contentState = params.contentState;

    // attributes + attributes-type belong to `start` ONLY. An update or end goes
    // to the per-activity token, which already identifies the activity, and
    // leaking attributes-type onto an update is how you get a SECOND activity
    // instead of a changed one.
    const { identity } = params;
    if (identity.mode === 'dynamic') {
        (n as any).attributes = {
            name: identity.activityName,
            ...(identity.deepLinkUrl ? { deepLinkUrl: identity.deepLinkUrl } : {}),
        };
        (n as any).aps['attributes-type'] = dynamicAttributesType(identity.definitionId);
    } else {
        (n as any).attributes = { name: identity.activityName };
        (n as any).aps['attributes-type'] = VOLTRA_ATTRIBUTES_TYPE;
    }

    const alert: Record<string, any> = { title: params.alert.title, body: params.alert.body };
    if (params.alert.sound) alert.sound = params.alert.sound;
    n.alert = alert as any;

    applyDates(n, params.options);
    return n;
}

export function buildUpdateNotification(params: {
    contentState: Record<string, any>;
    options?: LiveActivityOptions;
}): apn.Notification {
    const n = baseNotification(params.options);
    (n as any).event = 'update';
    (n as any).contentState = params.contentState;
    applyDates(n, params.options);
    return n;
}

export function buildEndNotification(params: {
    finalContentState?: Record<string, any>;
    /** Unix SECONDS. Defaults to now, i.e. dismiss immediately. */
    dismissalDate?: number;
    options?: LiveActivityOptions;
}): apn.Notification {
    const n = baseNotification(params.options);
    (n as any).event = 'end';
    if (params.finalContentState) {
        (n as any).contentState = params.finalContentState;
    }
    (n as any).dismissalDate = params.dismissalDate ?? Math.floor(Date.now() / 1000);
    if (params.options?.staleDate) (n as any).staleDate = params.options.staleDate;
    return n;
}

/** Serialised byte length. The thing APNs actually measures. */
export function payloadBytes(n: apn.Notification): number {
    return Buffer.byteLength((n as any).compile(), 'utf8');
}

// ─── Service ────────────────────────────────────────────────────────────────

class ApnsService {
    private provider: apn.Provider | null = null;

    private getProvider(): apn.Provider {
        if (this.provider) return this.provider;

        if (!config.apns.keyId || !config.apns.teamId || !config.apns.keyContent) {
            throw new Error(
                '[APNS] Missing credentials. Set APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_CONTENT.',
            );
        }

        // Spondle hardcoded `production: true` here while logging
        // config.apns.production. A development-signed build gets a SANDBOX
        // token, and a sandbox token on the production gateway is
        // BadDeviceToken every time.
        const production = Boolean(config.apns.production);

        this.provider = new apn.Provider({
            token: {
                key: config.apns.keyContent,
                keyId: config.apns.keyId,
                teamId: config.apns.teamId,
            },
            production,
        });

        logger.info(`[APNS] provider up (${production ? 'production' : 'sandbox'} gateway)`, {
            bundleId: config.apns.bundleId,
        });

        const client = (this.provider as any).client;
        if (client?.on) {
            client.on('error', (err: any) =>
                logger.error('[APNS] HTTP/2 client error', { message: err?.message, code: err?.code }));
            client.on('goaway', (errorCode: any, lastStreamID: any) =>
                logger.error('[APNS] HTTP/2 GOAWAY', { errorCode, lastStreamID }));
            client.on('close', () => logger.warn('[APNS] HTTP/2 connection closed'));
            client.on('sessionError', (err: any) =>
                logger.error('[APNS] HTTP/2 session error', { message: err?.message }));
        }

        return this.provider;
    }

    private async send(
        notification: apn.Notification,
        token: string,
        label: string,
    ): Promise<ApnsResult> {
        // Fail here, with the number, rather than at Apple with PayloadTooLarge.
        const bytes = payloadBytes(notification);
        if (bytes > MAX_PAYLOAD_BYTES) {
            logger.error(`[APNS] ${label} payload too large`, { bytes, limit: MAX_PAYLOAD_BYTES });
            return {
                success: false,
                verdict: 'terminal',
                error: `Payload ${bytes}B exceeds ${MAX_PAYLOAD_BYTES}B — shrink the layout (budget ≈${MAX_LAYOUT_BYTES}B before escaping)`,
            };
        }

        let last: ApnsResult = { success: false, verdict: 'terminal', error: 'not attempted' };

        for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
            try {
                const result = await this.getProvider().send(notification, token);

                if (!result.failed?.length) {
                    if (attempt > 1) logger.info(`[APNS] ${label} sent on attempt ${attempt}`, { bytes });
                    return { success: true, verdict: 'sent' };
                }

                const failure: any = result.failed[0];
                const reason: string | undefined = failure.response?.reason;
                const errorMsg: string | undefined = failure.error?.message;
                const verdict = classify(reason, errorMsg);

                logger.warn(`[APNS] ${label} attempt ${attempt} failed`, {
                    verdict,
                    reason,
                    status: failure.status,
                    errorMessage: errorMsg,
                    errorCode: failure.error?.code,
                    tokenPrefix: String(failure.device ?? token).slice(0, 12),
                    bytes,
                });

                last = {
                    success: false,
                    verdict,
                    reason,
                    error: reason ?? errorMsg ?? 'Unknown APNS error',
                };

                if (verdict === 'prune-token' || verdict === 'terminal') return last;
                if (attempt > MAX_RETRIES) return last;

                if (verdict === 'retry-reconnect') {
                    // Spondle shut the provider down on every retry. It is a
                    // SHARED singleton, so one bad stream tears the HTTP/2
                    // session out from under every other in-flight send —
                    // which manufactures more connection errors. Scoped to
                    // connection-level verdicts only; a 429 no longer does it.
                    await this.shutdown();
                }
                await sleep(RETRY_DELAY_MS * attempt);
            } catch (err: any) {
                const errorMsg = err?.message ?? String(err);
                const verdict = classify(undefined, errorMsg);
                logger.error(`[APNS] ${label} attempt ${attempt} threw`, { verdict, errorMsg });

                last = { success: false, verdict, error: errorMsg };
                if (verdict === 'terminal' || attempt > MAX_RETRIES) return last;
                if (verdict === 'retry-reconnect') await this.shutdown();
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }

        return last;
    }

    /**
     * Create an activity on a device, app running or not. Needs iOS 17.2+ and a
     * push-to-start token. Below 17.2 only the app can start one.
     */
    async startLiveActivity(
        pushToStartToken: string,
        identity: ActivityIdentity,
        contentState: Record<string, any>,
        alert: { title: string; body: string; sound?: string },
        options?: LiveActivityOptions,
    ): Promise<ApnsResult> {
        try {
            return await this.send(
                buildStartNotification({ identity, contentState, alert, options }),
                pushToStartToken,
                `LA start (${identity.mode})`,
            );
        } catch (err: any) {
            logger.error('[APNS] LA start build error', { error: err?.message });
            return { success: false, verdict: 'terminal', error: err?.message ?? String(err) };
        }
    }

    /** Update one activity. Requires its PER-ACTIVITY token, not push-to-start. */
    async updateLiveActivity(
        activityPushToken: string,
        contentState: Record<string, any>,
        options?: LiveActivityOptions,
    ): Promise<ApnsResult> {
        try {
            return await this.send(
                buildUpdateNotification({ contentState, options }),
                activityPushToken,
                'LA update',
            );
        } catch (err: any) {
            logger.error('[APNS] LA update build error', { error: err?.message });
            return { success: false, verdict: 'terminal', error: err?.message ?? String(err) };
        }
    }

    /**
     * End one activity. Requires its PER-ACTIVITY token.
     *
     * A push-to-start token will NOT work here, whatever Spondle's
     * dismissViaFallback comment claims: that token is only valid for
     * event:'start', and an end carries no attributes-type for Apple to match.
     * It fails silently, and because Spondle marks the row ENDED regardless of
     * the result, the DB says gone while the activity sits on the lock screen
     * until its dismissalDate. Hence: no fallback here, and callers must key
     * their status write off `verdict`.
     */
    async endLiveActivity(
        activityPushToken: string,
        finalContentState?: Record<string, any>,
        dismissalDate?: number,
        options?: LiveActivityOptions,
    ): Promise<ApnsResult> {
        try {
            return await this.send(
                buildEndNotification({ finalContentState, dismissalDate, options }),
                activityPushToken,
                'LA end',
            );
        } catch (err: any) {
            logger.error('[APNS] LA end build error', { error: err?.message });
            return { success: false, verdict: 'terminal', error: err?.message ?? String(err) };
        }
    }

    async shutdown(): Promise<void> {
        if (this.provider) {
            await this.provider.shutdown();
            this.provider = null;
            logger.info('[APNS] provider shut down');
        }
    }
}

export default new ApnsService();