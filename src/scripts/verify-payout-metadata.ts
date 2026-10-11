// scripts/verify-payout-metadata.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/verify-payout-metadata.ts
//
// AIM: prove the REAL payout path writes the metadata the replenishment needs.
//
// Everything downstream has now been tested with fixtures that wrote their own
// metadata, so the one thing never checked is whether a genuine payout writes
// it. It hangs on a single line in initiateGlobalPayoutBlock's metadata:
//
//     cryptoCurrencyId,
//
// Without it, scheduleReplenishmentForPayout has no idea which stablecoin was
// frozen, so it flags the payout and gives up. Not some payouts — every one.
// The feature would look wired and replenish nothing.
//
// READ ONLY. It writes nothing, moves nothing, and is safe to run on production.
//
// WHAT IT ANSWERS
//   1. do recent real payouts carry cryptoCurrencyId and treasuryAccountId
//   2. for the stablecoins actually being paid out, does STABLECOIN_TREASURY
//      resolve — or would those payouts be flagged for a missing map entry
//   3. is the threshold for each live chain sane against real payout sizes

import prisma from '../config/prisma.client';
import { resolveTreasury, thresholdFor } from '../config/nuvionTreasury.config';

// How many recent CRYPTO payouts to look at.
const LOOK_AT = 25;

// Rows the test harnesses created. They MUST be excluded: they are the newest
// rows in the table, they were written by fixtures rather than by the payout
// path, and judging the live code from them gives exactly the wrong answer.
const TEST_PREFIXES = ['TESTWH-', 'TESTSEND-'];

async function main() {
    console.log('1. Recent CRYPTO payouts\n');

    const payouts = await prisma.transferRequest.findMany({
        where: {
            type: 'CRYPTO',
            AND: TEST_PREFIXES.map((p) => ({ NOT: { idempotencyKey: { startsWith: p } } })),
        },
        orderBy: { createdAt: 'desc' },
        take: LOOK_AT,
        select: { id: true, idempotencyKey: true, status: true, amount: true, createdAt: true },
    });

    // Counted, not hidden. Leftover test rows are worth knowing about: they sit
    // in the payout table as PROCESSING forever.
    const leftovers = await prisma.transferRequest.count({
        where: { OR: TEST_PREFIXES.map((p) => ({ idempotencyKey: { startsWith: p } })) },
    });
    if (leftovers) {
        console.log(`   (ignoring ${leftovers} test row(s) from the harnesses — run clean-test-rows.ts to remove them)\n`);
    }

    if (payouts.length === 0) {
        console.log('   No CRYPTO payouts at all, so there is nothing to check yet.');
        console.log('   Run this again after the first real payout goes through.');
        return;
    }

    // The same lookup outflows.completed does: VirtualTransaction by the
    // payout's idempotencyKey.
    const rows: { payout: any; tx: any }[] = [];
    for (const p of payouts) {
        const tx = await prisma.virtualTransaction.findFirst({
            where: { reference: p.idempotencyKey },
            select: { id: true, blockId: true, metadata: true },
        });
        rows.push({ payout: p, tx });
    }

    let good = 0;
    let missingCrypto = 0;
    let missingTx = 0;
    const isoChainSeen = new Map<string, { currencyId: string; count: number }>();

    for (const { payout, tx } of rows) {
        const when = payout.createdAt?.toISOString?.().slice(0, 16) ?? '?';
        const meta: any = tx?.metadata ?? null;

        if (!tx) {
            missingTx++;
            console.log(`   ✗ ${when}  ${payout.status.padEnd(10)} no VirtualTransaction for ${payout.idempotencyKey}`);
            continue;
        }

        const hasCrypto = !!meta?.cryptoCurrencyId;
        const hasTreasury = !!meta?.treasuryAccountId;
        const hasBlock = !!tx.blockId;

        if (hasCrypto && hasTreasury && hasBlock) {
            good++;
            const currency = await prisma.currency.findUnique({
                where: { id: meta.cryptoCurrencyId },
                select: { ISO: true, chain: true },
            });
            const key = currency ? `${currency.ISO}:${String(currency.chain ?? '?').toUpperCase()}` : `unknown(${meta.cryptoCurrencyId})`;
            const seen = isoChainSeen.get(key);
            isoChainSeen.set(key, { currencyId: meta.cryptoCurrencyId, count: (seen?.count ?? 0) + 1 });
            console.log(`   ✓ ${when}  ${payout.status.padEnd(10)} ${key}, ${payout.amount}`);
        } else {
            if (!hasCrypto) missingCrypto++;
            const gaps = [
                !hasCrypto ? 'cryptoCurrencyId' : null,
                !hasTreasury ? 'treasuryAccountId' : null,
                !hasBlock ? 'blockId' : null,
            ].filter(Boolean).join(', ');
            console.log(`   ✗ ${when}  ${payout.status.padEnd(10)} missing ${gaps}`);
        }
    }

    console.log('');
    console.log(`   ${good} of ${rows.length} carry everything the replenishment needs.`);
    if (missingTx) {
        console.log(`   ${missingTx} have no VirtualTransaction at all. These took a payout path that`);
        console.log('   creates no block, so outflows.completed bails on them by design. Old payouts');
        console.log('   from before the unified block path look like this and are not a new problem.');
    }
    if (missingCrypto) console.log(`   ${missingCrypto} are missing cryptoCurrencyId and could never be replenished.`);
    console.log('');

    // The verdict that matters. Old payouts predate the field, so what counts is
    // whether the MOST RECENT one has it: that is the live code path.
    const newest = rows[0];
    const newestHasIt = !!(newest.tx?.metadata as any)?.cryptoCurrencyId;
    console.log('2. Is the live code writing it?\n');
    console.log(`   Judging by the newest real payout: ${newest.payout.idempotencyKey}`);
    console.log(`   (${newest.payout.createdAt?.toISOString?.() ?? '?'}, ${newest.payout.status})\n`);
    if (newestHasIt) {
        console.log('   ✅ That payout carries cryptoCurrencyId, so the patch is in.');
    } else {
        console.log('   ❌ The most recent payout does NOT carry cryptoCurrencyId.');
        console.log('');
        console.log('   Either the metadata line is not deployed, or that payout took a different');
        console.log('   path. Until it is there, every completed payout will be flagged and the');
        console.log('   USD treasury will never replenish itself.');
        console.log('');
        console.log('   The line belongs in initiateGlobalPayoutBlock\'s metadata in blockCryptoPayout:');
        console.log('       cryptoCurrencyId,');
    }
    console.log('');

    // ─────────────────────────────────────────────────────────────
    // The second way this silently does nothing: the metadata is right, but the
    // stablecoin being paid out has no entry in the map.
    console.log('3. Can the map handle what is actually being paid out?\n');

    if (isoChainSeen.size === 0) {
        console.log('   Nothing resolvable to check (see above).');
    } else {
        for (const [key, info] of isoChainSeen) {
            const [iso, chain] = key.split(':');
            const target = await resolveTreasury(iso, chain);
            if (target.ok) {
                console.log(`   ✅ ${key.padEnd(16)} ${info.count} payout(s) → ${target.address} (threshold ${thresholdFor(chain)})`);
            } else {
                console.log(`   ❌ ${key.padEnd(16)} ${info.count} payout(s) → ${target.reason}`);
                console.log(`      Real payouts are happening in this pair and every one of them will be`);
                console.log(`      flagged until STABLECOIN_TREASURY has an entry for it.`);
            }
        }
    }

    console.log('');
    console.log('Done. Nothing was changed.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });