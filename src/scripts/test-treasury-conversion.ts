// scripts/test-treasury-conversion.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/test-treasury-conversion.ts
//
// THIS MOVES REAL MONEY inside Nuvion: AMOUNT of the stablecoin treasury is
// converted into the USD treasury. Start with 5.
//
// This is the last step of a crypto-sourced payout. The USD treasury pays the
// recipient, the user's stablecoin is sent to the Nuvion stablecoin wallet, and
// then this converts it into USD so the USD treasury is whole again.
//
// It answers three things the design depends on:
//   1. does the cross-currency book transfer work at all
//   2. does the SAME unique_reference return the ORIGINAL transfer, which is
//      what makes a retry safe
//   3. does the money actually land, and is getAccount's balance in dollars or
//      cents (the quote and transfer calls convert to cents, getAccount does not)

import prisma from '../config/prisma.client';
import {
    getAccount,
    createFxQuote,
    initiateCrossCurrencyTransfer,
    getTransferStatus,
} from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M4DR3EAFPNRZRC2Z85SFGM36';

// In dollars. Nuvion rejects anything under 1.00.
const AMOUNT = 5;

// Nuvion's code for the stablecoin being converted: USC (USDC) or UST (USDT).
const FROM_CURRENCY = 'USC';

// The Nuvion account ids. Set either one to use it directly; leave it blank and
// the script looks the row up in NuvionTreasuryAccount.
// The stablecoin one below is the account your own inflows.completed webhook
// credited: display_name "Master-Base", network base. There is no row for it in
// the database yet, which is why the lookup found nothing.
const STABLECOIN_ACCOUNT_ID = '01M0T7QZHBRAMKY93TC38Y3EJS';
const USD_ACCOUNT_ID = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function balances(stableId: string, usdId: string, label: string) {
    const [s, u] = await Promise.all([getAccount(stableId), getAccount(usdId)]);
    console.log(`   ${label}  ${FROM_CURRENCY}: ${s.balance?.available ?? '?'}   USD: ${u.balance?.available ?? '?'}`);
    return { stable: Number(s.balance?.available ?? 0), usd: Number(u.balance?.available ?? 0) };
}

async function main() {
    console.log('Step 1: Finding both accounts...');

    let stableAccountId = STABLECOIN_ACCOUNT_ID;
    let usdAccountId = USD_ACCOUNT_ID;

    if (!stableAccountId || !usdAccountId) {
        const rows = await prisma.nuvionTreasuryAccount.findMany();
        if (!usdAccountId) {
            const row = rows.find((r: any) => r.currency === 'USD' && r.isActive);
            usdAccountId = row?.nuvionAccountId ?? '';
            if (row) console.log(`   USD from the database: row ${row.id}`);
        }
        if (!stableAccountId) {
            const row = rows.find((r: any) => ['USDC', 'USC', 'USDT', 'UST'].includes(r.currency) && r.isActive);
            stableAccountId = row?.nuvionAccountId ?? '';
            if (row) console.log(`   stablecoin from the database: row ${row.id}`);
        }
        if (!stableAccountId || !usdAccountId) {
            console.error(`❌ Could not find an account. stablecoin: ${stableAccountId || 'none'}, USD: ${usdAccountId || 'none'}`);
            console.log('\n   Every NuvionTreasuryAccount row:');
            console.table(rows.map((r: any) => ({ id: r.id, currency: r.currency, chain: r.chain, isActive: r.isActive, nuvionAccountId: r.nuvionAccountId })));
            console.log('   Set STABLECOIN_ACCOUNT_ID / USD_ACCOUNT_ID at the top of this script to go ahead anyway.');
            process.exit(1);
        }
    }

    console.log(`✅ stablecoin Nuvion account ${stableAccountId}`);
    console.log(`✅ USD        Nuvion account ${usdAccountId}\n`);

    console.log('Step 2: Balances before (exactly as getAccount returns them)...');
    const before = await balances(stableAccountId, usdAccountId, 'before:');
    console.log('   If the dashboard shows 12.50 and this shows 1250, getAccount is returning CENTS.\n');

    if (before.stable < AMOUNT) {
        console.error(`❌ The stablecoin account shows ${before.stable}, less than the ${AMOUNT} to convert.`);
        process.exit(1);
    }

    console.log(`Step 3: Quoting ${AMOUNT} ${FROM_CURRENCY} → USD...`);
    const quote = await createFxQuote({
        from_currency: FROM_CURRENCY,
        to_currency: 'USD',
        amount_from: AMOUNT,
        account_id: stableAccountId,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
    });
    if (!quote.success || !quote.id) {
        console.error('❌ Quote failed:', quote.error);
        console.error(JSON.stringify(quote.rawData, null, 2));
        process.exit(1);
    }
    console.log(`✅ Quote ${quote.id}, rate ${quote.rate}, gives ${(quote as any).amount_to} USD\n`);

    const reference = `TEST-CONV-${Date.now()}`;
    console.log(`Step 4: Transferring (reference ${reference})...`);
    const transfer = await initiateCrossCurrencyTransfer({
        account_id: stableAccountId,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        fx_quote_id: quote.id,
        narration: 'Treasury replenishment test',
        payment_type: 'book-transfer',
        unique_reference: reference,
    });
    if (!transfer.success) {
        console.error('❌ Transfer failed:', transfer.error);
        console.error(JSON.stringify(transfer.rawData, null, 2));
        process.exit(1);
    }
    console.log(`✅ Transfer ${transfer.id}, status ${transfer.status}, fee ${transfer.applicable_fee}\n`);

    console.log('Step 5: Sending the SAME reference again, as a retry would...');
    const again = await createFxQuote({
        from_currency: FROM_CURRENCY,
        to_currency: 'USD',
        amount_from: AMOUNT,
        account_id: stableAccountId,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
    });
    const repeat = await initiateCrossCurrencyTransfer({
        account_id: stableAccountId,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        fx_quote_id: again.success && again.id ? again.id : quote.id,
        narration: 'Treasury replenishment test',
        payment_type: 'book-transfer',
        unique_reference: reference,
    });
    if (repeat.success && repeat.id === transfer.id) {
        console.log(`✅ Returned the ORIGINAL transfer (${repeat.id}). Retrying is safe.\n`);
    } else if (repeat.success) {
        console.log(`🔴 Created a SECOND transfer (${repeat.id}). A retry would convert twice. DO NOT enable auto-replenish.\n`);
    } else {
        console.log(`⚠️  Rejected the repeat: ${repeat.error}`);
        console.log('   No money at risk, but a conversion that succeeds without being recorded would look like a failure on retry.\n');
    }

    console.log('Step 6: Watching the transfer...');
    let status = transfer.status;
    for (let i = 0; i < 10 && !['successful', 'completed', 'failed', 'reversed'].includes(String(status)); i++) {
        await sleep(3000);
        const s = await getTransferStatus(transfer.id!);
        status = s.status;
        console.log(`   ${(i + 1) * 3}s: ${status ?? s.error}`);
    }
    console.log(`   Final: ${status}\n`);

    console.log('Step 7: Balances after...');
    await sleep(3000);
    const after = await balances(stableAccountId, usdAccountId, 'after: ');
    const spent = before.stable - after.stable;
    const gained = after.usd - before.usd;
    console.log(`   ${FROM_CURRENCY} down by ${spent}, USD up by ${gained}\n`);

    if (spent >= AMOUNT * 100 * 0.98) {
        console.log(`🔴 The account fell by about ${AMOUNT * 100}, so getAccount returns CENTS.`);
        console.log('   Every lastKnownAvailable written from it is 100x too big. Divide by 100 inside getAccount.');
    } else if (spent >= AMOUNT * 0.98 && spent <= AMOUNT * 1.5) {
        console.log('✅ getAccount returns dollars, and the account was debited once.');
    } else if (spent >= AMOUNT * 1.9) {
        console.log(`🔴 The account fell by about ${spent}, roughly twice the ${AMOUNT} converted. It looks debited TWICE.`);
    } else if (spent === 0) {
        console.log('⚠️  Nothing moved yet. It may settle later. Check the Nuvion dashboard.');
    }
    if (gained > 0) console.log('✅ The USD treasury went up, so the conversion lands where it should.');
    else console.log('⚠️  The USD treasury has not gone up yet. Check it in the dashboard before trusting this.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });