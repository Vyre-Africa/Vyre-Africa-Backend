// scripts/check-stuck-transfers.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/check-stuck-transfers.ts

import prisma from '../config/prisma.client';

// ⚠️ FILL IN — the two real TransferRequest IDs
const TRANSFER_REQUEST_IDS = ['c625fc14-9425-4ffc-98b3-d6aed94211ff', 'f905337b-5d66-4987-8e39-b3423486ef81'];

async function main() {
    for (const id of TRANSFER_REQUEST_IDS) {
        console.log(`\n=== TransferRequest ${id} ===`);
        const transferRequest = await prisma.transferRequest.findUnique({ where: { id } });

        if (!transferRequest) {
            console.log('❌ Not found.');
            continue;
        }

        console.log(JSON.stringify(transferRequest, null, 2));

        // Find the associated VirtualTransaction/Block, if any
        const transaction = await prisma.virtualTransaction.findFirst({
            where: { reference: transferRequest.idempotencyKey },
        });

        if (!transaction) {
            console.log('\n⚠️  No VirtualTransaction found for this reference — nothing frozen to release.');
            continue;
        }

        console.log('\n--- Associated VirtualTransaction ---');
        console.log(JSON.stringify(transaction, null, 2));

        if (transaction.blockId) {
            const block = await prisma.block.findUnique({ where: { id: transaction.blockId } });
            console.log('\n--- Associated Block ---');
            console.log(JSON.stringify(block, null, 2));
            console.log(`\nBlock active: ${block?.active} — ${block?.active ? 'FROZEN, needs releasing' : 'already resolved, nothing to do'}`);
        }
    }
}

main()
    .catch((err) => console.error('Script crashed:', err))
    .finally(async () => { await prisma.$disconnect(); });