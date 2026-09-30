// walletFunding.controller.ts

import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import walletFundingService from '../services/walletFunding.service'; // adjust path to match your real structure
import logger from '../config/logger';
import liquidityRampService from '../services/liquidityRamp.service';
import internalOfframpService from '../services/internalOfframp.service';
import { generalQueue } from '../workers/general.worker';
import config from '../config/env.config';

class InternalOfframpController {
 
    // POST /offramp/internal/quote
    // Cheap preview — no Quidax transaction created.
    async quote(req: Request & Record<string, any>, res: Response) {
        try {
            const { cryptoCurrencyId, amount, fiatCurrency = 'NGN' } = req.query as Record<string, string>;
 
            if (!cryptoCurrencyId || !amount) {
                return res.status(400).json({ success: false, msg: 'cryptoCurrencyId and amount are required' });
            }
 
            const currency = await prisma.currency.findUnique({ where: { id: cryptoCurrencyId } });
            if (!currency?.chain) {
                return res.status(400).json({ success: false, msg: 'Invalid currency' });
            }
 
            // getRate returns fiat-per-crypto-unit
            const rate = await liquidityRampService.getRate(currency.ISO, fiatCurrency, currency.chain);
            const estimatedFiat = (Number(amount) * rate).toFixed(2);
 
            return res.status(200).json({
                success: true,
                rate,
                estimatedFiatAmount: estimatedFiat,
                cryptoCurrency: currency.ISO,
                fiatCurrency,
                minimumAmount: config.OFFRAMP_MIN_USD ?? '5',
            });
 
        } catch (error: any) {
            logger.error('Offramp quote failed:', error);
            return res.status(400).json({ success: false, msg: error.message ?? 'Could not fetch rate' });
        }
    }
 
    // POST /offramp/internal/initiate
    async initiate(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;
            const { cryptoCurrencyId, amount, fiatCurrency = 'NGN' } = req.body;
 
            if (!cryptoCurrencyId || !amount) {
                return res.status(400).json({ success: false, msg: 'cryptoCurrencyId and amount are required' });
            }
 
            // Read the real record — req.user may carry only a subset
            const dbUser = await prisma.user.findUnique({
                where: { id: user.id },
                select: {
                    id: true, email: true, kycTier: true,
                    legalFirstName: true, legalLastName: true,
                },
            });
 
            if (!dbUser) return res.status(404).json({ success: false, msg: 'User not found' });
 
            // Tier 2 — same gate as wallet funding
            if ((dbUser.kycTier ?? 0) < 2) {
                return res.status(403).json({
                    success: false,
                    msg: 'Please complete identity verification before withdrawing to your bank.',
                    requiresKyc: true,
                });
            }
 
            if (!dbUser.legalFirstName || !dbUser.legalLastName) {
                return res.status(400).json({
                    success: false,
                    msg: 'Please complete identity verification first.',
                    requiresKyc: true,
                });
            }
 
            const result = await internalOfframpService.initiate({
                userId: dbUser.id,
                cryptoCurrencyId,
                amount: String(amount),
                fiatCurrency,
                userEmail: dbUser.email,
                legalFirstName: dbUser.legalFirstName,
                legalLastName: dbUser.legalLastName,
            });
 
            // Queue the on-chain send — slow and retry-prone, so it runs
            // outside the request cycle.
            await generalQueue.add('internal-offramp-send', { requestId: result.requestId });
 
            return res.status(200).json({ success: true, ...result });
 
        } catch (error: any) {
            logger.error('Internal offramp initiate failed:', error);
            return res.status(400).json({ success: false, msg: error.message ?? 'Could not initiate withdrawal' });
        }
    }
 
    // GET /offramp/internal/:requestId
    async getStatus(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;
            const { requestId } = req.params;
 
            const request = await prisma.internalOfframpRequest.findUnique({
                where: { id: requestId },
            });
 
            if (!request || request.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Request not found' });
            }
 
            return res.status(200).json({ success: true, request });
 
        } catch (error: any) {
            return res.status(400).json({ success: false, msg: error.message });
        }
    }
 
    // GET /offramp/internal
    async listRecent(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;
            const requests = await prisma.internalOfframpRequest.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: 'desc' },
                take: 20,
            });
 
            return res.status(200).json({ success: true, requests });
 
        } catch (error: any) {
            return res.status(400).json({ success: false, msg: error.message });
        }
    }
}

export default new InternalOfframpController();