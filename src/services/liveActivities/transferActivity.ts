// ─────────────────────────────────────────────────────────────────────────────
// src/services/transferActivity.ts   (BACKEND)
//
// The domain adapter. liveActivityService is deliberately subject-agnostic —
// it knows about subjects, steps and tokens, and nothing about money. This file
// is the one place that knows a Vyre stablecoin→fiat transfer, so when the
// cross-border provider changes (Nuvion), this is the file that moves and the
// transport underneath it does not.
//
// Three rules it exists to enforce:
//
//   1. Currency codes in, artwork out. Call sites pass 'USDC' and 'NGN'. They
//      never hand-write an assetName, so a corridor that has no bundled icon
//      degrades to an SF Symbol instead of pointing at a missing imageset.
//
//   2. Nothing here throws. A Live Activity is decoration on top of a money
//      movement. If APNs is down, the transfer still happens. Every function
//      swallows its own errors into the log and returns void.
//
//   3. Start is the only call that knows both currencies. Everything after it
//      sends a patch and the pair is merged back from the row. That is what
//      makes this usable from a provider webhook, which carries a reference
//      and a status and nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import logger from '../../config/logger';
import liveActivityService from '../liveActivity.service';
import { assetFor } from './VyreActivity';

/** Keyed per subject, so a user can have one transfer card at a time. */
const SUBJECT_TYPE = 'transfer';

/**
 * The stages of a stablecoin→fiat payout, in order.
 *
 * Four, because the chevron track draws one per step and more than about six
 * stops reading as progress and starts reading as texture. These are the
 * customer's words, not the provider's: 'Converting' rather than
 * 'swap_pending', 'Paid out' rather than 'payout_settled'.
 *
 * The count is fixed for the life of a card. stepCount is written once at start
 * and advance only patches stepIndex, so the number of chevrons cannot change
 * mid-transfer — which it would if each webhook supplied its own list.
 */
export const TRANSFER_STEPS = ['Received', 'Converting', 'Sending', 'Paid out'] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];

/** Where tapping the card lands. A URL, never a router path — see +native-intent.ts. */
const DEEP_LINK = 'vyre://activity';

/**
 * Start the card.
 *
 * Call this AFTER the transfer row exists — it needs the id for the subject key
 * — and do not await it in the request path:
 *
 *     void startTransferCard({ ... });
 *
 * It does a device lookup and an APNs round trip, which is 100–300ms you do not
 * want in front of the customer. Not awaiting means failures surface only in
 * the log, which is the right trade for something decorative. (Safe on Express;
 * on a platform that freezes the process after the response, await it instead.)
 */
export async function startTransferCard(input: {
    userId: string;
    /** The transfer's own id. Becomes subjectId, so it must be stable. */
    transferId: string;
    /** Source asset code, e.g. 'USDC' / 'USDT'. */
    fromCurrency: string;
    /** Destination fiat code, e.g. 'NGN' / 'KES'. */
    toCurrency: string;
    /** Set when a VirtualTransaction row exists, for the FK and cascade delete. */
    virtualTransactionId?: string;
}): Promise<void> {
    try {
        const from = assetFor(input.fromCurrency);
        const to = assetFor(input.toCurrency);

        const outcome = await liveActivityService.start({
            userId: input.userId,
            subjectType: SUBJECT_TYPE,
            subjectId: input.transferId,
            virtualTransactionId: input.virtualTransactionId,
            props: {
                from,
                to,
                stepIndex: 0,
                stepCount: TRANSFER_STEPS.length,
                stepLabel: TRANSFER_STEPS[0],
                state: 'in_progress',
                deepLink: DEEP_LINK,
            },
            // The alert for the push that CREATES the activity — this is a
            // banner on the lock screen, so it carries no amount and no
            // recipient, same rule as the card itself. The pair is not private:
            // it says what kind of transfer, not whose or how much.
            alert: {
                title: 'Transfer started',
                body: `${from.code} → ${to.code}`,
            },
            // Greys the card if nothing has updated it in 20 minutes, so a
            // stalled transfer looks stalled rather than looking live.
            staleAfterMs: 20 * 60 * 1000,
            // Hard ceiling. The sweep normally ends cards properly; this is the
            // net for an end push that never lands.
            dismissAfterMs: 3 * 60 * 60 * 1000,
        });

        if (!outcome.started) {
            // Expected often enough to be info, not warn: a user with no iOS
            // 17.2+ device simply has no push-to-start token.
            logger.info('[LA] transfer card not started', {
                transferId: input.transferId,
                reason: outcome.reason,
            });
            return;
        }

        logger.info('[LA] transfer card started', {
            transferId: input.transferId,
            pair: `${from.code} → ${to.code}`,
            // Logged because a missing assetName is the difference between the
            // real mark and an SF Symbol, and that is invisible from the server.
            artwork: `${from.assetName ?? 'symbol'} / ${to.assetName ?? 'symbol'}`,
        });
    } catch (err) {
        logger.error('[LA] startTransferCard threw', {
            transferId: input.transferId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Move the card to a stage. No currencies — they come off the row.
 *
 * This is the signature a provider webhook can actually satisfy:
 *
 *     await advanceTransferCard({ userId, transferId, step: 'Sending' });
 */
export async function advanceTransferCard(input: {
    userId: string;
    transferId: string;
    step: TransferStep | number;
}): Promise<void> {
    try {
        const stepIndex =
            typeof input.step === 'number'
                ? input.step
                : TRANSFER_STEPS.indexOf(input.step);

        if (stepIndex < 0) {
            logger.warn('[LA] advanceTransferCard: unknown step', {
                transferId: input.transferId,
                step: input.step,
            });
            return;
        }

        const out = await liveActivityService.advance({
            userId: input.userId,
            subjectType: SUBJECT_TYPE,
            subjectId: input.transferId,
            // Only what changed. stepCount, from, to and deepLink are merged
            // from baseProps — see mergeProps in liveActivity.service.ts.
            patch: {
                stepIndex,
                stepLabel: TRANSFER_STEPS[stepIndex] ?? '',
                state: 'in_progress',
            },
        });

        if (!out.updated) {
            logger.info('[LA] transfer card not advanced', {
                transferId: input.transferId,
                reason: out.reason,
            });
        }
    } catch (err) {
        logger.error('[LA] advanceTransferCard threw', {
            transferId: input.transferId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Final frame, then dismissal.
 *
 * On failure the card gets the support action — the one moment the customer
 * most wants a way through, and a lock screen button is the shortest path to
 * it. `reason` is a short customer-facing label, not a provider error code: it
 * lands on a lock screen, so 'Bank rejected' not 'NUVION_ERR_4122'.
 */
export async function finishTransferCard(input: {
    userId: string;
    transferId: string;
    ok: boolean;
    reason?: string;
}): Promise<void> {
    try {
        const out = await liveActivityService.finish({
            userId: input.userId,
            subjectType: SUBJECT_TYPE,
            subjectId: input.transferId,
            patch: input.ok
                ? {
                      stepIndex: TRANSFER_STEPS.length - 1,
                      stepLabel: 'Complete',
                      state: 'succeeded',
                  }
                : {
                      stepLabel: input.reason ?? 'Stopped',
                      state: 'failed',
                      action: {
                          label: 'Get help',
                          url: 'vyre://support',
                          symbol: 'questionmark.circle',
                      },
                      // stepIndex deliberately omitted: it merges from the row,
                      // so a failure freezes the chevrons where the transfer
                      // actually stopped instead of claiming it reached the end.
                  },
            // Long enough to be read on a glance at a locked phone. Dismissing
            // instantly means the resolution is never seen, which defeats the
            // point of the final frame.
            lingerMs: 30_000,
        });

        if (!out.ended) {
            logger.info('[LA] transfer card not finished', {
                transferId: input.transferId,
                reason: out.reason,
            });
        }
    } catch (err) {
        logger.error('[LA] finishTransferCard threw', {
            transferId: input.transferId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Was a card up for this transfer?
 *
 * For suppressing a duplicate push. A completion that fires both the card's
 * final frame AND a TRANSFER_LANDED notification buzzes twice for one event,
 * and the card already said it:
 *
 *     if (!(await transferCardIsLive({ userId, transferId }))) {
 *         await notificationService.notify(userId, { kind: 'TRANSFER_LANDED', ... });
 *     }
 *
 * Check it BEFORE finishTransferCard — finishing sets the row terminal, so
 * afterwards this always reads false and the suppression never fires.
 */
export async function transferCardIsLive(input: {
    userId: string;
    transferId: string;
}): Promise<boolean> {
    try {
        return await liveActivityService.isLive({
            userId: input.userId,
            subjectType: SUBJECT_TYPE,
            subjectId: input.transferId,
        });
    } catch {
        // Failing closed would silence a real notification. A duplicate buzz is
        // a smaller harm than a missing one.
        return false;
    }
}

export default {
    TRANSFER_STEPS,
    startTransferCard,
    advanceTransferCard,
    finishTransferCard,
    transferCardIsLive,
};