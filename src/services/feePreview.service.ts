// services/feePreview.service.ts
//
// What a transfer will actually cost, answered BEFORE the user commits.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────
//
// This file does not compute a fee. It calls the exact functions the payout
// path calls and reports what they return.
//
//   nuvionpayout.service.ts, initiateNuvionPayoutFromCrypto:
//     const feeScheme           = feeSchemeFor(currency, scheme, paymentMethod);
//     const estimatedNuvionFee  = estimateNuvionFee(feeScheme ?? scheme);
//     const vyreFee             = calculateVyreFee(amount);
//     const totalDebit          = amount + estimatedNuvionFee + vyreFee;
//
// Those four lines are the charge. A preview that re-derived them would be
// correct exactly until someone edited one copy, and a fee preview that
// drifts from the fee is worse than none: it is a quoted price the system
// does not honour.
//
// ── WHAT "REAL" MEANS HERE, HONESTLY ────────────────────────────────────
//
// Two different numbers get called "the fee", and conflating them is what
// produced a $14 charge on a $5 transfer:
//
//   WHAT THE USER IS DEBITED   amount + Nuvion estimate + Vyre fee.
//                              Exact. Computable. This is what the preview
//                              shows, and it is what gets frozen.
//
//   WHAT THE TRANSFER COSTS    Nuvion's real charge, known only after they
//                              settle. If it lands under the estimate the
//                              difference is returned — which is why a Naira
//                              payout was quoted ~$7 and refunded ~$6.96.
//
// So the preview can promise the debit exactly, and must not promise the
// cost. It says which lines are measured and which are estimated, and where
// an estimate is in play it states that the difference comes back.
//
// Hiding that distinction behind one confident number is the thing to avoid.
// A user who is told "$0.50" and charged $7.50 has been misled even if $7
// comes back a day later.

import {
    estimateNuvionFee,
    calculateVyreFee,
    NUVION_FEE_ESTIMATES_USD,
    VYRE_GLOBAL_PAYOUT_FEE,
} from './nuvionpayout.service';
import { feeSchemeFor } from './railRequirements';
import { railFeeFor } from './railFee.service';

// Confidence is NOT tracked here any more.
//
// It used to be a hand-maintained NUVION_FEE_CONFIRMED map saying which
// rails were measured. railFee.service now knows that from its `mode`, which
// is derived from real charges — so the map was a second source of the same
// truth, and the one that nobody would remember to update. Exactly the drift
// this file's header warns about, committed inside this file.
//
// `railFeeFor(rail).mode` is the answer now:
//   MEASURED_FLAT / _PERCENT / _CEILING → measured
//   FAMILY_PRIOR / UNKNOWN              → estimated

/** Caveats worth showing next to a specific rail, rather than in general. */
const SCHEME_NOTES: Record<string, string> = {
    fps: 'Measured on a cross-currency transfer. A same-currency GBP transfer may differ.',
    swift: 'SWIFT fees vary by intermediary bank and can exceed this.',
    default: 'This rail has not been measured yet, so this is a ceiling rather than a price.',
};

export type FeeConfidence = 'measured' | 'estimated';

export interface FeeLine {
    key: 'amount' | 'network' | 'vyre';
    label: string;
    amountUsd: number;
    confidence: FeeConfidence;
    note?: string;
}

export interface FeePreview {
    /** What the recipient receives, in the payout currency. */
    sendAmount: number;
    currency: string;
    /** The rail the fee was priced off — null when a choice is still pending. */
    scheme: string | null;

    lines: FeeLine[];

    /** Fees only, excluding the amount. */
    totalFeeUsd: number;
    /** Everything that leaves the balance. This is the number that is frozen. */
    totalDebitUsd: number;

    /** True when every line is measured, so the debit is also the final cost. */
    exact: boolean;
    /** Present when not exact: the plain-language promise about the difference. */
    refundNote?: string;

    // ── Present only on a LIVE, quote-backed preview ────────────────────
    /** The quote this price came from. Pass it to the transfer and the user
     *  is charged exactly what they were shown. */
    quoteId?: string;
    /** When the quote stops being honoured. */
    expiresAt?: string;
    /** 1 USD = rate <currency>. */
    rate?: number;
    /** What lands in the recipient's account, in their currency. */
    receiveAmount?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The cost of a global payout, before anything is committed.
 *
 * Mirrors initiateNuvionPayoutFromCrypto's arithmetic by CALLING it, not by
 * copying it.
 */
export function previewGlobalPayoutFee(input: {
    amount: string | number;
    currency: string;
    scheme?: string | null;
    paymentMethod?: string;
}): FeePreview {
    const { amount, currency, scheme = null, paymentMethod = 'bank-transfer' } = input;

    const sendAmount = Number(amount) || 0;

    // Priced off the RAIL, not off whatever happens to be in `scheme` —
    // which is null for a single-rail currency and, for EUR, deliberately
    // never sent. estimateNuvionFee(null) returns `default: 7`, and that is
    // the whole reason every Naira payout was quoted ~$7 against a real
    // ~$0.04.
    const feeScheme = feeSchemeFor(currency, scheme, paymentMethod);
    const pricedScheme = feeScheme ?? scheme ?? null;

    const networkFee = estimateNuvionFee(pricedScheme);
    const vyreFee = calculateVyreFee(String(sendAmount));

    // Confidence comes from the same record the number came from, so the two
    // cannot disagree. estimateNuvionFee delegates to railFeeFor, so this is
    // reading the row that actually priced the transfer rather than guessing
    // which one did.
    const learned = railFeeFor(pricedScheme, sendAmount);
    const networkConfirmed = learned.mode.startsWith('MEASURED');
    const usedKey = pricedScheme && pricedScheme in NUVION_FEE_ESTIMATES_USD ? pricedScheme : 'default';

    const lines: FeeLine[] = [
        {
            key: 'amount',
            label: 'Amount to recipient',
            amountUsd: round2(sendAmount),
            confidence: 'measured',
        },
        {
            key: 'network',
            label: 'Network fee',
            amountUsd: round2(networkFee),
            confidence: networkConfirmed ? 'measured' : 'estimated',
            note: networkConfirmed
                ? SCHEME_NOTES[usedKey]
                : (SCHEME_NOTES[usedKey]
                    ?? (learned.mode === 'FAMILY_PRIOR'
                        ? 'This rail has not been used yet, so this is a safe starting figure rather than a price.'
                        : SCHEME_NOTES.default)),
        },
        {
            key: 'vyre',
            // Vyre's own charge. Always exact — it is our formula, not a
            // guess about someone else's pricing.
            label: 'Vyre fee',
            amountUsd: round2(vyreFee),
            confidence: 'measured',
            note: vyreFee === VYRE_GLOBAL_PAYOUT_FEE.minUsd && sendAmount > 0
                ? `Minimum fee of $${VYRE_GLOBAL_PAYOUT_FEE.minUsd} applies on smaller transfers.`
                : undefined,
        },
    ];

    const totalFeeUsd = round2(networkFee + vyreFee);
    const totalDebitUsd = round2(sendAmount + networkFee + vyreFee);
    const exact = networkConfirmed;

    return {
        sendAmount: round2(sendAmount),
        currency,
        scheme: pricedScheme,
        lines,
        totalFeeUsd,
        totalDebitUsd,
        exact,
        refundNote: exact
            ? undefined
            : 'The network fee is an estimate. You are charged this amount up front, and anything the '
              + 'network does not use is returned to your balance once the transfer settles.',
    };
}

/**
 * A rail's fee at a glance, for showing cost next to each option while the
 * user is still choosing — before an amount has even been typed.
 */
export function previewFeesByScheme(
    currency: string,
    schemes: string[],
    amount: string | number = 0,
): Array<{ scheme: string; totalFeeUsd: number; exact: boolean }> {
    return schemes.map((scheme) => {
        const p = previewGlobalPayoutFee({ amount, currency, scheme });
        return { scheme, totalFeeUsd: p.totalFeeUsd, exact: p.exact };
    });
}


// ════════════════════════════════════════════════════════════════════════
// LIVE QUOTE — real rate and real receive amount. NOT the fee.
// ════════════════════════════════════════════════════════════════════════
//
// MEASURED 21 Oct, from an actual createFxQuote response:
//
//   { id, from, to, amount_from, amount_to, rate,
//     quote: { status, expires_at, valid_for, used_at, used_in_payment_id },
//     created, updated }
//
// There is NO fee field. Nor is one baked into the rate: on a $5,000 GHS
// quote, amount_from × rate = 50,180.525 against an amount_to of 50,180 —
// five cents of rounding, where a $3.54 fee would have left about 50,144.
//
// `applicable_fee` appears only on the TRANSFER response, which is after the
// money has moved. So the quote cannot tell us the fee, and this function
// does not pretend otherwise: it returns the quote's real rate, real receive
// amount, id and expiry, and leaves the fee as the table's estimate.
//
// WHAT IS STILL WORTH THE CALL
//
//   rate + amount_to   exact, and what the user most wants to see — "they
//                      receive KES 12,725.81" is the headline on the screen.
//   quoteId            initiateNuvionPayoutFromCrypto accepts
//                      jobData.fxQuoteId and reuses it, so the RATE the user
//                      agreed to is the rate they get.
//   expires_at         the screen needs the countdown either way.
//
// THE OPEN QUESTION
//
// Nuvion's own screens show a fee next to the rate and the expiry — $3.54
// for KES, $0.63 for ZAR — so they know it at quote time and simply do not
// return it on this endpoint. That is a question for them, and a narrow one:
// "your dashboard shows the fee on a quote; can the API return it too?"
//
// The fee-path scan below stays, so the day they add a field this starts
// reporting `exact` on its own with no code change.

import { createFxQuote } from './nuvion.service';

/**
 * Where the fee hides in a quote response.
 *
 * `applicable_fee` is what the TRANSFER response returns — nuvionpayout
 * reads it in three places — so it is the first guess for the quote too.
 * The rest are spellings worth trying rather than failing over.
 *
 * The path that actually hits is logged on first use, so the real name gets
 * recorded here instead of staying a list of guesses.
 */
const FEE_PATHS = [
    'applicable_fee', 'fee', 'fee_amount', 'fee_usd', 'total_fee',
    'fees.total', 'fees.amount', 'fees.network',
    'networkFee', 'networkFeeUsd', 'nuvionFeeUsd', 'feeUsd',
];

function pick(obj: any, path: string): any {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function readQuoteFee(quote: any): { fee: number; path: string } | null {
    const sources = [quote, quote?.rawData, quote?.data, quote?.quote];
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        for (const path of FEE_PATHS) {
            const v = pick(src, path);
            const n = Number(v);
            // 0 is a legitimate fee — book-transfer is free — so the test is
            // "is it a number", not "is it truthy".
            if (v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0) {
                return { fee: n, path };
            }
        }
    }
    return null;
}

export interface LivePreviewInput {
    amount: string | number;
    currency: string;
    scheme?: string | null;
    paymentMethod?: string;
    /** All three come from the beneficiary once it is registered with Nuvion. */
    counterpartyId: string;
    paymentDetailNuvionId: string;
    treasuryAccountId: string;
}

export async function previewGlobalPayoutFeeLive(
    input: LivePreviewInput,
): Promise<FeePreview> {
    const { amount, currency, scheme = null, paymentMethod = 'bank-transfer' } = input;

    // The table version supplies the Vyre line — ours, never Nuvion's — and
    // the fee estimate we fall back on.
    const base = previewGlobalPayoutFee({ amount, currency, scheme, paymentMethod });

    let quote: any;
    try {
        quote = await createFxQuote({
            to_currency: currency,
            from_currency: 'USD',
            amount_from: Number(amount),
            account_id: input.treasuryAccountId,
            counterparty_id: input.counterpartyId,
            payment_detail_id: input.paymentDetailNuvionId,
        } as any);
    } catch {
        return base;
    }

    if (!quote?.success) return base;

    // The response nests everything under `data`, with the expiry one level
    // deeper under `data.quote`.
    const d = quote.rawData?.data ?? quote.data ?? quote.rawData ?? quote;
    const rate = Number(d?.rate ?? quote.rate) || undefined;
    const receiveAmount = Number(d?.amount_to) || (rate ? Number(amount) * rate : undefined);
    const expiresAtMs = Number(d?.quote?.expires_at ?? d?.expires_at);

    // Still scanned, so this upgrades itself the day Nuvion adds the field.
    const found = readQuoteFee(quote);

    const vyreLine = base.lines.find((l) => l.key === 'vyre')!;
    const networkFee = found ? found.fee : base.lines.find((l) => l.key === 'network')!.amountUsd;
    const sendAmount = Number(amount) || 0;

    const lines: FeeLine[] = [
        { key: 'amount', label: 'Amount to recipient', amountUsd: base.sendAmount, confidence: 'measured' },
        {
            key: 'network',
            label: 'Network fee',
            amountUsd: Math.round(networkFee * 100) / 100,
            // Honest: measured ONLY if it came from Nuvion on this call.
            confidence: found ? 'measured' : base.lines.find((l) => l.key === 'network')!.confidence,
            note: found ? undefined : base.lines.find((l) => l.key === 'network')!.note,
        },
        vyreLine,
    ];

    const exact = Boolean(found) || base.exact;

    return {
        ...base,
        lines,
        totalFeeUsd: Math.round((networkFee + vyreLine.amountUsd) * 100) / 100,
        totalDebitUsd: Math.round((sendAmount + networkFee + vyreLine.amountUsd) * 100) / 100,
        exact,
        refundNote: exact ? undefined : base.refundNote,
        // Real, from Nuvion, on every call — fee or no fee.
        quoteId: d?.id ?? quote.id,
        expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : undefined,
        rate,
        receiveAmount: receiveAmount ? Math.round(receiveAmount * 100) / 100 : undefined,
    };
}

/** Which field the fee was found under, once a live quote has been read. */
export function describeFeeSource(quote: any): string {
    const found = readQuoteFee(quote);
    return found ? `fee read from \`${found.path}\`` : 'no fee field found on this quote';
}