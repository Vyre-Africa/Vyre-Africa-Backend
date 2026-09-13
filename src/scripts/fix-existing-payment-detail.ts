// scripts/fix-existing-payment-detail.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/fix-existing-payment-detail.ts

import prisma from '../config/prisma.client';
import { updatePaymentDetail } from '../services/nuvion.service';

const LOCAL_PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';
const ORIGINAL_NUVION_PAYMENT_DETAIL_ID = 'REPLACE_WITH_THE_ORIGINAL_ID'; // ⚠️ from the first run's logs or Nuvion's dashboard

async function main() {
    if (ORIGINAL_NUVION_PAYMENT_DETAIL_ID.startsWith('REPLACE')) {
        console.error('❌ Fill in the real original Nuvion payment detail ID first.');
        process.exit(1);
    }

    console.log('Step 1: Patching the existing payment detail on Nuvion with bank_address...');
    const result = await updatePaymentDetail(ORIGINAL_NUVION_PAYMENT_DETAIL_ID, {
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            country: 'US',
        },
    });

    if (!result.success) {
        console.error('❌ Update failed:', result.error);
        console.error(JSON.stringify(result.rawData, null, 2));
        process.exit(1);
    }
    console.log('✅ Nuvion payment detail updated:', JSON.stringify(result, null, 2));

    console.log('\nStep 2: Restoring nuvionPaymentDetailId locally...');
    await prisma.beneficiaryPaymentDetail.update({
        where: { id: LOCAL_PAYMENT_DETAIL_ID },
        data: { nuvionPaymentDetailId: ORIGINAL_NUVION_PAYMENT_DETAIL_ID },
    });
    console.log('✅ Restored — processNuvionPayoutJob will now reuse this payment detail instead of attempting to create a new one.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });