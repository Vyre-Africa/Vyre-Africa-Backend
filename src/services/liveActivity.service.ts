// ─────────────────────────────────────────────────────────────────────────────
// src/services/liveActivity.service.ts
//
// Generic orchestration. Keyed on (subjectType, subjectId, userId) — nothing in
// here names a payment rail, a provider or a flow, so a new subject is a
// mapping function that produces VyreActivityProps, not new infrastructure.
//
// Four behaviours that differ from Spondle's version, each a bug in theirs:
//
//   1. Every status write is conditional on the APNs verdict. Spondle writes
//      status: 'ENDED' outside its if/else, so a failed end still records
//      ENDED — DB says gone, card stays on the lock screen until its
//      dismissalDate.
//   2. A dead token is cleared. Spondle marks the ACTIVITY failed but never
//      touches the token, so a dead push-to-start token is retried on every
//      future activity forever.
//   3. No push-to-start fallback for ending. That token is only valid for
//      event:'start'; an end carries no attributes-type for Apple to match, so
//      Spondle's dismissViaFallback cannot work.
//   4. Superseding is explicit. Voltra allows one activity per activityName, so
//      starting a second silently replaces the first. Here the displaced row is
//      ended and logged rather than orphaned.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import apnsService, { MAX_LAYOUT_BYTES, type ActivityIdentity } from './apns.service';
import { renderLiveActivityToString } from '@use-voltra/ios-server';
import {
    buildVyreActivityLayout,
    type VyreActivityProps,
} from './liveActivities/VyreActivity';

/**
 * The activity's name. Note this is NOT a concurrency slot: an earlier draft
 * said one activity per name, which was Spondle's own constraint rather than
 * Voltra's. The client addresses activities by the targetId returned from
 * startLiveActivity, so concurrent activities are fine; only
 * isLiveActivityActive() is name-keyed.
 */
const ACTIVITY_NAME = 'VyreActivity';

/**
 * Definition id for DYNAMIC mode. Must match the `id` in app.json's
 * `liveActivities` entry exactly — the plugin derives the generated Swift
 * attributes struct from it, so a mismatch means Apple has no type to attach
 * the activity to and the start is rejected.
 */
const DEFINITION_ID = 'vyre_activity';

export type RenderMode = 'STATIC' | 'DYNAMIC';

/** Give up re-sending an end after this many tries. */
const MAX_END_ATTEMPTS = 4;

/** Default greying point if the caller gives none. */
const DEFAULT_STALE_MS = 15 * 60 * 1000;

/**
 * Default hard dismissal if the caller gives none. The safety net for an end
 * push that never lands — without it a stuck activity sits there until iOS's
 * own 12-hour ceiling.
 */
const DEFAULT_DISMISS_MS = 2 * 60 * 60 * 1000;

/** Force-end an ACTIVE row nothing has touched for this long. */
const ORPHAN_AFTER_MS = 6 * 60 * 60 * 1000;

type SubjectKey = {
    userId: string;
    subjectType: string;
    subjectId: string;
};

type StartParams = SubjectKey & {
    props: VyreActivityProps;
    /** Lock-screen alert for the push that CREATES the activity. */
    alert: { title: string; body: string; sound?: string };
    /** Set when the subject is a transaction, for the FK and cascade delete. */
    virtualTransactionId?: string;
    staleAfterMs?: number;
    dismissAfterMs?: number;
    /**
     * STATIC renders the whole UI server-side into { uiJsonData } — the card can
     * be redesigned without an app release. DYNAMIC sends { props } against the
     * definition bundled in the app — tiny payloads and one copy of the layout,
     * but a redesign needs a release, and it is @experimental in Voltra 2.4.0.
     *
     * Stored on the row, because advance() and finish() must use the same shape
     * as the start did: a dynamic activity handed { uiJsonData } decodes nothing.
     */
    renderMode?: RenderMode;
};

export type StartOutcome =
    | { started: true; id: string }
    | { started: false; reason: string };

class LiveActivityService {

    // ── Tokens from the client ──────────────────────────────────────────────

    /**
     * Store a device's push-to-start token. iOS 17.2+ only; below that the
     * client never emits one and the server can only update an activity the app
     * itself started.
     *
     * Keyed by the DeviceToken PK, which IS the push token in this schema.
     */
    async recordPushToStartToken(deviceTokenId: string, pushToStartToken: string) {
        try {
            return await prisma.deviceToken.update({
                where: { token: deviceTokenId },
                data: {
                    liveActivityPushToStartToken: pushToStartToken,
                    liveActivityTokenUpdatedAt: new Date(),
                },
            });
        } catch (err: any) {
            // P2025 = no such row. The device deregistered between emitting the
            // token and this call; not worth throwing over.
            if (err?.code === 'P2025') {
                logger.warn('[LA] push-to-start token for unknown device', {
                    deviceTokenPrefix: deviceTokenId.slice(0, 12),
                });
                return null;
            }
            throw err;
        }
    }

    /**
     * Attach a per-activity token WITHOUT the client having to say which subject
     * it belongs to.
     *
     * Voltra's `activityTokenReceived` event carries only `{ activityName,
     * pushToken }` — no subject, no targetId. Spondle solves that by reading a
     * module-level `currentChoreInstanceId` inside the handler, which misfiles
     * the token whenever a second start happens before the first token arrives,
     * and silently does nothing when a token ROTATES later with no start in
     * flight.
     *
     * Resolving it server-side removes the race entirely: the backend already
     * knows which of this user's activities is live under that name. The client
     * forwards what the event gave it and tracks nothing.
     */
    async attachTokenByActivityName(params: {
        userId: string;
        activityName: string;
        pushToken: string;
        deviceToken?: string;
    }) {
        const row = await prisma.liveActivity.findFirst({
            where: { userId: params.userId, activityName: params.activityName, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
        });

        if (!row) {
            // Normal, not an error: a token can arrive for an activity the
            // server never recorded, or just after one ended.
            logger.info('[LA] token arrived with no active activity under that name', {
                userId: params.userId,
                activityName: params.activityName,
            });
            return null;
        }

        return prisma.liveActivity.update({
            where: { id: row.id },
            data: {
                activityPushToken: params.pushToken,
                ...(params.deviceToken ? { deviceToken: params.deviceToken } : {}),
                lastUpdatedAt: new Date(),
            },
        });
    }

    /**
     * Record an activity the CLIENT started.
     *
     * The app starting its own activity is the better path for anything the user
     * initiates in-app: it works on iOS 16.1+ rather than needing 17.2's
     * push-to-start, there is no push latency, and the per-activity token exists
     * from the first second — a server-started activity is write-once until the
     * app next opens.
     *
     * No APNs call here; the card already exists on the device. This only
     * records it so the server can drive it afterwards.
     */
    async registerClientStarted(params: SubjectKey & {
        /** The targetId returned by the client's startLiveActivity(). */
        activityId: string;
        activityPushToken?: string;
        deviceToken?: string;
        renderMode?: RenderMode;
        virtualTransactionId?: string;
        /** The state the client started with, so the server can resend it. */
        props: VyreActivityProps;
    }) {
        const renderMode: RenderMode = params.renderMode ?? 'STATIC';
        const contentState = await this.contentStateFor(renderMode, params.props);

        const row = await prisma.liveActivity.upsert({
            where: this.whereKey(params),
            create: {
                subjectType: params.subjectType,
                subjectId: params.subjectId,
                userId: params.userId,
                virtualTransactionId: params.virtualTransactionId ?? null,
                deviceToken: params.deviceToken ?? null,
                activityName: ACTIVITY_NAME,
                renderMode,
                definitionId: renderMode === 'DYNAMIC' ? DEFINITION_ID : null,
                activityId: params.activityId,
                activityPushToken: params.activityPushToken ?? null,
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                ...(contentState ? { lastContentState: contentState as Prisma.InputJsonValue } : {}),
                status: 'ACTIVE',
                platform: 'ios',
                startedAt: new Date(),
            },
            update: {
                virtualTransactionId: params.virtualTransactionId ?? null,
                ...(params.deviceToken ? { deviceToken: params.deviceToken } : {}),
                renderMode,
                definitionId: renderMode === 'DYNAMIC' ? DEFINITION_ID : null,
                activityId: params.activityId,
                ...(params.activityPushToken ? { activityPushToken: params.activityPushToken } : {}),
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                ...(contentState ? { lastContentState: contentState as Prisma.InputJsonValue } : {}),
                status: 'ACTIVE',
                startedAt: new Date(),
                endRequestedAt: null,
                endedAt: null,
                endAttempts: 0,
                errorMessage: null,
                lastUpdatedAt: new Date(),
            },
        });

        logger.info('[LA] client-started activity registered', {
            id: row.id,
            subjectType: params.subjectType,
            subjectId: params.subjectId,
            renderMode,
            hasToken: Boolean(params.activityPushToken),
        });
        return row;
    }

    /**
     * The client's view of reality, from Voltra's `stateChange` event.
     *
     * This is the device-side half of the stale-card problem the sweep handles
     * server-side: an activity the user swiped away, or that iOS ended on its
     * own, is gone from the device while the row still says ACTIVE. Spondle has
     * no equivalent, so its rows drift until something else notices.
     */
    async recordStateChange(params: {
        userId: string;
        activityName: string;
        /** 'active' | 'dismissed' | 'pending' | 'stale' | 'ended' | … */
        activityState: string;
    }) {
        if (params.activityState !== 'dismissed' && params.activityState !== 'ended') {
            // 'active', 'pending' and 'stale' need no bookkeeping. 'stale' in
            // particular is not terminal — iOS greys the card and the next
            // update revives it.
            return null;
        }

        const row = await prisma.liveActivity.findFirst({
            where: { userId: params.userId, activityName: params.activityName, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
        });
        if (!row) return null;

        logger.info('[LA] device reports the activity is gone', {
            id: row.id, activityState: params.activityState,
        });

        return prisma.liveActivity.update({
            where: { id: row.id },
            data: {
                status: 'ENDED',
                endedAt: new Date(),
                // Null the token: it is dead now, and keeping it means the sweep
                // would try to end an activity that no longer exists.
                activityPushToken: null,
                errorMessage: `device reported "${params.activityState}"`,
            },
        });
    }

    /**
     * Is a card currently up for this subject?
     *
     * For deciding whether to ALSO send a push notification. A completion that
     * fires both an activity's final frame and a DEPOSIT_CREDITED push buzzes
     * twice for one event, and the card already said it. Generic on purpose, so
     * that decision can be made per subject later without touching this file.
     */
    async isLive(key: SubjectKey): Promise<boolean> {
        const row = await prisma.liveActivity.findUnique({
            where: this.whereKey(key),
            select: { status: true },
        });
        return row?.status === 'ACTIVE';
    }

    // ── Start ───────────────────────────────────────────────────────────────

    async start(params: StartParams): Promise<StartOutcome> {
        const device = await this.pickDevice(params.userId);
        if (!device) {
            // Not an error. No iOS 17.2+ device has reported a token, so this
            // user simply does not get activities. Callers ignore this.
            return { started: false, reason: 'no push-to-start token for this user' };
        }

        const renderMode: RenderMode = params.renderMode ?? 'STATIC';

        const contentState = await this.contentStateFor(renderMode, params.props);
        if (!contentState) return { started: false, reason: 'could not render the content state' };

        const identity: ActivityIdentity =
            renderMode === 'DYNAMIC'
                ? {
                      mode: 'dynamic',
                      definitionId: DEFINITION_ID,
                      activityName: ACTIVITY_NAME,
                      deepLinkUrl: params.props.deepLink,
                  }
                : { mode: 'static', activityName: ACTIVITY_NAME };

        const now = Date.now();
        const staleDate = Math.floor((now + (params.staleAfterMs ?? DEFAULT_STALE_MS)) / 1000);
        const dismissalDate = Math.floor((now + (params.dismissAfterMs ?? DEFAULT_DISMISS_MS)) / 1000);

        // Voltra keys by activityName, so a second start REPLACES the first on
        // the device. End the displaced row rather than orphaning it — Spondle
        // drops it silently and its DB keeps claiming the old one is ACTIVE.
        await this.supersedeOthers(params, device.token);

        const result = await apnsService.startLiveActivity(
            device.liveActivityPushToStartToken!,
            identity,
            contentState,
            params.alert,
            { staleDate, dismissalDate, priority: 10 },
        );

        if (!result.success) {
            if (result.verdict === 'prune-token') {
                // The device is gone. Clearing it is the point: otherwise every
                // future activity for this user retries the same dead token.
                await this.pruneDeviceToken(device.token, result.reason);
            }
            logger.warn('[LA] start failed', {
                subjectType: params.subjectType,
                subjectId: params.subjectId,
                verdict: result.verdict,
                reason: result.reason ?? result.error,
            });
            return { started: false, reason: result.error ?? 'APNs rejected the start' };
        }

        // Written only after APNs accepted it, so an ACTIVE row means a card
        // really was created.
        const row = await prisma.liveActivity.upsert({
            where: this.whereKey(params),
            create: {
                subjectType: params.subjectType,
                subjectId: params.subjectId,
                userId: params.userId,
                virtualTransactionId: params.virtualTransactionId ?? null,
                deviceToken: device.token,
                activityName: ACTIVITY_NAME,
                renderMode,
                definitionId: renderMode === 'DYNAMIC' ? DEFINITION_ID : null,
                // activityId stays null: push-to-start returns none. Spondle
                // writes the activity NAME here because its column is non-null.
                activityId: null,
                activityPushToken: null,
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                lastContentState: contentState as Prisma.InputJsonValue,
                status: 'ACTIVE',
                platform: 'ios',
                startedAt: new Date(),
            },
            update: {
                virtualTransactionId: params.virtualTransactionId ?? null,
                deviceToken: device.token,
                renderMode,
                definitionId: renderMode === 'DYNAMIC' ? DEFINITION_ID : null,
                activityId: null,
                activityPushToken: null,
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                lastContentState: contentState as Prisma.InputJsonValue,
                status: 'ACTIVE',
                startedAt: new Date(),
                endRequestedAt: null,
                endedAt: null,
                endAttempts: 0,
                errorMessage: null,
                lastUpdatedAt: new Date(),
            },
        });

        logger.info('[LA] started', {
            id: row.id,
            subjectType: params.subjectType,
            subjectId: params.subjectId,
            steps: `${params.props.stepIndex + 1}/${params.props.stepCount}`,
        });
        return { started: true, id: row.id };
    }

    // ── Advance ─────────────────────────────────────────────────────────────

    /**
     * Push a new state to a running activity. Needs the per-activity token, so
     * it is a no-op until the client has reported one — which is why a
     * push-to-start activity on a never-opened app cannot be updated.
     */
    async advance(params: SubjectKey & { props: VyreActivityProps }) {
        const row = await prisma.liveActivity.findUnique({ where: this.whereKey(params) });

        if (!row || row.status !== 'ACTIVE') return { updated: false, reason: 'no active activity' };
        if (!row.activityPushToken) {
            logger.info('[LA] advance skipped — client has not reported a token yet', { id: row.id });
            return { updated: false, reason: 'no per-activity token' };
        }

        // The row's mode, not a parameter: a dynamic activity handed
        // { uiJsonData } decodes nothing, and vice versa.
        const contentState = await this.contentStateFor(row.renderMode as RenderMode, params.props);
        if (!contentState) return { updated: false, reason: 'could not render the content state' };

        const result = await apnsService.updateLiveActivity(row.activityPushToken, contentState, {
            priority: 10,
        });

        if (!result.success) {
            if (result.verdict === 'prune-token') {
                // The activity is gone from the device. Nothing left to end, so
                // this row is terminal — but FAILED, not ENDED, because it did
                // not finish the way the subject did.
                await prisma.liveActivity.update({
                    where: { id: row.id },
                    data: {
                        status: 'FAILED',
                        activityPushToken: null,
                        errorMessage: result.reason ?? result.error,
                        endedAt: new Date(),
                    },
                });
                logger.warn('[LA] advance: activity token dead, row closed', { id: row.id, reason: result.reason });
                return { updated: false, reason: result.error };
            }

            // Transient. Leave the row ACTIVE and keep the old lastContentState
            // so a later advance or the sweep can still act. Spondle marks it
            // FAILED here, so one 429 and the activity never updates again.
            await prisma.liveActivity.update({
                where: { id: row.id },
                data: { errorMessage: result.reason ?? result.error },
            });
            logger.warn('[LA] advance failed, row left ACTIVE', {
                id: row.id, verdict: result.verdict, reason: result.reason ?? result.error,
            });
            return { updated: false, reason: result.error };
        }

        await prisma.liveActivity.update({
            where: { id: row.id },
            data: {
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                lastContentState: contentState as Prisma.InputJsonValue,
                errorMessage: null,
                lastUpdatedAt: new Date(),
            },
        });

        return { updated: true };
    }

    // ── Finish ──────────────────────────────────────────────────────────────

    /**
     * Terminal state, then dismissal. `props.state` should already be
     * 'succeeded' or 'failed' — the user sees this frame briefly before the
     * card goes, and it is the frame that tells them what happened.
     *
     * `lingerMs` keeps it on screen after the final state lands. Dismissing
     * instantly means the resolution is never read.
     */
    async finish(params: SubjectKey & {
        props: VyreActivityProps;
        lingerMs?: number;
    }) {
        const row = await prisma.liveActivity.findUnique({ where: this.whereKey(params) });
        if (!row || row.status !== 'ACTIVE') return { ended: false, reason: 'no active activity' };

        const contentState = await this.contentStateFor(row.renderMode as RenderMode, params.props);
        const dismissalDate = Math.floor((Date.now() + (params.lingerMs ?? 30_000)) / 1000);

        // Mark the intent BEFORE sending. If the process dies mid-send, the
        // sweep can still find this and retry — that is what endRequestedAt is
        // for.
        await prisma.liveActivity.update({
            where: { id: row.id },
            data: {
                endRequestedAt: new Date(),
                stepIndex: params.props.stepIndex,
                stepCount: params.props.stepCount,
                stepLabel: params.props.stepLabel,
                ...(contentState ? { lastContentState: contentState as Prisma.InputJsonValue } : {}),
            },
        });

        if (!row.activityPushToken) {
            // No per-activity token means no way to end it remotely. Spondle
            // tries the push-to-start token here; that token is only valid for
            // event:'start' and the attempt fails silently. The honest answer
            // is to lean on the dismissalDate set at start and say so.
            logger.warn('[LA] finish: no per-activity token — relying on dismissalDate', {
                id: row.id, subjectType: params.subjectType, subjectId: params.subjectId,
            });
            await prisma.liveActivity.update({
                where: { id: row.id },
                data: {
                    status: 'FAILED',
                    errorMessage: 'no per-activity token; dismissal left to iOS',
                    endedAt: new Date(),
                },
            });
            return { ended: false, reason: 'no per-activity token' };
        }

        return this.sendEnd(row.id, row.activityPushToken, contentState, dismissalDate, row.endAttempts);
    }

    /** Shared by finish() and the sweep so the bookkeeping cannot diverge. */
    private async sendEnd(
        id: string,
        token: string,
        contentState: Record<string, any> | null,
        dismissalDate: number,
        priorAttempts: number,
    ) {
        const result = await apnsService.endLiveActivity(
            token,
            contentState ?? undefined,
            dismissalDate,
        );

        if (result.success) {
            await prisma.liveActivity.update({
                where: { id },
                data: {
                    status: 'ENDED',
                    endedAt: new Date(),
                    endAttempts: priorAttempts + 1,
                    errorMessage: null,
                },
            });
            return { ended: true };
        }

        const attempts = priorAttempts + 1;
        const dead = result.verdict === 'prune-token';
        const exhausted = attempts >= MAX_END_ATTEMPTS;

        // ENDED is only ever written on success. A dead token means the card is
        // already gone from the device, so ENDED is true then too.
        await prisma.liveActivity.update({
            where: { id },
            data: {
                status: dead ? 'ENDED' : exhausted ? 'FAILED' : 'ACTIVE',
                endAttempts: attempts,
                errorMessage: result.reason ?? result.error,
                ...(dead || exhausted ? { endedAt: new Date() } : {}),
                ...(dead ? { activityPushToken: null } : {}),
            },
        });

        logger.warn('[LA] end failed', {
            id, attempts, verdict: result.verdict,
            reason: result.reason ?? result.error,
            outcome: dead ? 'token dead, card already gone' : exhausted ? 'giving up' : 'will retry',
        });
        return { ended: false, reason: result.error };
    }

    // ── Sweep ───────────────────────────────────────────────────────────────

    /**
     * Run on a schedule, like Push_Receipt_Sweep. Two jobs:
     *   · retry ends that were requested but never confirmed
     *   · force-end activities nothing has touched in hours
     *
     * This is the half of the design that makes "status only on success" safe.
     * Without it, a transient failure at end time leaves a card up forever.
     */
    async sweep() {
        let retried = 0;
        let forced = 0;

        const pending = await prisma.liveActivity.findMany({
            where: {
                status: 'ACTIVE',
                endRequestedAt: { not: null },
                endAttempts: { lt: MAX_END_ATTEMPTS },
                activityPushToken: { not: null },
            },
            take: 100,
            orderBy: { endRequestedAt: 'asc' },
        });

        for (const row of pending) {
            const r = await this.sendEnd(
                row.id,
                row.activityPushToken!,
                (row.lastContentState as Record<string, any> | null) ?? null,
                Math.floor(Date.now() / 1000),
                row.endAttempts,
            );
            if (r.ended) retried++;
        }

        // Orphans: started, never finished, nobody is coming. The subject
        // presumably resolved without anyone calling finish().
        const orphans = await prisma.liveActivity.findMany({
            where: {
                status: 'ACTIVE',
                endRequestedAt: null,
                lastUpdatedAt: { lt: new Date(Date.now() - ORPHAN_AFTER_MS) },
            },
            take: 100,
        });

        for (const row of orphans) {
            logger.warn('[LA] orphan swept', {
                id: row.id, subjectType: row.subjectType, subjectId: row.subjectId,
                ageHours: ((Date.now() - row.lastUpdatedAt.getTime()) / 3_600_000).toFixed(1),
            });
            if (row.activityPushToken) {
                await prisma.liveActivity.update({
                    where: { id: row.id }, data: { endRequestedAt: new Date() },
                });
                const r = await this.sendEnd(
                    row.id,
                    row.activityPushToken,
                    (row.lastContentState as Record<string, any> | null) ?? null,
                    Math.floor(Date.now() / 1000),
                    row.endAttempts,
                );
                if (r.ended) forced++;
            } else {
                await prisma.liveActivity.update({
                    where: { id: row.id },
                    data: {
                        status: 'FAILED',
                        endedAt: new Date(),
                        errorMessage: 'orphaned with no per-activity token',
                    },
                });
            }
        }

        if (retried || forced || pending.length || orphans.length) {
            logger.info('[LA] sweep', {
                pending: pending.length, retried, orphans: orphans.length, forced,
            });
        }
        return { pending: pending.length, retried, orphans: orphans.length, forced };
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private whereKey(k: SubjectKey) {
        return {
            subjectType_subjectId_userId: {
                subjectType: k.subjectType,
                subjectId: k.subjectId,
                userId: k.userId,
            },
        };
    }

    /**
     * Most recently reported push-to-start token wins. One activity per user
     * per subject, so multi-device means it lands on the device the user most
     * recently had the app open on — which is the best available guess at where
     * they are looking.
     */
    private async pickDevice(userId: string) {
        return prisma.deviceToken.findFirst({
            where: {
                userId,
                platform: 'ios',
                liveActivityPushToStartToken: { not: null },
            },
            orderBy: { liveActivityTokenUpdatedAt: 'desc' },
        });
    }

    private async pruneDeviceToken(deviceTokenId: string, reason?: string) {
        await prisma.deviceToken.update({
            where: { token: deviceTokenId },
            data: { liveActivityPushToStartToken: null, liveActivityTokenUpdatedAt: null },
        }).catch(() => undefined);
        logger.warn('[LA] cleared dead push-to-start token', {
            deviceTokenPrefix: deviceTokenId.slice(0, 12), reason,
        });
    }

    /**
     * Render, then refuse anything over budget. Returning null rather than
     * throwing keeps a too-large layout from taking down the caller — a missing
     * activity is a far smaller problem than a failed webhook.
     */
    private async contentStateFor(
        mode: RenderMode,
        props: VyreActivityProps,
    ): Promise<Record<string, any> | null> {
        // DYNAMIC: no rendering at all. The definition bundled in the app owns
        // the layout and receives these props as its contract, so the payload is
        // the props themselves — a couple of hundred bytes rather than a
        // compressed view tree. VyreActivityProps is already JSON-safe (strings,
        // numbers, one nested object), which is what makes this a free swap.
        //
        // The cost: the app's bundled definition and this props shape must agree.
        // Add a field here and an older app simply ignores it; rename one and
        // the card renders wrong with no error anywhere. Version the props if
        // this mode goes to production.
        if (mode === 'DYNAMIC') {
            return { props: props as unknown as Record<string, any> };
        }

        let uiJsonData: string;

        try {
            uiJsonData = await renderLiveActivityToString(buildVyreActivityLayout(props));
        } catch (err: any) {
            // renderLiveActivityToString THROWS when the compressed tree passes
            // Voltra's own safe budget:
            //   "[Voltra] Compressed payload size 3808B exceeds safe budget
            //    3345B (ActivityKit hard cap 4096B)"
            // Without this catch that throw propagates out of start/advance/
            // finish and into the caller — which for a real subject is a
            // webhook handler. A missing activity is a far smaller problem than
            // a failed webhook, so degrade rather than throw.
            logger.error('[LA] render failed — no activity for this state', {
                error: err?.message,
                title: props.title,
                stepCount: props.stepCount,
            });
            return null;
        }

        // Belt and braces. Voltra throws above at its own 3345B ceiling, so
        // this only catches the band between our budget and theirs — but the
        // rendered size is CONTENT-dependent (the tree is compressed, so
        // repetitive copy is nearly free and random ids are not), which means
        // it cannot be predicted from the layout and has to be measured on
        // every render.
        if (uiJsonData.length > MAX_LAYOUT_BYTES) {
            logger.error('[LA] layout over budget — not sending', {
                bytes: uiJsonData.length,
                budget: MAX_LAYOUT_BYTES,
                title: props.title,
            });
            return null;
        }

        return { uiJsonData };
    }

    /**
     * End any other ACTIVE activity in this slot for this user. Voltra permits
     * one per activityName, so without this the device quietly swaps cards and
     * the old row stays ACTIVE forever, which then confuses the sweep.
     */
    private async supersedeOthers(key: SubjectKey, deviceToken: string) {
        const others = await prisma.liveActivity.findMany({
            where: {
                userId: key.userId,
                activityName: ACTIVITY_NAME,
                status: 'ACTIVE',
                NOT: { subjectType: key.subjectType, subjectId: key.subjectId },
            },
        });

        for (const other of others) {
            logger.info('[LA] superseding', {
                displaced: other.id,
                displacedSubject: `${other.subjectType}:${other.subjectId}`,
                incomingSubject: `${key.subjectType}:${key.subjectId}`,
                note: 'Voltra allows one activity per activityName',
            });

            if (other.activityPushToken) {
                await apnsService.endLiveActivity(
                    other.activityPushToken, undefined, Math.floor(Date.now() / 1000),
                );
            }
            await prisma.liveActivity.update({
                where: { id: other.id },
                data: {
                    status: 'ENDED',
                    endedAt: new Date(),
                    errorMessage: `superseded by ${key.subjectType}:${key.subjectId}`,
                },
            });
        }
    }
}

export default new LiveActivityService();