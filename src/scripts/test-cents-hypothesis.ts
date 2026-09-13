// scripts/test-cents-hypothesis.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-cents-hypothesis.ts

import { createFxQuote } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const PAYMENT_DETAIL_ID = '01M27A3Q2SF6KM2X84P97MH31K'; // the GBP one just created

async function main() {
    console.log('Testing FX quote with amount_from in CENTS (300 = $3.00)...');
    const quote = await createFxQuote({
        to_currency: 'GBP',
        from_currency: 'USD',
        amount_from: 300, // $3.00 in cents, not 3
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        counterparty_id: COUNTERPARTY_ID,
        payment_detail_id: PAYMENT_DETAIL_ID,
    });

    console.log(JSON.stringify(quote, null, 2));

    if (quote.success) {
        console.log('\n✅ CONFIRMED — amount_from is in smallest currency unit (cents).');
        console.log(`   Quote: $3.00 USD → £${(quote as any).amount_to / 100} GBP at rate ${quote.rate}`);
        console.log('\n⚠️  This strongly implies /transfers\' amount field uses the SAME convention.');
        console.log('   Every prior "real" transfer test (Wire, ACH) may have actually moved');
        console.log('   1/100th of the intended amount. Worth checking Nuvion\'s dashboard directly');
        console.log('   for the ACTUAL amounts of those past transfers before assuming otherwise.');
    } else {
        console.log('\n⚠️  Still failed — the hypothesis may be wrong, or there\'s a different issue. See error above.');
    }
}

main().catch((err) => console.error('Raw crash:', err));