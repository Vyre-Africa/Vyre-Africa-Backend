// scripts/test-wire-us-country.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-wire-us-country.ts
//
// Real $1 transfer if this succeeds — not a safe dry run.

import prisma from '../config/prisma.client';
import { updatePaymentDetail, initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M25W2RN7ZEATTAJ2SMSSY5VK';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 1;

async function main() {
    console.log('Step 1: Setting bank_address.country to a FRESH "US" under Wire scheme...');
    const updateResult = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        scheme: 'wire',
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            country: 'US',
        },
    });

    console.log('Update result:', JSON.stringify(updateResult.rawData ?? updateResult, null, 2));

    if (!updateResult.success) {
        console.error('❌ Update failed — see the error above.');
        process.exit(1);
    }
    console.log('✅ Updated.\n');

    console.log(`Step 2: Attempting the transfer with $${TEST_AMOUNT}...`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: 'Wire + US country test',
        payment_type: 'bank-transfer',
        unique_reference: `WIRE-US-TEST-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log('\n✅ WORKED — Wire genuinely does accept US bank_address.country. The earlier');
        console.log('   rejection was scoped specifically to SWIFT, not a platform-wide limitation.');
        console.log('   ⚠️  This was a REAL transfer, not tracked in your database.');
    } else {
        console.log('\n⚠️  Still failing — this now genuinely confirms the limitation is platform-wide,');
        console.log('   not scheme-specific. Time to escalate to Nuvion support and move to GBP/FPS.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });