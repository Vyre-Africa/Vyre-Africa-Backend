// scripts/create-usd-book-payment-detail.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/create-usd-book-payment-detail.ts
//
// Creates the book-transfer payment detail that the USD treasury is paid INTO
// when a stablecoin is converted back into it. Nuvion models every transfer as
// "pay this payment detail", so the USD account needs one of its own.
//
// Safe to run again: if a book-transfer detail with this account number already
// exists under the counterparty, it reuses it instead of creating a second.
//
// It only prints the id. Nothing is written to the database, because the column
// that holds it does not exist yet. Keep the id for the Prisma step next.

import prisma from '../config/prisma.client';
import {
    getAccount,
    getCounterparty,
    listCounterpartyPaymentDetails,
    createPaymentDetail,
} from '../services/nuvion.service';

const COUNTERPARTY_ID = '01M25W2R39GMGVH69C5M6WPT18';

// The USD treasury's account number AT NUVION. Leave it blank and the script
// prints what Nuvion returns for the account so you can find it.
const ACCOUNT_NUMBER = '0014797028';

const ACCOUNT_HOLDER_NAME = 'Vyre Africa';

// Nuvion lists a book transfer as "any country", so this is only sent if set.
const COUNTRY = '';

async function main() {
    console.log('Step 1: Finding the USD treasury...');
    const treasury = await prisma.nuvionTreasuryAccount.findFirst({
        where: { currency: 'USD', isActive: true },
    });
    if (!treasury) {
        console.error('❌ No active USD NuvionTreasuryAccount row found.');
        process.exit(1);
    }
    console.log(`✅ USD treasury ${treasury.id}, Nuvion account ${treasury.nuvionAccountId}\n`);

    if (!ACCOUNT_NUMBER) {
        console.log('ACCOUNT_NUMBER is blank. This is what Nuvion returns for that account:');
        const acct = await getAccount(treasury.nuvionAccountId);
        console.log(JSON.stringify(acct.rawData ?? acct, null, 2));
        console.log('\nPut the account number at the top of this script and run it again.');
        process.exit(1);
    }

    console.log('Step 2: Checking the counterparty...');
    const cp = await getCounterparty(COUNTERPARTY_ID);
    if (!cp.success) {
        console.error(`❌ Nuvion could not find counterparty ${COUNTERPARTY_ID}:`, cp.error);
        process.exit(1);
    }
    console.log(`✅ ${COUNTERPARTY_ID} — ${cp.type ?? '?'}, ${cp.nickname ?? 'no nickname'}, ${cp.status ?? '?'}\n`);

    console.log('Step 3: Is there already a book-transfer detail for this account number?');
    const list = await listCounterpartyPaymentDetails(COUNTERPARTY_ID);
    if (!list.success) {
        console.error('❌ Failed to list payment details:', list.error);
        process.exit(1);
    }

    const existing = list.paymentDetails?.find(
        (pd: any) =>
            String(pd.account_number) === ACCOUNT_NUMBER &&
            (!pd.payment_method || pd.payment_method === 'book-transfer')
    );

    if (existing) {
        console.log(`✅ One already exists: ${existing.id}. Nothing created.\n`);
        done(existing.id);
        return;
    }
    console.log('   None found, creating it.\n');

    console.log('Step 4: Creating the payment detail...');
    const payload = {
        payment_method: 'book-transfer' as const,
        currency: 'USD',
        account_holder_name: ACCOUNT_HOLDER_NAME,
        counterparty_id: COUNTERPARTY_ID,
        account_number: ACCOUNT_NUMBER,
        ...(COUNTRY ? { country: COUNTRY } : {}),
    };
    console.log('   Payload:', JSON.stringify(payload));

    const created = await createPaymentDetail(payload);
    if (!created.success || !created.id) {
        console.error('❌ Create failed:', created.error);
        console.error(JSON.stringify(created.rawData, null, 2));
        process.exit(1);
    }
    console.log(`✅ Created: ${created.id}\n`);
    done(created.id);
}

function done(paymentDetailId: string) {
    console.log('── Keep these two. They go on the USD treasury row in the Prisma step ──');
    console.log(`  conversionCounterpartyId:  ${COUNTERPARTY_ID}`);
    console.log(`  conversionPaymentDetailId: ${paymentDetailId}`);
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });