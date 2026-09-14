// scripts/diagnose-quote-error.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/diagnose-quote-error.ts

import prisma from '../config/prisma.client';
import { ensureNuvionCounterpartyAndPaymentDetail } from '../services/nuvionpayout.service';

const BENEFICIARY_ID = 'cmtvk6jyu0000h2sb9kiandus';
const PAYMENT_DETAIL_ID = 'cmtweydx10000x8sbb3zkwv5a';

async function main() {
    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: BENEFICIARY_ID } });
    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: PAYMENT_DETAIL_ID } });

    if (!beneficiary || !paymentMethod) {
        console.error('❌ Beneficiary or payment method not found.');
        process.exit(1);
    }

    console.log('Calling the REAL, shared ensureNuvionCounterpartyAndPaymentDetail directly...\n');

    try {
        const result = await ensureNuvionCounterpartyAndPaymentDetail(beneficiary, paymentMethod);
        console.log('✅ Success:', result);
    } catch (err: any) {
        console.error('❌ Failed:', err.message);
        // The fix from last message attaches rawData to thrown errors now
        // — this should show the real validations array if it still fails.
        if (err.rawData) {
            console.error('\nFull Nuvion validation detail:');
            console.error(JSON.stringify(err.rawData, null, 2));
        }
    }
}

main()
    .catch((err) => console.error('Script crashed:', err))
    .finally(async () => { await prisma.$disconnect(); });