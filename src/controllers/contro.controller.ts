import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';
import { verifyControWebhookSignature, issueCard, activateCard, revealHtml, updateSpendControl } from '../services/contro.service';
import { handleKycSessionCompleted, startCardKyc, checkProgramKycAndNotify } from '../services/controOnboarding.service';
import notificationService from '../services/notification.service';
import ablyService from '../services/ably.service';
import walletService from '../services/wallet.service';
import { Decimal } from 'decimal.js';


function toDecimal(value: number | string | Decimal): Decimal {
    return new Decimal(value.toString());
}

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
            
                case 'card.issued': {
                // CONFIRMED: this event carries no status field at all —
                // its firing simply means the card is now active. No
                // extraction, no fallback guessing needed.
                const cardId = body?.cardId;
 
                if (!cardId) {
                    logger.warn('card.issued webhook — no cardId in payload, check raw payload above');
                    break;
                }
 
                const card = await prisma.controCard.findUnique({ where: { controCardId: cardId } });
                if (!card) {
                    logger.warn(`No local ControCard record for Contro card ${cardId} — was it issued outside our normal flow?`);
                    break;
                }
 
                await prisma.controCard.update({
                    where: { id: card.id },
                    data: { status: 'active' },
                });
 
                // Real "your card is ready" confirmation — the actual
                // point of certainty that issuance + activation both
                // succeeded on Contro's side. issueCard's HTTP response
                // fires before that's confirmed.
                await notificationService.queue({
                    userId: card.userId,
                    title: 'Your card is ready',
                    type: 'GENERAL',
                    content: 'Your Vyre card has been issued and is ready to use.',
                });
 
                logger.info(`ControCard ${card.id} confirmed active via card.issued webhook`);
                break;
                }
    
                case 'card.status.changed': {
                    // The only case that actually carries newStatus/
                    // previousStatus — handles every transition AFTER
                    // initial issuance (frozen, unfrozen, cancelled, etc.).
                    const cardId = body?.cardId;
                    const newStatus = body?.newStatus;
                    const previousStatus = body?.previousStatus;
    
                    if (!cardId || !newStatus) {
                        logger.warn('card.status.changed webhook — missing cardId or newStatus, check raw payload above');
                        break;
                    }
    
                    const card = await prisma.controCard.findUnique({ where: { controCardId: cardId } });
                    if (!card) {
                        logger.warn(`No local ControCard record for Contro card ${cardId} — was it issued outside our normal flow?`);
                        break;
                    }
    
                    await prisma.controCard.update({
                        where: { id: card.id },
                        data: { status: newStatus },
                    });
    
                    logger.info(`ControCard ${card.id} status changed: ${previousStatus ?? '?'} → ${newStatus}`);
    
                    // Still conservative on notifications here — not yet
                    // confirmed whether Contro fires this for user-initiated
                    // freezes (via our own /freeze endpoint) too, which would
                    // risk a duplicate notification alongside whatever that
                    // endpoint already tells the user directly.
                    if (newStatus === 'frozen' && previousStatus !== 'frozen') {
                        logger.info(`Card ${card.id} frozen — TODO: confirm whether Contro fires this for user-initiated freezes too, to avoid duplicate notifications`);
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
                        select: {
                            id: true,
                            controCardId: true,
                            status: true,
                            last4: true,
                            brand: true,
                            createdAt: true,
                            fundingWalletId: true,
                            lastSyncedCapUsd: true,
                            totalSpentUsd: true,
                        },
                        orderBy: { createdAt: 'desc' },
                        // NO take: 1 — every card, not just the latest one
                    },
                },
            });

            if (!fresh) {
                return res.status(404).json({ success: false, msg: 'User not found' });
            }

            if (fresh.controCardholderId && fresh.controProgramKycStatus !== 'approved') {
                await checkProgramKycAndNotify(user.id);
                const refreshed = await prisma.user.findUnique({
                    where: { id: user.id },
                    select: { controProgramKycStatus: true },
                });
                fresh.controProgramKycStatus = refreshed?.controProgramKycStatus ?? fresh.controProgramKycStatus;
            }

            // Resolve funding-currency display info for EVERY card, not
            // just one — batched to avoid one query per card.
            const walletIds = [...new Set(fresh.controCards.map(c => c.fundingWalletId))];
            const wallets = walletIds.length
                ? await prisma.wallet.findMany({ where: { id: { in: walletIds } }, select: { id: true, currencyId: true } })
                : [];
            // const currencyIds = [...new Set(wallets.map(w => w.currencyId))];

            const currencyIds = [...new Set(wallets.map(w => w.currencyId).filter((id): id is string => id !== null))];
            const currencies = currencyIds.length
                ? await prisma.currency.findMany({ where: { id: { in: currencyIds } }, select: { id: true, ISO: true, name: true, chain: true, imgUrl: true } })
                : [];

            const walletToCurrency = new Map(wallets.map(w => [w.id, currencies.find(c => c.id === w.currencyId)]));

            const cards = fresh.controCards.map(c => ({
                ...c,
                availableBalance: toDecimal(c.lastSyncedCapUsd ?? 0).minus(toDecimal(c.totalSpentUsd ?? 0)).toString(),
                fundingCurrency: walletToCurrency.get(c.fundingWalletId) ?? null,
            }));

            return res.status(200).json({
                success: true,
                hasCardholder: !!fresh.controCardholderId,
                kycStatus: fresh.controKycStatus,
                programKycStatus: fresh.controProgramKycStatus,
                // CHANGED — no longer gated by "no existing cards". Once
                // KYC is approved, the user can always issue another card.
                readyToIssueCard: fresh.controProgramKycStatus === 'approved',
                cards, // CHANGED — array, not a single "card"
            });

        } catch (error: any) {
            logger.error('Failed to get Contro card status:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async issueCard(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const { cryptoCurrencyId } = req.body; // NEW — which wallet this card gets permanently tied to for both the issuance fee and every future funding
 
            if (!cryptoCurrencyId) {
                return res.status(400).json({ success: false, msg: 'cryptoCurrencyId is required to select which wallet funds this card' });
            }
 
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
            // if (fresh.controCards.length > 0) {
            //     return res.status(200).json({ success: true, msg: 'Card already issued', alreadyIssued: true });
            // }
 
            // NEW — collect the $4 issuance fee BEFORE calling Contro at
            // all. No point debiting the user if issuance then fails, and
            // this confirms upfront that the chosen wallet actually has
            // the funds before we commit to anything with Contro.
            const CARD_ISSUANCE_FEE_USD = '4';
            const wallet = await prisma.wallet.findFirst({ where: { userId: user.id, currencyId: cryptoCurrencyId } });
            if (!wallet || toDecimal(wallet.availableBalance).lt(toDecimal(CARD_ISSUANCE_FEE_USD))) {
                return res.status(400).json({ success: false, msg: 'Insufficient balance to cover the $4 issuance fee' });
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
                // The $4 fee has already been collected at this point.
                // Issuance genuinely failed, so this needs a real refund
                // path — not built yet, flagging loudly rather than
                // silently leaving the user out $4 for a card they never
                // got.
                logger.error(`[CONTRO FEE REFUND NEEDED] User ${user.id} was charged $4 (${cryptoCurrencyId}) for a card that failed to issue`);
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

            // Deduct issuance Fee
            // balance is validate in the direct_offchain_Transfer function 
            await walletService.direct_offchain_Transfer({
                userId: user.id,
                receipientId: config.Admin_Id,
                currencyId: cryptoCurrencyId,
                amount: CARD_ISSUANCE_FEE_USD,
                narration: 'Card issuance fee'
            });
 
            await prisma.controCard.create({
                data: {
                    userId: user.id,
                    controCardId: card.id,
                    programId,
                    status: card.status ?? 'created',
                    type: (card as any).type,
                    brand: (card as any).brand,
                    last4: (card as any).last4,
                    fundingWalletId: wallet.id, // NEW — permanently binds this card to the wallet chosen above
                    lastSyncedCapUsd: 0, // NEW — starts at zero; card can't spend anything until funded
                },
            });
 
            logger.info(`Card issued for user ${user.id}`, { cardId: card.id, fundingCurrencyId: cryptoCurrencyId });
            return res.status(200).json({ success: true, msg: 'Card issued', cardId: card.id });
 
        } catch (error: any) {
            logger.error('Card issuance error:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async fundCard(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { cardId } = req.params;
        try {
            const { amount, pin } = req.body;

            if (!amount) {
                return res.status(400).json({ success: false, msg: 'amount is required' });
            }

            const card = await prisma.controCard.findUnique({ where: { id: cardId } });
            if (!card || card.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Card not found' });
            }

            // Direct lookup by the exact wallet ID — no ambiguity possible,
            // unlike searching by userId+currencyId.
            const wallet = await prisma.wallet.findUnique({ where: { id: card.fundingWalletId } });
            if (!wallet) {
                return res.status(404).json({ success: false, msg: 'Funding wallet not found' });
            }
            if (!wallet.currencyId) {
                logger.error(`[DATA INTEGRITY] Wallet ${wallet.id} (funding wallet for card ${card.id}) has no currencyId`);
                return res.status(500).json({ success: false, msg: 'This card\'s funding wallet is misconfigured. Contact support.' });
            }

            // Balance itself is validated inside direct_offchain_Transfer —
            // matching the confirmed pattern from issueCard, no redundant
            // pre-check needed here.
            await walletService.direct_offchain_Transfer({
                userId: user.id,
                receipientId: config.Admin_Id,
                currencyId: wallet.currencyId, // now genuinely narrowed to string, not string | null
                amount,
                narration: 'Card funding',
            });

            const newCap = toDecimal(card.lastSyncedCapUsd ?? 0).plus(toDecimal(amount));

            const syncResult = await updateSpendControl(card.controCardId, {
                sales: { allTime: newCap.toNumber() },
            });

            if (!syncResult.success) {
                await prisma.controCard.update({ where: { id: cardId }, data: { lastCapSyncError: syncResult.error } });
                logger.error(`[CONTRO CAP SYNC FAILED] Card ${cardId} funded internally but Contro cap not updated`, { error: syncResult.error });
                return res.status(422).json({ success: false, msg: 'Funding recorded, but could not sync your new limit with the card provider. Contact support.' });
            }

            await prisma.controCard.update({
                where: { id: cardId },
                data: { lastSyncedCapUsd: newCap, lastCapSyncedAt: new Date(), lastCapSyncError: null },
            });

            return res.status(200).json({ success: true, msg: 'Card funded', newBalance: newCap.minus(card.totalSpentUsd ?? 0).toString() });

        } catch (error: any) {
            logger.error('Card funding error:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
    
    // POST /cards/contro/reveal
    // CONFIRMED from Contro's docs: single-use, 60-second-expiry signed URL.
    // Generate a fresh one every time the user opens the reveal UI — never
    // cache/reuse.
    async revealCard(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { cardId } = req.params; // NEW — was implicitly "the" card before
 
        try {
            const card = await prisma.controCard.findUnique({ where: { id: cardId } });
            if (!card || card.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Card not found' });
            }
 
            const reveal = await revealHtml(card.controCardId, { copyPan: true });
 
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