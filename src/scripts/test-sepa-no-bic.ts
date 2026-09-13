// scripts/test-sepa-no-bic.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-sepa-no-bic.ts
//
// Safe — only creates a payment detail, no transfer attempted. This
// purely tests whether swift_bic is genuinely optional for this
// GB-registered SEPA account, or whether Nuvion still requires it.

import { createPaymentDetail } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';

async function main() {
    console.log('Testing SEPA/EUR payment detail creation WITHOUT swift_bic...');
    const paymentDetail = await createPaymentDetail({
        payment_method: 'bank-transfer',
        currency: 'EUR',
        account_holder_name: 'Obiajulu Ogechukwu Anayo',
        counterparty_id: COUNTERPARTY_ID,
        country: 'GB',
        iban: 'GB89CLJU04130743370981',
        bank_name: 'Clear Junction Limited',
        // swift_bic deliberately OMITTED — testing whether it's genuinely optional
    } as any);

    console.log(JSON.stringify(paymentDetail, null, 2));

    if (paymentDetail.success) {
        console.log(`\n✅ ACCEPTED — swift_bic is genuinely optional for this account.`);
        console.log(`   Payment detail ID: ${paymentDetail.id}`);
        console.log('   Safe to proceed to a real FX quote + transfer using this ID.');
    } else {
        console.log('\n⚠️  REJECTED — swift_bic is still required here.');
        console.log('   The GB registration likely still counts as "non-European" for this rule,');
        console.log('   regardless of SEPA being a European scheme. Still need the confirmed BIC.');
    }
}

main().catch((err) => console.error('Raw crash:', err));