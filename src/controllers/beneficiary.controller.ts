import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { getBankCodes, updatePaymentDetail } from '../services/nuvion.service';
import { addressCollectedFromUser, emailCollectedFromUser } from '../services/recipientparse.service';
import { ensureNuvionCounterpartyAndPaymentDetail } from '../services/nuvionpayout.service';

// ── Registering the recipient with Nuvion at the moment it is saved ──────
//
// THE PROBLEM. Some banks and some account numbers are refused by Nuvion.
// Until now the first Nuvion call happened at the QUOTE step, so the refusal
// landed after the user had chosen a recipient, typed an amount and asked
// what it would cost — the worst possible moment, and one where the error
// reads as "the transfer failed" rather than "that account cannot be paid".
//
// Nothing is ADDED to the flow. These are the same two calls that used to run
// at quote time, moved earlier. `ensureNuvionCounterpartyAndPaymentDetail`
// short-circuits on the stored ids, so the quote step now finds the work done
// and gets faster.
//
// THE DISTINCTION THAT MATTERS. A failure here is one of two things, and they
// need opposite handling:
//
//   VALIDATION — the bank is not supported, the account number is wrong, the
//   scheme is not one Nuvion takes. This will never succeed on retry. Tell
//   the user NOW and do not keep a row that cannot be paid.
//
//   TRANSIENT — Nuvion is down, slow, or the socket dropped. The account is
//   probably fine. Blocking here would mean a short outage at Nuvion stops
//   people saving perfectly good recipients.
//
// Which way to lean is NOT symmetric. Treating a validation failure as
// transient costs nothing new: the user hits it at quote time, exactly as
// they do today. Treating a TRANSIENT failure as validation deletes a good
// account and tells someone their bank is unsupported when it is not — a new
// and much worse failure. So validation requires positive evidence and
// everything else is transient.
function isValidationFailure(err: any): boolean {
    // Nuvion named the fields it wanted. Unambiguous.
    if (err?.needsFields?.length) return true;

    // An HTTP status, where one survived, is the strongest signal there is.
    const status = Number(err?.status ?? err?.response?.status ?? 0);
    if (status >= 500) return false;                        // their fault, retryable
    if (status === 408 || status === 429) return false;     // timeout / rate limit, retryable
    if (status >= 400) return true;                         // our payload, not retryable

    const raw = typeof err?.rawData === 'string' ? err.rawData : JSON.stringify(err?.rawData ?? '');
    // Nuvion's own structured refusal codes — error_validation_error,
    // error_validation_required_field_missing, error_validation_phone_invalid.
    // Matching the PREFIX covers every member of that family.
    //
    // Deliberately NOT matching a bare /invalid/: "Invalid gateway response"
    // and similar appear in transient 5xx bodies, and that false positive
    // deletes a good account and tells the user their bank is unsupported.
    // A missed validation error merely defers to quote time, as today.
    if (/error_validation|not_supported|unsupported/i.test(raw)) return true;

    const msg = String(err?.message ?? '');
    // Our own pre-check in nuvionpayout.service.ts, which refuses an unknown
    // scheme before Nuvion ever sees it.
    if (/is not a payment scheme Nuvion accepts/i.test(msg)) return true;
    // The field-list error thrown by ensureNuvionCounterpartyAndPaymentDetail.
    if (/^This recipient needs:/i.test(msg)) return true;
    // Placeholder-config errors. Not the user's problem and not their bank's —
    // refusing the account would be a lie. Transient keeps the row, and the
    // thrown message names the unset env var in the logs.
    if (/Cannot build the placeholder/i.test(msg)) return false;

    return false;
}

// Kill switch. This change puts a third-party call in the path of saving a
// recipient, so there is a way to turn it off without a deploy if Nuvion
// becomes slow enough to hurt. Off means the old behaviour exactly: the
// registration happens at quote time instead.
const VERIFY_ON_SAVE = process.env.VERIFY_RECIPIENT_WITH_NUVION !== 'false';

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

            // CHANGED — was addressRequiredFor(ISO), which is true on every
            // rail because the address is always SENT. The question here is a
            // different one: must the USER supply it? On the African rails
            // Vyre's placeholder fills both the address and the email, so
            // demanding them rejects recipients Nuvion will accept.
            const needsAddress = addressCollectedFromUser(ISO);
            const needsEmail = emailCollectedFromUser(ISO);

            // Country stays unconditional — it drives the rail and the bank
            // country, and nothing can stand in for it.
            if (type === 'BANK' && !country) {
                return res.status(400).json({ success: false, msg: 'country is required' });
            }

            if (type === 'BANK' && needsEmail && !email) {
                return res.status(400).json({ success: false, msg: `An email address is required for ${ISO} payouts` });
            }

            // CHANGED — was all four address fields. Nuvion's measured minimum
            // is line1 + city + country (13 Oct), so demanding state and postal
            // code only rejected recipients Nuvion would have taken. Both are
            // still STORED when supplied; this guard is about what we REFUSE,
            // not what we keep.
            if (type === 'BANK' && needsAddress && (!addressLine1 || !addressCity)) {
                return res.status(400).json({ success: false, msg: `A street address and city are required for ${ISO} payouts` });
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

            if (!VERIFY_ON_SAVE) {
                return res.status(200).json({ success: true, msg: 'Payment method added', paymentDetail });
            }

            // ── Register with Nuvion now, not at quote time ──────────────
            try {
                const { counterpartyId, paymentDetailNuvionId } =
                    await ensureNuvionCounterpartyAndPaymentDetail(beneficiary, paymentDetail);

                logger.info('[Beneficiary] recipient registered with Nuvion on save', {
                    beneficiaryId: id, paymentDetailId: paymentDetail.id,
                    counterpartyId, paymentDetailNuvionId,
                });

                // Re-read so the response carries the nuvion ids the ensure
                // call just wrote, rather than the pre-write row.
                const verified = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetail.id } });

                return res.status(200).json({
                    success: true,
                    msg: 'Payment method added',
                    paymentDetail: verified ?? paymentDetail,
                    nuvionVerified: true,
                });
            } catch (nuvionError: any) {
                const validation = isValidationFailure(nuvionError);

                logger.warn('[Beneficiary] Nuvion refused a recipient at save time', {
                    beneficiaryId: id, paymentDetailId: paymentDetail.id, currency,
                    bankCode, validation, error: nuvionError?.message,
                });

                if (!validation) {
                    // Transient. Keep the row and let the user carry on — the
                    // quote step runs the same idempotent function and will
                    // pick this up. This is the pre-existing behaviour, so a
                    // Nuvion outage leaves the flow as it was rather than
                    // newly blocking it.
                    return res.status(200).json({
                        success: true,
                        msg: 'Payment method added',
                        paymentDetail,
                        nuvionVerified: false,
                        nuvionPending: true,
                    });
                }

                // Validation. This account cannot be paid, and a stored row
                // that cannot be paid is worse than no row: it sits in the
                // recipient list looking usable.
                //
                // Only the payment detail goes — NOT the beneficiary. The
                // person may be pre-existing with other accounts hanging off
                // them, and even when they are new they are a valid person
                // awaiting a valid account: the retry re-finds them through
                // the person dedupe and attaches the working account there.
                //
                // Hard delete, matching deletePaymentDetail. This row never
                // became usable — no Nuvion id, no transfer can reference it —
                // so there is no history to preserve and nothing for the
                // archive path in deleteBeneficiary to protect.
                try {
                    await prisma.beneficiaryPaymentDetail.delete({ where: { id: paymentDetail.id } });
                } catch (cleanupError: any) {
                    // Never let a failed cleanup mask the real reason. Log it
                    // and still tell the user what Nuvion said.
                    logger.error('[Beneficiary] could not roll back a refused payment detail', {
                        paymentDetailId: paymentDetail.id, error: cleanupError?.message,
                    });
                }

                // The counterparty, if one was created, is deliberately KEPT.
                // The person is valid; only the account was refused. Keeping
                // it makes the retry one call instead of two.
                return res.status(422).json({
                    success: false,
                    msg: nuvionError?.message ?? 'This account cannot be paid through our provider',
                    // Present when Nuvion named fields it wanted, so the screen
                    // can ask for exactly those instead of a generic failure.
                    ...(nuvionError?.needsFields?.length ? { needsFields: nuvionError.needsFields } : {}),
                    nuvionVerified: false,
                });
            }
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
 
            // `paymentMethodCount: 0` is now reachable: when Nuvion refuses an
            // account at save time the account row is removed and the person
            // is kept.
            //
            // Those rows are deliberately NOT filtered out here. This list is
            // what feeds `knownRecipients`, and `findExistingPerson` dedupes
            // against it — so hiding a person with no accounts would mean the
            // retry could not find them and would create a SECOND copy, which
            // is the duplicate-recipient bug the person dedupe exists to stop.
            //
            // If an empty recipient card is unwanted, that is a rendering
            // decision: the screen can hide `paymentMethodCount === 0` from
            // the picker while still passing the full list to the dedupe.
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