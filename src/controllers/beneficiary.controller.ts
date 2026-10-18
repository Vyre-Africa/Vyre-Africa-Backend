import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { getBankCodes, updatePaymentDetail } from '../services/nuvion.service';
import { addressRequiredFor } from '../services/recipientparse.service';

class BeneficiaryController {

    async createBeneficiary(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            const { ISO, type, accountName, email, country, addressLine1, addressCity, addressState, addressPostalCode } = req.body;

            if (!ISO || !type || !accountName) {
                return res.status(400).json({ success: false, msg: 'ISO, type, and accountName are required' });
            }

            // if (type === 'BANK' && (!email || !country || !addressLine1 || !addressCity || !addressState || !addressPostalCode)) {
            //     return res.status(400).json({
            //         success: false,
            //         msg: 'Bank beneficiaries require email, country, and a full address (line1, city, state, postal code)',
            //     });
            // }

            const needsAddress = addressRequiredFor(ISO);
            if (type === 'BANK' && (!email || !country)) {
                return res.status(400).json({ success: false, msg: 'email and country are required' });
            }

            if (type === 'BANK' && needsAddress && (!addressLine1 || !addressCity || !addressState || !addressPostalCode)) {
                return res.status(400).json({ success: false, msg: `A full address is required for ${ISO} payouts` });
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

    async deleteBeneficiary(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({
                where: { id },
                include: { paymentDetails: { select: { id: true } } },
            });

            // Same shape as every other 404 here: a beneficiary belonging to
            // someone else is reported as missing, not as forbidden. Saying
            // "forbidden" would confirm the id exists.
            if (!beneficiary || beneficiary.userId !== user.id || (beneficiary as any).deletedAt) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const paymentDetailIds = beneficiary.paymentDetails.map((pd) => pd.id);

            let settled = 0;
            if (paymentDetailIds.length) {
                // Money in flight comes first. Removing a recipient mid-payout
                // orphans the job that is about to pay them.
                const inFlight = await prisma.transferRequest.count({
                    where: {
                        beneficiaryPaymentDetailId: { in: paymentDetailIds },
                        status: { in: ['PENDING', 'PROCESSING'] as any },
                    },
                });

                if (inFlight > 0) {
                    return res.status(409).json({
                        success: false,
                        msg: 'This recipient has a transfer in progress. You can remove them once it has settled.',
                    });
                }

                settled = await prisma.transferRequest.count({
                    where: { beneficiaryPaymentDetailId: { in: paymentDetailIds } },
                });
            }

            if (settled > 0) {
                // ARCHIVE. The row stays, the transaction records stay pointed at
                // it, and it leaves every list. We are required to keep these for
                // five years and the privacy policy says we do.
                await prisma.beneficiary.update({
                    where: { id },
                    data: { deletedAt: new Date() } as any,
                });

                return res.status(200).json({
                    success: true,
                    msg: 'Recipient removed',
                    archived: true,
                });
            }

            // No history: nothing to preserve, so it really goes. This is the path
            // the duplicate rows take.
            //
            // Explicit deleteMany rather than relying on `onDelete: Cascade` —
            // it works whether or not the relation declares one, and both
            // statements land together or not at all.
            await prisma.$transaction([
                prisma.beneficiaryPaymentDetail.deleteMany({ where: { beneficiaryId: id } }),
                prisma.beneficiary.delete({ where: { id } }),
            ]);

            return res.status(200).json({
                success: true,
                msg: 'Recipient removed',
                archived: false,
            });
        } catch (error: any) {
            logger.error('Failed to delete beneficiary:', error);
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

            const {
                currency, label, accountNumber, accountName, bankName, bankCode,
                swiftCode, iban, routingNumber, sortCode,
                paymentMethod, scheme,
                accountType, // NEW — required for Wire/ACH/RTP
                branchCode, institutionNumber, transitNumber,
                bankAddressLine1, bankAddressCity, bankAddressState, bankAddressPostal, bankAddressCountry, // NEW — required for Wire/ACH/RTP/SWIFT
            } = req.body;

            if (!currency || !accountNumber) {
                return res.status(400).json({ success: false, msg: 'currency and accountNumber are required' });
            }

            const validMethods = ['bank-transfer', 'momo-transfer', 'stablecoin-transfer', 'book-transfer'];
            if (paymentMethod && !validMethods.includes(paymentMethod)) {
                return res.status(400).json({ success: false, msg: `paymentMethod must be one of: ${validMethods.join(', ')}` });
            }

            const paymentDetail = await prisma.beneficiaryPaymentDetail.create({
                data: {
                    beneficiaryId: id, currency, label,
                    paymentMethod: paymentMethod ?? 'bank-transfer',
                    scheme,
                    accountNumber: String(accountNumber), accountName, bankName,
                    bankCode: bankCode ? String(bankCode) : undefined,
                    swiftCode, iban,
                    routingNumber: routingNumber ? String(routingNumber) : undefined,
                    sortCode: sortCode ? String(sortCode) : undefined,
                    accountType, // NEW
                    branchCode: branchCode ? String(branchCode) : undefined,
                    institutionNumber: institutionNumber ? String(institutionNumber) : undefined,
                    transitNumber: transitNumber ? String(transitNumber) : undefined,
                    bankAddressLine1, bankAddressCity, bankAddressState, bankAddressPostal, bankAddressCountry, // NEW
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
            // if (!beneficiary || beneficiary.userId !== user.id) {
            //     return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            // }

            if (!beneficiary || beneficiary.userId !== user.id || (beneficiary as any).deletedAt) {
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
                where: { userId: user.id, deletedAt: null } as any,
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
            // if (!beneficiary || beneficiary.userId !== user.id) {
            //     return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            // }

            if (!beneficiary || beneficiary.userId !== user.id || (beneficiary as any).deletedAt) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            return res.status(200).json({ success: true, beneficiary });
        } catch (error: any) {
            logger.error('Failed to get beneficiary:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }

    async updatePaymentDetail(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        const { id, paymentDetailId } = req.params;
        try {
            const beneficiary = await prisma.beneficiary.findUnique({ where: { id } });
            if (!beneficiary || beneficiary.userId !== user.id || (beneficiary as any).deletedAt) {
                return res.status(404).json({ success: false, msg: 'Beneficiary not found' });
            }

            const existing = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
            if (!existing || existing.beneficiaryId !== id) {
                return res.status(404).json({ success: false, msg: 'Payment method not found' });
            }

            const {
                accountName, bankName, bankCode, swiftCode, iban, routingNumber, sortCode,
                accountType,
                branchCode, institutionNumber, transitNumber,   // NEW — AUD BECS, HKD CHATS, CAD EFT
                bankAddressLine1, bankAddressCity, bankAddressState, bankAddressPostal, bankAddressCountry,
            } = req.body;

            // Leading zeros are significant on every one of these — a Canadian
            // institution number is 004, not 4 — so they stay strings all the way
            // down. An empty string means "not sent", not "clear it".
            const asText = (v: any) => (v === undefined || v === null || v === '' ? undefined : String(v));

            const routing: Record<string, string | undefined> = {
                bankCode: asText(bankCode),
                routingNumber: asText(routingNumber),
                sortCode: asText(sortCode),
                swiftCode: asText(swiftCode),
                iban: asText(iban),
                branchCode: asText(branchCode),
                institutionNumber: asText(institutionNumber),
                transitNumber: asText(transitNumber),
            };

            // WHERE THE MONEY GOES IS NOT EDITABLE once Nuvion holds the account.
            //
            // The sync below sends only the name, the bank name and the bank
            // address. Nuvion keeps its own copy of the routing fields and pays
            // against THAT. So editing a bank code here would change our row,
            // leave Nuvion's untouched, and send the next payout to the old
            // destination while this screen showed the new one — with nothing
            // anywhere reporting a failure.
            const changedRouting = Object.entries(routing)
                .filter(([k, v]) => v !== undefined && v !== ((existing as any)[k] ?? undefined))
                .map(([k]) => k);

            if (changedRouting.length && existing.nuvionPaymentDetailId) {
                return res.status(409).json({
                    success: false,
                    msg: 'Account and routing details can\'t be changed once an account has been used. Remove this account and add it again.',
                    fields: changedRouting,
                });
            }

            // Sync to Nuvion first — if this fails, don't touch the local
            // record, so the two never drift out of sync with each other.
            if (existing.nuvionPaymentDetailId) {
                const nuvionUpdate = await updatePaymentDetail(existing.nuvionPaymentDetailId, {
                    counterparty_id: beneficiary.nuvionCounterpartyId!, // confirmed required even on PATCH
                    account_holder_name: accountName,
                    ...(bankName && { bank_name: bankName }),
                    ...(bankAddressLine1 && {
                        bank_address: {
                            line1: bankAddressLine1, city: bankAddressCity,
                            state: bankAddressState, postal_code: bankAddressPostal, country: bankAddressCountry,
                        },
                    }),
                });
                if (!nuvionUpdate.success) {
                    return res.status(422).json({ success: false, msg: `Could not update with Nuvion: ${nuvionUpdate.error}` });
                }
            }

            const updated = await prisma.beneficiaryPaymentDetail.update({
                where: { id: paymentDetailId },
                data: {
                    accountName, bankName,
                    bankCode: routing.bankCode,
                    swiftCode: routing.swiftCode,
                    iban: routing.iban,
                    routingNumber: routing.routingNumber,
                    sortCode: routing.sortCode,
                    accountType,
                    branchCode: routing.branchCode,                 // NEW
                    institutionNumber: routing.institutionNumber,   // NEW
                    transitNumber: routing.transitNumber,           // NEW
                    bankAddressLine1, bankAddressCity, bankAddressState, bankAddressPostal, bankAddressCountry,
                },
            });

            return res.status(200).json({ success: true, msg: 'Payment method updated', paymentDetail: updated });
        } catch (error: any) {
            logger.error('Failed to update payment detail:', error);
            return res.status(500).json({ success: false, msg: 'Internal Server Error' });
        }
    }
 
}

export default new BeneficiaryController();