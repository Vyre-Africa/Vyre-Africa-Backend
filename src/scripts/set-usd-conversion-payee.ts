// scripts/set-usd-conversion-payee.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/set-usd-conversion-payee.ts
//
// Saves the book-transfer payee onto the USD treasury row, so the conversion
// knows where to pay. Run it AFTER the migration that adds
// conversionCounterpartyId and conversionPaymentDetailId.
//
// The ids below are the ones create-usd-book-payment-detail.ts printed.
// Safe to run again.

import prisma from '../config/prisma.client';
import { listCounterpartyPaymentDetails } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const PAYMENT_DETAIL_ID = '01M4DR3EAFPNRZRC2Z85SFGM36';

async function main() {
    console.log('Step 1: Checking the payment detail still exists at Nuvion...');
    const list = await listCounterpartyPaymentDetails(COUNTERPARTY_ID);
    if (!list.success) {
        console.error('❌ Failed to list payment details:', list.error);
        process.exit(1);
    }
    const match = list.paymentDetails?.find((pd: any) => pd.id === PAYMENT_DETAIL_ID);
    if (!match) {
        console.error(`❌ Nuvion does not list ${PAYMENT_DETAIL_ID} under counterparty ${COUNTERPARTY_ID}.`);
        console.error('   Re-run create-usd-book-payment-detail.ts and use the id it prints.');
        process.exit(1);
    }
    console.log(`✅ ${PAYMENT_DETAIL_ID} — ${match.payment_method ?? '?'}, account ${match.account_number ?? '?'}\n`);

    console.log('Step 2: Finding the USD treasury...');
    const treasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: 'USD', isActive: true },
    });
    if (!treasury) {
        console.error('❌ No active USD NuvionTreasuryAccount row found.');
        process.exit(1);
    }
    console.log(`✅ ${treasury.id}, Nuvion account ${treasury.nuvionAccountId}\n`);

    console.log('Step 3: Saving the payee on that row...');
    const updated = await prisma.nuvionTreasuryAccount.update({
        where: { id: treasury.id },
        data: {
            conversionCounterpartyId: COUNTERPARTY_ID,
            conversionPaymentDetailId: PAYMENT_DETAIL_ID,
        },
    });
    console.log('✅ Saved:');
    console.log(`   conversionCounterpartyId:  ${updated.conversionCounterpartyId}`);
    console.log(`   conversionPaymentDetailId: ${updated.conversionPaymentDetailId}`);
    console.log('\nNext: test-replenishment-send.ts (no --confirm) — its step 3 reads these two');
    console.log('columns, so a clean dry run confirms this worked.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });