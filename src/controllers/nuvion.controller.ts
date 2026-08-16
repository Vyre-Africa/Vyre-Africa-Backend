import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { initiateNuvionPayout } from './../services/nuvionpayout.service';

class NuvionController {

    // POST /api/v1/webhook/nuvion
    //
    // SIGNATURE VERIFICATION NOT IMPLEMENTED — Nuvion's signing scheme
    // (algorithm, header name, secret location) has never been documented
    // anywhere seen so far, and is one of the open questions sent to
    // their team. verifyNuvionWebhookSignature() in nuvion.service.ts
    // deliberately throws rather than pretending to verify something we
    // don't actually know how to verify.
    //
    // DO NOT deploy this to a publicly-reachable production endpoint
    // without signature verification wired in once Nuvion confirms their
    // scheme. Fine for sandbox/internal testing in the meantime.
    //
    // CONFIRMED payload shape: inflows.completed (full example in
    // Nuvion's docs). NOT CONFIRMED: transfers.updated payload shape —
    // also one of the open questions sent to their team. Field
    // extraction for that event is written defensively, same discipline
    // used for Contro's webhooks before real payloads corrected the
    // guesses there.
    async nuvionWebhook(req: Request | any, res: Response) {
        try {
            const body = req.body; // NOTE: regular express.json() parsing, NOT express.raw() — no signature to verify against yet. Revisit once signing scheme is confirmed (will need express.raw() at that point, same as Contro/Tatum).
            console.log('Nuvion webhook received:', body);
            const eventType = body?.event;
            const data = body?.data;

            console.log('Nuvion webhook data:', data);

            if (!eventType) {
                logger.warn('Nuvion webhook missing event type', { body });
                return res.status(400).json({ error: 'Missing event type' });
            }

            logger.info('Nuvion webhook received', { eventType });
            logger.info('Nuvion webhook raw payload', { eventType, body });

            // inflows.completed confirms a real `id` field on event data
            // (unlike Contro, where no such field ever existed) — using
            // it directly where available, deriving a key otherwise.
            const derivedEventId = data?.id ?? data?.unique_reference ?? `${eventType}_${JSON.stringify(data).slice(0, 100)}_${Date.now()}`;

            const existing = await prisma.nuvionWebhookEvent.findUnique({ where: { eventId: derivedEventId } });
            if (existing) {
                logger.info(`Nuvion webhook ${derivedEventId} already processed — skipping`);
                return res.status(200).json({ received: true, duplicate: true });
            }

            await prisma.nuvionWebhookEvent.create({
                data: { eventId: derivedEventId, eventType, rawPayload: body },
            });

            switch (eventType) {

                // CONFIRMED payload shape, directly from Nuvion's docs.
                // This is Feature A territory (inbound funds via
                // account-details) — genuinely blocked on the still-open
                // account-details attribution question. Logging and
                // storing this in full regardless, since real historical
                // payloads help answer that question ourselves once
                // unblocked — deliberately NOT crediting any specific
                // user's VirtualAccount yet, since we can't reliably
                // attribute it to one.
                case 'inflows.completed': {
                    logger.info('inflows.completed received — Feature A territory, not yet actioned pending the account-details attribution question', {
                        accountId: data?.account_id,
                        amount: data?.amount,
                        currency: data?.currency,
                        uniqueReference: data?.unique_reference,
                    });
                    break;
                }

                // NOT CONFIRMED payload shape — Feature B's actual
                // completion signal. Field names below are best-guess
                // based on the pattern every other Nuvion object follows
                // — treat as provisional until a real delivery confirms
                // or corrects them.
                case 'transfers.updated': {
                    const nuvionTransferId = data?.id;
                    const newStatus = data?.status; // pending | processing | completed | failed | reversed, per the Transfer object docs
                    const uniqueReference = data?.unique_reference;

                    if (!nuvionTransferId && !uniqueReference) {
                        logger.warn('transfers.updated webhook — could not identify the transfer (no id or unique_reference in payload), check raw payload above');
                        break;
                    }

                    const transferRequest = uniqueReference
                        ? await prisma.transferRequest.findUnique({ where: { idempotencyKey: uniqueReference } })
                        : await prisma.transferRequest.findFirst({ where: { reference: nuvionTransferId } });

                    if (!transferRequest) {
                        logger.warn(`No matching TransferRequest found for Nuvion transfer (id=${nuvionTransferId}, ref=${uniqueReference})`);
                        break;
                    }

                    if (!newStatus) {
                        logger.warn('transfers.updated webhook — no status field found in payload, check raw payload above for the real field name');
                        break;
                    }

                    // Maps Nuvion's lowercase status vocabulary onto our
                    // existing uppercase TransferRequest.status strings.
                    // No existing REVERSED status on our side — mapped to
                    // FAILED for now, flagged rather than silently lost.
                    const statusMap: Record<string, string> = {
                        pending: 'PENDING',
                        processing: 'PROCESSING',
                        completed: 'COMPLETED',
                        failed: 'FAILED',
                        reversed: 'FAILED', // TODO: consider a real REVERSED status if this distinction matters for reporting/support
                    };
                    const mappedStatus = statusMap[newStatus] ?? newStatus;

                    await prisma.transferRequest.update({
                        where: { id: transferRequest.id },
                        data: {
                            status: mappedStatus,
                            ...(mappedStatus === 'COMPLETED' && { completedAt: new Date() }),
                            ...(mappedStatus === 'FAILED' && { failedAt: new Date(), errorMessage: data?.status_reason ?? undefined }),
                        },
                    });

                    logger.info(`TransferRequest ${transferRequest.id} updated to ${mappedStatus} via transfers.updated webhook`, { nuvionStatus: newStatus });

                    // A reversal means the user's VirtualAccount debit
                    // needs reversing too — NOT automated yet, since
                    // reversing real money movement based on a guessed
                    // payload field is exactly the kind of mistake this
                    // project has learned to avoid. Flagged loudly for
                    // manual handling instead.
                    if (newStatus === 'reversed') {
                        logger.error(`[NUVION REVERSAL — MANUAL ACTION NEEDED] TransferRequest ${transferRequest.id} was reversed by Nuvion. The original VirtualAccount debit has NOT been automatically reversed — needs manual reconciliation until this payload shape is confirmed and automated handling is built.`);
                    }
                    break;
                }

                default:
                    logger.info(`Nuvion webhook event "${eventType}" received but not yet handled`, { body });
            }

            return res.status(200).json({ received: true });

        } catch (error) {
            logger.error('Error handling Nuvion webhook:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }

    async initiatePayout(req: Request & Record<string, any>, res: Response) {
        const { user } = req; // adjust to however this codebase's auth middleware actually attaches the authenticated user
        try {
            const { beneficiaryId, fromCurrency, toCurrency, amount, narration, recipientCountry, recipientEmail } = req.body;
 
            if (!beneficiaryId || !fromCurrency || !toCurrency || !amount || !narration) {
                return res.status(400).json({
                    success: false,
                    msg: 'beneficiaryId, fromCurrency, toCurrency, amount, and narration are required',
                });
            }
 
            const result = await initiateNuvionPayout({
                userId: user.id,
                beneficiaryId,
                fromCurrency,
                toCurrency,
                amount,
                narration,
                recipientCountry,
                recipientEmail,
            });
 
            return res.status(200).json({
                success: true,
                msg: 'Payout initiated',
                transferRequestId: result.transferRequestId,
                nuvionTransferId: result.nuvionTransferId,
            });
 
        } catch (error: any) {
            logger.error('Nuvion payout initiation failed:', error);
            return res.status(422).json({
                success: false,
                msg: error.message ?? 'Payout failed',
            });
        }
    }

}

export default new NuvionController();