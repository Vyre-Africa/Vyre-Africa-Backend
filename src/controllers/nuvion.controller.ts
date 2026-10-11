import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { initiateNuvionPayout, blockNuvionPayout, blockCryptoPayout, ensureNuvionCounterpartyAndPaymentDetail } from './../services/nuvionpayout.service';
import { createFxQuote } from '../services/nuvion.service';
import { generalQueue } from '../workers/general.worker';

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
    // Nuvion's docs, and a real one received 8 Oct). NOT CONFIRMED:
    // transfers.updated payload shape — also one of the open questions
    // sent to their team. Field extraction for that event is written
    // defensively, same discipline used for Contro's webhooks before
    // real payloads corrected the guesses there.
    async nuvionWebhook(req: Request | any, res: Response) {
        try {
            const body = req.body;
            console.log('Nuvion webhook received:', body);
            const eventType = body?.event;
            const data = body?.data;

            console.log('Nuvion webhook data:', data);

            if (!eventType) {
                logger.warn('Nuvion webhook missing event type', { body });
                return res.status(400).json({ error: 'Missing event type' });
            }

            logger.info('Nuvion webhook received', { eventType });

            // const derivedEventId = data?.id ?? data?.unique_reference ?? `${eventType}_${JSON.stringify(data).slice(0, 100)}_${Date.now()}`;

            const derivedEventId = data?.id
                ? `${eventType}_${data.id}`
                : data?.unique_reference
                    ? `${eventType}_${data.unique_reference}`
                    : `${eventType}_${JSON.stringify(data).slice(0, 100)}_${Date.now()}`;



            // Idempotency check + record stays HERE, synchronous — this is
            // what prevents a retried delivery from queueing the same
            // work twice. Two fast, indexed queries; not the expensive
            // part of processing this event.
            const existing = await prisma.nuvionWebhookEvent.findUnique({ where: { eventId: derivedEventId } });
            if (existing) {
                logger.info(`Nuvion webhook ${derivedEventId} already processed — skipping`);
                return res.status(200).json({ received: true, duplicate: true });
            }

            await prisma.nuvionWebhookEvent.create({
                data: { eventId: derivedEventId, eventType, rawPayload: body },
            });

            // Hand off the actual work — everything that used to be the
            // switch statement now runs in eventService.handleNuvionEvent,
            // dispatched via the 'Nuvion_Event' job type.
            await generalQueue.add('Nuvion_Event', { eventType, data, rawBody: body });

            return res.status(200).json({ received: true });

        } catch (error) {
            logger.error('Error handling Nuvion webhook:', error);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    }

    // POST /payouts/nuvion — fiat-sourced. PIN enforced via
    // requireTransactionPin middleware at the route level.
    async initiatePayout(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const { beneficiaryId, paymentDetailId, fromCurrency, amount, narration } = req.body;

            if (!beneficiaryId || !paymentDetailId || !fromCurrency || !amount || !narration) {
                return res.status(400).json({
                    success: false,
                    msg: 'beneficiaryId, paymentDetailId, fromCurrency, amount, and narration are required',
                });
            }

            const treasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: fromCurrency, isActive: true } });
            if (!treasury) {
                return res.status(400).json({ success: false, msg: `Payouts in ${fromCurrency} are not available yet` });
            }

            const { transferRequestId } = await blockNuvionPayout({
                userId: user.id, beneficiaryId, paymentDetailId, fromCurrency, amount, narration,
            });

            return res.status(200).json({ success: true, msg: 'Payout is being processed', transferRequestId, status: 'PENDING' });
        } catch (error: any) {
            logger.error('Nuvion payout initiation failed:', error);
            return res.status(422).json({ success: false, msg: error.message ?? 'Payout failed' });
        }
    }

    // POST /payouts/nuvion/crypto — crypto-sourced, float-funded. Takes
    // cryptoCurrencyId only — chain is derived internally, never passed
    // from the frontend. PIN enforced via requireTransactionPin
    // middleware at the route level, same as the fiat route.
    async initiateCryptoPayout(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const { beneficiaryId, paymentDetailId, cryptoCurrencyId, amount, narration } = req.body;

            if (!beneficiaryId || !paymentDetailId || !cryptoCurrencyId || !amount || !narration) {
                return res.status(400).json({
                    success: false,
                    msg: 'beneficiaryId, paymentDetailId, cryptoCurrencyId, amount, and narration are required',
                });
            }

            // CHANGED — blockCryptoPayout already works all three of these out
            // and returns them. They were being thrown away, which is why
            // GlobalTransfer.vue carries its own copy of VYRE_GLOBAL_PAYOUT_FEE
            // and the Nuvion fee table to show the user a total. Two copies of
            // the same pricing drift the day either one changes, and the user
            // is then shown one number and charged another.
            const { transferRequestId, estimatedFee, vyreFee, totalDebit } = await blockCryptoPayout({
                userId: user.id, beneficiaryId, paymentDetailId, cryptoCurrencyId, amount, narration,
            });

            return res.status(200).json({
                success: true,
                msg: 'Payout is being processed',
                transferRequestId,
                status: 'PENDING',
                estimatedFee,   // Nuvion's own pass-through cost
                vyreFee,        // Vyre's margin
                totalDebit,     // what was actually frozen from the user
            });
        } catch (error: any) {
            logger.error('Nuvion crypto payout initiation failed:', error);
            return res.status(422).json({ success: false, msg: error.message ?? 'Payout failed' });
        }
    }

    // nuvionPayout.controller.ts (or wherever payout controllers live)

    async getPayoutQuote(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { beneficiaryId, paymentDetailId, cryptoCurrencyId, amount } = req.body;

        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
            if (!beneficiary || beneficiary.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
            if (!paymentMethod || paymentMethod.beneficiaryId !== beneficiaryId) {
                return res.status(404).json({ success: false, msg: 'Payment method not found' });
            }

            const cryptoCurrency = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
            if (!cryptoCurrency) return res.status(400).json({ success: false, msg: 'Unknown source currency' });

            const usdTreasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true } });
            if (!usdTreasury) return res.status(503).json({ success: false, msg: 'Quotes temporarily unavailable' });

            // Same shared logic the real payout uses — ensures the
            // counterparty/payment detail genuinely exist on Nuvion's side
            // before a quote can even be requested.
            const { counterpartyId, paymentDetailNuvionId } = await ensureNuvionCounterpartyAndPaymentDetail(beneficiary, paymentMethod);

            const quote = await createFxQuote({
                to_currency: paymentMethod.currency,
                from_currency: 'USD',
                amount_from: Number(amount),
                account_id: usdTreasury.nuvionAccountId,
                counterparty_id: counterpartyId,
                payment_detail_id: paymentDetailNuvionId,
            });

            if (!quote.success || !quote.id) {
                return res.status(422).json({ success: false, msg: quote.error ?? 'Could not get a quote right now' });
            }

            // ⚠️ expiresAt / validForSeconds are read from a NESTED `quote`
            // object. createFxQuote spreads res.data.data, so these only exist
            // if Nuvion actually nests them that way. If they come back
            // undefined, the frontend countdown runs on NaN. One
            // console.log(JSON.stringify(quote.rawData)) on a real quote
            // settles it; left as-is until then rather than guessing a shape.
            return res.status(200).json({
                success: true,
                fxQuoteId: quote.id,
                amountTo: (quote as any).amount_to,
                rate: quote.rate,
                toCurrency: paymentMethod.currency,
                expiresAt: (quote as any).quote?.expires_at, // real timestamp, ms
                validForSeconds: (quote as any).quote?.valid_for, // real, currently ~119
            });

        } catch (error: any) {
            logger.error('Failed to get payout quote:', error);
            return res.status(500).json({ success: false, msg: error.message ?? 'Internal Server Error' });
        }
    }

    // GET /payouts/nuvion/:id
    async getPayoutStatus(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id } = req.params;
        try {
            // CHANGED — include the currency relation. currencyId is a
            // Currency.id (a cuid), so returning it as "currency" showed the
            // caller something like cmg2x8k9p0001 instead of USD.
            const transferRequest = await prisma.transferRequest.findUnique({
                where: { id },
                include: { currency: true },
            });
            if (!transferRequest || transferRequest.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Transfer not found' });
            }

            return res.status(200).json({
                success: true,
                status: transferRequest.status,
                amount: transferRequest.amount,
                currency: transferRequest.currency?.ISO ?? transferRequest.currencyId, // CHANGED — the ISO, not the id
                reference: transferRequest.reference,
                errorMessage: transferRequest.errorMessage,
                createdAt: transferRequest.createdAt,
                completedAt: transferRequest.completedAt,
                failedAt: transferRequest.failedAt,
            });
        } catch (error: any) {
            logger.error('Failed to get Nuvion payout status:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    // GET /payouts/nuvion
    async listPayouts(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            // CHANGED — beneficiaryPaymentDetailId is what makes a row a Nuvion
            // payout: only blockNuvionPayout and blockCryptoPayout set it.
            // Filtering on type alone also caught ordinary on-chain withdrawals
            // to a crypto beneficiary, which are type CRYPTO as well, so they
            // appeared in the global payouts list.
            //
            // The currency relation is included for the same reason as above:
            // currencyId on its own is a cuid.
            const transferRequests = await prisma.transferRequest.findMany({
                where: {
                    userId: user.id,
                    type: { in: ['BANK', 'CRYPTO'] },
                    beneficiaryPaymentDetailId: { not: null },
                },
                orderBy: { createdAt: 'desc' },
                take: 50,
                include: { currency: true },
            });

            return res.status(200).json({
                success: true,
                transfers: transferRequests.map((t) => ({ ...t, currency: t.currency?.ISO ?? t.currencyId })),
            });
        } catch (error: any) {
            logger.error('Failed to list Nuvion payouts:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    // GET /payouts/nuvion/supported-currencies
    async getSupportedCurrencies(req: Request & Record<string, any>, res: Response) {
        try {
            // CHANGED — chain: null keeps this to the FIAT treasuries.
            // Stablecoin accounts (USC, UST) have a chain and are holding
            // accounts for replenishment, not currencies anyone can be paid in.
            // Without this filter, recording the Master-Base USC treasury made
            // this endpoint start returning USC alongside GHS, NGN and USD.
            const treasuries = await prisma.nuvionTreasuryAccount.findMany({
                where: { isActive: true, chain: null },
                select: { currency: true },
                distinct: ['currency'],
            });

            return res.status(200).json({ success: true, currencies: treasuries.map((t) => t.currency) });
        } catch (error: any) {
            logger.error('Failed to get supported currencies:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
}

export default new NuvionController();