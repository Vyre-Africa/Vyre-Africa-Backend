// scripts/test-remove-bank-address.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-remove-bank-address.ts

import prisma from '../config/prisma.client';
import { updatePaymentDetail, initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M25W2RN7ZEATTAJ2SMSSY5VK';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 1;

async function main() {
    console.log('Step 1: Attempting to clear bank_address (setting it to null)...');
    const updateResult = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        bank_address: null,
    });

    if (!updateResult.success) {
        console.error('❌ Update failed:', JSON.stringify(updateResult.rawData, null, 2));
        console.log('\n💡 If this failed specifically because null isn\'t accepted, Nuvion may not support unsetting a field via PATCH at all — that would mean this specific payment detail is permanently stuck with bank_address attached, and a genuinely fresh payment detail (under a different account_number, or after support clears this one) would be the only way forward.');
        process.exit(1);
    }
    console.log('✅ Update accepted:', JSON.stringify(updateResult.rawData, null, 2), '\n');

    console.log(`Step 2: Retrying the transfer with $${TEST_AMOUNT}...`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: 'Remove bank_address hypothesis test',
        payment_type: 'bank-transfer',
        unique_reference: `NOADDR-TEST-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log('\n✅ HYPOTHESIS CONFIRMED — removing bank_address (now that scheme is correctly "swift") was the fix.');
        console.log('   ⚠️  This was a REAL transfer, not tracked in your database.');
    } else {
        console.log('\n⚠️  Still failing — see the error above.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });