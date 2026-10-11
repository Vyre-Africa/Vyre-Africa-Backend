// scripts/test-sweepers.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-sweepers.ts
//
// AIM: test the recovery paths. They only run when something has already gone
// wrong, which is exactly why they are never exercised — and a sweeper that
// misbehaves either stalls every replenishment or sends one twice.
//
// It also covers the NUVION_MANUAL_SEND fix, which has never run. Before it,
// sweepReplenishments re-queued anything PENDING for 10 minutes without
// checking the flag, so a row deliberately left for a person to send by hand
// was picked up and sent automatically ten minutes later.
//
// SAFE TO RUN WITH THE WORKER UP. Nothing here can send crypto, by
// construction, not by timing:
//
//   The sweeper re-queues a row's PAYLOAD, and the handler reads
//   replenishCurrencyId from that payload. These fixtures put a currency id
//   that does not exist in it, so if a worker does pick the job up, the wallet
//   lookup finds nothing and the handler refuses before reaching
//   blockchain_Transfer. The ROW keeps real foreign keys, so the database stays
//   consistent.
//
// It asserts on THE QUEUE, not on row status: the queue is what the sweeper
// actually decides, and a worker racing to process the job cannot change the
// answer.
//
// Every row and job it creates is prefixed SWEEPTEST- and removed at the end.

import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { generalQueue } from '../workers/general.worker';
import { sweepReplenishments } from '../services/treasuryReplenishment.service';

// Must match the service. If these drift, this test lies rather than failing.
const STALE_PENDING_MINUTES = 10;
const STALE_RETRY_MINUTES = 5;
const STALE_SUBMITTING_MINUTES = 15;

const tag = `SWEEPTEST-${Date.now()}`;
const made: string[] = [];

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
    ok ? pass++ : fail++;
    console.log(`   ${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n        ${detail}`}`);
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

// Any job the sweeper adds for this transfer, whatever generation it stamped on
// it. The sweeper uses `sweep${Date.now()}`, so the id cannot be predicted —
// only its prefix.
async function queuedFor(transferRequestId: string) {
    const jobs = await generalQueue.getJobs(['waiting', 'delayed', 'active', 'failed', 'completed']);
    return jobs.filter((j: any) => String(j?.id ?? '').startsWith(`replenish_${transferRequestId}_`));
}

async function seed(o: {
    label: string;
    status: string;
    ageMinutes: number;
    cryptoCurrencyId: string;
    usdTreasuryAccountId: string;
}) {
    const transferRequestId = `${tag}-${o.label}`;
    made.push(transferRequestId);

    await prisma.treasuryReplenishment.create({
        data: {
            transferRequestId,
            // REAL foreign keys, so the row is valid.
            cryptoCurrencyId: o.cryptoCurrencyId,
            usdTreasuryAccountId: o.usdTreasuryAccountId,
            status: o.status as any,
            statusUpdatedAt: minutesAgo(o.ageMinutes),
            amount: '25',
            nuvionCurrency: 'USC',
            // DELIBERATELY UNSENDABLE. The handler reads the currency from here,
            // and no wallet exists for this id, so it refuses before sending.
            payload: {
                transferRequestId,
                replenishUserId: config.Admin_Id,
                replenishCurrencyId: `${tag}-no-such-currency`,
                treasuryAccountId: `${tag}-no-such-treasury`,
                usdTreasuryAccountId: o.usdTreasuryAccountId,
                treasuryWalletAddress: '0x0000000000000000000000000000000000000000',
                amount: '25',
                nuvionCurrency: 'USC',
            } as any,
        },
    });

    return transferRequestId;
}

async function main() {
    console.log(`Rows tagged ${tag}\n`);

    const currency = await prisma.currency.findFirst({ where: { ISO: 'USDC' }, select: { id: true, ISO: true } });
    const usdTreasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true }, select: { id: true } });
    if (!currency || !usdTreasury) {
        console.error('❌ Need a USDC Currency row and an active USD treasury row to build valid fixtures.');
        process.exit(1);
    }

    const originalFlag = process.env.NUVION_MANUAL_SEND;

    // ─────────────────────────────────────────────────────────────
    console.log('1. MANUAL_SEND is ON, with a stale PENDING row');
    console.log('   Testing: the sweeper leaves it alone. This is the fix — before it,');
    console.log('   the flag was honoured when scheduling and ignored when sweeping, so');
    console.log('   a row held back for a person went out automatically after 10 minutes.');
    process.env.NUVION_MANUAL_SEND = 'true';
    const held = await seed({
        label: 'HELD', status: 'PENDING', ageMinutes: STALE_PENDING_MINUTES + 5,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    check('nothing was queued for it', (await queuedFor(held)).length === 0,
        'the flag is being ignored by the sweeper: the manual escape hatch leaks');
    const heldRow = await prisma.treasuryReplenishment.findUnique({ where: { transferRequestId: held } });
    check('it is still PENDING, not moved', heldRow?.status === 'PENDING', `got ${heldRow?.status}`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('2. MANUAL_SEND is OFF, with a stale PENDING row');
    console.log('   Testing: the normal recovery still works. A job lost to a Redis');
    console.log('   outage leaves the row PENDING, and the sweeper is what rescues it.');
    process.env.NUVION_MANUAL_SEND = 'false';
    const stale = await seed({
        label: 'STALE', status: 'PENDING', ageMinutes: STALE_PENDING_MINUTES + 5,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    check('it was re-queued', (await queuedFor(stale)).length > 0,
        'a lost job would never recover: this is the whole point of the sweeper');
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('3. MANUAL_SEND is OFF, with a FRESH PENDING row');
    console.log('   Testing: the staleness window is respected. A row queued seconds');
    console.log('   ago has a live job already, and re-queueing it is how you get two.');
    const fresh = await seed({
        label: 'FRESH', status: 'PENDING', ageMinutes: 0,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    check('it was left alone', (await queuedFor(fresh)).length === 0,
        `a row ${STALE_PENDING_MINUTES} minutes fresher than the window was swept anyway`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('4. A RETRY row past its shorter window');
    console.log(`   Testing: RETRY uses ${STALE_RETRY_MINUTES} minutes, not ${STALE_PENDING_MINUTES}.`);
    const retrying = await seed({
        label: 'RETRY', status: 'RETRY', ageMinutes: STALE_RETRY_MINUTES + 2,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    check('it was re-queued', (await queuedFor(retrying)).length > 0,
        `a RETRY row older than ${STALE_RETRY_MINUTES} minutes was not picked up`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('5. A SUBMITTING row that never finished');
    console.log('   Testing: it is escalated, NEVER retried. The worker may have died');
    console.log('   AFTER the send went out, so re-sending could double-pay the treasury.');
    console.log('   This is the one case where doing nothing automatically is correct.');
    const hung = await seed({
        label: 'HUNG', status: 'SUBMITTING', ageMinutes: STALE_SUBMITTING_MINUTES + 5,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    const hungRow = await prisma.treasuryReplenishment.findUnique({ where: { transferRequestId: hung } });
    check('it was moved to MANUAL_REVIEW', hungRow?.status === 'MANUAL_REVIEW', `got ${hungRow?.status}`);
    check('it was NOT re-queued', (await queuedFor(hung)).length === 0,
        'a half-finished send was queued again: this is how the treasury gets paid twice');
    check('the note says the outcome is unknown', /unknown/i.test(hungRow?.note ?? ''), hungRow?.note ?? '(no note)');
    console.log('   (an ops alert should have been raised for this one — check the logs)');
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('6. The hung check runs even with MANUAL_SEND on');
    console.log('   Testing: the fix skips only the re-queue. A row that may already');
    console.log('   have been sent needs a person whether the flag is on or not.');
    process.env.NUVION_MANUAL_SEND = 'true';
    const hungManual = await seed({
        label: 'HUNGMANUAL', status: 'SUBMITTING', ageMinutes: STALE_SUBMITTING_MINUTES + 5,
        cryptoCurrencyId: currency.id, usdTreasuryAccountId: usdTreasury.id,
    });
    await sweepReplenishments();
    const hungManualRow = await prisma.treasuryReplenishment.findUnique({ where: { transferRequestId: hungManual } });
    check('still escalated to MANUAL_REVIEW', hungManualRow?.status === 'MANUAL_REVIEW',
        `got ${hungManualRow?.status} — the fix returned early and silenced the escalation`);
    console.log('');

    if (originalFlag === undefined) delete process.env.NUVION_MANUAL_SEND;
    else process.env.NUVION_MANUAL_SEND = originalFlag;

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}

async function cleanup() {
    console.log('\nCleaning up...');

    // Jobs first. Leaving one behind means a worker could pick it up later; it
    // would refuse to send, but it would still churn through five attempts.
    let removedJobs = 0;
    for (const id of made) {
        for (const job of await queuedFor(id)) {
            try { await job.remove(); removedJobs++; } catch { /* already gone */ }
        }
    }

    const d = await prisma.treasuryReplenishment.deleteMany({
        where: { transferRequestId: { startsWith: tag } },
    });
    console.log(`Removed ${d.count} row(s) and ${removedJobs} job(s) tagged ${tag}.`);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => {
        try { await cleanup(); } catch (e: any) { console.error('Cleanup failed:', e?.message); }
        await prisma.$disconnect();
        // The queue holds the process open otherwise.
        try { await generalQueue.close(); } catch { /* ignore */ }
        process.exit(process.exitCode ?? 0);
    });