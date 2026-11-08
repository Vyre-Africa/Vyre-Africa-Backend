import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { getUsageSummary, getMonthlyUsage, KYC_TIERS, TIER_FOR_GRANT } from '../services/kycLimits.service';
import type { KycTier } from '../services/kycLimits.service';
import { createDiditSession, getDiditDecision } from '../services/didit.service';
import { requestTier3 } from '../services/manualTierUpgrade.service';

// ══════════════════════════════════════════════════════════════════════
// KYC controller, renumbered for the new tier ladder
//
//   0  Anonymous   nothing                    $200 / trade
//   1  Basic       Didit identity session     $5,000 / month
//   2  Standard    Didit address session      $100,000 / month
//   3  Enhanced    manual review, by request  uncapped
//
// ── What was removed ──────────────────────────────────────────────────
//
// The Dojah BVN / NIN route is retired, as decided. It granted tier 1, and
// tier 1 now means the Didit identity session — so left running it would
// mint tier-1 users at $5,000/month who never passed identity verification.
// `getIdTypes` and `upgradeTier1` now answer 410 Gone rather than vanishing,
// because the web app may still call them and a 404 reads like an outage.
// Their Dojah imports are gone; delete dojah.service too once nothing else
// references it.
//
// `upgradeTier2` and `getTier2Status` are also retired. `upgradeTier2`
// created a Didit session with NO workflowId, so it relied on the account
// default — harmless when there was one workflow, ambiguous now there are
// two. `startIdentityVerification` does the same job and names its workflow.
// The large commented-out block above the old `upgradeTier2` went with it;
// it was the pre-Didit Dojah selfie flow and is in git history if needed.
//
// ── What moved ────────────────────────────────────────────────────────
//
// Every tier comparison shifted down one. They are written against
// TIER_FOR_GRANT rather than as literals, so the next renumber is a change
// to the limits table and nothing else:
//
//   identity complete:  kycTier >= 2  ->  >= TIER_IDENTITY (1)
//   address  allowed:   kycTier >= 2  ->  >= TIER_IDENTITY (1)
//   address  complete:  kycTier >= 3  ->  >= TIER_ADDRESS  (2)
// ══════════════════════════════════════════════════════════════════════

const TIER_IDENTITY = TIER_FOR_GRANT.didit_identity; // 1
const TIER_ADDRESS = TIER_FOR_GRANT.didit_address;   // 2
const TIER_ENHANCED = TIER_FOR_GRANT.manual;         // 3

const GONE = {
  success: false,
  msg: 'This verification route has been retired. Use POST /kyc/verify/identity.',
};

class KycController {

  // GET /kyc/id-types?country=NG
  // RETIRED — served the Dojah BVN / NIN flow.
  async getIdTypes(_req: Request, res: Response) {
    return res.status(410).json(GONE);
  }

  // POST /kyc/upgrade/tier1
  // RETIRED — Dojah BVN / NIN. See the header note.
  async upgradeTier1(_req: Request & Record<string, any>, res: Response) {
    return res.status(410).json(GONE);
  }

  // POST /kyc/upgrade/tier2
  // RETIRED — superseded by POST /kyc/verify/identity.
  async upgradeTier2(_req: Request & Record<string, any>, res: Response) {
    return res.status(410).json(GONE);
  }

  // GET /kyc/tier2/status
  // RETIRED — superseded by GET /kyc/status, which reports both flows.
  async getTier2Status(_req: Request & Record<string, any>, res: Response) {
    return res.status(410).json({
      success: false,
      msg: 'This status route has been retired. Use GET /kyc/status.',
    });
  }

  // GET /kyc/lookup?email=someone@example.com
  //
  // ⚠️ READ BEFORE TOUCHING THIS ENDPOINT. Two problems, neither introduced
  // by the renumber, both worth a decision.
  //
  // 1. IMPERSONATION. The stated purpose is "silently apply higher limits
  //    when the email belongs to a verified registered account" — but the
  //    caller is anonymous and the email is unverified. Anyone who knows a
  //    verified user's email address can type it into the anonymous order
  //    flow and transact under that user's tier. At the new numbers that is
  //    $100,000 a month of someone else's allowance, with no identity
  //    check anywhere in the path. If the anonymous flow consumes the
  //    looked-up limit, it also burns the real user's headroom.
  //
  //    The fix is an ownership proof — a one-time code to that address
  //    before the limit is applied — not anything in this file.
  //
  // 2. VOLUME DISCLOSURE. The comment says "No PII ever returned", and no
  //    name or ID is. But `usedUsd` tells any unauthenticated caller how
  //    much a given email has traded this month, and there is no rate limit
  //    in front of it. That is commercially sensitive on its own and an
  //    account-existence oracle in aggregate.
  //
  // The response shape is left alone so the current caller keeps working.
  // What IS fixed here: the limits were hardcoded inline as a third copy of
  // the tier table (1 -> 10000, 2 -> 50000) and are now read from it.
  async lookupByEmail(req: Request, res: Response) {
    const email = (req.query.email as string)?.toLowerCase().trim();
    try {
      if (!email) {
        return res.status(400).json({ success: false, msg: 'email is required' });
      }

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, kycTier: true }, // never select PII
      });

      // No account — return Tier 0 defaults, not an error
      if (!user) {
        return res.status(200).json({
          success: true,
          kycTier: 0,
          monthlyLimitUsd: KYC_TIERS[0].monthlyUsd,
          usedUsd: 0,
          remainingUsd: null,
        });
      }

      const tier = Number(user.kycTier ?? 0) as KycTier;
      const usedUsd = await getMonthlyUsage(user.id);

      // From the table. The inline ternary this replaces would have kept
      // quoting the old $10,000 and $50,000 after the renumber.
      const monthlyLimitUsd = KYC_TIERS[tier]?.monthlyUsd ?? null;

      const remainingUsd =
        monthlyLimitUsd !== null ? Math.max(0, monthlyLimitUsd - usedUsd) : null;

      return res.status(200).json({
        success: true,
        kycTier: tier,
        monthlyLimitUsd,
        usedUsd,
        remainingUsd,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // GET /kyc/usage
  async getUsage(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const summary = await getUsageSummary(user.id, user.kycTier as KycTier);
      return res.status(200).json({
        success: true,
        msg: 'KYC usage fetched successfully',
        data: summary,
      });
    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // POST /kyc/verify/identity
  // Workflow A — ID + liveness + face match + AML → Tier 1
  async startIdentityVerification(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, kycTier: true },
      });

      if (!fresh) {
        return res.status(404).json({ success: false, msg: 'User not found' });
      }

      // Was `>= 2`. Left at 2, a user who had just completed identity
      // verification would sit at tier 1, fail this check, and be sent
      // through the whole Didit flow a second time to no effect.
      if ((fresh.kycTier ?? 0) >= TIER_IDENTITY) {
        return res.status(200).json({
          success: true,
          msg: 'Identity already verified',
          kycTier: fresh.kycTier,
        });
      }

      const session = await createDiditSession({
        workflowId: config.DIDIT_IDENTITY_WORKFLOW_ID,
        vendorData: fresh.id,
        callback: `${config.FRONTEND_URL}/kyc/callback?flow=identity`,
        metadata: { purpose: 'identity_verification' },
      });

      if (!session.success || !session.url || !session.session_id) {
        console.log('Didit identity session creation failed:', session.error);
        return res.status(422).json({
          success: false,
          msg: session.error ?? 'Failed to start identity verification. Please try again.',
        });
      }

      await prisma.user.update({
        where: { id: fresh.id },
        data: { diditSessionId: session.session_id, diditKycStatus: session.status },
      });

      return res.status(200).json({
        success: true,
        msg: 'Identity verification session created',
        sessionUrl: session.url,
        sessionId: session.session_id,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // POST /kyc/verify/address
  // Workflow B — POA only → Tier 2
  async startAddressVerification(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, kycTier: true },
      });

      if (!fresh) {
        return res.status(404).json({ success: false, msg: 'User not found' });
      }

      // Identity must come first — you can't prove where you live before
      // proving who you are. Was `< 2`; at the new numbering that would have
      // demanded address verification before address verification.
      if ((fresh.kycTier ?? 0) < TIER_IDENTITY) {
        return res.status(403).json({
          success: false,
          msg: 'Verify your identity before verifying your address.',
          requiresIdentityFirst: true,
        });
      }

      // Was `>= 3`. Tier 3 is now a manual grant, so a user who had finished
      // address verification would sit at 2, fail this, and be offered the
      // address flow again forever.
      if ((fresh.kycTier ?? 0) >= TIER_ADDRESS) {
        return res.status(200).json({
          success: true,
          msg: 'Address already verified',
          kycTier: fresh.kycTier,
        });
      }

      const session = await createDiditSession({
        workflowId: config.DIDIT_ADDRESS_WORKFLOW_ID,
        vendorData: fresh.id,
        callback: `${config.FRONTEND_URL}/kyc/callback?flow=address`,
        metadata: { purpose: 'address_verification' },
      });

      if (!session.success || !session.url || !session.session_id) {
        console.log('Didit address session creation failed:', session.error);
        return res.status(422).json({
          success: false,
          msg: session.error ?? 'Failed to start address verification. Please try again.',
        });
      }

      await prisma.user.update({
        where: { id: fresh.id },
        data: { diditAddressSessionId: session.session_id, diditAddressKycStatus: session.status },
      });

      return res.status(200).json({
        success: true,
        msg: 'Address verification session created',
        sessionUrl: session.url,
        sessionId: session.session_id,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // POST /kyc/request-enhanced
  //
  // The user asks to be considered for tier 3. Grants nothing — it creates
  // a PENDING record for the compliance queue, and `grantTier3` (admin only,
  // in manualTierUpgrade) is what actually promotes.
  //
  // Deliberately no admin grant/revoke route here. Those take `approvedBy`
  // and must sit behind an admin guard; putting them on the user-facing KYC
  // controller is how one ends up exposed by accident.
  async requestEnhancedReview(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const reason = typeof req.body?.reason === 'string'
        ? req.body.reason.slice(0, 300).trim()
        : undefined;

      const result = await requestTier3(user.id, reason || undefined);

      if (!result.ok) {
        if (result.reason === 'already_enhanced') {
          return res.status(200).json({
            success: true,
            msg: 'Your account is already enhanced verified.',
          });
        }
        return res.status(403).json({
          success: false,
          msg: 'Verify your address before requesting an enhanced review.',
          needsTier: result.needsTier,
        });
      }

      return res.status(200).json({
        success: true,
        msg: result.alreadyPending
          ? "Your request is already with us — we'll be in touch."
          : "Request received. We'll review your account and get back to you.",
        alreadyPending: result.alreadyPending,
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

  // GET /kyc/status
  // Returns the state of all three steps so the frontend can render a real
  // ladder rather than a single opaque status.
  async getVerificationStatus(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    try {
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          kycTier: true,
          diditSessionId: true,
          diditKycStatus: true,
          diditAddressSessionId: true,
          diditAddressKycStatus: true,
        },
      });

      if (!fresh) {
        return res.status(404).json({ success: false, msg: 'User not found' });
      }

      // Re-check non-terminal statuses directly rather than trusting a
      // possibly-stale cached value — the webhook is a trigger, not a
      // guaranteed-arrived source of truth.
      const nonTerminal = ['Not Started', 'In Progress'];

      let identityStatus = fresh.diditKycStatus;
      if (fresh.diditSessionId && nonTerminal.includes(identityStatus ?? '')) {
        const d = await getDiditDecision(fresh.diditSessionId);
        if (d.success && d.status && d.status !== identityStatus) {
          await prisma.user.update({
            where: { id: user.id },
            data: { diditKycStatus: d.status },
          });
          identityStatus = d.status;
        }
      }

      let addressStatus = fresh.diditAddressKycStatus;
      if (fresh.diditAddressSessionId && nonTerminal.includes(addressStatus ?? '')) {
        const d = await getDiditDecision(fresh.diditAddressSessionId);
        if (d.success && d.status && d.status !== addressStatus) {
          await prisma.user.update({
            where: { id: user.id },
            data: { diditAddressKycStatus: d.status },
          });
          addressStatus = d.status;
        }
      }

      const tier = fresh.kycTier ?? 0;

      // Whether an enhanced review is already in the queue. Without this the
      // app cannot tell "not requested" from "waiting on us", and a user who
      // has asked sees a button that invites them to ask again.
      const pendingEnhanced = tier >= TIER_ADDRESS && tier < TIER_ENHANCED
        ? await prisma.kycVerification.findFirst({
            where: { userId: user.id, type: 'ENHANCED_DUE_DILIGENCE', status: 'PENDING' },
            select: { id: true, createdAt: true },
          })
        : null;

      return res.status(200).json({
        success: true,
        kycTier: tier,
        tierName: KYC_TIERS[tier as KycTier]?.name ?? KYC_TIERS[0].name,
        identity: {
          hasSession: !!fresh.diditSessionId,
          sessionId: fresh.diditSessionId,
          status: identityStatus,
          complete: tier >= TIER_IDENTITY,
        },
        address: {
          hasSession: !!fresh.diditAddressSessionId,
          sessionId: fresh.diditAddressSessionId,
          status: addressStatus,
          complete: tier >= TIER_ADDRESS,
          available: tier >= TIER_IDENTITY, // can't start until identity is done
        },
        // Tier 3 has no Didit session behind it — it is requested, then
        // granted by a human. The app needs all three states to render the
        // top of the ladder honestly.
        enhanced: {
          complete: tier >= TIER_ENHANCED,
          available: tier >= TIER_ADDRESS,
          requested: !!pendingEnhanced,
          requestedAt: pendingEnhanced?.createdAt ?? null,
        },
      });

    } catch (error) {
      console.log(error);
      return res.status(500).json({ msg: 'Internal Server Error', success: false });
    }
  }

}

export default new KycController();