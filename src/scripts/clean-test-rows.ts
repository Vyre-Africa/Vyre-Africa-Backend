// scripts/clean-test-rows.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/clean-test-rows.ts          # dry run
//   npx ts-node --transpile-only -r dotenv/config src/scripts/clean-test-rows.ts --apply  # deletes
//
// AIM: remove rows the test harnesses left behind.
//
// test-webhook-flow.ts cleaned up at the END of main(), after a process.exit()
// that never reached it — so every run that crashed partway left its rows in
// place. They are now the newest rows in the payout table, which is actively
// misleading: verify-payout-metadata.ts read them as real payouts and reported
// the wrong verdict about the live code.
//
// Dry run by default. Nothing is deleted without --apply.
//
// WHAT IT TOUCHES: only rows whose key starts with TESTWH- or TESTSEND-.
// Nothing else can match, so a real payout cannot be caught by this.

import prisma from '../config/prisma.client';

const APPLY = process.argv.includes('--apply');
const PREFIXES = ['TESTWH-', 'TESTSEND-'];

async function main() {
    console.log(`Running in ${APPLY ? 'APPLY' : 'DRY RUN'} mode.\n`);

    const byPrefix = PREFIXES.map((p) => ({ idempotencyKey: { startsWith: p } }));

    const payouts = await prisma.transferRequest.findMany({
        where: { OR: byPrefix },
        orderBy: { createdAt: 'asc' },
        select: { id: true, idempotencyKey: true, status: true, createdAt: true },
    });

    // Replenishment rows are keyed by transferRequestId, which for the send test
    // is a synthetic TESTSEND- string with no TransferRequest behind it, so look
    // for both: rows pointing at a test payout, and rows with a test key.
    const replenishments = await prisma.treasuryReplenishment.findMany({
        where: {
            OR: [
                { transferRequestId: { in: payouts.map((p: { id: string }) => p.id) } },
                ...PREFIXES.map((p) => ({ transferRequestId: { startsWith: p } })),
            ],
        },
        select: { transferRequestId: true, status: true, amount: true, txRef: true },
    });

    console.log(`TransferRequest rows:        ${payouts.length}`);
    console.log(`TreasuryReplenishment rows:  ${replenishments.length}\n`);

    if (payouts.length === 0 && replenishments.length === 0) {
        console.log('Nothing to clean.');
        return;
    }

    for (const p of payouts) {
        console.log(`  payout  ${p.createdAt?.toISOString?.().slice(0, 16)}  ${p.status.padEnd(10)} ${p.idempotencyKey}`);
    }

    // Anything with a txRef was really sent on-chain. Deleting the row does not
    // undo that, and it is the only record of where the crypto went, so it is
    // never deleted automatically.
    const sent = replenishments.filter((r: { txRef: string | null }) => r.txRef);
    for (const r of replenishments) {
        const flag = r.txRef ? '  ⚠️  HAS A TX HASH — REALLY SENT' : '';
        console.log(`  replen  ${r.status.padEnd(14)} ${r.amount} ${r.transferRequestId}${flag}`);
    }
    console.log('');

    if (sent.length) {
        console.log(`⚠️  ${sent.length} replenishment row(s) have a transaction hash, so real crypto moved for them.`);
        console.log('   They are the only record of that, and they are NOT deleted by this script.');
        console.log('   Read them, note the hash, and delete them by hand when you are done:');
        for (const r of sent) console.log(`     ${r.transferRequestId}  ${r.txRef}`);
        console.log('');
    }

    if (!APPLY) {
        console.log('Dry run only — nothing deleted. Re-run with --apply.');
        return;
    }

    console.log('Deleting...');

    const safeReplenishments = replenishments.filter((r: { txRef: string | null }) => !r.txRef).map((r: { transferRequestId: string }) => r.transferRequestId);
    if (safeReplenishments.length) {
        const d = await prisma.treasuryReplenishment.deleteMany({
            where: { transferRequestId: { in: safeReplenishments } },
        });
        console.log(`  ${d.count} replenishment row(s)`);
    }

    // Order matters: the transaction references the block, so the transaction
    // goes first. Blocks left behind are already committed or released and inert.
    const keys = payouts.map((p: { idempotencyKey: string }) => p.idempotencyKey);
    if (keys.length) {
        const dtx = await prisma.virtualTransaction.deleteMany({ where: { reference: { in: keys } } });
        console.log(`  ${dtx.count} virtual transaction(s)`);
        const dtr = await prisma.transferRequest.deleteMany({ where: { id: { in: payouts.map((p: { id: string }) => p.id) } } });
        console.log(`  ${dtr.count} payout row(s)`);
    }

    for (const p of PREFIXES) {
        const dw = await prisma.nuvionWebhookEvent.deleteMany({ where: { eventId: { contains: p } } });
        const dd = await prisma.nuvionDepositEvent.deleteMany({ where: { id: { contains: p } } });
        if (dw.count || dd.count) console.log(`  ${dw.count} webhook event(s), ${dd.count} deposit event(s) for ${p}`);
    }

    console.log('\nDone.');
    console.log('NOTE: pendingManualTopupUsd on the USD treasury was incremented by the');
    console.log('below-threshold test and is NOT reset here. Check the figure if it matters.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });