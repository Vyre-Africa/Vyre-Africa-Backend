// scripts/fix-payment-detail-address.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/fix-payment-detail-address.ts

import prisma from '../config/prisma.client';

const PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';

async function main() {
    const updated = await prisma.beneficiaryPaymentDetail.update({
        where: { id: PAYMENT_DETAIL_ID },
        data: {
            bankAddressLine1: '89-16 Jamaica Ave',
            bankAddressCity: 'Woodhaven',
            bankAddressState: 'NY',
            bankAddressPostal: '11421',
            bankAddressCountry: 'US',
            nuvionPaymentDetailId: null, // clears the incomplete one — forces fresh creation with the address included
        },
    });

    console.log('✅ Updated:', {
        bankAddressLine1: updated.bankAddressLine1,
        bankAddressCity: updated.bankAddressCity,
        bankAddressState: updated.bankAddressState,
        bankAddressPostal: updated.bankAddressPostal,
        bankAddressCountry: updated.bankAddressCountry,
        nuvionPaymentDetailId: updated.nuvionPaymentDetailId,
    });
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });