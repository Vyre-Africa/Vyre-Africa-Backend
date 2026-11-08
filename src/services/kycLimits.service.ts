import prisma from '../config/prisma.client';

// ─── Tier Limits (all values in USD) ──────────────────────────────────────────
//
// ── The ladder, after the renumber ────────────────────────────────────────────
//
//   0  Anonymous   nothing                   $200 per trade
//   1  Basic       Didit identity session    $5,000 / month      (was $10,000)
//   2  Standard    Didit address session     $100,000 / month    (was $50,000)
//   3  Enhanced    manual review, on request uncapped
//
// What moved: the Didit identity session used to grant tier 2 and now grants
// tier 1; the address session used to grant tier 3 and now grants tier 2;
// tier 3 is no longer reachable by webhook at all and is granted by hand
// after Vyre's own due diligence. `grantedBy` below records that, so the
// webhook asks this table which tier a workflow grants instead of carrying
// its own copy of the mapping.
//
// This table is the ONLY place a limit is written down. The webhook's upgrade
// notification used to contain a hardcoded "$50,000/month" sentence, which
// meant the number a user was told and the number enforced were two separate
// facts that happened to agree. `upgradeMessage` at the bottom of this file
// derives that copy from here.

export const KYC_TIERS = {
  0: {
    name: 'Anonymous',
    perTradeUsd: 200,
    // ⚠️ No monthly aggregate. Fifty trades of $199 is $9,950 moved with no
    // identity attached and no rule noticing — textbook structuring. Setting
    // this to a number is all it takes to close; the check below already
    // reads it. Left null to preserve current behaviour rather than change
    // policy without being asked.
    monthlyUsd: null,
    requirement: 'No verification required',
    grantedBy: 'none',
  },
  1: {
    name: 'Basic',
    perTradeUsd: null,
    monthlyUsd: 5_000,
    requirement: 'Government ID + selfie match',
    grantedBy: 'didit_identity',
  },
  2: {
    name: 'Standard',
    perTradeUsd: null,
    monthlyUsd: 100_000,
    requirement: 'Proof of address',
    grantedBy: 'didit_address',
  },
  3: {
    name: 'Enhanced',
    perTradeUsd: null,
    monthlyUsd: null,
    requirement: 'Full enhanced due diligence, by request',
    grantedBy: 'manual',
  },
} as const;

export type KycTier = keyof typeof KYC_TIERS;
export type TierGrant = (typeof KYC_TIERS)[KycTier]['grantedBy'];

/**
 * Which tier a grant route confers. The webhook imports this rather than
 * hardcoding 1 and 2, so a future renumber is a change to the table above
 * and nothing else.
 */
export const TIER_FOR_GRANT: Record<Exclude<TierGrant, 'none'>, KycTier> = {
  didit_identity: 1,
  didit_address: 2,
  manual: 3,
};

// A single trade at or above this is allowed but flagged for a human.
//
// NOTE: this was equal to the old tier 2 monthly cap. That is now a
// coincidence rather than a relationship — tier 2 is $100,000 and this is
// still $50,000, so a Standard user can make two unflagged trades that
// exhaust their month. If it was meant to track the top monthly cap, it
// should be derived; if it is an independent "large trade" threshold, it is
// fine as a literal. Worth a decision either way.
const MANUAL_REVIEW_THRESHOLD_USD = 50_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface LimitCheckResult {
  allowed: boolean;
  flagForReview: boolean;
  reason?: string;
  remainingUsd?: number;
  limitUsd?: number;
  usedUsd?: number;
}

// ─── Safe tier resolver ────────────────────────────────────────────────────────
// Coerces any incoming value (string "0", number 0, undefined, null) to a valid
// KycTier key. Defaults to 0 (Anonymous) if the value is unrecognised.

function resolveTier(raw: any): KycTier {
  const n = Number(raw);
  if (n === 0 || n === 1 || n === 2 || n === 3) return n as KycTier;
  return 0;
}

// ─── Check limit before creating an order ──────────────────────────────────────

export async function checkKycLimit({
  userId,
  kycTier,
  tradeAmountUsd,
}: {
  userId: string | null;
  kycTier: KycTier | number | string;
  tradeAmountUsd: number;
}): Promise<LimitCheckResult> {
  const tier = resolveTier(kycTier);
  const limits = KYC_TIERS[tier];

  // 0. The amount must be a real number.
  //
  // ⚠️ SEPARATE FIX — revertable on its own, nothing else depends on it.
  //
  // Without this the limits fail OPEN. `toUsd` returns NaN when ratePerUsd is
  // absent or malformed, and every comparison against NaN is false: the
  // per-trade check passes, the monthly check passes, flagForReview is false,
  // and the trade is allowed at any size with no review. `recordUsage` then
  // increments volumeUsd by NaN, which poisons that user's counter for the
  // rest of the period — every later check against it is NaN too.
  //
  // ratePerUsd === 0 was already safe by accident (Infinity > cap blocks).
  // It is a missing or NaN rate that gets through.
  if (!Number.isFinite(tradeAmountUsd) || tradeAmountUsd < 0) {
    return {
      allowed: false,
      flagForReview: true,
      reason: 'Could not value this trade in USD. Please try again in a moment.',
    };
  }

  // 1. Per-trade cap — Tier 0 only
  if (limits.perTradeUsd !== null && tradeAmountUsd > limits.perTradeUsd) {
    return {
      allowed: false,
      flagForReview: false,
      reason: `Anonymous trades are limited to $${limits.perTradeUsd.toLocaleString()} per transaction. Create an account and verify your identity to trade more.`,
      limitUsd: limits.perTradeUsd,
    };
  }

  // 2. Monthly cap — Tier 1 & 2 only
  if (limits.monthlyUsd !== null && userId) {
    const usedUsd = await getMonthlyUsage(userId);
    const remainingUsd = Math.max(0, limits.monthlyUsd - usedUsd);

    if (usedUsd + tradeAmountUsd > limits.monthlyUsd) {
      return {
        allowed: false,
        flagForReview: false,
        reason: `You have $${remainingUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} remaining in your monthly limit. Upgrade your verification level or reduce your trade amount.`,
        remainingUsd,
        limitUsd: limits.monthlyUsd,
        usedUsd,
      };
    }

    return {
      allowed: true,
      flagForReview: tradeAmountUsd >= MANUAL_REVIEW_THRESHOLD_USD,
      remainingUsd: remainingUsd - tradeAmountUsd,
      limitUsd: limits.monthlyUsd,
      usedUsd,
    };
  }

  return {
    allowed: true,
    flagForReview: tradeAmountUsd >= MANUAL_REVIEW_THRESHOLD_USD,
  };
}

// ─── Record usage after a trade settles ───────────────────────────────────────

export async function recordUsage({
  userId,
  amountUsd,
}: {
  userId: string;
  amountUsd: number;
}): Promise<void> {
  // Same guard as the check, for the same reason: a NaN increment is
  // unrecoverable without a manual correction, because every later read of
  // volumeUsd is NaN too. Throwing is correct here — trackKycUsage below
  // catches it and logs, so a bad value is visible instead of silently
  // destroying the counter.
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error(`recordUsage refused a non-finite amount: ${amountUsd}`);
  }

  const { periodStart, periodEnd } = getCurrentPeriod();

  await prisma.kycUsage.upsert({
    where: { userId_periodStart: { userId, periodStart } },
    update: { volumeUsd: { increment: amountUsd } },
    create: { userId, periodStart, periodEnd, volumeUsd: amountUsd },
  });
}

// ─── Get current month usage ───────────────────────────────────────────────────

export async function getMonthlyUsage(userId: string): Promise<number> {
  const { periodStart } = getCurrentPeriod();

  const record = await prisma.kycUsage.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
  });

  const used = record?.volumeUsd ?? 0;
  // A counter already poisoned by a pre-fix NaN write must not read back as
  // NaN, or every check for that user silently passes. Treating it as 0 is
  // wrong in the user's favour; treating it as unusable would lock them out
  // of a working account. 0 plus a loud log is the lesser harm, and the log
  // is what tells you a correction is needed.
  if (!Number.isFinite(used)) {
    console.error('[getMonthlyUsage] non-finite volumeUsd on record — treating as 0', {
      userId,
      used,
    });
    return 0;
  }
  return used;
}

// ─── Get full usage summary ────────────────────────────────────────────────────

export async function getUsageSummary(userId: string, kycTier: KycTier | number | string) {
  const tier = resolveTier(kycTier);
  const limits = KYC_TIERS[tier];
  const usedUsd = await getMonthlyUsage(userId);
  const { periodStart, periodEnd } = getCurrentPeriod();

  return {
    kycTier: tier,
    tierName: limits.name,
    usedUsd,
    monthlyLimitUsd: limits.monthlyUsd,
    remainingUsd:
      limits.monthlyUsd !== null ? Math.max(0, limits.monthlyUsd - usedUsd) : null,
    perTradeLimitUsd: limits.perTradeUsd,
    periodStart,
    periodEnd,
    resetsAt: periodEnd,
  };
}

// ─── Convert local currency amount to USD ─────────────────────────────────────

const STABLECOINS = ['USD', 'USDC', 'USDT', 'PYUSD'];

export function toUsd({
  amount,
  currencyIso,
  ratePerUsd,
}: {
  amount: number;
  currencyIso: string;
  ratePerUsd: number;
}): number {
  if (STABLECOINS.includes(currencyIso.toUpperCase())) return amount;
  // Returns NaN for a missing or malformed rate, deliberately and visibly.
  // Callers must not treat NaN as "no limit" — checkKycLimit and recordUsage
  // both refuse it. See the note in checkKycLimit.
  return amount / ratePerUsd;
}

// ─── Convert USD limit to local currency for display ──────────────────────────

export function limitInLocalCurrency({
  limitUsd,
  ratePerUsd,
  currencyIso,
}: {
  limitUsd: number | null;
  ratePerUsd: number;
  currencyIso: string;
}): number | null {
  if (limitUsd === null) return null;
  if (STABLECOINS.includes(currencyIso.toUpperCase())) return limitUsd;
  return Math.round(limitUsd * ratePerUsd);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function getCurrentPeriod(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { periodStart, periodEnd };
}

// ─── Fire-and-forget KYC usage recorder ──────────────────────────────────────
// Non-blocking — safe to call inside any completion handler without await.
// Converts local currency to USD and records against the user's monthly usage.
// Never throws — logs errors silently so trade completion is never affected.

export function trackKycUsage({
  userId,
  amount,
  currencyIso,
  ratePerUsd,
  context,
}: {
  userId: string;
  amount: number;
  currencyIso: string;
  ratePerUsd: number;
  context?: string;
}): void {
  const tradeAmountUsd = toUsd({ amount, currencyIso, ratePerUsd });

  recordUsage({ userId, amountUsd: tradeAmountUsd }).catch((err) =>
    console.error(
      `[trackKycUsage] failed to record usage${context ? ` — ${context}` : ''}`,
      { userId, tradeAmountUsd, error: err?.message }
    )
  );
}

// ─── Copy, derived from the table ─────────────────────────────────────────────

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

/** "$5,000/month", "$200/trade", "unlimited" — one phrasing, used everywhere. */
export function limitPhrase(tier: KycTier | number | string): string {
  const limits = KYC_TIERS[resolveTier(tier)];
  if (limits.monthlyUsd !== null) return `${usd(limits.monthlyUsd)}/month`;
  if (limits.perTradeUsd !== null) return `${usd(limits.perTradeUsd)}/trade`;
  return 'unlimited';
}

/**
 * The body of the upgrade notification.
 *
 * Replaces the hardcoded "$50,000/month" sentence in the Didit webhook, so a
 * change to the table above reaches the message a user actually reads.
 */
export function upgradeMessage(tier: KycTier): string {
  const limits = KYC_TIERS[tier];
  const next = KYC_TIERS[(tier + 1) as KycTier] as (typeof KYC_TIERS)[KycTier] | undefined;

  const earned =
    limits.monthlyUsd !== null
      ? `you can now move up to ${usd(limits.monthlyUsd)} a month`
      : 'your transaction limit has been removed';

  if (!next) return `You're ${limits.name} verified — ${earned}.`;

  const onward =
    next.grantedBy === 'manual'
      ? ' Need more than that? Request an enhanced review and we will take a look.'
      : ` ${next.requirement} to reach ${limitPhrase((tier + 1) as KycTier)}.`;

  return `You're ${limits.name} verified — ${earned}.${onward}`;
}