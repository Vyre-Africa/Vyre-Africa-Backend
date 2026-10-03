// scripts/test-e2e-offramp.ts
//
// FIXED — ECONNREFUSED on the first Prisma query meant env vars were
// never loaded. The real app's entry point (app.ts / server.ts) almost
// certainly calls dotenv at startup before anything else runs; this
// standalone script bypasses that entirely. Without DATABASE_URL set,
// Prisma falls back to something that refuses the connection outright.
//
// This import MUST be the very first line, before the prisma import
// below — if it runs after prisma.client.ts has already been loaded
// and attempted to read process.env, the fix won't take effect.
import 'dotenv/config';
// ⚠️ If your project uses a specific env file (.env.development,
// .env.local, etc.) rather than a plain .env, use the explicit form
// instead:
//   import * as dotenv from 'dotenv';
//   dotenv.config({ path: '.env.development' });
//
// Full end-to-end internal offramp test: initiate → attach settlement
// account → confirm (get deposit address) → send real USDC on-chain →
// poll for the webhook-driven settlement to complete.
//
// ⚠️ THIS SENDS REAL CRYPTO. Once the on-chain transfer step runs,
// there is no undo. Read the whole script before running it, and
// confirm you're pointed at the right environment (which admin wallet,
// which chain, which amount) before it reaches that step.
//
// ⚠️ THE LAST STEP DEPENDS ON YOUR REAL BACKEND. Quidax notifies your
// deployed webhook endpoint when the payout completes, not this
// script. This script polls the DATABASE for the status your real
// webhook handler writes — so your real server needs to be running and
// reachable by Quidax at the same time you run this, or the DB will
// just sit at the same status forever and this script will time out
// having learned nothing about whether it actually worked.
//
// Run with: npx ts-node scripts/test-e2e-offramp.ts

import readline from 'readline';
import prisma from '../config/prisma.client';
import internalOfframpService from '../services/internalOfframp.service';

// ── A real, funded test user ─────────────────────────────────────────
// Using the known test account with a real USDC/Base balance from this
// session's logs. Confirm this user still has at least the test amount
// available before running — the script checks this itself below, but
// worth knowing in advance rather than discovering it mid-run.
const TEST_USER_ID = 'user_38OI3Y47pS0u4gKiRoee5GySGiV';
const TEST_CURRENCY_ID = '4e44778a-c7eb-4b6b-97c2-740d40313823'; // USDC
const TEST_AMOUNT = '5'; // the confirmed minimum
const TEST_FIAT = 'NGN';

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

async function main() {
    console.log('── Pre-flight: user and balance ──────────────────');
    const user = await prisma.user.findUnique({
        where: { id: TEST_USER_ID },
        select: { id: true, email: true, legalFirstName: true, legalLastName: true, kycTier: true },
    });

    if (!user) {
        console.log('🛑 Test user not found. Update TEST_USER_ID.');
        return;
    }
    if ((user.kycTier ?? 0) < 2) {
        console.log(`🛑 Test user is at kycTier ${user.kycTier}, below the Tier 2 gate. Can't proceed.`);
        return;
    }
    console.log('✅ User found:', user.email, '| kycTier:', user.kycTier);

    const wallet = await prisma.wallet.findFirst({ where: { userId: TEST_USER_ID, currencyId: TEST_CURRENCY_ID } });
    if (!wallet) {
        console.log('🛑 No USDC wallet found for this user.');
        return;
    }
    console.log('✅ Wallet found. Available balance:', wallet.availableBalance);

    if (Number(wallet.availableBalance) < Number(TEST_AMOUNT)) {
        console.log(`🛑 Insufficient balance. Need ${TEST_AMOUNT}, have ${wallet.availableBalance}.`);
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 1 — initiate (now using the FIXED settlement name handling)
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── Step 1: initiate ──────────────────────────────');
    let result;
    try {
        result = await internalOfframpService.initiate({
            userId: TEST_USER_ID,
            cryptoCurrencyId: TEST_CURRENCY_ID,
            amount: TEST_AMOUNT,
            fiatCurrency: TEST_FIAT,
            userEmail: "team@vyre.africa",
            legalFirstName: user.legalFirstName ?? '',
            legalLastName: user.legalLastName ?? '',
        });
        console.log('✅ initiate succeeded');
        console.log(JSON.stringify(result, null, 2));
    } catch (error: any) {
        // FIXED — printing the full error here directly, rather than
        // relying on the service's internal logger output. That log
        // call IS capturing the real Quidax response now, but the
        // local console transport appears to only print the message
        // string and drop metadata objects (common winston/pino
        // behavior outside a JSON-formatted production sink). This
        // doesn't depend on that logger's config at all — initiate()
        // re-throws the error after logging it, so it's fully intact
        // right here.
        console.log('❌ initiate FAILED');
        console.log('   status:', error?.response?.status);
        console.log('   quidax response:', JSON.stringify(error?.response?.data, null, 2));
        console.log('   message:', error?.message);
        return;
    }

    const { requestId, depositAddress } = result;

    if (!depositAddress) {
        console.log('🛑 No deposit address returned — cannot proceed to the on-chain send.');
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // THE POINT OF NO RETURN — explicit confirmation required
    // ═══════════════════════════════════════════════════════════════
    console.log('\n⚠️  ─────────────────────────────────────────────────');
    console.log('⚠️   NEXT STEP SENDS REAL USDC ON-CHAIN. IRREVERSIBLE.');
    console.log('⚠️  ─────────────────────────────────────────────────');
    console.log(`    Amount:   ${TEST_AMOUNT} USDC`);
    console.log(`    To:       ${depositAddress}`);
    console.log(`    Request:  ${requestId}`);
    console.log('');

    const confirmation = await ask('Type SEND to proceed, anything else to abort: ');
    if (confirmation.trim() !== 'SEND') {
        console.log('\nAborted. The user\'s funds are frozen but not debited — releasing now.');
        try {
            await internalOfframpService.failRequest(requestId, 'Test script aborted before on-chain send');
            console.log('✅ Released. Test user\'s balance is unaffected.');
        } catch (err: any) {
            console.log('⚠️  Could not auto-release. Check the request manually:', requestId);
        }
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 2 — the real, irreversible on-chain send
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── Step 2: sendToQuidax (real on-chain transfer) ──');
    try {
        const sendResult = await internalOfframpService.sendToQuidax(requestId);
        console.log('✅ On-chain send complete');
        console.log(JSON.stringify(sendResult, null, 2));
    } catch (error: any) {
        console.log('❌ sendToQuidax FAILED:', error?.message);
        console.log('   Check the request status — failRequest() should have released the');
        console.log('   user\'s funds automatically if the chain send itself never fired.');
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3 — poll the DB for the webhook-driven settlement
    // ═══════════════════════════════════════════════════════════════
    console.log('\n── Step 3: waiting for settlement ────────────────');
    console.log('This depends entirely on your REAL backend receiving Quidax\'s');
    console.log('webhook and running processInternalOfframpWebhook. This script');
    console.log('only reads the database — it is not doing the settlement itself.');
    console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s for up to ${POLL_TIMEOUT_MS / 60_000} minutes...\n`);

    const startTime = Date.now();
    let lastStatus = '';

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
        const current = await prisma.internalOfframpRequest.findUnique({ where: { id: requestId } });

        if (!current) {
            console.log('🛑 Request record disappeared — this should not happen.');
            return;
        }

        if (current.status !== lastStatus) {
            console.log(`[${new Date().toLocaleTimeString()}] status: ${lastStatus || '(start)'} → ${current.status}`);
            lastStatus = current.status;
        }

        if (current.status === 'COMPLETED') {
            console.log('\n✅ SETTLED.');
            console.log('   Actual fiat credited:', current.actualFiatAmount?.toString());
            console.log('\nFull loop confirmed: USDC left the admin wallet, Quidax');
            console.log('processed it, the webhook fired, and the user was credited.');
            return;
        }

        if (current.status === 'FAILED') {
            console.log('\n❌ Request ended in FAILED.');
            console.log('   Reason:', current.failureReason);
            console.log('\n⚠️  Since the on-chain send already happened, check whether the');
            console.log('   crypto is sitting with Quidax unresolved — this is the');
            console.log('   "manual reconciliation required" case flagged in the webhook');
            console.log('   handler\'s sell_transaction.failed branch.');
            return;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    console.log('\n⏱️  Timed out waiting for settlement.');
    console.log('   Current status:', lastStatus);
    console.log('   This likely means either:');
    console.log('   1. Your real backend server is not running / not reachable by Quidax, or');
    console.log('   2. Quidax has not yet processed the payout on their end, or');
    console.log('   3. The webhook arrived but failed silently — check your real server logs.');
    console.log(`   Request ID for manual follow-up: ${requestId}`);
}

main()
    .catch((err) => { console.error('Unexpected script error:', err); process.exit(1); })
    .finally(() => process.exit(0));