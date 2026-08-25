import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';
import { verifyControWebhookSignature, issueCard, activateCard, revealHtml } from '../services/contro.service';
import { handleKycSessionCompleted, startCardKyc, checkProgramKycAndNotify } from '../services/controOnboarding.service';
import notificationService from '../services/notification.service';
import ablyService from '../services/ably.service';

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

                    await ablyService.notifyCardKycUpdate(user.id, 'rejected');
                
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

    async startCardOnboarding(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            if (user.controCardholderId) {
                return res.status(200).json({
                    success: true,
                    msg: 'You already have a Contro cardholder — no new KYC session needed',
                    alreadyOnboarded: true,
                });
            }
 
            const result = await startCardKyc(user.id);
 
            if (!result.success) {
                return res.status(422).json({ success: false, msg: result.error });
            }
 
            return res.status(200).json({
                success: true,
                msg: result.skippedToDirectCreation
                    ? 'Verification reused — no new session needed'
                    : 'KYC session created',
                sessionUrl: result.sessionUrl,
                sessionId: result.sessionId,
                skippedToDirectCreation: result.skippedToDirectCreation ?? false,
            });
 
        } catch (error: any) {
            logger.error('Failed to start Contro card onboarding:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
 
    // GET /cards/contro/status
    // Lets the frontend check where a user currently sits in the
    // pipeline — KYC session pending, cardholder created, program KYC
    // pending/approved/rejected, card issued/active.
    async getCardStatus(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const fresh = await prisma.user.findUnique({
                where: { id: user.id },
                select: {
                    controCardholderId: true,
                    controKycStatus: true,
                    controProgramKycStatus: true,
                    controCards: {
                        select: { id: true, controCardId: true, status: true, last4: true, brand: true, createdAt: true },
                        orderBy: { createdAt: 'desc' },
                        take: 1,
                    },
                },
            });
 
            if (!fresh) {
                return res.status(404).json({ success: false, msg: 'User not found' });
            }
 
            // If a cardholder exists but program KYC isn't confirmed
            // approved yet, re-check real state rather than trust
            // whatever's cached — same "webhook is a trigger, not a
            // trusted source" discipline used throughout this
            // integration. Cheap enough to do on every status check.
            if (fresh.controCardholderId && fresh.controProgramKycStatus !== 'approved') {
                await checkProgramKycAndNotify(user.id);
                const refreshed = await prisma.user.findUnique({
                    where: { id: user.id },
                    select: { controProgramKycStatus: true },
                });
                fresh.controProgramKycStatus = refreshed?.controProgramKycStatus ?? fresh.controProgramKycStatus;
            }
 
            return res.status(200).json({
                success: true,
                hasCardholder: !!fresh.controCardholderId,
                kycStatus: fresh.controKycStatus,
                programKycStatus: fresh.controProgramKycStatus,
                readyToIssueCard: fresh.controProgramKycStatus === 'approved' && fresh.controCards.length === 0,
                card: fresh.controCards[0] ?? null,
            });
 
        } catch (error: any) {
            logger.error('Failed to get Contro card status:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async issueCard(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const fresh = await prisma.user.findUnique({
                where: { id: user.id },
                select: { controCardholderId: true, controProgramKycStatus: true, controCards: { select: { id: true } } },
            });
    
            if (!fresh?.controCardholderId) {
                return res.status(400).json({ success: false, msg: 'No cardholder found — complete verification first' });
            }
            if (fresh.controProgramKycStatus !== 'approved') {
                return res.status(400).json({ success: false, msg: 'Program KYC not yet approved' });
            }
            if (fresh.controCards.length > 0) {
                return res.status(200).json({ success: true, msg: 'Card already issued', alreadyIssued: true });
            }
    
            const programId = process.env.CONTRO_CARD_PROGRAM_ID as string;
            const idempotencyKey = `issue_card_${user.id}`; // stable/deterministic — confirmed supported specifically to prevent double-issuance on retry
    
            const card = await issueCard({
                cardholderId: fresh.controCardholderId,
                programId,
                idempotencyKey,
            });
    
            if (!card.success || !card.id) {
                logger.error(`Card issuance failed for user ${user.id}`, { error: card.error });
                return res.status(422).json({ success: false, msg: card.error ?? 'Card issuance failed' });
            }
    
            // Activation is a real, separate, required step — confirmed via
            // live testing earlier this session, cards start in "created"/
            // "pending", never usable until this call succeeds.
            const activation = await activateCard(card.id);
            if (!activation.success) {
                logger.error(`Card activation failed for user ${user.id}, card ${card.id}`, { error: activation.error });
                // Card DOES exist on Contro's side at this point even though
                // activation failed — record it as-is rather than losing
                // track of it, status will just reflect whatever Contro
                // reports until a retry/webhook resolves it.
            }
    
            await prisma.controCard.create({
                data: {
                    userId: user.id,
                    controCardId: card.id,
                    programId,
                    status: card.status ?? 'created',
                    type: (card as any).type,
                    brand: (card as any).brand,
                    last4: (card as any).last4,
                },
            });
    
            logger.info(`Card issued for user ${user.id}`, { cardId: card.id });
            return res.status(200).json({ success: true, msg: 'Card issued', cardId: card.id });
    
        } catch (error: any) {
            logger.error('Card issuance error:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
    
    // POST /cards/contro/reveal
    // CONFIRMED from Contro's docs: single-use, 60-second-expiry signed URL.
    // Generate a fresh one every time the user opens the reveal UI — never
    // cache/reuse.
    async revealCard(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const card = await prisma.controCard.findFirst({
                where: { userId: user.id },
                orderBy: { createdAt: 'desc' },
            });
    
            if (!card) {
                return res.status(404).json({ success: false, msg: 'No card found' });
            }
    
            const reveal = await revealHtml(card.controCardId, {
                copyPan: true,
            });
    
            if (!reveal.success || !(reveal as any).accessUrl) {
                return res.status(422).json({ success: false, msg: reveal.error ?? 'Failed to generate reveal URL' });
            }
    
            return res.status(200).json({ success: true, accessUrl: (reveal as any).accessUrl });
    
        } catch (error: any) {
            logger.error('Card reveal error:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }



}

export default new ControController();