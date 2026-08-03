import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import logger from '../config/logger';

class NuvionWebhookController {

    // POST /api/v1/webhook/nuvion
    //
    // Requires express.raw() on this route (registered BEFORE any global
    // express.json()) — signature verification needs the exact raw bytes
    // Nuvion signed, not a re-serialized JSON object. Same requirement as
    // the Tatum webhook elsewhere in this codebase.
    //
    //   router.post('/webhook/nuvion',
    //     express.raw({ type: 'application/json' }),
    //     nuvionWebhookController.nuvionWebhook
    //   );
    async nuvionWebhook(req: Request | any, res: Response) {
        try {
            const rawBody: Buffer = req.body;
            const eventId = req.headers['x-nuvion-event-id'] as string | undefined;
            const timestamp = req.headers['x-nuvion-event-timestamp'] as string | undefined;
            const signature = req.headers['x-nuvion-event-signature'] as string | undefined;

            if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
                logger.warn('Nuvion webhook body is not a raw Buffer — check express.raw() is mounted on this route before any global express.json()');
                return res.status(401).json({ error: 'Invalid signature' });
            }

            if (!eventId || !timestamp || !signature) {
                logger.warn('Nuvion webhook missing required headers', {
                    hasEventId: !!eventId,
                    hasTimestamp: !!timestamp,
                    hasSignature: !!signature,
                });
                return res.status(401).json({ error: 'Invalid signature' });
            }

            // Per Nuvion's docs: signed payload is "{timestamp}.{payload}",
            // where {payload} is the raw request body as sent.
            const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
            const expectedSignature = createHmac('sha256', config.NUVION_WEBHOOK_SECRET as string)
                .update(signedPayload)
                .digest('hex');

            const sigBuf = Buffer.from(signature, 'hex');
            const expectedBuf = Buffer.from(expectedSignature, 'hex');

            if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
                logger.warn('Nuvion webhook signature verification failed', { eventId });
                return res.status(401).json({ error: 'Invalid signature' });
            }

            // ── Idempotency ──────────────────────────────────────────────
            // Nuvion explicitly warns the same event may be delivered more
            // than once. Check the event id before processing.
            const existing = await prisma.nuvionWebhookEvent.findUnique({ where: { eventId } });
            if (existing) {
                logger.info(`Nuvion webhook ${eventId} already processed — skipping (idempotent)`);
                return res.status(200).json({ received: true, duplicate: true });
            }

            const body = JSON.parse(rawBody.toString('utf8'));
            const { event, data } = body as { event: string; data: any };

            logger.info('Nuvion webhook verified', { eventId, event });

            // Always log the full raw payload for any event whose shape
            // isn't fully confirmed yet — cheapest possible insurance
            // against a wrong field-extraction guess going unnoticed.
            logger.info('Nuvion webhook raw payload', { eventId, event, data });

            // Record receipt BEFORE processing, so a crash mid-processing
            // doesn't cause an infinite reprocess loop on retry.
            await prisma.nuvionWebhookEvent.create({
                data: { eventId, event, rawPayload: body },
            });

            switch (event) {

                case 'entities.updated': {
                    // THIS is the confirmed, correct signal for KYC/document
                    // review status changing — per Nuvion's explicit
                    // guidance: "Don't poll GET /entities/:id — listen for
                    // the entities.updated webhook event instead."
                    //
                    // Payload shape is NOT confirmed from docs (no example
                    // was available) — nesting conventions have already
                    // proven inconsistent between event types (accounts.
                    // created nests under data.account; account_details.
                    // updated is flat under data). Trying multiple fallback
                    // paths below; the raw payload is logged above
                    // regardless — correct these against the first real
                    // delivery.
                    const entityId =
                        data?.entity?.id ??
                        data?.id ??
                        data?.entity_id;

                    const entityStatus =
                        data?.entity?.status ??
                        data?.status;

                    const documentStatus =
                        data?.identification?.document?.verification_status ??
                        data?.document?.verification_status;

                    const addressStatus =
                        data?.identification?.proof_of_address?.verification_status ??
                        data?.proof_of_address?.verification_status;

                    if (!entityId) {
                        logger.warn('entities.updated webhook — could not determine entity id from any known path, check raw payload above', { data });
                        break;
                    }

                    const user = await prisma.user.findFirst({ where: { nuvionEntityId: entityId } });
                    if (!user) {
                        logger.warn(`No user found for Nuvion entity ${entityId} (entities.updated)`);
                        break;
                    }

                    logger.info(`entities.updated for user ${user.id}`, { entityStatus, documentStatus, addressStatus });

                    if (entityStatus) {
                        await prisma.user.update({
                            where: { id: user.id },
                            data: { nuvionEntityStatus: entityStatus },
                        });

                        // TODO once extraction paths above are confirmed
                        // correct against a real delivery: notify the user
                        // their global account is ready (or what needs
                        // fixing, if rejected), via notificationService.
                    }

                    break;
                }

                case 'accounts.created': {
                    // Confirmed schema: data.account.{id, entity_id, type,
                    // currency, display_name, balance, meta, created, updated}
                    //
                    // NOTE: this does NOT mean KYC/document verification is
                    // complete — account creation is a separate action from
                    // document review finishing. That was an earlier wrong
                    // assumption in this file; corrected. entities.updated
                    // above is the real signal for verification status.
                    const account = data?.account;
                    const entityId = account?.entity_id;

                    if (!entityId) {
                        logger.warn('accounts.created webhook missing entity_id', { data });
                        break;
                    }

                    const user = await prisma.user.findFirst({ where: { nuvionEntityId: entityId } });
                    if (!user) {
                        logger.warn(`No user found for Nuvion entity ${entityId} (accounts.created)`);
                        break;
                    }

                    await prisma.nuvionAccount.create({
                        data: {
                            userId: user.id,
                            nuvionAccountId: account.id,
                            currency: account.currency,
                            accountType: account.type,
                            displayName: account.display_name,
                        },
                    });

                    logger.info(`Account provisioned for user ${user.id}`, { accountId: account.id, currency: account.currency });
                    break;
                }

                case 'account_details.created': {
                    // Confirmed schema: data.account_details.{id, entity_id,
                    // account_id, account_number, routing_number, issuer, status}
                    const details = data?.account_details;
                    const entityId = details?.entity_id;

                    if (!entityId) {
                        logger.warn('account_details.created webhook missing entity_id', { data });
                        break;
                    }

                    const user = await prisma.user.findFirst({ where: { nuvionEntityId: entityId } });
                    if (!user) {
                        logger.warn(`No user found for Nuvion entity ${entityId} (account_details.created)`);
                        break;
                    }

                    await prisma.nuvionAccount.updateMany({
                        where: { nuvionAccountId: details.account_id },
                        data: {
                            accountNumber: details.account_number,
                            routingNumber: details.routing_number,
                            issuerName: details.issuer?.name,
                            issuerCode: details.issuer?.code,
                            status: details.status,
                        },
                    });

                    logger.info(`Account details populated for user ${user.id}`, {
                        accountId: details.account_id,
                        accountNumber: details.account_number,
                    });

                    // This is the moment to notify the user their real
                    // account number/details are ready — wire into
                    // notificationService here once confirmed working.
                    break;
                }

                case 'account_details.updated': {
                    const details = data;
                    await prisma.nuvionAccount.updateMany({
                        where: { nuvionAccountId: details?.account_id },
                        data: { status: details?.status },
                    });
                    logger.info('Account details updated', { accountId: details?.account_id, status: details?.status });
                    break;
                }

                default:
                    // Every other confirmed event type (inflows.completed,
                    // outflows.*, payment_intent.*, payment_refund.*,
                    // funding_sessions_updated) — not yet wired up. Logged
                    // and acknowledged so Nuvion doesn't retry, but no
                    // action taken. Build these out as each feature
                    // (transfers, payments) actually gets implemented.
                    logger.info(`Nuvion webhook event "${event}" received but not yet handled`, { eventId });
            }

            return res.status(200).json({ received: true });

        } catch (error) {
            logger.error('Error handling Nuvion webhook:', error);
            // Now that real signature verification is in place, a genuine
            // processing error SHOULD trigger Nuvion's retry, rather than
            // silently swallowing a failure with a fake 200.
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

export default new NuvionWebhookController();