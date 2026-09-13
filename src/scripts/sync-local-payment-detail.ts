// scripts/sync-local-payment-detail.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/sync-local-payment-detail.ts

import prisma from '../config/prisma.client';

const LOCAL_PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';

async function main() {
    const updated = await prisma.beneficiaryPaymentDetail.update({
        where: { id: LOCAL_PAYMENT_DETAIL_ID },
        data: {
            scheme: 'wire', // CONFIRMED working — not SWIFT
            routingNumber: '026073150',
            accountType: 'checking',
            bankAddressCountry: 'US', // CONFIRMED must be present and correct, not empty/omitted
        },
    });

    console.log('✅ Local record synced:', {
        scheme: updated.scheme,
        routingNumber: updated.routingNumber,
        accountType: updated.accountType,
        bankAddressCountry: updated.bankAddressCountry,
    });
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });