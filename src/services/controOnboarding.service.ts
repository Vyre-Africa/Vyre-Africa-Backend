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
import { mintDiditShareToken } from './didit.service';
import ablyService from './ably.service';

const CARD_PROGRAM_ID = process.env.CONTRO_CARD_PROGRAM_ID as string;

// ⚠️ STILL THE ONE BLOCKING UNKNOWN — Contro's Didit application ID,
// needed to mint a share token scoped correctly to them. Ask Contro
// directly if this hasn't been provided yet; nothing in this branch can
// actually succeed without it.
const CONTRO_DIDIT_APPLICATION_ID = process.env.CONTRO_DIDIT_APPLICATION_ID as string;

// ── Step 1: Start the KYC session ──────────────────────────────────────
// Still writes controKycSessionId — this is the fallback bridge, kept
// deliberately until externalUserId-in-webhook is proven reliable.

export async function startCardKyc(userId: string): Promise<{ success: boolean; sessionUrl?: string; sessionId?: string; skippedToDirectCreation?: boolean; error?: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'User not found' };
 
    if (user.controCardholderId) {
        return { success: false, error: 'User already has a Contro cardholder — KYC step already complete' };
    }
 
    // ── Branch: reuse existing Didit Tier 2 verification ────────────
    const hasApprovedDidit = user.kycTier >= 2 && user.diditSessionId && user.diditKycStatus === 'Approved';
 
    if (hasApprovedDidit) {
        if (!CONTRO_DIDIT_APPLICATION_ID) {
            logger.error('CONTRO_DIDIT_APPLICATION_ID not configured — cannot mint a share token. Falling back to Contro-hosted session instead.');
            // Deliberately NOT throwing — fall through to the original
            // flow below rather than blocking card issuance entirely
            // just because the optimization isn't configured yet.
        } else {
            const shareToken = await mintDiditShareToken({
                sessionId: user.diditSessionId!,
                forApplicationId: CONTRO_DIDIT_APPLICATION_ID,
            });
 
            if (!shareToken.success || !shareToken.share_token) {
                logger.error(`Failed to mint Didit share token for user ${userId}`, { error: shareToken.error });
                // Same reasoning — don't block the user on this
                // optimization failing; fall through to the hosted flow.
            } else {
                // CONFIRMED from Contro's docs: do NOT send firstName/
                // lastName — they read it from the shared verification.
                const cardholder = await createCardholder({
                    externalUserId: userId,
                    kycSource: 'didit',
                    diditShareToken: shareToken.share_token,
                    email: user.email,
                    phoneNumber: user.phoneNumber ?? '',
                } as any); // TODO: createCardholder's TS type currently only declares kycSource: 'web' — needs widening to accept 'didit' + diditShareToken as an alternative shape; see note below
 
                if (cardholder.success && cardholder.id) {
                    await prisma.user.update({
                        where: { id: userId },
                        data: { controCardholderId: cardholder.id, controKycStatus: cardholder.kycStatus },
                    });
 
                    const programKyc = await initiateProgramKyc(cardholder.id, CARD_PROGRAM_ID);
                    if (programKyc.success) {
                        await prisma.user.update({
                            where: { id: userId },
                            data: { controProgramKycStatus: programKyc.status ?? 'pending' },
                        });
                    }
 
                    logger.info(`User ${userId} onboarded to Contro via Didit share token — no duplicate verification needed`, { cardholderId: cardholder.id });
                    return { success: true, skippedToDirectCreation: true };
                }
 
                // CRITICAL per Contro's docs: "if a request fails for any
                // reason, the token is spent — retry with a newly minted
                // one, never the same token." If cardholder creation
                // failed here, the token above is now dead. Do NOT retry
                // with it. Falling through to the hosted-session flow
                // below is the safe recovery path — it needs no token at
                // all, so there's nothing stale to worry about reusing.
                logger.error(`createCardholder with Didit share token failed for user ${userId} — token is now spent, falling back to hosted session`, { error: cardholder.error });
            }
        }
    }
 
    // ── Fallback: original Contro-hosted kycSource:"web" flow,
    // completely unchanged from before this handshake existed ────────
    const session = await createKycSession(userId);
    if (!session.success || !session.id || !session.url) {
        return { success: false, error: session.error ?? 'Failed to create KYC session' };
    }
 
    await prisma.user.update({
        where: { id: userId },
        data: { controKycSessionId: session.id },
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
 
    // FIXED — kycSource: 'web' was missing entirely from this call. Real,
    // pre-existing bug: every call here was sending Contro a payload
    // without kycSource at all, only invisible because --transpile-only
    // strips type checking at runtime. Now matches the confirmed shape.
    const cardholder = await createCardholder({
        externalUserId: user.id,
        kycSource: 'web',
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

    // CORRECTED — uses the real, existing AblyService singleton
    await ablyService.notifyCardKycUpdate(userId, 'approved');

    logger.info(`Approval email queued for user ${userId}`);
    return { success: true, approved: true };
}