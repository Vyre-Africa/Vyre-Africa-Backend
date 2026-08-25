import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { getBankCodes } from '../services/nuvion.service';

class BeneficiaryController {

    async createBeneficiary(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const { ISO, type, accountName, email, country, addressLine1, addressCity, addressState, addressPostalCode } = req.body;

            if (!ISO || !type || !accountName) {
                return res.status(400).json({ success: false, msg: 'ISO, type, and accountName are required' });
            }

            if (type === 'BANK' && (!email || !country || !addressLine1 || !addressCity || !addressState || !addressPostalCode)) {
                return res.status(400).json({
                    success: false,
                    msg: 'Bank beneficiaries require email, country, and a full address (line1, city, state, postal code)',
                });
            }

            const beneficiary = await prisma.beneficiary.create({
                data: {
                    userId: user.id, ISO, type,
                    bank: type === 'BANK' ? { accountName } : undefined,
                    nuvionRecipientCountry: country,
                    nuvionRecipientEmail: email,
                    nuvionRecipientAddressLine1: addressLine1,
                    nuvionRecipientAddressCity: addressCity,
                    nuvionRecipientAddressState: addressState,
                    nuvionRecipientAddressPostal: addressPostalCode,
                } as any,
            });

            return res.status(200).json({ success: true, msg: 'Beneficiary added', beneficiary });
        } catch (error: any) {
            logger.error('Failed to create beneficiary:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async addPaymentDetail(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id } });
            if (!beneficiary || beneficiary.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const { currency, label, accountNumber, accountName, bankName, bankCode, swiftCode, iban, routingNumber, sortCode } = req.body;

            if (!currency || !accountNumber) {
                return res.status(400).json({ success: false, msg: 'currency and accountNumber are required' });
            }

            const paymentDetail = await prisma.beneficiaryPaymentDetail.create({
                data: {
                    beneficiaryId: id, currency, label,
                    accountNumber: String(accountNumber), accountName, bankName,
                    bankCode: bankCode ? String(bankCode) : undefined,
                    swiftCode, iban,
                    routingNumber: routingNumber ? String(routingNumber) : undefined,
                    sortCode: sortCode ? String(sortCode) : undefined,
                },
            });

            return res.status(200).json({ success: true, msg: 'Payment method added', paymentDetail });
        } catch (error: any) {
            logger.error('Failed to add payment detail:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async getBankCodesForCountry(req: Request & Record<string, any>, res: Response) {
        const { country } = req.params;
        try {
            if (!country || country.length !== 2) {
                return res.status(400).json({ success: false, msg: 'A valid 2-letter country code is required' });
            }
 
            const result = await getBankCodes(country.toUpperCase());
            if (!result.success) {
                return res.status(422).json({ success: false, msg: result.error ?? 'Failed to fetch bank list' });
            }
 
            return res.status(200).json({ success: true, banks: result.banks ?? [] });
 
        } catch (error: any) {
            logger.error('Failed to get bank codes:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async listPaymentDetails(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id } });
            if (!beneficiary || beneficiary.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const paymentDetails = await prisma.beneficiaryPaymentDetail.findMany({
                where: { beneficiaryId: id },
                orderBy: { createdAt: 'desc' },
            });

            return res.status(200).json({ success: true, paymentDetails });
        } catch (error: any) {
            logger.error('Failed to list payment details:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async deletePaymentDetail(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id, paymentDetailId } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id } });
            if (!beneficiary || beneficiary.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const paymentDetail = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
            if (!paymentDetail || paymentDetail.beneficiaryId !== id) {
                return res.status(404).json({ success: false, msg: 'Payment method not found' });
            }

            await prisma.beneficiaryPaymentDetail.delete({ where: { id: paymentDetailId } });

            return res.status(200).json({ success: true, msg: 'Payment method removed' });
        } catch (error: any) {
            logger.error('Failed to delete payment detail:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async listBeneficiaries(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const beneficiaries = await prisma.beneficiary.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: 'desc' },
                include: { paymentDetails: { select: { id: true, currency: true, label: true } } },
            });
 
            return res.status(200).json({
                success: true,
                beneficiaries: beneficiaries.map((b) => ({
                    id: b.id, type: b.type, ISO: b.ISO,
                    accountName: (b.bank as any)?.accountName,
                    country: b.nuvionRecipientCountry, // NEW — needed for the bank-codes lookup on the frontend
                    paymentMethodCount: b.paymentDetails.length,
                    currencies: b.paymentDetails.map((pd) => pd.currency),
                })),
            });
        } catch (error: any) {
            logger.error('Failed to list beneficiaries:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async getBeneficiary(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id }, include: { paymentDetails: true } });
            if (!beneficiary || beneficiary.userId !== user.id) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            return res.status(200).json({ success: true, beneficiary });
        } catch (error: any) {
            logger.error('Failed to get beneficiary:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
}

export default new BeneficiaryController();