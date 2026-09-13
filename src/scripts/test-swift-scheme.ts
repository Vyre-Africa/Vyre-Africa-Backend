// scripts/test-swift-scheme.ts

import prisma from '../config/prisma.client';
import { updatePaymentDetail, initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M25W2RN7ZEATTAJ2SMSSY5VK';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 1; // reduced from 10 — this is a real-money attempt if the hypothesis is right

async function main() {
    console.log('Step 1: Patching payment detail with explicit scheme: "swift"...');
    const updateResult = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        scheme: 'swift',
    });

    if (!updateResult.success) {
        console.error('❌ Update failed:', JSON.stringify(updateResult.rawData, null, 2));
        process.exit(1);
    }
    console.log('✅ Scheme updated.\n');

    console.log(`Step 2: Retrying the transfer with $${TEST_AMOUNT}...`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: 'SWIFT scheme hypothesis test',
        payment_type: 'bank-transfer',
        unique_reference: `SWIFT-TEST-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log('\n✅ HYPOTHESIS CONFIRMED — explicit scheme: "swift" was the missing piece.');
        console.log('   ⚠️  This was a REAL transfer, not tracked in your database — reconcile manually or run the full flow next for a properly recorded transaction.');
    } else {
        console.log('\n⚠️  Still failing — see the error above for the next real clue.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });