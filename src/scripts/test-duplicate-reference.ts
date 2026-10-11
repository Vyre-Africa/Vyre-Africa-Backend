// scripts/test-duplicate-reference.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-duplicate-reference.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-duplicate-reference.ts --yes
//
// Measures exactly what Nuvion does when a unique_reference is used again.
// This is NOT a style question. withBoundedRetry in nuvionPayout.service
// retries on a timeout with the same reference, and what Nuvion answers on that
// second attempt decides whether a payout is completed or wrongly refunded:
//
//   Attempt 1 reaches Nuvion, the transfer is created, the response times out.
//   withBoundedRetry retries with the same reference.
//   Whatever comes back now is what the payout's fate is decided on.
//
// Three things are being measured, and only the first has been seen:
//   1. the exact error TEXT                (seen once, cross-currency)
//   2. the exact HTTP STATUS               (never seen: 409 is a guess)
//   3. whether the SAME-CURRENCY call behaves the same way (never tested, and
//      that is the one the real payouts use)
//
// WHY IT IS SAFE: both phases resubmit a reference that has ALREADY been used.
// If Nuvion refuses, as expected, nothing moves at all. If it does not refuse,
// the worst case is a small internal transfer between Vyre's own Nuvion
// accounts. No customer money and no on-chain send is involved either way.

import prisma from '../config/prisma.client';
import { createFxQuote, initiateCrossCurrencyTransfer, initiateSameCurrencyTransfer } from '../services/nuvion.service';

// A reference Nuvion has ALREADY seen. This one is from the conversion test on
// 8 October. Any reference from a real transfer works.
const USED_REFERENCE = 'TEST-CONV-1791465827551';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M4DR3EAFPNRZRC2Z85SFGM36';

// Nuvion rejects anything under 1.00, so this is the smallest testable amount.
const AMOUNT = 1;
const FROM_CURRENCY = 'USC';

// The stablecoin account, for the cross-currency phase.
const STABLECOIN_ACCOUNT_ID = '01M0T7QZHBRAMKY93TC38Y3EJS';

const confirmed = process.argv.includes('--yes');

function report(label: string, res: any) {
    console.log(`   success:     ${res.success}`);
    console.log(`   httpStatus:  ${res.httpStatus ?? 'none returned'}`);
    console.log(`   id:          ${res.id ?? 'none'}`);
    console.log(`   status:      ${res.status ?? 'none'}`);
    console.log(`   error:       ${res.error ?? 'none'}`);
    console.log(`   raw body:    ${JSON.stringify(res.rawData ?? null)}`);

    if (res.success) {
        console.log(`\n   🔴 ${label}: Nuvion ACCEPTED a reused reference and returned transfer ${res.id}.`);
        console.log('      If that id is new, a retry after a timeout would send the money TWICE.');
        console.log('      Compare it with the original transfer in the dashboard before anything else.');
    } else {
        console.log(`\n   ✅ ${label}: refused with HTTP ${res.httpStatus ?? '?'}.`);
    }
    return res;
}

async function main() {
    console.log('Reference under test:', USED_REFERENCE);
    console.log('This reference must ALREADY have been used at Nuvion. If it has not, phase 1');
    console.log('will create a real transfer rather than measuring a refusal.\n');

    const usd = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true } });
    if (!usd) { console.error('❌ No active USD treasury row.'); process.exit(1); }
    console.log(`USD treasury: ${usd.nuvionAccountId}`);
    console.log(`Stablecoin:   ${STABLECOIN_ACCOUNT_ID}\n`);

    if (!confirmed) {
        console.log('Would run two phases, both resubmitting that used reference:');
        console.log(`   1. initiateCrossCurrencyTransfer  ${AMOUNT} ${FROM_CURRENCY} -> USD   (the conversion path)`);
        console.log(`   2. initiateSameCurrencyTransfer   ${AMOUNT} USD                        (the payout path)`);
        console.log('\nBoth should be refused, and nothing moves. Add --yes to measure it.');
        return;
    }

    // ── Phase 1: the cross-currency call, where the refusal was first seen ──
    console.log('── Phase 1: cross-currency (the conversion path) ──');
    const quote = await createFxQuote({
        from_currency: FROM_CURRENCY,
        to_currency: 'USD',
        amount_from: AMOUNT,
        account_id: STABLECOIN_ACCOUNT_ID,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
    });
    if (!quote.success || !quote.id) {
        console.error('❌ Could not get a quote, so phase 1 cannot run:', quote.error);
    } else {
        const cross = await initiateCrossCurrencyTransfer({
            account_id: STABLECOIN_ACCOUNT_ID,
            payment_detail_id: PAYMENT_DETAIL_ID,
            counterparty_id: COUNTERPARTY_ID,
            fx_quote_id: quote.id,
            narration: 'Duplicate reference probe',
            payment_type: 'book-transfer',
            unique_reference: USED_REFERENCE,
        });
        report('cross-currency', cross);
    }

    // ── Phase 2: the SAME-CURRENCY call. This is the one the payouts use, and
    //    it has never been tested. Both functions POST to /transfers, so the
    //    dedupe is probably at the endpoint, but probably is not measured. ──
    console.log('\n── Phase 2: same-currency (the payout path) ──');
    const same = await initiateSameCurrencyTransfer({
        account_id: usd.nuvionAccountId,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: AMOUNT,
        currency: 'USD',
        narration: 'Duplicate reference probe',
        payment_type: 'book-transfer',
        unique_reference: USED_REFERENCE,
    });
    report('same-currency', same);

    // ── What it means for the retry ──
    console.log('\n── What this decides ──');
    const statuses = [same.httpStatus].filter(Boolean);
    const anyAccepted = same.success;

    if (anyAccepted) {
        console.log('🔴 A reused reference is ACCEPTED. withBoundedRetry retrying after a timeout could');
        console.log('   send twice. Stop retrying on the same reference until this is understood.');
    } else {
        console.log(`The refusal comes back as HTTP ${same.httpStatus ?? 'no status'}.`);
        if (typeof same.httpStatus === 'number' && same.httpStatus >= 500) {
            console.log('🔴 It is a 5xx, so isTransientError() calls it TRANSIENT and keeps retrying,');
            console.log('   burning all three attempts and then failing the payout anyway.');
        } else if (typeof same.httpStatus === 'number') {
            console.log('   isTransientError() treats that as PERMANENT, so withBoundedRetry stops and');
            console.log('   failPayout refunds the user, even though the transfer EXISTS at Nuvion and');
            console.log('   the recipient gets paid. That is the hole to close: treat this answer as');
            console.log('   "the transfer went through", not as a failure.');
        } else {
            console.log('   No status came back, so isTransientError() calls it transient and retries.');
        }
        console.log(`\n   Match it in code on the raw body above, not on this text if the body has a code:`);
        console.log(`   error text: ${JSON.stringify(same.error)}`);
    }
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });