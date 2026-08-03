import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import { analyzeDocument } from '../services/dojah.service';
import { createIndividualEntity, uploadNuvionDocument, submitOnboarding } from '../services/nuvion.service';
import { uploadToStorage } from '../services/storage.service'; // adjust to your actual storage helper

class GlobalAccountController {

    // POST /kyc/document/analyze
    // Called by the frontend right after capture, BEFORE the confirm screen.
    // Returns extracted fields for pre-fill — does NOT persist anything.
    // Requires kycTier >= 2 (this step is gated behind Tier 2 completion,
    // per the earlier design decision).
    async analyzeDocumentEndpoint(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            if (user.kycTier < 2) {
                return res.status(403).json({ success: false, msg: 'Complete Tier 2 verification before proceeding.' });
            }

            const { imageFrontBase64, imageBackBase64 } = req.body as {
                imageFrontBase64?: string;
                imageBackBase64?: string;
            };

            if (!imageFrontBase64) {
                return res.status(400).json({ success: false, msg: 'imageFrontBase64 is required' });
            }

            const result = await analyzeDocument({ imageFrontBase64, imageBackBase64 });

            if (!result.success) {
                return res.status(502).json({ success: false, msg: result.error ?? 'Document analysis failed' });
            }

            if (!result.isValid) {
                return res.status(422).json({
                    success: false,
                    msg: `Document could not be validated (${result.reason}). Please retake the photo.`,
                });
            }

            // Return only what the frontend needs for pre-fill — not the
            // full raw Dojah payload (which includes the portrait image,
            // MRZ data, etc.)
            const fieldMap: Record<string, string> = {};
            for (const field of result.fields) {
                if (field.status === 1) fieldMap[field.field_key] = field.value;
            }

            return res.status(200).json({
                success: true,
                documentName: result.documentName,
                documentCountry: result.documentCountry,
                extracted: fieldMap,
                // frontend uses this to decide which fields need manual entry
                uncertainFields: result.fields.filter(f => f.status !== 1).map(f => f.field_key),
            });

        } catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Internal Server Error', success: false });
        }
    }


    // POST /kyc/global-account/submit
    // The full submission — address, document metadata (already confirmed
    // by the user on the frontend after the analyze step above), and the
    // actual image files. Creates the Nuvion entity, uploads documents,
    // and submits for review, all in one guarded, idempotent call.
    async submitGlobalAccount(req: Request & Record<string, any>, res: Response) {
        const { user } = req;
        try {
            if (user.kycTier < 2) {
                return res.status(403).json({ success: false, msg: 'Complete Tier 2 verification before proceeding.' });
            }

            if (user.nuvionEntityId) {
                return res.status(200).json({
                    success: true,
                    msg: 'Global account onboarding already submitted',
                    status: user.nuvionEntityStatus,
                });
            }

            const {
                addressLine1, addressLine2, addressCity, addressState, addressPostalCode, addressCountryCode,
                idDocumentType, idDocumentNumber, idDocumentIssueDate, idDocumentExpiryDate, idDocumentIssuingCountry,
                identityFrontBase64, identityBackBase64, proofOfAddressBase64,
            } = req.body as {
                addressLine1?: string; addressLine2?: string; addressCity?: string; addressState?: string;
                addressPostalCode?: string; addressCountryCode?: string;
                idDocumentType?: string; idDocumentNumber?: string; idDocumentIssueDate?: string;
                idDocumentExpiryDate?: string; idDocumentIssuingCountry?: string;
                identityFrontBase64?: string; identityBackBase64?: string; proofOfAddressBase64?: string;
            };

            const required = {
                addressLine1, addressCity, addressState, addressPostalCode, addressCountryCode,
                idDocumentType, idDocumentNumber, idDocumentIssuingCountry,
                identityFrontBase64, proofOfAddressBase64,
            };
            const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
            if (missing.length > 0) {
                return res.status(400).json({ success: false, msg: `Missing required fields: ${missing.join(', ')}` });
            }

            // 1. Persist submitted data to User first — so even if something
            // downstream fails, this doesn't need re-collecting from the user.
            await prisma.user.update({
                where: { id: user.id },
                data: {
                    addressLine1, addressLine2, addressCity, addressState, addressPostalCode, addressCountryCode,
                    idDocumentType, idDocumentNumber,
                    idDocumentIssueDate: idDocumentIssueDate ? new Date(idDocumentIssueDate) : undefined,
                    idDocumentExpiryDate: idDocumentExpiryDate ? new Date(idDocumentExpiryDate) : undefined,
                    idDocumentIssuingCountry,
                },
            });

            // 2. Persist document files locally FIRST — never lose these
            // the way Tier 2's photo-ID capture was discarded before.
            const identityFrontUpload = await uploadToStorage(
                Buffer.from(identityFrontBase64!, 'base64'),
                `kyc/${user.id}/identity-front-${Date.now()}.jpg`
            );
            await prisma.kycDocument.create({
                data: { userId: user.id, type: 'identity_front', storageUrl: identityFrontUpload.url },
            });

            let identityBackUploadUrl: string | undefined;
            if (identityBackBase64) {
                const identityBackUpload = await uploadToStorage(
                    Buffer.from(identityBackBase64, 'base64'),
                    `kyc/${user.id}/identity-back-${Date.now()}.jpg`
                );
                identityBackUploadUrl = identityBackUpload.url;
                await prisma.kycDocument.create({
                    data: { userId: user.id, type: 'identity_back', storageUrl: identityBackUpload.url },
                });
            }

            const proofOfAddressUpload = await uploadToStorage(
                Buffer.from(proofOfAddressBase64!, 'base64'),
                `kyc/${user.id}/proof-of-address-${Date.now()}.jpg`
            );
            await prisma.kycDocument.create({
                data: { userId: user.id, type: 'proof_of_address', storageUrl: proofOfAddressUpload.url },
            });

            // 3. Create the Nuvion entity
            const entityResult = await createIndividualEntity(user.id);
            if (!entityResult.success || !entityResult.entityId || !entityResult.personId) {
                return res.status(502).json({ success: false, msg: entityResult.error ?? 'Failed to create Nuvion entity' });
            }

            // 4. Upload identity document
            const identityDocResult = await uploadNuvionDocument({
                entityId: entityResult.entityId,
                personId: entityResult.personId,
                key: 'identity',
                description: `${idDocumentType} for ${user.legalFirstName} ${user.legalLastName}`,
                fileBase64: identityFrontBase64!,
                fileBackBase64: identityBackBase64,
            });
            if (!identityDocResult.success) {
                flagIncompleteSubmission(user.id, 'identity document upload failed', identityDocResult.error);
                return res.status(502).json({ success: false, msg: identityDocResult.error ?? 'Failed to upload identity document to Nuvion' });
            }
            if (identityDocResult.documentId) {
                await prisma.kycDocument.updateMany({
                    where: { userId: user.id, type: 'identity_front' },
                    data: { nuvionDocumentId: identityDocResult.documentId },
                });
            }

            // 5. Upload proof of address
            const addressDocResult = await uploadNuvionDocument({
                entityId: entityResult.entityId,
                personId: entityResult.personId,
                key: 'address',
                description: 'Proof of address',
                fileBase64: proofOfAddressBase64!,
            });
            if (!addressDocResult.success) {
                flagIncompleteSubmission(user.id, 'proof of address upload failed', addressDocResult.error);
                return res.status(502).json({ success: false, msg: addressDocResult.error ?? 'Failed to upload proof of address to Nuvion' });
            }
            if (addressDocResult.documentId) {
                await prisma.kycDocument.updateMany({
                    where: { userId: user.id, type: 'proof_of_address' },
                    data: { nuvionDocumentId: addressDocResult.documentId },
                });
            }

            // 6. Submit for review
            const submissionResult = await submitOnboarding(entityResult.entityId);
            if (!submissionResult.success) {
                flagIncompleteSubmission(user.id, 'onboarding submission failed', submissionResult.error);
                return res.status(502).json({ success: false, msg: submissionResult.error ?? 'Failed to submit onboarding to Nuvion' });
            }

            await prisma.user.update({
                where: { id: user.id },
                data: { nuvionEntityStatus: 'pending', nuvionSubmittedAt: new Date() },
            });

            return res.status(200).json({
                success: true,
                msg: 'Submitted for review — you\'ll be notified once processed.',
                entityId: entityResult.entityId,
                status: 'pending',
            });

        } catch (error) {
            console.log(error);
            return res.status(500).json({ msg: 'Internal Server Error', success: false });
        }
    }

}

// A submission that fails partway (entity created, but a document upload
// fails, say) leaves the user in a state that needs a human to notice —
// they can't easily retry through the normal flow since nuvionEntityId is
// already set. Flagging loudly here rather than silently swallowing it;
// wire this into whatever alerting you already have (Slack, PagerDuty,
// email) same as the UnreconciledDeposit flag earlier in this project.
function flagIncompleteSubmission(userId: string, stage: string, error?: string) {
    console.error(`[NUVION INCOMPLETE SUBMISSION] user=${userId} stage="${stage}" error="${error}" — needs manual follow-up`);
}

export default new GlobalAccountController();