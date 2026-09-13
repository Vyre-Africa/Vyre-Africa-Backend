// scripts/test-wire-scheme.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-wire-scheme.ts
//
// Real $1 transfer if this succeeds — not a safe dry run.

import prisma from '../config/prisma.client';
import { updatePaymentDetail, initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M25W2RN7ZEATTAJ2SMSSY5VK';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 1;

async function main() {
    console.log('Step 1: Patching payment detail to Wire scheme, with routing_number and account_type...');
    const updateResult = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        scheme: 'wire',
        routing_number: '026073150', // real, from the original Wise details
        account_type: 'checking', // real — confirmed "Account type: Checking" on the Wise details
    } as any);

    console.log('Update result:', JSON.stringify(updateResult.rawData ?? updateResult, null, 2));

    if (!updateResult.success) {
        console.error('❌ Update failed — see the error above.');
        process.exit(1);
    }
    console.log('✅ Scheme updated to Wire.\n');

    console.log(`Step 2: Attempting the transfer with $${TEST_AMOUNT}...`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: 'Wire scheme test',
        payment_type: 'bank-transfer',
        unique_reference: `WIRE-TEST-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log('\n✅ WIRE WORKED — this was the correct rail for a US bank all along.');
        console.log('   ⚠️  This was a REAL transfer, not tracked in your database.');
    } else {
        console.log('\n⚠️  Still failing — see the error above for the next real clue.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });