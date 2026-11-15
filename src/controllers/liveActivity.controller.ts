// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/liveActivity.controller.ts
//
// Four endpoints, all of them things only the device can tell the server.
// Nothing here starts, advances or ends an activity — that is the service's job,
// driven by webhooks. A client that could end another user's activity by
// calling an endpoint would be a problem; these only report.
//
//   POST /devices/live-activity-token   the device's push-to-start token
//   POST /live-activities/register      an activity the APP started
//   POST /live-activities/token         a per-activity token from Voltra
//   POST /live-activities/state         the device's view (dismissed / ended)
//
// userId always comes from the authenticated session, never the body. ⚠ adjust
// `currentUserId` below to Vyre's auth middleware.
// ─────────────────────────────────────────────────────────────────────────────

import type { Request, Response } from 'express';
import liveActivityService, { type RenderMode } from '../services/liveActivity.service';
import logger from '../config/logger';            // ← adjust to Vyre's path

/**
 * ⚠ Vyre-specific. Clerk middleware usually leaves the internal user on the
 * request; match whatever the notification and device controllers already do
 * rather than trusting anything in the body.
 */
function currentUserId(req: Request): string | undefined {
    return (req as any).user?.id ?? (req as any).auth?.userId;
}

function bad(res: Response, message: string) {
    return res.status(400).json({ success: false, message });
}

const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// POST /devices/live-activity-token
//
// Fires once per app start on iOS 17.2+, and again whenever the token rotates.
// Below 17.2 the client never emits one, so its absence is normal rather than a
// failure — it just means this device cannot be sent a push-to-start.
// ─────────────────────────────────────────────────────────────────────────────

export async function putPushToStartToken(req: Request, res: Response) {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'unauthenticated' });

    const pushToStartToken = str(req.body?.pushToStartToken);
    // The DeviceToken row's primary key, i.e. the device's Expo push token.
    const deviceToken = str(req.body?.deviceToken);

    if (!pushToStartToken) return bad(res, 'pushToStartToken is required');
    if (!deviceToken) return bad(res, 'deviceToken is required');

    try {
        const row = await liveActivityService.recordPushToStartToken(deviceToken, pushToStartToken);

        // null means the DeviceToken row is gone — the device deregistered
        // between emitting the token and this call. Not an error worth a 500.
        return res.status(200).json({ success: true, recorded: Boolean(row) });
    } catch (err: any) {
        logger.error('[LA] putPushToStartToken failed', { userId, error: err?.message });
        return res.status(500).json({ success: false, message: 'could not store the token' });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /live-activities/register
//
// The app started an activity itself and is telling the server, so the server
// can take over updates. This is the primary path for anything the user
// initiates in-app: it works on iOS 16.1+ and the per-activity token is
// available immediately, where a server-started activity is write-once until
// the app next opens.
// ─────────────────────────────────────────────────────────────────────────────

export async function registerActivity(req: Request, res: Response) {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'unauthenticated' });

    const subjectType = str(req.body?.subjectType);
    const subjectId = str(req.body?.subjectId);
    const activityId = str(req.body?.activityId);
    const props = req.body?.props;

    if (!subjectType) return bad(res, 'subjectType is required');
    if (!subjectId) return bad(res, 'subjectId is required');
    if (!activityId) return bad(res, 'activityId is required');
    if (!props || typeof props !== 'object') return bad(res, 'props is required');

    const renderMode: RenderMode = req.body?.renderMode === 'DYNAMIC' ? 'DYNAMIC' : 'STATIC';

    try {
        const row = await liveActivityService.registerClientStarted({
            userId,
            subjectType,
            subjectId,
            activityId,
            activityPushToken: str(req.body?.activityPushToken),
            deviceToken: str(req.body?.deviceToken),
            virtualTransactionId: str(req.body?.virtualTransactionId),
            renderMode,
            props,
        });

        return res.status(200).json({ success: true, id: row.id });
    } catch (err: any) {
        logger.error('[LA] registerActivity failed', {
            userId, subjectType, subjectId, error: err?.message,
        });
        return res.status(500).json({ success: false, message: 'could not register the activity' });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /live-activities/token
//
// Voltra's activityTokenReceived gives the client only { activityName,
// pushToken } — no subject and no targetId. So the client forwards exactly that
// and the server resolves which activity it belongs to.
//
// Spondle instead reads a module-level `currentChoreInstanceId` inside the
// handler, which misfiles the token when a second start beats the first token,
// and does nothing at all when a token rotates with no start in flight.
// ─────────────────────────────────────────────────────────────────────────────

export async function putActivityToken(req: Request, res: Response) {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'unauthenticated' });

    const activityName = str(req.body?.activityName);
    const pushToken = str(req.body?.pushToken);

    if (!activityName) return bad(res, 'activityName is required');
    if (!pushToken) return bad(res, 'pushToken is required');

    try {
        const row = await liveActivityService.attachTokenByActivityName({
            userId,
            activityName,
            pushToken,
            deviceToken: str(req.body?.deviceToken),
        });

        // null is fine: a token can arrive for an activity the server never
        // recorded, or just after one ended.
        return res.status(200).json({ success: true, attached: Boolean(row) });
    } catch (err: any) {
        logger.error('[LA] putActivityToken failed', { userId, activityName, error: err?.message });
        return res.status(500).json({ success: false, message: 'could not attach the token' });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /live-activities/state
//
// From Voltra's stateChange event. The device-side half of the stale-card
// problem: an activity the user swiped away, or that iOS ended on its own, is
// gone from the device while the row still reads ACTIVE. 'stale' is NOT
// terminal — iOS greys the card and the next update revives it — so the service
// only acts on 'dismissed' and 'ended'.
// ─────────────────────────────────────────────────────────────────────────────

export async function putActivityState(req: Request, res: Response) {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ success: false, message: 'unauthenticated' });

    const activityName = str(req.body?.activityName);
    const activityState = str(req.body?.activityState);

    if (!activityName) return bad(res, 'activityName is required');
    if (!activityState) return bad(res, 'activityState is required');

    try {
        const row = await liveActivityService.recordStateChange({ userId, activityName, activityState });
        return res.status(200).json({ success: true, closed: Boolean(row) });
    } catch (err: any) {
        logger.error('[LA] putActivityState failed', { userId, activityName, error: err?.message });
        return res.status(500).json({ success: false, message: 'could not record the state' });
    }
}