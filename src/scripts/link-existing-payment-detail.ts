// scripts/link-existing-payment-detail.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/link-existing-payment-detail.ts

import prisma from '../config/prisma.client';

const LOCAL_PAYMENT_DETAIL_ID = 'cmtweydx10000x8sbb3zkwv5a';
const REAL_NUVION_PAYMENT_DETAIL_ID = '01M27A3Q2SF6KM2X84P97MH31K'; // from the earlier successful off-ledger GBP test

async function main() {
    const updated = await prisma.beneficiaryPaymentDetail.update({
        where: { id: LOCAL_PAYMENT_DETAIL_ID },
        data: { nuvionPaymentDetailId: REAL_NUVION_PAYMENT_DETAIL_ID },
    });

    console.log('✅ Linked:', {
        id: updated.id,
        nuvionPaymentDetailId: updated.nuvionPaymentDetailId,
    });
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });