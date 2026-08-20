// scripts/test-nuvion-payout.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/test-nuvion-payout.ts
//
// Tests a same-currency NGN payout end to end against LIVE Nuvion
// (no sandbox environment exists for this provider — confirmed, every
// call goes to api.nuvion.dev against the real, KYB'd business entity).
// Safe to run right now specifically because the NGN treasury account
// balance is confirmed at ₦0 — no funds can actually move regardless of
// how far this gets.
//
// ⚠️ FILL IN YOUR REAL BANK DETAILS BELOW (step 4) before running —
// this now uses real, verifiable data instead of fabricated test values,
// so a successful payment-detail creation actually means something.

import prisma from '../config/prisma.client';
import logger from '../config/logger';
import { initiateNuvionPayout } from '../services/nuvionpayout.service';

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
}

async function main() {
    step('1. Confirm treasury account exists');
    const treasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: 'NGN', isActive: true },
    });
    if (!treasury) {
        console.error('❌ No NGN treasury account found. Run setup-nuvion-treasury.ts --confirm first.');
        process.exit(1);
    }
    console.log('Treasury account:', treasury.nuvionAccountId);
    console.log('Last known balance:', treasury.lastKnownAvailable, '(confirm this is still 0 before proceeding, for safety)');

    step('2. Create/reset test user');
    const testEmail = 'vyreafrica@gmail.com';
    let user = await prisma.user.findUnique({ where: { email: testEmail } });

    if (!user) {
        user = await prisma.user.create({
            data: {
                email: testEmail,
                firstName: 'Nuvion',
                lastName: 'PayoutTest',
                phoneNumber: '+2348012345678',
                userStatus: 'CREATED',
            } as any, // adjust to match real required User fields if this errors
        });
        console.log(`Created test user: ${user.id}`);
    } else {
        console.log(`Using existing test user: ${user.id}`);
    }

    step('3. Ensure a funded NGN VirtualAccount exists');
    let account = await prisma.virtualAccount.findFirst({
        where: { userId: user.id, currency: 'NGN' },
    });

    const TEST_FUNDING_AMOUNT = 2000; // ₦2,000 — internal ledger only, doesn't touch the real treasury balance

    if (!account) {
        account = await prisma.virtualAccount.create({
            data: {
                userId: user.id,
                currency: 'NGN',
                balance: TEST_FUNDING_AMOUNT,
                available: TEST_FUNDING_AMOUNT,
            },
        });
        console.log(`Created and funded VirtualAccount: ${account.id} (₦${TEST_FUNDING_AMOUNT})`);
    } else if (Number(account.available) < 2000) {
        account = await prisma.virtualAccount.update({
            where: { id: account.id },
            data: { balance: { increment: TEST_FUNDING_AMOUNT }, available: { increment: TEST_FUNDING_AMOUNT } },
        });
        console.log(`Topped up existing VirtualAccount: ${account.id} (+₦${TEST_FUNDING_AMOUNT})`);
    } else {
        console.log(`Using existing funded VirtualAccount: ${account.id} (available: ₦${account.available})`);
    }

    step('4. Create/reuse test beneficiary — REAL bank details');
    let beneficiary = await prisma.beneficiary.findFirst({
        where: { userId: user.id, type: 'BANK', ISO: 'NGN' },
    });

    if (!beneficiary) {
        beneficiary = await prisma.beneficiary.create({
            data: {
                userId: user.id,
                ISO: 'NGN',
                type: 'BANK',
                bank: {
                    accountNumber: 2004930143,
                    accountName: 'Harvey Onyeka Anafuwe',   // must match your bank's records exactly
                    bankName: 'Kuda',
                    bankCode: '090267'      // NIP bank code
                },
            },
        });
        console.log(`Created test beneficiary: ${beneficiary.id}`);
    } else {
        console.log(`Using existing test beneficiary: ${beneficiary.id}`);
        console.log('⚠️  Re-using a previously created beneficiary — if it still has the OLD fabricated details, delete it and re-run so the real details above get used.');
    }

    step('5. Call initiateNuvionPayout — the real thing, against LIVE Nuvion');
    const PAYOUT_AMOUNT = '1000.00'; // ₦1,000 — irrelevant given ₦0 treasury balance, but kept deliberately small

    try {
        const result = await initiateNuvionPayout({
            userId: user.id,
            beneficiaryId: beneficiary.id,
            fromCurrency: 'NGN',
            toCurrency: 'NGN',
            amount: PAYOUT_AMOUNT,
            narration: 'Vyre live test payout — expected to fail on zero treasury balance',
            recipientCountry: 'NG',
            recipientEmail: 'vyreafrica@gmail.com',

            recipientAddress: {
                line1: '12 Admiralty Way',
                city: 'Lekki',  
                state_or_province: 'Lagos',
                postal_code: '106104',    
            },
        });

        console.log('\n✅ Payout initiated:', result);
        console.log('⚠️  If this actually succeeded, STOP and verify nothing real was moved before running anything else — the ₦0 balance assumption may no longer hold.');

    } catch (error: any) {
        console.error('\n❌ Payout failed (expected, given ₦0 treasury balance):', error.message);
    }

    step('6. Final state check');
    const finalAccount = await prisma.virtualAccount.findUnique({ where: { id: account.id } });
    console.log('VirtualAccount after:', {
        balance: finalAccount?.balance,
        frozen: finalAccount?.frozen,
        available: finalAccount?.available,
    });
    console.log('Expect frozen back to 0 and available back to its pre-test value — confirms the block was correctly released on failure.');

    const finalBeneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiary.id } });
    
    console.log('Beneficiary Nuvion linkage after:', {
        nuvionCounterpartyId: (finalBeneficiary as any)?.nuvionCounterpartyId,
        nuvionPaymentDetailId: (finalBeneficiary as any)?.nuvionPaymentDetailId,
    });

    const transferRequests = await prisma.transferRequest.findMany({
        where: { userId: user.id, payoutProvider: 'NUVION' } as any,
        orderBy: { createdAt: 'desc' },
        take: 1,
    });

    console.log('Latest TransferRequest:', transferRequests[0]);

    step('DONE');
}

main()
    .catch((error) => {
        console.error('❌ Script failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });