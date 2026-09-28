import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';
import { verifyDiditWebhookSignature } from '../services/didit.service';
import { generalQueue } from '../workers/general.worker';

class DiditController {

    // POST /api/v1/webhook/didit
    // Requires express.raw() — signature is over the raw body, same
    // requirement as every other signed webhook in this codebase.
    //
    // CONFIRMED shape from a real live delivery: { event_id, session_id,
    // status, created_at, timestamp, workflow_id, workflow_version,
    // vendor_data, metadata, environment, webhook_type, application_id,
    // decision? }. decision is present only on terminal statuses and its
    // per-feature fields are PLURAL ARRAYS (id_verifications[],
    // aml_screenings[], poa_verifications[], liveness_checks[]).
    //
    // Decoupled — respond fast, hand off processing to the general
    // queue, same pattern already proven for Contro and Nuvion.
    async diditWebhook(req: Request | any, res: Response) {
        try {
            const rawBody: Buffer = req.body;
            const signature = req.headers['x-signature'] as string | undefined;
            const timestamp = req.headers['x-timestamp'] as string | undefined;
 
            if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
                logger.warn('Didit webhook body is not a raw Buffer — check express.raw() is mounted before any global express.json()');
                return res.status(401).json({ error: 'Invalid signature' });
            }
 
            if (!signature || !timestamp) {
                logger.warn('Didit webhook missing X-Signature or X-Timestamp header');
                return res.status(401).json({ error: 'Invalid signature' });
            }
 
            const bodyString = rawBody.toString('utf8');
            const { valid, reason } = verifyDiditWebhookSignature(
                bodyString,
                signature,
                timestamp,
                config.DIDIT_WEBHOOK_SECRET as string
            );
 
            if (!valid) {
                logger.warn(`Didit webhook rejected: ${reason}`);
                return res.status(401).json({ error: 'Invalid signature' });
            }
 
            const body = JSON.parse(bodyString);
 
            // CONFIRMED field name from a real delivery: "webhook_type".
            // Fallback chain kept as insurance against future variants.
            const webhookType = body?.webhook_type ?? body?.event_type ?? body?.type;
 
            logger.info('Didit webhook received', {
                webhookType,
                eventId: body?.event_id,
                sessionId: body?.session_id,
                workflowId: body?.workflow_id,
                status: body?.status,
            });
            logger.info('Didit webhook raw payload', { body });
 
            // ─── Idempotency key ──────────────────────────────────────
            // FIXED — was `${...body?.timestamp ?? Date.now()}`, which
            // meant a missing timestamp produced a unique key on every
            // retry and defeated dedup entirely (same class of bug as the
            // Nuvion outflows.completed dedup failure).
            //
            // Didit provides a real unique event identifier — use it.
            // CONFIRMED present: "event_id": "e8b6844a-32de-4b8b-...".
            let derivedEventId: string;
 
            if (body?.event_id) {
                derivedEventId = `didit_${body.event_id}`;
            } else if (body?.session_id && body?.timestamp) {
                // Deterministic fallback — no Date.now(), so retries of
                // the same delivery still collapse to one key.
                derivedEventId = `didit_${webhookType ?? 'unknown'}_${body.session_id}_${body.timestamp}`;
            } else {
                // Nothing stable to key on. Refuse rather than fabricate
                // an id that would let the same event process repeatedly.
                logger.error('Didit webhook has neither event_id nor session_id+timestamp — cannot derive a stable idempotency key', { body });
                return res.status(400).json({ error: 'Missing event identifier' });
            }
 
            // ─── Dedup via the unique constraint itself ───────────────
            // FIXED — the old findUnique-then-create had a race: two
            // simultaneous retries could both pass the check before
            // either wrote, and the loser's create would throw into the
            // catch block and return 500, prompting Didit to retry again.
            // Letting the DB's unique constraint be the guard closes it.
            try {
                await prisma.diditWebhookEvent.create({
                    data: {
                        eventId: derivedEventId,
                        eventType: webhookType ?? 'unknown',
                        rawPayload: body,
                    },
                });
            } catch (e: any) {
                if (e?.code === 'P2002') { // Prisma unique constraint violation
                    logger.info(`Didit webhook ${derivedEventId} already processed — skipping`);
                    return res.status(200).json({ received: true, duplicate: true });
                }
                throw e;
            }
 
            // ─── Route to processing ──────────────────────────────────
            if (webhookType === 'status.updated' || (!webhookType && body?.session_id && body?.status)) {
                await generalQueue.add('Didit_Event', { body });
            } else {
                // Every other subscribed event type — logged and stored
                // above (full audit trail preserved), but not acted on.
                //
                // ⚠️ AML ONGOING MONITORING: the identity workflow has
                // is_ongoing_monitoring_enabled: true, meaning Didit keeps
                // screening users AFTER their session closes. If someone
                // later appears on a sanctions list or in adverse media,
                // that event presumably arrives with a different
                // webhook_type and would land HERE — logged but ignored.
                //
                // That's a real compliance gap. Find out what those
                // events are typed as and handle them explicitly.
                logger.warn(
                    `Didit webhook_type "${webhookType}" received but not handled — ` +
                    `stored for audit, no processing logic built. If this is an ongoing ` +
                    `AML monitoring alert, it needs real handling.`,
                    { eventId: body?.event_id, sessionId: body?.session_id }
                );
            }
 
            return res.status(200).json({ received: true });
 
        } catch (error) {
            logger.error('Error handling Didit webhook:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

export default new DiditController();