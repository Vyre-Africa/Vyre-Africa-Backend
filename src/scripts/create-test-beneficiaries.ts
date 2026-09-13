// scripts/create-test-beneficiaries.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/create-test-beneficiaries.ts

import prisma from '../config/prisma.client';

const USER_ID = 'user_38OI3Y47pS0u4gKiRoee5GySGiV';

async function main() {
    // ── USD beneficiary — Obiajulu Anayo ──
    // Recipient's own country/address is Nigeria (where he actually
    // lives) — separate from the bank itself, which is genuinely
    // US-based via Wise. Nuvion's counterparty profile represents the
    // PERSON, not the bank.
    const usdBeneficiary = await prisma.beneficiary.create({
        data: {
            userId: USER_ID,
            ISO: 'NG', // CORRECTED — was 'US', but this represents the recipient's own country
            type: 'BANK',
            bank: { accountName: 'Obiajulu Anayo' },
            nuvionRecipientCountry: 'NG', // CORRECTED
            nuvionRecipientEmail: 'obiianayo@gmail.com',
            nuvionRecipientAddressLine1: '23 Wole Omo Osho Street',
            nuvionRecipientAddressCity: 'Egbeda',
            nuvionRecipientAddressState: 'Lagos',
            nuvionRecipientAddressPostal: '100214',
        } as any,
    });

    console.log(`✅ USD beneficiary created: ${usdBeneficiary.id}`);

    // Payment detail — the BANK side, genuinely US-based, unchanged.
    const usdPaymentDetail = await prisma.beneficiaryPaymentDetail.create({
        data: {
            beneficiaryId: usdBeneficiary.id,
            currency: 'USD',
            paymentMethod: 'bank-transfer', // SWIFT (Acct No.) — swift_bic + account_number + bank_name, no iban
            accountName: 'Obiajulu Anayo',
            accountNumber: '8312040762',
            bankName: 'Community Federal Savings Bank',
            swiftCode: 'CMFGUS33',
        },
    });

    console.log(`✅ USD payment detail created: ${usdPaymentDetail.id}\n`);

    console.log('Use these for the payout test:');
    console.log(`  --beneficiaryId=${usdBeneficiary.id}`);
    console.log(`  --paymentDetailId=${usdPaymentDetail.id}`);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });