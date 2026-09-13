// scripts/test-country-variants.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-country-variants.ts
//
// Tests three variants in sequence. Stops at the first success. Each
// attempt is a REAL $1 transfer if it succeeds — not a safe dry run.

import prisma from '../config/prisma.client';
import { updatePaymentDetail, initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M25W2RN7ZEATTAJ2SMSSY5VK';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 1;

async function attemptTransfer(label: string) {
    console.log(`\n--- Attempting transfer (${label}) ---`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: `Country variant test — ${label}`,
        payment_type: 'bank-transfer',
        unique_reference: `COUNTRY-TEST-${label.replace(/\s/g, '')}-${Date.now()}`,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.success;
}

async function main() {
    // ── Variant 1: bank_address without country ──
    console.log('=== Variant 1: bank_address omitting country ===');
    const v1Update = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            // country omitted entirely
        },
    });
    console.log('Update result:', JSON.stringify(v1Update.rawData ?? v1Update, null, 2));

    if (v1Update.success && await attemptTransfer('bank_address no country')) {
        console.log('\n✅ VARIANT 1 WORKED — omitting country from bank_address was the fix.');
        return;
    }

    // ── Variant 2: bank_address.country as empty string ──
    console.log('\n=== Variant 2: bank_address.country as empty string ===');
    const v2Update = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            country: '',
        },
    });
    console.log('Update result:', JSON.stringify(v2Update.rawData ?? v2Update, null, 2));

    if (v2Update.success && await attemptTransfer('empty string country')) {
        console.log('\n✅ VARIANT 2 WORKED — empty string for bank_address.country was the fix.');
        return;
    }

    // ── Variant 3: top-level country changed to match the bank (US) ──
    console.log('\n=== Variant 3: top-level payment detail country set to US ===');
    const v3Update = await updatePaymentDetail(PAYMENT_DETAIL_ID, {
        counterparty_id: COUNTERPARTY_ID,
        country: 'US',
    } as any);
    console.log('Update result:', JSON.stringify(v3Update.rawData ?? v3Update, null, 2));

    if (v3Update.success && await attemptTransfer('top-level country US')) {
        console.log('\n✅ VARIANT 3 WORKED — changing the top-level country field was the fix.');
        return;
    }

    console.log('\n⚠️  None of the three variants worked. This payment detail is likely genuinely');
    console.log('   stuck until Nuvion either fixes the "US not supported yet" limitation or');
    console.log('   support intervenes to clear/delete this specific record.');
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });