// services/railFee.service.ts
//
// A fee estimate per rail that corrects itself from what Nuvion actually
// charged, instead of from a table somebody remembers to edit.
//
// ── THE LOOP ────────────────────────────────────────────────────────────
//
//   1. A payout settles. Nuvion returns `applicable_fee` on the transfer
//      response, and nuvionpayout.service.ts already stores it as
//      TransferRequest.actualFeeUsd.
//   2. recordRailFee() is called with that number.
//   3. The rail's estimate is recomputed from its recent observations.
//   4. The next preview and the next freeze use the new estimate.
//
// Step 2 is the only new wiring. The data has been arriving all along — 11
// payouts had already priced three rails before anyone looked.
//
// ── WHY THE ESTIMATE TRACKS THE HIGH END ────────────────────────────────
//
// Being wrong is not symmetric:
//
//   too HIGH   the user is frozen more than needed, and the difference is
//              refunded at settlement. Recoverable, and visible.
//   too LOW    Nuvion charges more than was frozen and VYRE ABSORBS THE
//              DIFFERENCE. Unrecoverable, and silent — it only shows up as
//              a [NUVION FEE UNDERESTIMATE] line in the logs.
//
// So the estimate is the MAXIMUM of recent observations, not the mean. A
// mean would undercharge on roughly half of all payouts by construction.
//
// It still comes down over time: the window is the last N observations, so
// an old high value ages out once newer, cheaper ones replace it.
//
// ── WHY THERE IS NO SINGLE GLOBAL DEFAULT ───────────────────────────────
//
// Measured so far: NG $0.04, ZA $0.63, KE $3.54, US wire $5.00, GB $6.89.
// Two orders of magnitude. One number across all of them either freezes $7
// on a Ghanaian transfer that costs cents, or underprices SWIFT and loses
// money every time.
//
// So an unmeasured rail starts from its FAMILY — rails that behave alike —
// and that prior is replaced by the real number after its first payout. The
// families are a guess; they are simply a much better-informed guess than
// one constant, and they are labelled as priors so nobody mistakes them for
// measurements.

import prisma from '../config/prisma.client';
import logger from '../config/logger';

// ── Families ────────────────────────────────────────────────────────────
//
// Grouped by how they have actually behaved, not by geography for its own
// sake. Each seed is the HIGHEST measured value in that family, so a new
// rail in the family starts safe and corrects downward on first use.
type Family = 'AFRICAN_BANK' | 'MOMO' | 'DEVELOPED_LOCAL' | 'SWIFT' | 'INTERNAL';

const FAMILY_OF: Record<string, Family> = {
    // African local bank rails — measured: nip 0.04, ke_eft 3.54, rtc 0.63
    nip: 'AFRICAN_BANK', ke_eft: 'AFRICAN_BANK', rtc: 'AFRICAN_BANK',
    gh_eft: 'AFRICAN_BANK', ug_eft: 'AFRICAN_BANK', tz_eft: 'AFRICAN_BANK',

    // Mobile money — nothing measured. Grouped apart from bank rails because
    // there is no reason to assume a momo network prices like a bank ACH.
    mpesa: 'MOMO', airtel: 'MOMO', telkom: 'MOMO', mtn: 'MOMO',
    vodafone: 'MOMO', tigo: 'MOMO', vodacom: 'MOMO', halotel: 'MOMO',

    // Domestic rails in developed markets — measured: fps 6.89, wire 5.00
    fps: 'DEVELOPED_LOCAL', wire: 'DEVELOPED_LOCAL', ach: 'DEVELOPED_LOCAL',
    rtp: 'DEVELOPED_LOCAL', sepa: 'DEVELOPED_LOCAL', becs: 'DEVELOPED_LOCAL',
    fast: 'DEVELOPED_LOCAL', hk_chats: 'DEVELOPED_LOCAL', eft: 'DEVELOPED_LOCAL',
    interac_email: 'DEVELOPED_LOCAL', interac_account: 'DEVELOPED_LOCAL',
    pesonet: 'DEVELOPED_LOCAL', insta_pay: 'DEVELOPED_LOCAL',
    uae_local: 'DEVELOPED_LOCAL', clabe: 'DEVELOPED_LOCAL',

    swift: 'SWIFT',
    'book-transfer': 'INTERNAL',
};

/**
 * The starting estimate for a rail nobody has used.
 *
 * Each is the highest MEASURED value in its family, so the first payout on a
 * new rail is priced safely and every one after it is priced from reality.
 * MOMO has no measurement at all and borrows the African bank ceiling, which
 * is a guess and is marked as one.
 */
const FAMILY_SEED_USD: Record<Family, number> = {
    AFRICAN_BANK: 3.54,     // highest measured African rail (ke_eft)
    MOMO: 3.54,             // ⚠️ no momo rail measured — borrowed from above
    DEVELOPED_LOCAL: 6.89,  // highest measured (fps)
    SWIFT: 15,              // ⚠️ never measured, and intermediary banks add more
    INTERNAL: 0,            // book-transfer, measured at zero
};

/** Absolute ceiling for a rail in no family at all. */
const UNKNOWN_RAIL_USD = 7;

/** How many recent observations the estimate is computed from. */
const WINDOW = 20;

/**
 * Past this, observations stop counting. A fee measured four months ago is
 * not evidence about today's price, and quietly treating it as such is how a
 * self-correcting table stops correcting.
 */
const MAX_AGE_DAYS = 120;

export type FeeMode = 'MEASURED_FLAT' | 'MEASURED_PERCENT' | 'MEASURED_CEILING' | 'FAMILY_PRIOR' | 'UNKNOWN';

export interface RailFeeEstimate {
    rail: string;
    /** What to freeze, in USD. */
    usd: number;
    mode: FeeMode;
    observations: number;
    /** Only set on MEASURED_PERCENT — fee as a fraction of the amount. */
    percentage?: number;
    minUsd?: number;
    maxUsd?: number;
    lastSeenAt?: Date;
}

interface Observation { fee: number; amount: number; at: string }

// ── In-memory cache ─────────────────────────────────────────────────────
//
// estimateNuvionFee is called synchronously from the payout path, so this
// cannot become an await without touching that path. The cache is refreshed
// on boot, on a timer, and on every write.
//
// ⚠️ UNDER PM2 each worker holds its own copy. A write in one worker is not
// seen by another until its next refresh, so two workers can price the same
// rail differently for up to REFRESH_MS. That is tolerable here — the drift
// is cents, and both values are refunded against reality at settlement — but
// it is the same per-worker issue the parse rate limiter had, and if it ever
// needs to be exact, this belongs in Redis.
const cache = new Map<string, RailFeeEstimate>();
const REFRESH_MS = 5 * 60 * 1000;
let lastLoad = 0;

function percentileSafeMax(values: number[]): number {
    // Max, but ignoring a single extreme outlier once there are enough
    // observations to tell an outlier from the truth. One freak charge
    // should not permanently inflate what every user is frozen.
    if (values.length < 5) return Math.max(...values);
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length - 2];
}

function computeEstimate(rail: string, obs: Observation[]): RailFeeEstimate {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const fresh = obs.filter((o) => new Date(o.at).getTime() >= cutoff).slice(-WINDOW);

    if (!fresh.length) return seedFor(rail);

    const fees = fresh.map((o) => o.fee);
    const min = Math.min(...fees);
    const max = Math.max(...fees);

    // Proportional? If fee ÷ amount is near-constant while the fee itself is
    // not, the rail charges a percentage and a flat number is wrong at every
    // amount except the ones already seen.
    const ratios = fresh.filter((o) => o.amount > 0).map((o) => o.fee / o.amount);
    const ratioSpread = ratios.length > 1 ? Math.max(...ratios) - Math.min(...ratios) : Infinity;
    const feeVaries = max - min > 0.01;

    if (feeVaries && ratioSpread < 0.002) {
        const pct = Math.max(...ratios);
        return {
            rail, usd: max, mode: 'MEASURED_PERCENT', percentage: pct,
            observations: fresh.length, minUsd: min, maxUsd: max,
            lastSeenAt: new Date(fresh[fresh.length - 1].at),
        };
    }

    return {
        rail,
        usd: feeVaries ? percentileSafeMax(fees) : max,
        mode: feeVaries ? 'MEASURED_CEILING' : 'MEASURED_FLAT',
        observations: fresh.length,
        minUsd: min, maxUsd: max,
        lastSeenAt: new Date(fresh[fresh.length - 1].at),
    };
}

function seedFor(rail: string): RailFeeEstimate {
    const family = FAMILY_OF[rail];
    if (!family) return { rail, usd: UNKNOWN_RAIL_USD, mode: 'UNKNOWN', observations: 0 };
    return { rail, usd: FAMILY_SEED_USD[family], mode: 'FAMILY_PRIOR', observations: 0 };
}

// ── Reading ─────────────────────────────────────────────────────────────

/**
 * The estimate in force for a rail. Synchronous by design — the payout path
 * calls it inline.
 *
 * `amount` matters only for a rail measured as proportional, where the fee
 * is a share of what is being sent rather than a constant.
 */
export function railFeeFor(rail: string | null | undefined, amount?: number): RailFeeEstimate {
    if (!rail) return { rail: 'default', usd: UNKNOWN_RAIL_USD, mode: 'UNKNOWN', observations: 0 };

    const hit = cache.get(rail) ?? seedFor(rail);

    if (hit.mode === 'MEASURED_PERCENT' && hit.percentage && amount && amount > 0) {
        // Never below the smallest fee ever seen on this rail — a percentage
        // that rounds to nothing on a tiny transfer is still a real charge.
        const scaled = Math.max(amount * hit.percentage, hit.minUsd ?? 0);
        return { ...hit, usd: Math.round(scaled * 100) / 100 };
    }

    return hit;
}

/** Everything known, for an ops endpoint or a review of what is being charged. */
export function dumpRailFees(): RailFeeEstimate[] {
    return [...cache.values()].sort((a, b) => a.rail.localeCompare(b.rail));
}

// ── Writing ─────────────────────────────────────────────────────────────

/**
 * Record what Nuvion actually charged, and recompute the rail's estimate.
 *
 * Call this wherever actualFeeUsd is written. It must never throw into the
 * payout path: a bookkeeping failure cannot be allowed to fail a transfer
 * that has already moved money.
 */
export async function recordRailFee(
    rail: string | null | undefined,
    feeUsd: number,
    amountUsd: number,
    currency?: string,
): Promise<void> {
    try {
        if (!rail || !Number.isFinite(feeUsd) || feeUsd < 0) return;

        const existing: any = await prisma.railFee.findUnique({ where: { rail } });
        const obs: Observation[] = Array.isArray(existing?.observations) ? existing.observations : [];

        obs.push({ fee: feeUsd, amount: amountUsd, at: new Date().toISOString() });
        const trimmed = obs.slice(-WINDOW);

        const next = computeEstimate(rail, trimmed);

        await prisma.railFee.upsert({
            where: { rail },
            create: {
                rail, currency,
                estimateUsd: next.usd, mode: next.mode,
                percentage: next.percentage ?? null,
                observationCount: next.observations,
                minUsd: next.minUsd ?? null, maxUsd: next.maxUsd ?? null,
                lastSeenAt: next.lastSeenAt ?? new Date(),
                observations: trimmed as any,
            } as any,
            update: {
                currency: currency ?? existing?.currency,
                estimateUsd: next.usd, mode: next.mode,
                percentage: next.percentage ?? null,
                observationCount: next.observations,
                minUsd: next.minUsd ?? null, maxUsd: next.maxUsd ?? null,
                lastSeenAt: next.lastSeenAt ?? new Date(),
                observations: trimmed as any,
            } as any,
        });

        cache.set(rail, next);

        const before = existing?.estimateUsd != null ? Number(existing.estimateUsd) : null;
        if (before === null || Math.abs(before - next.usd) > 0.005) {
            logger.info('[RailFee] estimate updated from a real charge', {
                rail, from: before, to: next.usd, mode: next.mode,
                observations: next.observations, charged: feeUsd, amount: amountUsd,
            });
        }
    } catch (error: any) {
        // Swallowed on purpose. This runs after the money has moved.
        logger.warn('[RailFee] could not record a fee observation', { rail, error: error?.message });
    }
}

// ── Cache loading ───────────────────────────────────────────────────────

export async function loadRailFees(force = false): Promise<void> {
    if (!force && Date.now() - lastLoad < REFRESH_MS) return;
    try {
        const rows: any[] = await prisma.railFee.findMany();
        cache.clear();
        for (const r of rows) {
            cache.set(r.rail, {
                rail: r.rail,
                usd: Number(r.estimateUsd),
                mode: r.mode as FeeMode,
                observations: r.observationCount ?? 0,
                percentage: r.percentage != null ? Number(r.percentage) : undefined,
                minUsd: r.minUsd != null ? Number(r.minUsd) : undefined,
                maxUsd: r.maxUsd != null ? Number(r.maxUsd) : undefined,
                lastSeenAt: r.lastSeenAt ?? undefined,
            });
        }
        lastLoad = Date.now();
        logger.info('[RailFee] loaded', { rails: cache.size });
    } catch (error: any) {
        // An empty cache is safe: railFeeFor falls back to the family seeds,
        // which are the values the hardcoded table would have given anyway.
        logger.warn('[RailFee] could not load estimates, using family priors', { error: error?.message });
    }
}

/** Seed the table from history, so it starts out knowing what it already knew. */
export async function backfillFromTransferRequests(): Promise<number> {
    const rows: any[] = await prisma.transferRequest.findMany({
        where: { actualFeeUsd: { not: null } } as any,
        orderBy: { createdAt: 'asc' },
        take: 5000,
    });

    const detailIds = [...new Set(rows.map((r) => r.beneficiaryPaymentDetailId).filter(Boolean))];
    const details = await prisma.beneficiaryPaymentDetail.findMany({
        where: { id: { in: detailIds as string[] } },
    });
    const byId = new Map(details.map((d: any) => [d.id, d]));

    const { feeSchemeFor } = await import('./railRequirements');
    let recorded = 0;

    for (const r of rows) {
        const d: any = r.beneficiaryPaymentDetailId ? byId.get(r.beneficiaryPaymentDetailId) : null;
        if (!d) continue;
        const rail = feeSchemeFor(d.currency, d.scheme, d.paymentMethod) ?? d.scheme;
        if (!rail) continue;
        await recordRailFee(rail, Number(r.actualFeeUsd), Number(r.amount), d.currency);
        recorded++;
    }

    await loadRailFees(true);
    return recorded;
}