// scripts/test-replenishment-send.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-replenishment-send.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-replenishment-send.ts --confirm
//
// AIM: run the ONE step that has never been run, and cannot be faked:
// blockchain_Transfer sending crypto from the admin account to the Nuvion
// stablecoin wallet.
//
// Everything else in the replenishment is either proven (the conversion, live
// on 8 Oct) or coverable by test-webhook-flow.ts. This is the gap.
//
// IT MOVES REAL CRYPTO, on-chain, irreversibly. Nothing happens without
// --confirm.
//
// NUVION_MANUAL_SEND DOES NOT STOP THIS, by design. That flag is checked where
// a job is QUEUED; this script calls handleTreasuryReplenishment directly, so
// --confirm is the only gate. That is the point of the script — it is the
// manual send — but do not expect the flag to protect you here.
//
// Run it WITHOUT --confirm first. Every check runs and nothing is created, so a
// clean dry run means the only thing left untested is the send itself.
//
// HOW IT WORKS
//   It creates a TreasuryReplenishment row with a synthetic transferRequestId
//   and calls the REAL handler. transferRequestId is a plain column with no
//   foreign key, so no payout and no customer is involved.
//
// WHAT IT ANSWERS
//   1. does blockchain_Transfer work with the ADMIN account as userId
//   2. does it return a tx hash (if not, deposit matching falls back to amount)
//   3. is the amount above the chain minimum transferfeeService enforces
//   4. does the money actually arrive at the Nuvion wallet
//
// AFTER IT RUNS, leave the row in place. Nuvion's inflows.completed will fire,
// and if the event handler is wired the deposit will be matched and converted
// automatically. Watching that row reach CONVERTED proves steps 4, 5 and 6
// end to end with real money and a real webhook.

import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { handleTreasuryReplenishment } from '../services/treasuryReplenishment.service';
import { resolveTreasury, thresholdFor } from '../config/nuvionTreasury.config';

// Which stablecoin to send. Must be a pair present in STABLECOIN_TREASURY.
const CURRENCY_ISO = 'USDC';
const CHAIN = 'BASE';

// How much, in whole tokens. Must clear the chain minimum in
// transferfeeService, which this script cannot read. Start at the threshold.
//
// If it is below the minimum the send is REFUSED before anything leaves the
// chain, and the row goes to FAILED with the minimum in the note. So a wrong
// value here costs a re-run, not money.
const AMOUNT = '20';

// The send also takes a withdrawal fee on top of AMOUNT, and this script cannot
// read it either. Require this much slack over AMOUNT before starting, so the
// attempt is not refused for being a few cents short.
const FEE_HEADROOM = 2;

const CONFIRMED = process.argv.includes('--confirm');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const transferRequestId = `TESTSEND-${Date.now()}`;

    console.log('1. Where would it go?');
    const target = await resolveTreasury(CURRENCY_ISO, CHAIN);
    if (!target.ok || !target.address || !target.treasuryRowId) {
        console.error(`❌ ${target.reason ?? 'could not resolve a treasury'}`);
        console.error('   Fix STABLECOIN_TREASURY in nuvionTreasury.config.ts before going further.');
        process.exit(1);
    }
    console.log(`   ✅ ${target.key} → ${target.address} (row ${target.treasuryRowId})`);
    console.log(`   threshold for ${CHAIN}: ${thresholdFor(CHAIN)}\n`);

    console.log('2. Can the admin actually send?');
    const currency = await prisma.currency.findFirst({ where: { ISO: CURRENCY_ISO, chain: CHAIN } })
        ?? await prisma.currency.findFirst({ where: { ISO: CURRENCY_ISO } });
    if (!currency) { console.error(`❌ No Currency record for ${CURRENCY_ISO}`); process.exit(1); }

    // The exact lookup blockchain_Transfer does. Without this row it returns
    // undefined WITHOUT throwing, which is the silent failure the handler now
    // catches, but better to know before sending.
    const wallet = await prisma.wallet.findFirst({ where: { userId: config.Admin_Id, currencyId: currency.id } });
    if (!wallet) {
        console.error(`❌ The admin has no Wallet row for ${CURRENCY_ISO} (${currency.id}).`);
        console.error('   blockchain_Transfer would return undefined and send nothing.');
        process.exit(1);
    }
    if (!wallet.depositAddress) {
        console.error(`❌ Wallet ${wallet.id} has no depositAddress; the transfer would throw.`);
        process.exit(1);
    }
    // The spendable balance lives on the VirtualAccount sharing the wallet's id.
    const account = await prisma.virtualAccount.findUnique({ where: { id: wallet.id } });
    console.log(`   wallet ${wallet.id}, deposit address ${wallet.depositAddress}`);
    console.log(`   VirtualAccount.available: ${account?.available ?? 'no matching account'}`);
    console.log(`   (the send also takes a withdrawal fee on top of ${AMOUNT})\n`);

    if (account && Number(account.available) < Number(AMOUNT) + FEE_HEADROOM) {
        console.error(`❌ Only ${account.available} available, need ${AMOUNT} plus the fee (about ${Number(AMOUNT) + FEE_HEADROOM}).`);
        process.exit(1);
    }

    // The step AFTER the send. Checked BEFORE it, because this is the one
    // failure that cannot be undone by re-running: if the USD treasury has no
    // internal-transfer payee, the crypto still leaves the chain and arrives at
    // Nuvion, the deposit still matches, and then handleTreasuryConversion
    // refuses — leaving real money sitting in the stablecoin account waiting for
    // a payee that was never set up. Cheap to check, expensive to discover.
    console.log('3. Can the deposit be converted once it lands?');
    const usdTreasury: any = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency: 'USD', isActive: true } });
    if (!usdTreasury) {
        console.error('❌ No active USD treasury row, so there is nothing to convert into.');
        process.exit(1);
    }
    if (!usdTreasury.conversionCounterpartyId || !usdTreasury.conversionPaymentDetailId) {
        console.error('❌ The USD treasury has no internal-transfer payee set up.');
        console.error(`   conversionCounterpartyId:   ${usdTreasury.conversionCounterpartyId ?? 'NOT SET'}`);
        console.error(`   conversionPaymentDetailId:  ${usdTreasury.conversionPaymentDetailId ?? 'NOT SET'}`);
        console.error('');
        console.error('   Without both, the crypto would be sent and arrive, and the conversion');
        console.error('   would then refuse — real money stuck in the stablecoin account.');
        console.error('   Run create-usd-book-payment-detail.ts then set-usd-conversion-payee.ts first.');
        process.exit(1);
    }
    console.log(`   ✅ counterparty ${usdTreasury.conversionCounterpartyId}`);
    console.log(`   ✅ payment detail ${usdTreasury.conversionPaymentDetailId}`);
    console.log(`   into USD treasury row ${usdTreasury.id}\n`);

    // The deposit matcher finds the waiting row by the currency Nuvion reports,
    // so a mismatch here means a successful send whose deposit never matches.
    const nuvionCurrency = CURRENCY_ISO === 'USDC' ? 'USC' : 'UST';
    const stablecoinRow: any = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: target.treasuryRowId } });
    if (stablecoinRow?.currency && stablecoinRow.currency !== nuvionCurrency) {
        console.log(`   ⚠️  This script will record nuvionCurrency "${nuvionCurrency}", but the treasury row`);
        console.log(`      says "${stablecoinRow.currency}". If Nuvion reports the row's value, the deposit`);
        console.log('      will not match and the row will sit at SUBMITTED. Worth settling first.\n');
    }

    console.log('4. What it will do');
    console.log(`   send ${AMOUNT} ${CURRENCY_ISO} on ${CHAIN}`);
    console.log(`   from the admin account (${config.Admin_Id})`);
    console.log(`   to   ${target.address}`);
    console.log(`   tracked as replenishment ${transferRequestId}\n`);

    if (!CONFIRMED) {
        console.log('Nothing done. This moves REAL CRYPTO and cannot be undone.');
        console.log('Add --confirm to send.');
        return;
    }

    console.log('5. Creating the tracking row...');
    const job = {
        transferRequestId,
        replenishUserId: config.Admin_Id,
        replenishCurrencyId: currency.id,
        treasuryAccountId: target.treasuryRowId,
        usdTreasuryAccountId: usdTreasury.id,
        treasuryWalletAddress: target.address,
        amount: AMOUNT,
        nuvionCurrency,
    };

    await prisma.treasuryReplenishment.create({
        data: {
            transferRequestId,
            cryptoCurrencyId: currency.id,
            usdTreasuryAccountId: job.usdTreasuryAccountId,
            status: 'PENDING',
            statusUpdatedAt: new Date(),
            payload: job as any,
            amount: AMOUNT,
            nuvionCurrency: job.nuvionCurrency,
        },
    });
    console.log('   ✅ created\n');

    console.log('6. Sending (this is the real thing)...');
    await handleTreasuryReplenishment(job);

    const row = await prisma.treasuryReplenishment.findUnique({ where: { transferRequestId } });
    console.log('');
    console.log(`   status:  ${row?.status}`);
    console.log(`   txRef:   ${row?.txRef ?? 'NONE'}`);
    console.log(`   note:    ${row?.note ?? '-'}\n`);

    if (row?.status === 'SUBMITTED') {
        console.log('✅ The send went through.');
        if (row.txRef) {
            console.log(`   Hash recorded: ${row.txRef}`);
            console.log('   Deposit matching will be exact.');
        } else {
            console.log('   ⚠️  No hash returned, so the deposit will have to be matched by amount.');
            console.log('      Workable, but less precise. Worth knowing what blockchain_Transfer returns.');
        }
    } else if (row?.status === 'FAILED') {
        console.log('❌ Refused before sending. Nothing moved.');
        console.log('   If the note mentions a minimum, raise AMOUNT and the chain threshold.');
        return;
    } else if (row?.status === 'MANUAL_REVIEW') {
        console.log('⚠️  The outcome is unknown: it may or may not have gone out.');
        console.log('   Check the chain before doing anything else. Do NOT run this again.');
        return;
    }

    console.log('\n7. Now watch for the deposit.');
    console.log('   Nuvion will send inflows.completed when the crypto lands. If the event');
    console.log('   handler is wired, the deposit is matched and the conversion runs on its own.');
    console.log(`   Watch: SUBMITTED → DEPOSITED → CONVERTED on ${transferRequestId}\n`);

    for (let i = 1; i <= 20; i++) {
        await sleep(15000);
        const r = await prisma.treasuryReplenishment.findUnique({ where: { transferRequestId } });
        console.log(`   ${i * 15}s: ${r?.status}${r?.depositedAmount ? ` (deposited ${r.depositedAmount})` : ''}${r?.note ? ` — ${r.note}` : ''}`);
        if (r?.status === 'CONVERTED') {
            console.log('\n✅ End to end. Sent, deposited, converted. The USD treasury is whole.');
            return;
        }
        if (['FAILED', 'CONVERT_FAILED', 'CONVERT_UNVERIFIED', 'MANUAL_REVIEW'].includes(r?.status ?? '')) {
            console.log(`\n⚠️  Stopped at ${r?.status}. See the note above and the ops alerts.`);
            return;
        }
    }

    console.log('\n⚠️  Still not converted after 5 minutes.');
    console.log('   The crypto may still be confirming on-chain. Check the row again later,');
    console.log('   and check whether inflows.completed arrived at all.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });