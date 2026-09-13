// scripts/release-stuck-block.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/release-stuck-block.ts

import prisma from '../config/prisma.client';
import virtualAccountService from '../services/virtualAccount.service';

const BLOCK_ID = 'cmtvld41d0000sysbopcjs1eq';

async function main() {
    const before = await prisma.virtualAccount.findUnique({ where: { id: 'cmpb4qg83000c0ds6jjzq0pqu' } });
    console.log('Before:', { available: before?.available, frozen: before?.frozen });

    // Uses the real, existing unblock() primitive directly — same
    // mechanism failGlobalPayoutBlock would have called automatically
    // if a VirtualTransaction had existed to trigger it.
    await virtualAccountService.unblock(BLOCK_ID);

    const after = await prisma.virtualAccount.findUnique({ where: { id: 'cmpb4qg83000c0ds6jjzq0pqu' } });
    console.log('After:', { available: after?.available, frozen: after?.frozen });
    console.log('\n✅ Released. The $10 should now show back in available balance.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });