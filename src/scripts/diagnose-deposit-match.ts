// scripts/diagnose-deposit-match.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/diagnose-deposit-match.ts
//
// AIM: explain exactly why a stablecoin deposit was not matched to the
// replenishment waiting for it.
//
// On 11 Oct a live payout sent 5.04 USDC to the Nuvion stablecoin wallet, a
// deposit of 9.95 USC arrived five minutes later, and the matcher reported
// UNMATCHED. The crypto is at Nuvion, the row is stuck at SUBMITTED, and the
// conversion never ran.
//
// This replays claimReplenishmentForDeposit's own logic against the rows that
// are actually in the database and prints, for every open replenishment, which
// test rejected it and with what numbers. It does not guess.
//
// READ ONLY. It claims nothing, converts nothing and writes nothing.

import prisma from '../config/prisma.client';
import Decimal from "decimal.js";

// These MUST match treasuryConversion.service.ts. If they drift, this lies.
const AMOUNT_TOLERANCE = new Decimal('0.005'); // 0.5%
const OPEN_FOR_DEPOSIT = ['SUBMITTED', 'DEPOSIT_OVERDUE'];

const HOW_MANY_EVENTS = 15;

async function main() {
    // ─────────────────────────────────────────────────────────────
    console.log('1. Replenishments still waiting for a deposit\n');

    const open = await prisma.treasuryReplenishment.findMany({
        where: { status: { in: OPEN_FOR_DEPOSIT as any } },
        orderBy: { sentAt: 'asc' },
        select: {
            transferRequestId: true, status: true, amount: true, txRef: true,
            nuvionCurrency: true, sentAt: true, depositEventId: true,
        },
    });

    if (open.length === 0) {
        console.log('   None. Either everything matched, or the rows moved on to another status.');
    }
    for (const r of open) {
        console.log(`   ${r.transferRequestId}`);
        console.log(`     status          ${r.status}`);
        console.log(`     amount          ${r.amount}        <- what the matcher expects to arrive`);
        console.log(`     nuvionCurrency  ${r.nuvionCurrency ?? 'NULL'}`);
        console.log(`     txRef           ${r.txRef ?? 'NULL'}`);
        console.log(`     sentAt          ${r.sentAt?.toISOString() ?? 'NULL'}`);
        console.log('');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('2. Deposit events Nuvion has delivered\n');

    const events = await prisma.nuvionDepositEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: HOW_MANY_EVENTS,
        select: {
            id: true, accountId: true, currency: true, amount: true,
            txHash: true, status: true, createdAt: true,
        },
    });

    for (const e of events) {
        console.log(`   ${e.createdAt?.toISOString().slice(0, 19)}  ${String(e.status).padEnd(10)} ${e.amount} ${e.currency}`);
        console.log(`     id        ${e.id}`);
        console.log(`     account   ${e.accountId}`);
        console.log(`     txHash    ${e.txHash ?? 'NULL   <- no chain hash from Nuvion'}`);
        console.log('');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('3. Replaying the matcher on every unmatched deposit\n');

    const unmatched = events.filter((e: { status: string }) => e.status !== 'MATCHED');
    if (unmatched.length === 0) {
        console.log('   No unmatched deposit events to explain.');
    }

    for (const e of unmatched) {
        const amount = new Decimal(e.amount.toString());
        console.log(`   ── deposit ${e.id}: ${amount} ${e.currency}`);

        // BRANCH 1: by chain hash.
        if (!e.txHash) {
            console.log('   hash branch: SKIPPED — Nuvion sent no provider_reference for this deposit.');
        } else {
            const byHash = open.find(
                (r: { txRef: string | null }) => (r.txRef ?? '').toLowerCase() === String(e.txHash).toLowerCase(),
            ) as any;
            console.log(byHash
                ? `   hash branch: MATCHED ${byHash.transferRequestId}`
                : `   hash branch: no open row has txRef = ${e.txHash}`);
            if (byHash) { console.log(''); continue; }
        }

        // BRANCH 2: by amount. Note the txRef: null requirement.
        console.log('   amount branch, row by row:');
        if (open.length === 0) console.log('     (no open rows at all)');

        for (const r of open) {
            const reasons: string[] = [];

            // THE TRAP. The service filters candidates on `txRef: null`, so a row
            // that recorded a hash is excluded from amount matching entirely —
            // even when the hash simply never matched anything.
            if (r.txRef !== null) {
                reasons.push(`EXCLUDED: txRef is set (${r.txRef}), and the amount branch only considers rows with txRef = NULL`);
            }
            if (r.nuvionCurrency !== e.currency) {
                reasons.push(`currency mismatch: row says ${r.nuvionCurrency ?? 'NULL'}, deposit says ${e.currency}`);
            }

            const expected = new Decimal((r.amount ?? 0).toString());
            const diff = amount.minus(expected).abs();
            const allowed = expected.times(AMOUNT_TOLERANCE);
            if (!expected.gt(0)) {
                reasons.push('row amount is zero or missing');
            } else if (diff.gt(allowed)) {
                reasons.push(
                    `amount out of tolerance: expected ${expected}, got ${amount}, ` +
                    `difference ${diff} > allowed ${allowed} (0.5% of ${expected})`,
                );
            }

            if (reasons.length === 0) {
                console.log(`     ✅ ${r.transferRequestId} WOULD have matched (diff ${diff}, allowed ${allowed})`);
            } else {
                console.log(`     ✗ ${r.transferRequestId}`);
                for (const why of reasons) console.log(`        ${why}`);
            }
        }
        console.log('');
    }

    // ─────────────────────────────────────────────────────────────
    console.log('4. The two reasons this fails, and how to tell them apart\n');
    console.log('   A. A FLAT FEE AGAINST A PROPORTIONAL TOLERANCE.');
    console.log('      Nuvion takes a flat fee on an inflow, so what arrives is always');
    console.log('      (sent - fee). The tolerance is 0.5% of the expected amount, which');
    console.log('      shrinks as the amount shrinks, while the fee does not:');
    const demo = [5.04, 10, 20, 50];
    for (const d of demo) {
        const tol = new Decimal(d).times(AMOUNT_TOLERANCE);
        console.log(`        ${String(d).padStart(6)} expected -> tolerance ${tol.toFixed(4)} ` +
            `${tol.lt(new Decimal('0.03')) ? '  TOO TIGHT for a 0.03 fee' : ''}`);
    }
    console.log('      So small replenishments cannot match and large ones can. Above,');
    console.log('      look for "amount out of tolerance" with a small difference.');
    console.log('');
    console.log('   B. THE txRef: null FILTER.');
    console.log('      If the send recorded a hash but Nuvion reports a different one or');
    console.log('      none, the hash branch misses AND the amount branch skips the row,');
    console.log('      because it only looks at rows with txRef = NULL. Such a row can');
    console.log('      never match, at any amount. Above, look for "EXCLUDED: txRef is set".');
    console.log('');
    console.log('   If a deposit is far larger than any open row (9.95 against 5.04), it is');
    console.log('   neither: that deposit belongs to something else. Check whether a manual');
    console.log('   top-up was made, and whether the 5.04 deposit arrived at all.');
    console.log('');
    console.log('Done. Nothing was changed.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });