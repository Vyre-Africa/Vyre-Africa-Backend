// scripts/test-payment-detail-validation.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-payment-detail-validation.ts

import prisma from '../config/prisma.client';
import { createPaymentDetail } from '../services/nuvion.service';

const BENEFICIARY_ID = 'cmtvk6jyu0000h2sb9kiandus';
const PAYMENT_DETAIL_ID = 'cmtvk6lyb0001h2sb9x8n9ngu';

async function main() {
    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: BENEFICIARY_ID } });
    const paymentMethod = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: PAYMENT_DETAIL_ID } });

    console.log('Counterparty ID (reused):', beneficiary?.nuvionCounterpartyId);

    if (!beneficiary?.nuvionCounterpartyId || !paymentMethod) {
        console.error('❌ Missing counterparty or payment method record.');
        process.exit(1);
    }

    const payload = {
        payment_method: 'bank-transfer',
        currency: 'USD',
        account_holder_name: paymentMethod.accountName,
        counterparty_id: beneficiary.nuvionCounterpartyId,
        country: beneficiary.nuvionRecipientCountry!,
        account_number: String(paymentMethod.accountNumber),
        ...(paymentMethod.bankName && { bank_name: paymentMethod.bankName }),
        ...(paymentMethod.swiftCode && { swift_bic: paymentMethod.swiftCode }),
        ...(paymentMethod.bankAddressLine1 && {
            bank_address: {
                line1: paymentMethod.bankAddressLine1,
                city: paymentMethod.bankAddressCity,
                state: paymentMethod.bankAddressState,
                postal_code: paymentMethod.bankAddressPostal,
                country: paymentMethod.bankAddressCountry,
            },
        }),
    };

    console.log('\n=== Payload being sent ===');
    console.log(JSON.stringify(payload, null, 2));

    const result = await createPaymentDetail(payload as any);

    console.log('\n=== Full result ===');
    console.log(JSON.stringify(result, null, 2));
}

main()
    .catch((err) => console.error('Raw crash:', err))
    .finally(async () => { await prisma.$disconnect(); });
