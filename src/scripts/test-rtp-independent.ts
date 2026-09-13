// scripts/test-rtp-independent.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-rtp-independent.ts
//
// Real $1 transfer if this succeeds. Uses the NEW, independent RTP
// payment detail — does not touch the existing Wire one at all.

import prisma from '../config/prisma.client';
import { initiateSameCurrencyTransfer } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const RTP_PAYMENT_DETAIL_ID = '01M26KE1J02V59PXKWEHF6E1N7'; // the new, independent one
const TREASURY_NUVION_ACCOUNT_ID = '01M1W086TX52RXWD4RKVQA34DX';
const TEST_AMOUNT = 2;

async function main() {
    console.log(`Attempting RTP transfer with $${TEST_AMOUNT}...`);
    const result = await initiateSameCurrencyTransfer({
        account_id: TREASURY_NUVION_ACCOUNT_ID,
        payment_detail_id: RTP_PAYMENT_DETAIL_ID,
        counterparty_id: COUNTERPARTY_ID,
        amount: TEST_AMOUNT,
        currency: 'USD',
        narration: 'RTP independent test',
        payment_type: 'bank-transfer',
        unique_reference: `RTP-INDEP-${Date.now()}`,
    });

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log(`\n✅ RTP ACCEPTED — watch for outflows.completed on transfer ${(result as any).id}.`);
        console.log('   If this bank genuinely supports RTP, this should settle within seconds, not hours.');
        console.log('   ⚠️  Real transfer, not tracked in your database.');
    } else {
        console.log('\n⚠️  RTP rejected — likely this bank doesn\'t support the network. Wire remains confirmed working.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });