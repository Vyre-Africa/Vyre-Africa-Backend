// scripts/resolve-both-blocks.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/resolve-both-blocks.ts

import prisma from '../config/prisma.client';
import { getTransferStatus } from '../services/nuvion.service';
import virtualAccountService from '../services/virtualAccount.service';

const BLOCK_IDS = ['cmtvvxckl000022sbimgg3seb', 'cmu2bm13u00040ds67ajl9auj'];

async function resolveBlock(blockId: string) {
    console.log(`\n═══ Block ${blockId} ═══`);

    const block = await prisma.block.findUnique({ where: { id: blockId } });
    if (!block || !block.active) { console.log('Already inactive — nothing to do.'); return; }

    const transaction = await prisma.virtualTransaction.findFirst({ where: { blockId } });
    if (!transaction) { console.log('❌ No VirtualTransaction found for this block — investigate manually before touching it.'); return; }

    const transferRequest = await prisma.transferRequest.findFirst({ where: { idempotencyKey: transaction.reference! } });
    if (!transferRequest) { console.log('❌ No TransferRequest found — investigate manually before touching it.'); return; }

    console.log(`TransferRequest: ${transferRequest.id}, status: ${transferRequest.status}, reference: ${transferRequest.reference ?? 'NONE'}`);

    if (!transferRequest.reference) {
        // No real Nuvion transfer was ever created — provably safe to
        // release immediately, no possibility of double-spend.
        console.log('✅ No Nuvion reference exists — this never actually reached Nuvion. Safe to release directly.');

        await virtualAccountService.failGlobalPayoutBlock({
            transactionId: transaction.id,
            blockId: block.id,
            reason: 'Resolved — payout never actually reached Nuvion (no reference was ever assigned)',
        });
        await prisma.transferRequest.update({ where: { id: transferRequest.id }, data: { status: 'FAILED', errorMessage: 'Resolved — never reached Nuvion' } });
        console.log('✅ Released.');
        return;
    }

    // A real reference exists — must check the real status before doing anything.
    console.log('Checking real Nuvion status before touching this one...');
    const result = await getTransferStatus(transferRequest.reference);

    if (!result.success) {
        console.log(`❌ Could not check status: ${result.error}. NOT releasing — unsafe to guess.`);
        return;
    }

    console.log(`Real Nuvion status: ${result.status}`);

    if (result.status === 'successful') {
        console.log('✅ Genuinely succeeded — completing (committing), NOT releasing funds.');
        await virtualAccountService.completeGlobalPayoutBlock({
            transactionId: transaction.id, blockId: block.id, externalRef: transferRequest.reference,
        });
        await prisma.transferRequest.update({ where: { id: transferRequest.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
        console.log('✅ Reconciled as COMPLETED.');
    } else if (result.status === 'failed' || result.status === 'reversed') {
        console.log('⚠️  Genuinely failed — releasing.');
        await virtualAccountService.failGlobalPayoutBlock({
            transactionId: transaction.id, blockId: block.id, reason: `Reconciled — Nuvion status: ${result.status}`,
        });
        await prisma.transferRequest.update({ where: { id: transferRequest.id }, data: { status: 'FAILED', errorMessage: `Reconciled — ${result.status}` } });
        console.log('✅ Released.');
    } else {
        console.log(`⚠️  Still "${result.status}" — NOT touching this one. Releasing now would risk a real double-spend if it later completes.`);
    }
}

async function main() {
    for (const blockId of BLOCK_IDS) {
        await resolveBlock(blockId);
    }
}

main()
    .catch((err) => console.error('Script crashed:', err))
    .finally(async () => { await prisma.$disconnect(); });