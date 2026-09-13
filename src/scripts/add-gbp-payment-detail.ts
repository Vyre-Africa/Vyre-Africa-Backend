// scripts/add-gbp-payment-detail.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/add-gbp-payment-detail.ts

import prisma from '../config/prisma.client';

const BENEFICIARY_ID = 'cmtvk6jyu0000h2sb9kiandus'; // Obiajulu's existing beneficiary — same person, new currency

async function main() {
    const gbpPaymentDetail = await prisma.beneficiaryPaymentDetail.create({
        data: {
            beneficiaryId: BENEFICIARY_ID,
            currency: 'GBP',
            paymentMethod: 'bank-transfer',
            // scheme intentionally left unset — Nuvion's own FPS/GBP
            // example never included an explicit scheme field, unlike
            // USD which needs one to disambiguate ach/wire/rtp. GBP
            // appears to only have one bank-transfer rail.
            accountName: 'Obiajulu Ogechukwu Anayo',
            accountNumber: '43370981',
            sortCode: '041307',
            bankName: 'Clear Junction Limited',
            iban: 'GB89CLJU04130743370981', // not required by FPS, but real and worth keeping on record
        },
    });

    console.log(`✅ GBP payment detail created: ${gbpPaymentDetail.id}`);
    console.log('\nUse this for the payout test:');
    console.log(`  --paymentDetailId=${gbpPaymentDetail.id}`);
    console.log(`  --beneficiaryId=${BENEFICIARY_ID} (unchanged)`);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });