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
    // CONFIRMED shape: { session_id, status, created_at, timestamp,
    // workflow_id, vendor_data, metadata, decision? } — decision is
    // present only on terminal statuses (Approved/Declined/In Review/
    // Abandoned) and its per-feature fields are PLURAL ARRAYS
    // (id_verifications[], not id_verification).
    //
    // Decoupled from the start — respond fast, hand off actual processing
    // to the general-process queue, same pattern already proven for
    // Contro and Nuvion.
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
            console.log('Didit webhook received', { body });
 
            // NEW — check event type FIRST. Fallback chain since the exact
            // field name isn't 100% pinned down from a real payload yet
            // (only referenced indirectly in the destinations doc) —
            // logged clearly either way so a real delivery confirms it.
            const webhookType = body?.webhook_type ?? body?.event_type ?? body?.type;
 
            logger.info('Didit webhook received', { webhookType, rawKeys: Object.keys(body) });
            logger.info('Didit webhook raw payload', { webhookType, body });
 
            // Derive an idempotency key generically — works regardless of
            // event type/shape, unlike relying on session_id which only
            // exists on session-related events.
            const derivedEventId = `didit_${webhookType}_${body?.session_id ?? body?.id ?? JSON.stringify(body).slice(0, 100)}_${body?.timestamp ?? Date.now()}`;
 
            const existing = await prisma.diditWebhookEvent.findUnique({ where: { eventId: derivedEventId } });
            if (existing) {
                logger.info(`Didit webhook ${derivedEventId} already processed — skipping`);
                return res.status(200).json({ received: true, duplicate: true });
            }
 
            await prisma.diditWebhookEvent.create({
                data: { eventId: derivedEventId, eventType: webhookType ?? 'unknown', rawPayload: body },
            });
 
            if (webhookType === 'status.updated' || (!webhookType && body?.session_id && body?.status)) {
                // Only queue the ones we actually have handling for.
                // Falls back to shape-detection (session_id + status
                // present) if webhook_type ever turns out to be named
                // something else in a real delivery — belt and suspenders.
                await generalQueue.add('Didit_Event', { body });
            } else {
                // Every other subscribed event type — logged and stored
                // above (full audit trail preserved), but not acted on.
                // Nothing is lost; this is just "not yet built," not
                // "silently dropped."
                logger.info(`Didit webhook_type "${webhookType}" received but not yet handled — no processing logic built for this event type yet`);
            }
 
            return res.status(200).json({ received: true });
 
        } catch (error) {
            logger.error('Error handling Didit webhook:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

export default new DiditController();