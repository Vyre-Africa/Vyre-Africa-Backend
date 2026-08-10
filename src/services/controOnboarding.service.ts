// services/controCardOnboarding.service.ts
//
// Updated: handleKycSessionCompleted now takes an optional externalUserId
// directly from the webhook payload as the PRIMARY way to identify which
// Vyre user this session belongs to — since externalUserId IS Vyre's own
// userId (confirmed: that's literally what startCardKyc sends when
// creating the session), and Contro's other confirmed response schemas
// consistently echo it back, this is a well-founded bet that it'll be in
// the webhook payload too.
//
// NOT YET CONFIRMED, though — we have never seen a real
// kyc_session.completed webhook body, only the delivery-LOG schema
// (different thing). So the controKycSessionId bridge from before is
// KEPT as a fallback, not removed, until a real webhook proves
// externalUserId is reliably present. Once confirmed, the sessionId
// field/lookup path can be deleted as dead weight.

import prisma from '../config/prisma.client';
import logger from '../config/logger';
import {
    createKycSession,
    createCardholder,
    initiateProgramKyc,
    getProgramKycStatus,
} from './contro.service';
import notificationService from './notification.service';

const CARD_PROGRAM_ID = process.env.CONTRO_CARD_PROGRAM_ID as string;

// ── Step 1: Start the KYC session ──────────────────────────────────────
// Still writes controKycSessionId — this is the fallback bridge, kept
// deliberately until externalUserId-in-webhook is proven reliable.

export async function startCardKyc(userId: string): Promise<{ success: boolean; sessionUrl?: string; sessionId?: string; error?: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'User not found' };

    if (user.controCardholderId) {
        return { success: false, error: 'User already has a Contro cardholder — KYC step already complete' };
    }

    // externalUserId = user.id — this IS the field the webhook lookup
    // below will try to use directly once we confirm it's echoed back.
    const session = await createKycSession(userId);
    if (!session.success || !session.id || !session.url) {
        return { success: false, error: session.error ?? 'Failed to create KYC session' };
    }

    await prisma.user.update({
        where: { id: userId },
        data: { controKycSessionId: session.id }, // fallback bridge — see file header
    });

    return { success: true, sessionUrl: session.url, sessionId: session.id };
}

// ── Step 2: Handle a completed KYC session ─────────────────────────────
//
// externalUserId param — extracted by the webhook handler from the real
// payload, PREFERRED over the sessionId-based lookup. If it's present
// and resolves to a real user, that user IS correct by construction
// (externalUserId only ever equals a real Vyre userId, since that's the
// only thing we ever send as that field) — no ambiguity, no fallback
// needed in that case.
//
// If externalUserId is missing/doesn't resolve (payload shape turned out
// different than expected, or this is being called from some other
// trigger that doesn't have it), falls back to the sessionId bridge —
// same behavior as before.

export async function handleKycSessionCompleted(
    sessionId: string,
    externalUserId?: string
): Promise<{ success: boolean; error?: string }> {
    let user = null;

    if (externalUserId) {
        user = await prisma.user.findUnique({ where: { id: externalUserId } });
        if (user) {
            logger.info(`Resolved user ${user.id} via externalUserId from webhook payload (primary path)`);
        } else {
            logger.warn(`externalUserId "${externalUserId}" from webhook payload did not match any real user — falling back to sessionId lookup`);
        }
    }

    if (!user) {
        user = await prisma.user.findFirst({ where: { controKycSessionId: sessionId } });
        if (user) {
            logger.info(`Resolved user ${user.id} via controKycSessionId fallback bridge`);
        }
    }

    if (!user) {
        logger.warn(`No user found for Contro KYC session ${sessionId} via either externalUserId or sessionId bridge`);
        return { success: false, error: 'No matching user for this session' };
    }

    if (user.controCardholderId) {
        logger.info(`User ${user.id} already has a cardholder (${user.controCardholderId}) — skipping duplicate handling`);
        return { success: true };
    }

    const cardholder = await createCardholder({
        externalUserId: user.id,
        kycSessionId: sessionId,
        email: user.email,
        phoneNumber: user.phoneNumber ?? '',
    });

    if (!cardholder.success || !cardholder.id) {
        logger.error(`Failed to create cardholder for user ${user.id}`, { error: cardholder.error });
        return { success: false, error: cardholder.error };
    }

    await prisma.user.update({
        where: { id: user.id },
        data: { controCardholderId: cardholder.id, controKycStatus: cardholder.kycStatus },
    });

    const programKyc = await initiateProgramKyc(cardholder.id, CARD_PROGRAM_ID);
    if (!programKyc.success) {
        logger.error(`Failed to initiate program KYC for cardholder ${cardholder.id}`, { error: programKyc.error });
        return { success: false, error: programKyc.error };
    }

    await prisma.user.update({
        where: { id: user.id },
        data: { controProgramKycStatus: programKyc.status ?? 'pending' },
    });

    logger.info(`Program KYC initiated for user ${user.id}`, { cardholderId: cardholder.id, status: programKyc.status });
    return { success: true };
}

// ── Step 3 — unchanged from before ──────────────────────────────────────

export async function checkProgramKycAndNotify(userId: string): Promise<{ success: boolean; approved?: boolean; error?: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.controCardholderId) {
        return { success: false, error: 'User has no Contro cardholder yet' };
    }

    const kycCheck = await getProgramKycStatus(user.controCardholderId, CARD_PROGRAM_ID);
    if (!kycCheck.success) {
        return { success: false, error: kycCheck.error };
    }

    await prisma.user.update({
        where: { id: userId },
        data: { controProgramKycStatus: kycCheck.kycStatus },
    });

    if (kycCheck.kycStatus !== 'approved') {
        logger.info(`Program KYC for user ${userId} still "${kycCheck.kycStatus}" — not notifying yet`);
        return { success: true, approved: false };
    }

    if (user.controCardApprovalEmailSentAt) {
        logger.info(`Approval email already sent to user ${userId} at ${user.controCardApprovalEmailSentAt} — skipping duplicate`);
        return { success: true, approved: true };
    }

    // TODO: replace with the real queue import once confirmed — see the
    // "one real gap" note from the previous message, still open.

    await notificationService.queue({
        userId: user.id,
        title: 'Your card is ready to create',
        type: 'GENERAL',
        content: 'Your identity verification is approved — you can now create your Vyre card.',
    });

    await prisma.user.update({
        where: { id: userId },
        data: { controCardApprovalEmailSentAt: new Date() },
    });

    logger.info(`Approval email queued for user ${userId}`);
    return { success: true, approved: true };
}