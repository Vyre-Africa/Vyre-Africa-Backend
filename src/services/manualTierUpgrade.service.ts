// services/manualTierUpgrade.ts
//
// Tier 3, by hand.
//
// Tiers 1 and 2 are granted by a webhook when Didit approves a session.
// Tier 3 is not, and must never be: it is uncapped volume, granted on
// Vyre's own enhanced due diligence after a user asks for it. No automated
// path leads here, which is the point — the label "Enhanced Verified: full
// enhanced due diligence" is now true, where under the old ladder tier 3
// was granted by a proof-of-address document.
//
// Two operations, deliberately separate from the webhook file:
//
//   requestTier3  — the user asks. Creates a reviewable record, grants
//                   nothing.
//   grantTier3    — a named human decides. Grants, and says who and why.
//   revokeTier3   — because an uncapped tier that cannot be withdrawn is
//                   not a control.
//
// ── On who may call grantTier3 ─────────────────────────────────────────
//
// This module does NOT check permissions. It takes `approvedBy` and trusts
// it, because authorisation belongs at the route, where the session is.
// Wiring this to an endpoint without an admin guard in front of it would
// hand every user an uncapped tier — so that guard is the one thing the
// reviewer of this file has to go and confirm exists.

import logger from '../config/logger';
import prisma from '../config/prisma.client';
import { TIER_FOR_GRANT, upgradeMessage } from '../services/kycLimits.service';
import notificationService from './notification.service';

const TIER_ENHANCED = TIER_FOR_GRANT.manual;
/** The tier a user must already hold before an enhanced review is worth doing. */
const TIER_PREREQUISITE = TIER_FOR_GRANT.didit_address;

export interface ManualUpgradeInput {
  userId: string;
  /** The staff member's id or email. Stored, not decorative. */
  approvedBy: string;
  /** What the due diligence actually found. Required — see below. */
  note: string;
}

/**
 * A user asks to be considered for tier 3.
 *
 * Writes a PENDING record and nothing else. The queue of these is the
 * compliance team's work list.
 */
export async function requestTier3(userId: string, reason?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`No user ${userId}`);

  const tier = user.kycTier ?? 0;

  if (tier >= TIER_ENHANCED) {
    return { ok: false as const, reason: 'already_enhanced' };
  }

  // Asking before address verification is premature: enhanced due diligence
  // builds on a verified identity and a verified address, and without them
  // there is nothing for a reviewer to review.
  if (tier < TIER_PREREQUISITE) {
    return { ok: false as const, reason: 'prerequisite_not_met', needsTier: TIER_PREREQUISITE };
  }

  // One open request at a time. Without this, a user who taps twice puts
  // two identical items in the review queue.
  const existing = await prisma.kycVerification.findFirst({
    where: { userId, type: 'ENHANCED_DUE_DILIGENCE', status: 'PENDING' },
  });
  if (existing) return { ok: true as const, alreadyPending: true, id: existing.id };

  const record = await prisma.kycVerification.create({
    data: {
      userId,
      type: 'ENHANCED_DUE_DILIGENCE',
      country: user.country ?? 'GLOBAL',
      status: 'PENDING',
      flaggedForReview: true,
      reviewNote: reason
        ? `User requested enhanced review: ${reason}`
        : 'User requested enhanced review.',
      // Genuinely unresolved, awaiting a human.
      resolvedAt: null,
    },
  });

  logger.info(`Tier ${TIER_ENHANCED} review requested by user ${userId}`, { recordId: record.id });
  return { ok: true as const, alreadyPending: false, id: record.id };
}

/**
 * A human grants tier 3.
 *
 * `note` is required rather than optional on purpose. An uncapped tier with
 * no recorded reason is indistinguishable, a year later, from a mistake or
 * an insider favour — and it is exactly the record an auditor asks to see.
 */
export async function grantTier3({ userId, approvedBy, note }: ManualUpgradeInput) {
  if (!note?.trim()) throw new Error('A due diligence note is required to grant tier 3');
  if (!approvedBy?.trim()) throw new Error('approvedBy is required to grant tier 3');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`No user ${userId}`);

  const tier = user.kycTier ?? 0;

  if (tier < TIER_PREREQUISITE) {
    throw new Error(
      `User ${userId} is at tier ${tier}; tier ${TIER_PREREQUISITE} (address verified) is required before an enhanced grant`,
    );
  }

  if (tier >= TIER_ENHANCED) {
    logger.info(`User ${userId} already at tier ${tier} — enhanced grant by ${approvedBy} is a no-op`);
    return { ok: true as const, changed: false };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { kycTier: TIER_ENHANCED, kycTier3At: new Date() },
    }),
    // Close any open request, rather than leaving it in the queue.
    prisma.kycVerification.updateMany({
      where: { userId, type: 'ENHANCED_DUE_DILIGENCE', status: 'PENDING' },
      data: {
        status: 'APPROVED',
        flaggedForReview: false,
        reviewNote: `Granted by ${approvedBy}. ${note.trim()}`,
        resolvedAt: new Date(),
      },
    }),
    // And always leave a record, even where no request preceded it —
    // compliance can upgrade someone who never asked.
    prisma.kycVerification.create({
      data: {
        userId,
        type: 'ENHANCED_DUE_DILIGENCE',
        country: user.country ?? 'GLOBAL',
        status: 'APPROVED',
        flaggedForReview: false,
        reviewNote: `Tier ${TIER_ENHANCED} granted by ${approvedBy}. ${note.trim()}`,
        resolvedAt: new Date(),
      },
    }),
  ]);

  logger.info(`User ${userId} upgraded to kycTier ${TIER_ENHANCED} by ${approvedBy}`);

  await notificationService.queue({
    userId,
    title: 'Enhanced verification approved',
    type: 'GENERAL',
    content: upgradeMessage(TIER_ENHANCED),
  });

  return { ok: true as const, changed: true };
}

/**
 * Withdraw tier 3.
 *
 * Drops to the prerequisite tier rather than to zero: the identity and
 * address verifications behind it are still valid, and wiping them would
 * punish the user for a decision about their enhanced status.
 */
export async function revokeTier3({ userId, approvedBy, note }: ManualUpgradeInput) {
  if (!note?.trim()) throw new Error('A reason is required to revoke tier 3');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`No user ${userId}`);
  if ((user.kycTier ?? 0) < TIER_ENHANCED) return { ok: true as const, changed: false };

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { kycTier: TIER_PREREQUISITE, kycTier3At: null },
    }),
    prisma.kycVerification.create({
      data: {
        userId,
        type: 'ENHANCED_DUE_DILIGENCE',
        country: user.country ?? 'GLOBAL',
        status: 'FAILED',
        flaggedForReview: true,
        reviewNote: `Tier ${TIER_ENHANCED} revoked by ${approvedBy}. ${note.trim()}`,
        resolvedAt: new Date(),
      },
    }),
  ]);

  logger.warn(`User ${userId} tier ${TIER_ENHANCED} revoked by ${approvedBy}: ${note.trim()}`);
  return { ok: true as const, changed: true };
}