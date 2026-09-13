// scripts/test-full-payout-flow.ts
//
// DRY RUN (safe, default):
//   npx ts-node --transpile-only -r dotenv/config scripts/test-full-payout-flow.ts \
//     --userId=<userId> --beneficiaryId=<id> --paymentDetailId=<id> --currency=NGN --amount=100
//
// REAL RUN (moves real money):
//   ...same args... --confirm
//
// This calls blockNuvionPayout/blockCryptoPayout and processNuvionPayoutJob
// DIRECTLY as function calls, not through the BullMQ queue — so you see
// every real step's result synchronously, in order, without needing a
// separate worker process running.
//
// It does NOT and CANNOT force the outflows.completed webhook to arrive
// early — that's genuinely async on Nuvion's side. This script gets you
// to "submitted, awaiting webhook" and then polls the DB for a while to
// see if completion shows up naturally.

import prisma from '../../src/config/prisma.client';
import { blockNuvionPayout, blockCryptoPayout, processNuvionPayoutJob } from '../services/nuvionpayout.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

const CONFIRMED = process.argv.includes('--confirm');

const userId = arg('userId');
const beneficiaryId = arg('beneficiaryId');
const paymentDetailId = arg('paymentDetailId');
const currency = arg('currency'); // 'NGN', 'GHS', or a crypto currencyId if --crypto is set
const amount = arg('amount') ?? '100'; // small default — override deliberately, never leave unset for a real run
const isCrypto = process.argv.includes('--crypto');

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  MODE: ${CONFIRMED ? '🔴 REAL RUN — THIS WILL MOVE REAL MONEY' : '🟢 DRY RUN — nothing will actually execute'}`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (!userId || !beneficiaryId || !paymentDetailId || !currency) {
        console.error('❌ Missing required args. Need --userId --beneficiaryId --paymentDetailId --currency (and --amount, optionally --crypto --confirm)');
        process.exit(1);
    }

    // ── Step 0: sanity-check everything exists before touching anything ──
    console.log('Step 0: Verifying prerequisites...');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) { console.error(`❌ User ${userId} not found`); process.exit(1); }
    console.log(`✅ User found: ${user.email ?? userId}`);

    const beneficiary = await prisma.beneficiary.findUnique({ where: { id: beneficiaryId } });
    if (!beneficiary || beneficiary.userId !== userId) { console.error(`❌ Beneficiary not found or doesn't belong to this user`); process.exit(1); }
    console.log(`✅ Beneficiary found: ${(beneficiary.bank as any)?.accountName ?? beneficiaryId}`);

    const paymentDetail = await prisma.beneficiaryPaymentDetail.findUnique({ where: { id: paymentDetailId } });
    if (!paymentDetail || paymentDetail.beneficiaryId !== beneficiaryId) { console.error(`❌ Payment detail not found or doesn't belong to this beneficiary`); process.exit(1); }
    console.log(`✅ Payment detail found: ${paymentDetail.paymentMethod} in ${paymentDetail.currency}`);

    if (isCrypto) {
        const cryptoCurrency = await prisma.currency.findUnique({ where: { id: currency } });
        if (!cryptoCurrency) { console.error(`❌ Crypto currency ${currency} not found`); process.exit(1); }
        console.log(`✅ Source: ${amount} ${cryptoCurrency.ISO} (crypto-sourced, float-funded)\n`);
    } else {
        const treasury = await prisma.nuvionTreasuryAccount.findFirst({ where: { currency, isActive: true } });
        if (!treasury) { console.error(`❌ No active treasury for ${currency}`); process.exit(1); }
        console.log(`✅ Source: ${amount} ${currency} (fiat treasury: ${treasury.nuvionAccountId})\n`);
    }

    if (!CONFIRMED) {
        console.log('🟢 DRY RUN COMPLETE — everything above checks out.');
        console.log('   Re-run with --confirm to actually execute this payout with real money.\n');
        return;
    }

    // ── From here on, this is REAL ──
    console.log('🔴 Proceeding with REAL execution in 3 seconds... (Ctrl+C to abort)\n');
    await new Promise(r => setTimeout(r, 3000));

    console.log('Step 1: Blocking payout (freezing funds)...');
    const blockResult = isCrypto
        ? await blockCryptoPayout({ userId, beneficiaryId, paymentDetailId, cryptoCurrencyId: currency, amount, narration: 'E2E pre-push test' })
        : await blockNuvionPayout({ userId, beneficiaryId, paymentDetailId, fromCurrency: currency, amount, narration: 'E2E pre-push test' });

    console.log(`✅ Blocked: TransferRequest ${blockResult.transferRequestId}\n`);

    const transferRequest = await prisma.transferRequest.findUnique({ where: { id: blockResult.transferRequestId } });
    if (!transferRequest) { console.error('❌ TransferRequest disappeared immediately after creation — something is very wrong'); process.exit(1); }

    // Need transactionId/blockId to call processNuvionPayoutJob directly —
    // find the VirtualTransaction created by the block step above.
    const transaction = await prisma.virtualTransaction.findFirst({ where: { reference: transferRequest.idempotencyKey } });
    if (!transaction || !transaction.blockId) { console.error('❌ Could not find the VirtualTransaction/Block just created'); process.exit(1); }

    console.log('Step 2: Processing payout (submitting to Nuvion)...');
    await processNuvionPayoutJob({
        transferRequestId: transferRequest.id,
        transactionId: transaction.id,
        blockId: transaction.blockId,
        sharedReference: transferRequest.idempotencyKey,
        narration: 'E2E pre-push test',
        isCryptoSourced: isCrypto,
    });

    const afterSubmission = await prisma.transferRequest.findUnique({ where: { id: transferRequest.id } });
    console.log(`\nStatus after submission: ${afterSubmission?.status}`);
    if (afterSubmission?.errorMessage) console.log(`Error message: ${afterSubmission.errorMessage}`);

    if (afterSubmission?.status !== 'PROCESSING') {
        console.log('\n⚠️  Did not reach PROCESSING — check the error above. Stopping here.\n');
        return;
    }

    // ── Step 3: poll for webhook-driven completion ──
    console.log('\nStep 3: Polling for webhook completion (outflows.completed/failed)...');
    console.log('        This can take anywhere from seconds to minutes depending on the rail.\n');

    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const current = await prisma.transferRequest.findUnique({ where: { id: transferRequest.id } });
        console.log(`  [${i + 1}/20] Status: ${current?.status}`);
        if (current?.status === 'COMPLETED' || current?.status === 'FAILED') {
            console.log(`\n${current.status === 'COMPLETED' ? '✅' : '❌'} Final status: ${current.status}`);
            if (current.errorMessage) console.log(`   Error: ${current.errorMessage}`);
            return;
        }
    }

    console.log('\n⚠️  Still PROCESSING after ~100 seconds. Not necessarily a problem —');
    console.log('   some rails settle slower. Check TransferRequest and NuvionWebhookEvent');
    console.log('   tables manually, or your webhook logs directly, for the final outcome.\n');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });