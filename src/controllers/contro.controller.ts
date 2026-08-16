import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';
import { verifyControWebhookSignature } from '../services/contro.service';
import { handleKycSessionCompleted, checkProgramKycAndNotify } from '../services/controOnboarding.service';
import notificationService from '../services/notification.service';

class ControController {

    // POST /api/v1/webhook/contro
    //
    // Requires express.raw() on this route (registered BEFORE any global
    // express.json()), same requirement as every other signed webhook in
    // this codebase (Tatum, Nuvion) — signature verification needs the
    // exact raw bytes Contro signed, not a re-serialized JSON object.
    //
    //   app.use('/api/v1/webhook/contro', express.raw({ type: 'application/json', limit: '10mb' }));
    //
    // IMPORTANT — what's confirmed vs. not, honestly:
    //   CONFIRMED: signing scheme (HMAC-SHA256, t=...,v1=... format),
    //   event type list, retry policy (5 attempts, exponential backoff).
    //   NOT YET CONFIRMED: the exact shape of `data` inside any real
    //   webhook body — we've only seen the EVENT DELIVERY LOG schema
    //   (id, eventType, status, attemptCount...), never an actual
    //   payload body. Field extraction below is written defensively
    //   with fallback paths, the same way the early Nuvion webhook
    //   handler was, until a real delivery confirms the true shape.
    async controWebhook(req: Request | any, res: Response) {
        try {
            const rawBody: Buffer = req.body;
            const signature = req.headers['x-contro-signature'] as string | undefined;
            const eventTypeHeader = req.headers['x-contro-event'] as string | undefined;
    
            if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
                logger.warn('Contro webhook body is not a raw Buffer — check express.raw() is mounted before any global express.json()');
                return res.status(401).json({ error: 'Invalid signature' });
            }
    
            const bodyString = rawBody.toString('utf8');
            const isSandbox = config.CONTRO_ENV === 'sandbox'; // explicit match only — anything else (including unset) is treated as production-strict
    
            if (isSandbox) {
                // CONFIRMED: sandbox has no webhook secret at all — nothing to
                // verify against. Loud warning every time so this is never
                // mistaken for a real security check, and so it's obvious in
                // logs if CONTRO_ENV is ever accidentally left as 'sandbox' in
                // a real deployment.
                logger.warn('⚠️  Contro webhook signature verification SKIPPED — CONTRO_ENV=sandbox, no secret exists to verify against. This must NEVER happen in production.');
            } else {
                if (!signature) {
                    logger.warn('Contro webhook missing x-contro-signature header');
                    return res.status(401).json({ error: 'Invalid signature' });
                }
    
                if (!config.CONTRO_WEBHOOK_SECRET) {
                    logger.error('CONTRO_WEBHOOK_SECRET not configured — cannot verify production webhook, rejecting');
                    return res.status(500).json({ error: 'Webhook secret not configured' });
                }
    
                const valid = verifyControWebhookSignature(bodyString, signature, config.CONTRO_WEBHOOK_SECRET as string);
                if (!valid) {
                    logger.warn('Contro webhook signature verification failed');
                    return res.status(401).json({ error: 'Invalid signature' });
                }
            }
    
            const body = JSON.parse(bodyString);

            console.log('Contro webhook body', body);
            const resolvedEventType = eventTypeHeader ?? body?.eventType ?? body?.type ?? 'unknown';
    
            logger.info('Contro webhook received', { eventType: resolvedEventType, verified: !isSandbox });
            logger.info('Contro webhook raw payload', { eventType: resolvedEventType, body });

            // ── Idempotency ──────────────────────────────────────────
            // Contro's docs never showed a dedicated event-id field
            // INSIDE the payload body itself (only in their delivery-log
            // listing, which is a different thing). Deriving a
            // best-effort idempotency key from whatever's available; if a
            // real event shows a genuine id field, switch to using that
            // directly instead.
            const derivedEventId = body?.id
                ?? body?.eventId
                ?? `${resolvedEventType}_${body?.data?.id ?? body?.data?.cardId ?? body?.data?.cardholderId ?? 'unknown'}_${body?.timestamp ?? Date.now()}`;

            const existing = await prisma.controWebhookEvent.findUnique({ where: { eventId: derivedEventId } });
            if (existing) {
                logger.info(`Contro webhook ${derivedEventId} already processed — skipping`);
                return res.status(200).json({ received: true, duplicate: true });
            }

            await prisma.controWebhookEvent.create({
                data: { eventId: derivedEventId, eventType: resolvedEventType, rawPayload: body },
            });

            switch (resolvedEventType) {
 
                case 'cardholder.created': {
                    const cardholderId = body?.cardholderId;
                    const externalUserId = body?.externalUserId;
            
                    if (!cardholderId || !externalUserId) {
                        logger.warn('cardholder.created webhook missing cardholderId or externalUserId', { body });
                        break;
                    }
            
                    const user = await prisma.user.findUnique({ where: { id: externalUserId } });
                    if (!user) {
                        logger.warn(`cardholder.created — externalUserId ${externalUserId} does not match any real Vyre user`);
                        break;
                    }
            
                    if (user.controCardholderId !== cardholderId) {
                        await prisma.user.update({
                            where: { id: user.id },
                            data: { controCardholderId: cardholderId },
                        });
                        logger.info(`Linked/reconciled controCardholderId for user ${user.id} via cardholder.created webhook`);
                    }
                    break;
                }
            
                case 'kyc_session.completed': {
                    const sessionId = body?.sessionId ?? body?.id;
                    const externalUserId = body?.externalUserId;
            
                    if (!sessionId) {
                        logger.warn('kyc_session.completed webhook — could not determine sessionId, check raw payload above');
                        break;
                    }
            
                    const result = await handleKycSessionCompleted(sessionId, externalUserId);
                    if (!result.success) {
                        logger.error(`Failed to handle KYC session completion for ${sessionId}`, { error: result.error });
                        logger.error(`[CONTRO ONBOARDING STUCK] sessionId=${sessionId} externalUserId=${externalUserId} — needs manual follow-up`);
                    }
                    break;
                }
            
                case 'kyc_session.failed':
                    logger.info('kyc_session.failed received', { body });
                    // TODO: user-facing UX for this — retry prompt? support link?
                    break;
            
                // ── Program-level KYC approval — CONFIRMED real event name, no
                // longer guessing between multiple candidates.
                case 'cardholder.kyc.approved': {
                    const cardholderId = body?.cardholderId; // NEVER body.userId — confirmed Contro's own internal id, not ours
            
                    if (!cardholderId) {
                        logger.warn('cardholder.kyc.approved webhook — no cardholderId in payload, check raw payload above');
                        break;
                    }
            
                    const user = await prisma.user.findFirst({ where: { controCardholderId: cardholderId } });
                    if (!user) {
                        logger.warn(`No user found for Contro cardholder ${cardholderId} (cardholder.kyc.approved)`);
                        break;
                    }
            
                    const result = await checkProgramKycAndNotify(user.id);
                    logger.info('Program KYC approval confirmed', { userId: user.id, approved: result.approved });
                    break;
                }
            
                // ── NEW — the rejection counterpart, previously completely
                // unhandled (would have silently fallen to default and done
                // nothing user-facing). A rejected verification is a real dead-end
                // for the user — they need to know, not be left wondering why
                // nothing's happening.
                case 'cardholder.kyc.rejected': {
                    const cardholderId = body?.cardholderId;
                
                    if (!cardholderId) {
                        logger.warn('cardholder.kyc.rejected webhook — no cardholderId in payload, check raw payload above');
                        break;
                    }
                
                    const user = await prisma.user.findFirst({ where: { controCardholderId: cardholderId } });
                    if (!user) {
                        logger.warn(`No user found for Contro cardholder ${cardholderId} (cardholder.kyc.rejected)`);
                        break;
                    }
                
                    // Idempotency mirrors the approval-email guard — reuse the same
                    // field family rather than inventing a parallel one. If a user
                    // somehow gets rejected, retries, and gets approved later,
                    // controCardApprovalEmailSentAt naturally guards THAT path
                    // separately, so no cross-contamination between the two states.
                    if (user.controProgramKycStatus === 'rejected') {
                        logger.info(`Rejection already recorded for user ${user.id} — skipping duplicate notification`);
                        break;
                    }
                
                    await prisma.user.update({
                        where: { id: user.id },
                        data: { controProgramKycStatus: 'rejected' },
                    });
                
                    await notificationService.queue({
                        userId: user.id,
                        title: 'Card verification unsuccessful',
                        type: 'GENERAL',
                        content: 'We were unable to verify your identity for card issuance. Please contact support or try again.',
                    });
                
                    logger.info(`Rejection notification queued for user ${user.id}`);
                    break;
                }
            
                case 'card.issued':
                case 'card.status.changed': {
                    const cardId = body?.cardId;
                    const newStatus = body?.newStatus;
            
                    if (!cardId) {
                        logger.warn(`${resolvedEventType} webhook — no cardId in payload, check raw payload above`);
                        break;
                    }
            
                    const card = await prisma.controCard.findUnique({ where: { controCardId: cardId } });
                    if (!card) {
                        logger.warn(`No local ControCard record for Contro card ${cardId} — was it issued outside our normal flow?`);
                        break;
                    }
            
                    if (newStatus) {
                        await prisma.controCard.update({
                            where: { id: card.id },
                            data: { status: newStatus },
                        });
                        logger.info(`Updated ControCard ${card.id} status`, { previousStatus: body?.previousStatus, newStatus });
                    } else {
                        logger.info(`${resolvedEventType} received with no status change info — likely the issuance confirmation itself`, { body });
                    }
                    break;
                }
            
                case 'card.transaction': {
                    logger.info('card.transaction event received — see raw payload above. Ledger update logic intentionally not yet wired in pending a real delivery to confirm the transaction-detail field names.');
                    break;
                }
            
                case 'card.3ds_otp': {
                    logger.warn('card.3ds_otp received — NOT YET WIRED to a real-time delivery channel. 60-second delivery window per Contro docs.');
                    break;
                }
            
                case 'balance.low':
                    logger.warn('Contro balance.low — partner balance running low. Wire into a real alert (Slack/PagerDuty) once confirmed working.');
                    break;
            
                case 'balance.top_up':
                    logger.info('Contro balance topped up', { body });
                    break;
            
                // ── NEW, genuinely unknown — never mentioned in any Contro
                // documentation seen so far. Don't guess at what triggers this or
                // what to do with it — log in full and ask Contro directly what a
                // "rebate" represents in their system before building anything on
                // top of it.
                case 'rebate.awarded':
                    logger.info('rebate.awarded received — UNKNOWN business logic, never documented anywhere seen so far. Full payload logged above. Ask Contro what this represents before building any handling.', { body });
                    break;
            
                default:
                    logger.info(`Contro webhook event "${resolvedEventType}" received but not yet handled`, { body });
            }

            return res.status(200).json({ received: true });

        } catch (error) {
            logger.error('Error handling Contro webhook:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

export default new ControController();