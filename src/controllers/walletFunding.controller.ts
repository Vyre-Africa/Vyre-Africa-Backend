// walletFunding.controller.ts

import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import walletFundingService from '../services/walletFunding.service'; // adjust path to match your real structure
import logger from '../config/logger';
import liquidityRampService from '../services/liquidityRamp.service';

class WalletFundingController {

    async initiate(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;
            const { currencyId, fiatAmount, fiatCurrency } = req.body;

            if (!currencyId || !fiatAmount || !fiatCurrency) {
                return res.status(400).json({ success: false, msg: 'currencyId, fiatAmount and fiatCurrency are required' });
            }

            const result = await walletFundingService.initiateStablecoinWalletFunding({
                userId: user.id,
                currencyId,
                fiatAmount: String(fiatAmount),
                fiatCurrency,
                userDetails: {
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                },
            });

            return res.status(200).json({ success: true, ...result });

        } catch (error: any) {
            logger.error('Failed to initiate wallet funding:', error);
            return res.status(400).json({ success: false, msg: error.message ?? 'Could not initiate wallet funding' });
        }
    }

    async getRatePreview(req: Request & Record<string, any>, res: Response) {
        try {
            const { currencyId, fiatAmount, fiatCurrency } = req.query as Record<string, string>;
 
            if (!currencyId || !fiatAmount || !fiatCurrency) {
                return res.status(400).json({ success: false, msg: 'currencyId, fiatAmount and fiatCurrency are required' });
            }
 
            const currency = await prisma.currency.findUnique({ where: { id: currencyId } });
            if (!currency) return res.status(404).json({ success: false, msg: 'Currency not found' });
            if (!currency.chain) return res.status(400).json({ success: false, msg: `${currency.ISO} has no chain configured` });
 
            // getRate returns fiat-per-crypto-unit (probed with a fixed
            // test amount internally) — NOT a quote for this specific
            // size, so this is a genuine estimate, same spirit as the
            // Nuvion fee estimates shown before a real quote is fetched.
            const rate = await liquidityRampService.getRate(currency.ISO, fiatCurrency, currency.chain);
            const estimatedCryptoAmount = (Number(fiatAmount) / rate).toFixed(8);
 
            return res.status(200).json({
                success: true,
                rate,
                estimatedCryptoAmount,
                currency: currency.ISO,
                fiatCurrency: fiatCurrency.toUpperCase(),
            });
 
        } catch (error: any) {
            logger.error('Failed to fetch rate preview:', error);
            return res.status(400).json({ success: false, msg: error.message ?? 'Could not fetch rate' });
        }
    }

    async getStatus(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;
            const { reference } = req.params;

            const record = await prisma.walletFundingRequest.findUnique({
                where: { merchantReference: reference },
                include: { currency: true },
            });

            if (!record || record.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Funding request not found' });
            }

            return res.status(200).json({
                success: true,
                status: record.status,
                currency: record.currency.ISO,
                fiatAmount: record.fiatAmount,
                fiatCurrency: record.fiatCurrency,
                expectedCryptoAmount: record.expectedCryptoAmount,
                bankName: record.bankName,
                bankAccountNumber: record.bankAccountNumber,
                bankAccountName: record.bankAccountName,
                createdAt: record.createdAt,
                completedAt: record.completedAt,
                failureReason: record.failureReason,
            });

        } catch (error: any) {
            logger.error('Failed to fetch wallet funding status:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async listRecent(req: Request & Record<string, any>, res: Response) {
        try {
            const { user } = req;

            const records = await prisma.walletFundingRequest.findMany({
                where: { userId: user.id },
                include: { currency: true },
                orderBy: { createdAt: 'desc' },
                take: 20,
            });

            return res.status(200).json({
                success: true,
                requests: records.map(r => ({
                    reference: r.merchantReference,
                    status: r.status,
                    currency: r.currency.ISO,
                    fiatAmount: r.fiatAmount,
                    fiatCurrency: r.fiatCurrency,
                    expectedCryptoAmount: r.expectedCryptoAmount,
                    createdAt: r.createdAt,
                    completedAt: r.completedAt,
                })),
            });

        } catch (error: any) {
            logger.error('Failed to list wallet funding requests:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

}

export default new WalletFundingController();