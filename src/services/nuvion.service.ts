import axios from 'axios';
import config from '../config/env.config';
import prisma from '../config/prisma.client';
import logger from '../config/logger';

// AUTH SCHEME UNCONFIRMED — Bearer token assumed as the standard pattern,
// matching every other provider in this codebase. Run one real sandbox
// call and check for a 401 before trusting this — if wrong, Nuvion's
// error message will very likely say so explicitly.
const nuvionAxios = axios.create({
    baseURL: config.NUVION_BASE_URL ?? 'https://api.nuvion.co',
    headers: {
        Authorization: `Bearer ${config.NUVION_API_KEY}`,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

function handleNuvionError(context: string, error: any) {
    logger.error(`Nuvion call failed [${context}]:`, {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error.message,
    });
    return {
        error: error?.response?.data?.message ?? error?.response?.data?.error ?? error.message,
        rawData: error?.response?.data,
    };
}

export interface NuvionEntityResult {
    success: boolean;
    entityId?: string;
    personId?: string;
    status?: string;
    rawData?: any;
    error?: string;
}

export interface NuvionDocumentResult {
    success: boolean;
    documentId?: string;
    rawData?: any;
    error?: string;
}

// ─── Create individual entity ───────────────────────────────────────────────
// Request shape confirmed from Nuvion's core-concepts/entities.md docs.
// Response shape is NOT fully confirmed — Nuvion's own docs flag the full
// entity object as "pending confirmation" from their team. Log the raw
// response and verify entityId/personId/status field names against it
// before trusting the parsed return value in production logic.

export async function createIndividualEntity(userId: string): Promise<NuvionEntityResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'User not found' };

    if (user.nuvionEntityId) {
        return { success: true, entityId: user.nuvionEntityId, personId: user.nuvionPersonId ?? undefined, status: user.nuvionEntityStatus ?? undefined };
    }

    const nuvionGender = normalizeGenderForNuvion(user.legalGender);
    const nuvionDocumentType = normalizeDocumentTypeForNuvion(user.idDocumentType);

    const missing: string[] = [];
    if (!user.legalFirstName) missing.push('legalFirstName');
    if (!user.legalLastName) missing.push('legalLastName');
    if (!user.legalDateOfBirth) missing.push('legalDateOfBirth');
    if (!user.dojahBvnRef) missing.push('dojahBvnRef (BVN)');
    if (!user.nationality) missing.push('nationality');
    if (!user.addressLine1) missing.push('addressLine1');
    if (!nuvionDocumentType) missing.push('idDocumentType (unrecognized or missing)');
    if (!nuvionGender) missing.push('legalGender (unrecognized or missing)');
    if (missing.length > 0) {
        return { success: false, error: `Cannot create Nuvion entity, missing: ${missing.join(', ')}` };
    }

    try {
        const payload = {
            name: `${user.legalFirstName} ${user.legalLastName}`,
            person: {
                first_name: user.legalFirstName,
                last_name: user.legalLastName,
                date_of_birth: user.legalDateOfBirth!.toISOString().slice(0, 10),
                email: user.email,
                nationality: user.nationality,
                // gender: user.legalGender,
                ...(nuvionGender ? { gender: nuvionGender } : {}),
                phonenumber: user.phoneNumber,
                bvn: user.dojahBvnRef,
            },
            address: {
                line_1: user.addressLine1,
                line_2: user.addressLine2 ?? undefined,
                city: user.addressCity,
                state: user.addressState,
                postal_code: user.addressPostalCode,
                country_code: user.addressCountryCode,
            },
            identification: {
                document: {
                    type: nuvionDocumentType,
                    number: user.idDocumentNumber,
                    issue_date: user.idDocumentIssueDate?.toISOString().slice(0, 10),
                    expiry_date: user.idDocumentExpiryDate?.toISOString().slice(0, 10),
                    issuing_country: user.idDocumentIssuingCountry,
                },
            },
        };

        const res = await nuvionAxios.post('/individual-entities', payload);

        logger.info('Nuvion entity created — raw response', { userId, rawData: res.data });

        const entityId = res.data?.data?.entity?.id;
        const personId = res.data?.data?.person?.id;
        const status = res.data?.data?.entity?.status;

        if (!entityId || !personId) {
            logger.error('Nuvion entity creation succeeded but expected fields missing — check raw response above', { rawData: res.data });
            return { success: false, error: 'Missing entity/person id in Nuvion response', rawData: res.data };
        }

        await prisma.user.update({
            where: { id: userId },
            data: { nuvionEntityId: entityId, nuvionPersonId: personId, nuvionEntityStatus: status },
        });

        return { success: true, entityId, personId, status, rawData: res.data };

    } catch (error: any) {
        console.error('RAW NUVION ERROR:', error); // temporary — remove once diagnosed
        console.error('error.message:', error?.message);
        console.error('error.code:', error?.code);
        console.error('error.response:', error?.response);
        console.error('error.request present:', !!error?.request);

        const { error: msg, rawData } = handleNuvionError('createIndividualEntity', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Upload a document ───────────────────────────────────────────────────
// Request shape confirmed from Nuvion's core-concepts/entities.md docs
// (entity_id, key, description, file, file_back, link_to_identity).

export async function uploadNuvionDocument({
    entityId,
    personId,
    key,
    description,
    fileBase64,
    fileBackBase64,
    mimeType = 'image/jpeg',
}: {
    entityId: string;
    personId: string;
    key: 'identity' | 'address';
    description: string;
    fileBase64: string;
    fileBackBase64?: string;
    mimeType?: string;
}): Promise<NuvionDocumentResult> {
    try {
        const payload = {
            entity_id: entityId,
            key,
            description,
            file: fileBase64,
            ...(fileBackBase64 ? { file_back: fileBackBase64 } : {}),
            meta: {
                file_type: mimeType,
            },
            link_to_identity: { person_id: personId },
        };

        console.log('DEBUG — outgoing Nuvion document payload:', {
            ...payload,
            file: `[${payload.file?.length ?? 0} chars]`,
            file_back: payload.file_back ? `[${(payload as any).file_back.length} chars]` : undefined,
        });

        const res = await nuvionAxios.post('/documents', payload);

        logger.info(`Nuvion document uploaded [${key}] — raw response`, { entityId, rawData: res.data });
        const documentId = res.data?.data?.document?.id;

        if (!documentId) {
            logger.error('Nuvion document upload succeeded but no id found in response — check raw response above', { rawData: res.data });
        }

        return { success: true, documentId, rawData: res.data };

    } catch (error: any) {
        const { error: msg, rawData } = handleNuvionError(`uploadNuvionDocument:${key}`, error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Submit for onboarding review ────────────────────────────────────────

export async function submitOnboarding(entityId: string): Promise<{ success: boolean; status?: string; rawData?: any; error?: string }> {
    try {
        const res = await nuvionAxios.post('/onboarding-submissions', { entity_id: entityId });

        logger.info('Nuvion onboarding submitted — raw response', { entityId, rawData: res.data });

        return { success: true, status: res.data?.status, rawData: res.data };

    } catch (error: any) {
        const { error: msg, rawData } = handleNuvionError('submitOnboarding', error);
        return { success: false, error: msg, rawData };
    }
}

// ─── Fetch entity status directly ────────────────────────────────────────
// Useful for polling as a fallback until the entities.updated webhook is
// confirmed working — same "verify before trusting the webhook" approach
// used throughout this project for Tatum.

export async function getEntityStatus(entityId: string): Promise<{ success: boolean; status?: string; rawData?: any; error?: string }> {
    try {
        const res = await nuvionAxios.get(`/individual-entities/${entityId}`);
        logger.info('Nuvion entity status fetched — raw response', { entityId, rawData: res.data });
        return { success: true, status: res.data?.status, rawData: res.data };
    } catch (error: any) {
        const { error: msg, rawData } = handleNuvionError('getEntityStatus', error);
        return { success: false, error: msg, rawData };
    }
}

function normalizeGenderForNuvion(dojahGender: string | null | undefined): 'm' | 'f' | undefined {
    if (!dojahGender) return undefined;
    const g = dojahGender.trim().toLowerCase();
    if (g === 'male' || g === 'm') return 'm';
    if (g === 'female' || g === 'f') return 'f';
    return undefined; // unrecognized — omit rather than send something Nuvion will reject anyway
}

function normalizeDocumentTypeForNuvion(
    docType: string | null | undefined
): 'international_passport' | 'drivers_license' | 'national_id' | undefined {
    if (!docType) return undefined;
    const t = docType.trim().toLowerCase();
    if (t === 'passport' || t === 'international_passport') return 'international_passport';
    if (t === 'drivers_license' || t === "driver's_license" || t === 'dl') return 'drivers_license';
    if (t === 'national_id' || t === 'nin') return 'national_id';
    return undefined; // unrecognized — omit rather than send something guaranteed to fail
}