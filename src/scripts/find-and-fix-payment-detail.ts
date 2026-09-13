// scripts/find-and-fix-payment-detail.ts — corrected Step 2 only

import prisma from '../config/prisma.client';
import { listCounterpartyPaymentDetails, updatePaymentDetail } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';
const LOCAL_PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';
const ACCOUNT_NUMBER = '8312040762';

async function main() {
    console.log('Step 1: Listing payment details for this counterparty...');
    const listResult = await listCounterpartyPaymentDetails(COUNTERPARTY_ID);

    if (!listResult.success || !listResult.paymentDetails) {
        console.error('❌ Failed to list payment details:', listResult.error);
        process.exit(1);
    }

    const match = listResult.paymentDetails.find(pd => pd.account_number === ACCOUNT_NUMBER);
    if (!match) {
        console.error(`❌ No match for account number ${ACCOUNT_NUMBER}.`);
        process.exit(1);
    }

    console.log(`✅ Found the real payment detail: ${match.id}\n`);

    console.log('Step 2: Patching it with bank_address...');
    const updateResult = await updatePaymentDetail(match.id, {
        counterparty_id: COUNTERPARTY_ID, // NEW — required even on PATCH, undocumented but confirmed via the real 422
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            country: 'US',
        },
    });

    if (!updateResult.success) {
        console.error('❌ Update failed:', updateResult.error);
        console.error(JSON.stringify(updateResult.rawData, null, 2));
        process.exit(1);
    }
    console.log('✅ Nuvion payment detail updated with bank_address.\n');

    console.log('Step 3: Restoring nuvionPaymentDetailId locally...');
    await prisma.beneficiaryPaymentDetail.update({
        where: { id: LOCAL_PAYMENT_DETAIL_ID },
        data: { nuvionPaymentDetailId: match.id },
    });
    console.log(`✅ Restored — nuvionPaymentDetailId set to ${match.id}.`);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });