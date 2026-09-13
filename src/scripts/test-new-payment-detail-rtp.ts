// scripts/test-new-payment-detail-rtp.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-new-payment-detail-rtp.ts
//
// Does NOT touch the existing Wire payment detail at all — only tests
// whether Nuvion allows a second, separate payment detail record with
// the same account number under a different scheme.

import prisma from '../config/prisma.client';
import { createPaymentDetail } from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';

async function main() {
    console.log('Attempting to create a NEW payment detail (RTP scheme, same account number)...');
    const result = await createPaymentDetail({
        payment_method: 'bank-transfer',
        currency: 'USD',
        account_holder_name: 'Obiajulu Anayo',
        counterparty_id: COUNTERPARTY_ID,
        country: 'US',
        scheme: 'rtp',
        account_number: '8312040762', // same real account number as the existing Wire payment detail
        routing_number: '026073150',
        account_type: 'checking',
        bank_name: 'Community Federal Savings Bank',
        bank_address: {
            line1: '89-16 Jamaica Ave',
            city: 'Woodhaven',
            state: 'NY',
            postal_code: '11421',
            country: 'US',
        },
    } as any);

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        console.log('\n✅ Nuvion allows separate payment details with the same account number, differing only by scheme.');
        console.log(`   New payment detail ID: ${result.id} — safe to test RTP against this, independent of the Wire one.`);
    } else if (result.error?.includes('already exists') || (result.rawData?.validations ?? []).some((v: any) => Object.values(v)[0] && (Object.values(v)[0] as any).type === 'error_duplicate_resource')) {
        console.log('\n⚠️  Confirmed — duplicate account_number rejected, exactly as predicted.');
        console.log('   Testing RTP requires either mutating the existing payment detail, or waiting');
        console.log('   until the Wire transfer settles first.');
    } else {
        console.log('\n⚠️  Failed for a different reason — see the error above.');
    }
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });