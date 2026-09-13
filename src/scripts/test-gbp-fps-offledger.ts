// scripts/test-gbp-fps-offledger.ts — updated to reuse the existing
// payment detail, skipping Step 1's creation entirely.

import { createFxQuote, initiateCrossCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const GBP_PAYMENT_DETAIL_ID = '01M27A3Q2SF6KM2X84P97MH31K'; // already exists from the previous run
const SEND_AMOUNT_USD = 3;

async function main() {
    console.log(`Step 1: Creating FX quote (USD ${SEND_AMOUNT_USD} → GBP)...`);
    const quote = await createFxQuote({
        to_currency: 'GBP',
        from_currency: 'USD',
        amount_from: SEND_AMOUNT_USD, // plain dollars now — nuvion.service.ts converts internally
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: GBP_PAYMENT_DETAIL_ID,
    });

    console.log(JSON.stringify(quote, null, 2));
    if (!quote.success || !quote.id) {
        console.error('❌ FX quote failed.');
        process.exit(1);
    }
    console.log(`\n✅ Quote: $${SEND_AMOUNT_USD} USD → £${(quote as any).amount_to} GBP at rate ${quote.rate}`);
    console.log('   (both values now correctly in dollars, not cents)\n');

    console.log('Step 2: Initiating cross-currency transfer...');
    const result = await initiateCrossCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: GBP_PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        fx_quote_id: quote.id,
        narration: 'GBP FPS off-ledger test — corrected units',
        payment_type: 'bank-transfer',
        unique_reference: `GBP-FPS-FIXED-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log(`\n✅ CROSS-CURRENCY TRANSFER WORKED — watch for outflows.completed on ${(result as any).id}.`);
        console.log(`   Real fee (already in dollars): $${(result as any).applicable_fee}`);
    } else {
        console.log('\n⚠️  Failed — see the error above.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err));