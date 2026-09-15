// scripts/release-admin-block.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/release-admin-block.ts

import prisma from '../config/prisma.client';
import virtualAccountService from '../services/virtualAccount.service';

const TRANSFER_REQUEST_ID = 'c625fc14-9425-4ffc-98b3-d6aed94211ff';
const TRANSACTION_ID = 'cmtvvxd7p000122sbnn5nn15n';
const BLOCK_ID = 'cmtvvxckl000022sbimgg3seb';

async function main() {
    console.log('Releasing block for admin test funds — real Nuvion status was still "pending" after 5 days.');
    console.log('Accepted risk: if the real Wire transfer later completes, treasury float will have been');
    console.log('drawn down for real while this $8 shows back as available locally. Documented below.\n');

    await virtualAccountService.failGlobalPayoutBlock({
        transactionId: TRANSACTION_ID,
        blockId: BLOCK_ID,
        reason: 'Manually released — admin test funds, Nuvion status still "pending" 5 days after submission (ref: 01M26AN199401K52Y99A89YCX4). Accepted risk: if this later completes on Nuvion\'s side, reconcile the treasury float by -$8.',
    });

    await prisma.transferRequest.update({
        where: { id: TRANSFER_REQUEST_ID },
        data: { status: 'FAILED', errorMessage: 'Manually released — admin test funds, accepted reconciliation risk. See block description for detail.' },
    });

    const account = await prisma.virtualAccount.findUnique({ where: { id: 'cmpb4qg83000c0ds6jjzq0pqu' } });
    console.log('✅ Released. Wallet now shows:', { available: account?.available, frozen: account?.frozen });
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });