// controllers/payoutCurrencies.controller.ts
//
// GET /payouts/nuvion/supported-currencies
//
// ── Why this is a new file and not an edit to your payout controller ────
//
// I don't hold that file. Handing you a reconstructed copy of it is exactly
// the mistake I made with beneficiary.controller.ts, where my version would
// have deleted deleteBeneficiary and lost every deletedAt filter. So this is
// a self-contained handler: one import line and one route line to wire, and
// nothing in a file I can't see gets rewritten.
//
// ── What was actually broken ───────────────────────────────────────────
//
// Two separate faults, and only the first causes the 404 you pasted.
//
// 1. THE ROUTE IS NOT REGISTERED. My own note in useGlobalPayout.ts says
//    "CONFIRMED from the controller: the method is getSupportedCurrencies
//    and the route comment says GET /payouts/nuvion/supported-currencies."
//    So the method exists; the router.get() line does not. /payouts/nuvion
//    itself is fine — your log shows POST /payouts/nuvion/quote 200.
//
// 2. THE EXISTING METHOD ANSWERS A DIFFERENT QUESTION. It lists the
//    distinct currencies with an active treasury. A treasury is the SOURCE
//    of a payout — the USDC/USD float the money is drawn from. This
//    endpoint feeds the DESTINATION picker: which currency the recipient
//    gets paid in. Those two sets barely overlap. Registering the route
//    without replacing the body would have turned a silent 404 into a
//    picker offering USDC and USD and nothing else — a visible regression
//    from the hardcoded fallback, which at least lists NGN and KES.
//
// So: register the route, and point it here.
//
// ── Where the answer comes from ────────────────────────────────────────
//
// railRequirements.ts, via supportedPayoutCurrencies(). Not a hand-written
// list, and not a call to Nuvion.
//
// Not a list, because a currency is supported exactly when it has a rail —
// if there is no rail, railsFor() returns [] (or SWIFT_RAILS) and the
// payout cannot be built. A second list would be a second statement of the
// same fact and would drift the first time a rail was added. Deriving it
// means this endpoint cannot disagree with the validation logic, because it
// *is* that logic.
//
// Not a call to Nuvion, because there is no endpoint of theirs that answers
// this, and because the honest answer is narrower than theirs anyway: what
// matters is what *Vyre* can build a valid payload for, not what Nuvion
// could theoretically accept. A currency Nuvion supports but we have no
// rail definition for would fail at the payment-detail step, which is
// precisely the late failure the beneficiary-first change was made to stop.
//
// No network call also means no timeout, no cache, and no reason for this
// to ever be the slow part of opening Quick Send.

import { Request, Response } from 'express';
import {
    supportedPayoutCurrencies,
    railsFor,
    RAILS,
    MOMO_RAILS,
} from '../services/railRequirements';   // ← adjust to your path for this file

/**
 * Currencies to withhold from the picker without a deploy.
 *
 * Comma-separated, e.g. PAYOUT_CURRENCIES_DISABLED=CNY,MXN
 *
 * The rail table defines 17 currencies; the frontend's hardcoded fallback
 * listed 9. So wiring this up widens the picker by 8 — AED, AUD, CAD, CNY,
 * HKD, MXN, PHP, SGD. Every one has a rail defined (uae_local, becs,
 * interac/eft, cips, hk_chats, clabe, pesonet, fast), and AUD/CAD/HKD are
 * unblocked now that branchCode / institutionNumber / transitNumber exist on
 * BeneficiaryPaymentDetail. But "has a rail defined" is not "has ever been
 * sent successfully" — of those 8, none appear in the measured fee data.
 *
 * This exists so that if one of them turns out to be broken at Nuvion's end,
 * you can take it off the picker with an env change and a restart, instead
 * of a frontend deploy or users hitting a failure at the quote step.
 */
const disabled = new Set(
    (process.env.PAYOUT_CURRENCIES_DISABLED ?? '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
);

export async function getSupportedCurrencies(_req: Request, res: Response) {
    try {
        const all = supportedPayoutCurrencies();
        const currencies = all.filter((c) => !disabled.has(c));

        // `currencies: string[]` is the shape the client reads:
        //   useGlobalPayout.ts:56 → if (res.data?.currencies?.length)
        //                             supportedCurrencies.value = res.data.currencies
        // Changing it to objects would silently fall back to the hardcoded
        // list again, because .length on an array of objects is still truthy
        // and the picker would render [object Object]. Anything richer goes
        // in a sibling field, never in `currencies`.
        return res.status(200).json({
            success: true,
            currencies,

            // Per-currency detail for a picker that wants to show the method
            // alongside the code. Additive — nothing reads it yet.
            details: currencies.map((currency) => ({
                currency,
                bank: railsFor(currency, 'bank-transfer').map((r) => r.scheme),
                momo: railsFor(currency, 'momo-transfer').map((r) => r.scheme),
                // A currency not in RAILS falls through to SWIFT_RAILS, which
                // means a wire: higher fee, slower, and it needs the full
                // address. Worth surfacing so the UI can warn before the user
                // has filled in six fields.
                viaSwift: !(currency in RAILS) && !(currency in MOMO_RAILS),
            })),

            ...(disabled.size ? { withheld: [...disabled] } : {}),
        });
    } catch (err: any) {
        // The client swallows errors by design and falls back to its
        // hardcoded list, so a failure here is invisible on the screen. That
        // is correct behaviour for a money screen and exactly why it has to
        // be loud in the log — this endpoint failing silently for months is
        // how it got to this point.
        console.error('[payouts] getSupportedCurrencies failed:', err?.message ?? err);
        return res.status(500).json({ success: false, message: 'Could not load supported currencies' });
    }
}

export default { getSupportedCurrencies };