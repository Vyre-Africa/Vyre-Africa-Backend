// scripts/test-transfer-validation.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-transfer-validation.ts

import prisma from '../config/prisma.client';
import { initiateSameCurrencyTransfer } from '../services/nuvion.service';

const BENEFICIARY_ID = 'cmtvk6jyu0000h2sb9kiandus';
const PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';
const TREASURY_ACCOUNT_ID = 'cmtqwo1n80000z5sbx79otsxc'; // the USD treasury's internal id

async function main() {
    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: BENEFICIARY_ID } });
    const paymentDetail = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: PAYMENT_DETAIL_ID } });
    const treasury = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: TREASURY_ACCOUNT_ID } });

    console.log('Counterparty ID:', beneficiary?.nuvionCounterpartyId);
    console.log('Payment Detail ID:', paymentDetail?.nuvionPaymentDetailId);
    console.log('Treasury Nuvion Account ID:', treasury?.nuvionAccountId, '\n');

    if (!beneficiary?.nuvionCounterpartyId || !paymentDetail?.nuvionPaymentDetailId || !treasury?.nuvionAccountId) {
        console.error('❌ Missing one of the required real Nuvion IDs — check the records above.');
        process.exit(1);
    }

    const result = await initiateSameCurrencyTransfer({
        account_id: treasury.nuvionAccountId,
        payment_detail_id: paymentDetail.nuvionPaymentDetailId,
        counterparty_id: beneficiary.nuvionCounterpartyId,
        amount: 10,
        currency: 'USD',
        narration: 'Validation debug test',
        payment_type: 'bank-transfer',
        unique_reference: `DEBUG-${Date.now()}`,
    });

    console.log('=== Full result ===');
    console.log(JSON.stringify(result, null, 2));
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });