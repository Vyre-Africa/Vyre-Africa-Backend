// scripts/recover-unmatched-deposit.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/recover-unmatched-deposit.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/recover-unmatched-deposit.ts --apply
//
// AIM: convert a deposit that arrived at Nuvion but matched no replenishment,
// by re-running the REAL handler rather than by hand-editing rows.
//
// On 11 Oct a 5.00 USC deposit (event 01M4MW3B1XAXVW1BXF8CKCPB6X) arrived for a
// 5.04 replenishment and was rejected by the amount tolerance. The money is at
// Nuvion, the row sits at SUBMITTED, and the conversion never ran.
//
// WHY A REPLAY AND NOT AN UPDATE
//   handleDepositConfirmed does the matching, the claim, the amount recording
//   and the conversion queueing. Setting those columns by hand would skip the
//   claim and the duplicate guard, so the next real delivery of the same event
//   could convert a second time. Replaying the handler keeps every one of those
//   protections.
//
// WHY THE RESET IS NEEDED
//   The failed attempt moved the NuvionDepositEvent out of RECEIVED, and the
//   handler treats anything not RECEIVED as already finished with ('DUPLICATE').
//   So the event has to go back to RECEIVED before a replay does anything. That
//   is the only row this script writes directly.
//
// APPLY THE MATCHER FIX FIRST (deposit-matcher-fix.md). Without it the replay
// will fail exactly as the original delivery did, which this script checks for
// and reports rather than leaving you guessing.
//
// Dry run by default.

import prisma from '../config/prisma.client';
import { handleDepositConfirmed, depositEventFromNuvion } from '../services/treasuryConversion.service';

const APPLY = process.argv.includes('--apply');

// The event to recover. Taken from the webhook log.
const EVENT_ID = process.env.RECOVER_EVENT_ID ?? '01M4MW3B1XAXVW1BXF8CKCPB6X';

async function main() {
    console.log(`Running in ${APPLY ? 'APPLY' : 'DRY RUN'} mode.\n`);

    // ─────────────────────────────────────────────────────────────
    console.log('1. The deposit event');
    const event = await prisma.nuvionDepositEvent.findUnique({ where: { id: EVENT_ID } });
    if (!event) {
        console.error(`❌ No NuvionDepositEvent with id ${EVENT_ID}.`);
        console.error('   Set RECOVER_EVENT_ID to the right one, or check it was recorded at all.');
        process.exit(1);
    }
    console.log(`   ${event.amount} ${event.currency} into ${event.accountId}`);
    console.log(`   status  ${event.status}`);
    console.log(`   txHash  ${event.txHash ?? 'NULL'}`);
    console.log('');

    if (event.status === 'MATCHED') {
        console.log('✅ Already MATCHED. Nothing to recover.');
        return;
    }

    // The stored payload is what Nuvion actually sent, so the replay uses the
    // real thing rather than a payload rebuilt from the columns.
    const mapped = depositEventFromNuvion(event.payload as any);
    if (!mapped) {
        console.error('❌ The stored payload does not map to a deposit event.');
        console.error('   depositEventFromNuvion rejected it, so a replay cannot be faithful.');
        console.error('   Check that payload was saved in full.');
        process.exit(1);
    }
    console.log('2. What the replay will feed the handler');
    console.log(`   eventId   ${mapped.eventId}`);
    console.log(`   amount    ${mapped.amount} ${mapped.currency}`);
    console.log(`   txHash    ${mapped.txHash ?? 'NULL'}`);
    console.log('');

    // ─────────────────────────────────────────────────────────────
    console.log('3. Will it match this time?');
    const open = await prisma.treasuryReplenishment.findMany({
        where: { status: { in: ['SUBMITTED', 'DEPOSIT_OVERDUE'] } },
        select: { transferRequestId: true, amount: true, txRef: true, nuvionCurrency: true },
    });
    if (open.length === 0) {
        console.error('❌ No replenishment is waiting for a deposit, so there is nothing to match.');
        console.error('   If the row moved on, work out which status it reached before replaying.');
        process.exit(1);
    }
    for (const r of open) {
        const hashHit = !!mapped.txHash && (r.txRef ?? '').toLowerCase() === mapped.txHash.toLowerCase();
        console.log(`   ${r.transferRequestId}: expects ${r.amount} ${r.nuvionCurrency ?? 'NULL'}, txRef ${r.txRef ?? 'NULL'}${hashHit ? '  <- hash matches' : ''}`);
    }
    console.log('');
    console.log('   If none of these shows a hash match, the amount branch has to carry it,');
    console.log('   which needs the tolerance floor from deposit-matcher-fix.md to be in.');
    console.log('');

    if (!APPLY) {
        console.log('Dry run only. Nothing was changed.');
        console.log('Re-run with --apply to reset the event and replay the handler.');
        return;
    }

    // ─────────────────────────────────────────────────────────────
    console.log('4. Resetting the event to RECEIVED...');
    await prisma.nuvionDepositEvent.update({
        where: { id: EVENT_ID },
        data: { status: 'RECEIVED' },
    });
    console.log('   done\n');

    console.log('5. Replaying the real handler...');
    const result = await handleDepositConfirmed(mapped);
    console.log(`   handleDepositConfirmed returned: ${result}\n`);

    if (result === 'MATCHED') {
        console.log('✅ Matched. The conversion is queued — your worker will run it.');
        console.log('   Watch the row reach CONVERTED.');
    } else if (result === 'UNMATCHED') {
        console.log('❌ Still unmatched, so the cause is not what the replay assumed.');
        console.log('   Run diagnose-deposit-match.ts: it prints which test rejected each row.');
        console.log('   The event has been left at its post-attempt status, as before.');
    } else {
        console.log('⚠️  Reported DUPLICATE, which means the reset did not take effect.');
        console.log('   Check the event status and try again.');
    }

    const after = await prisma.treasuryReplenishment.findMany({
        where: { depositEventId: EVENT_ID },
        select: { transferRequestId: true, status: true, depositedAmount: true },
    });
    for (const r of after) {
        console.log(`\n   ${r.transferRequestId}: ${r.status}, deposited ${r.depositedAmount}`);
    }
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });