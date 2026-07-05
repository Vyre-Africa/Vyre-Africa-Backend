import prisma from '../config/prisma.client';

// ─── Tier Limits (all values in USD) ──────────────────────────────────────────

export const KYC_TIERS = {
  0: { name: 'Anonymous', perTradeUsd: 200,  monthlyUsd: null  },
  1: { name: 'Basic',     perTradeUsd: null,  monthlyUsd: 10000 },
  2: { name: 'Standard',  perTradeUsd: null,  monthlyUsd: 50000 },
  3: { name: 'Enhanced',  perTradeUsd: null,  monthlyUsd: null  },
} as const;

export type KycTier = keyof typeof KYC_TIERS;

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

  return record?.volumeUsd ?? 0;
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

export function toUsd({
  amount,
  currencyIso,
  ratePerUsd,
}: {
  amount: number;
  currencyIso: string;
  ratePerUsd: number;
}): number {
  const stablecoins = ['USD', 'USDC', 'USDT', 'PYUSD'];
  if (stablecoins.includes(currencyIso.toUpperCase())) return amount;
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
  const stablecoins = ['USD', 'USDC', 'USDT', 'PYUSD'];
  if (stablecoins.includes(currencyIso.toUpperCase())) return limitUsd;
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