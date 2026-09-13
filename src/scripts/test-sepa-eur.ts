// scripts/test-sepa-eur.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-sepa-eur.ts
//
// swift_bic confirmed genuinely optional for this account — no longer
// needed. Reuses the payment detail already created in the no-bic test,
// no need to create a duplicate.

import { createFxQuote, initiateCrossCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const EUR_PAYMENT_DETAIL_ID = '01M29Q4JPTBJ3985RWBE5Z2396'; // already created, confirmed accepted without swift_bic
const SEND_AMOUNT_USD = 3;

async function main() {
    console.log(`Step 1: Creating FX quote (USD ${SEND_AMOUNT_USD} → EUR)...`);
    const quote = await createFxQuote({
        to_currency: 'EUR',
        from_currency: 'USD',
        amount_from: SEND_AMOUNT_USD,
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: EUR_PAYMENT_DETAIL_ID,
    });

    console.log(JSON.stringify(quote, null, 2));
    if (!quote.success || !quote.id) {
        console.error('❌ FX quote failed.');
        process.exit(1);
    }
    console.log(`\n✅ Quote: $${SEND_AMOUNT_USD} USD → €${(quote as any).amount_to} EUR at rate ${quote.rate}\n`);

    console.log('Step 2: Initiating cross-currency transfer...');
    const result = await initiateCrossCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: EUR_PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        fx_quote_id: quote.id,
        narration: 'SEPA EUR test — no swift_bic needed',
        payment_type: 'bank-transfer',
        unique_reference: `SEPA-EUR-TEST-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log(`\n✅ Accepted — watch for outflows.completed/failed on ${(result as any).id}.`);
        console.log('   Same EMI-scrutiny risk flagged earlier still applies — this reaches the');
        console.log('   same Clear Junction account that got manually rejected on FPS, just via SEPA.');
    } else {
        console.log('\n⚠️  Failed — see the error above.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err));