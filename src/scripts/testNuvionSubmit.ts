// scripts/testNuvionSubmit.ts
//
// Tests the final step: submitting the entity for onboarding review, now
// that identity and address documents have both been uploaded. Same
// discipline as every other step — log the raw response, don't trust
// nuvion.service.ts's assumed field names until confirmed.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/testNuvionSubmit.ts \
//     --userId=user_38OI3Y47pS0u4gKiRoee5GySGiV

import prisma from '../config/prisma.client';
import { submitOnboarding, getEntityStatus } from '../services/nuvion.service';

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

async function main() {
    const userId = arg('userId');
    if (!userId) {
        console.error('Usage: --userId=<id>');
        process.exit(1);
    }

    step('1. Loading user');
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.nuvionEntityId) {
        console.error('❌ User has no Nuvion entity yet.');
        process.exit(1);
    }
    console.log('entityId:', user.nuvionEntityId);
    console.log('current nuvionEntityStatus (local):', user.nuvionEntityStatus);

    step('2. Checking current entity status directly from Nuvion (before submitting)');
    const before = await getEntityStatus(user.nuvionEntityId);
    console.log('Full raw response:');
    console.log(JSON.stringify(before.rawData, null, 2));

    step('3. Submitting for onboarding review');
    const start = Date.now();
    const result = await submitOnboarding(user.nuvionEntityId);
    console.log(`Completed in ${Date.now() - start}ms`);

    if (!result.success) {
        console.error('\n❌ FAILED:', result.error);
        console.error('Raw response:', JSON.stringify(result.rawData, null, 2));
        await prisma.$disconnect();
        return;
    }

    step('4. Result — FULL raw response');
    console.log(JSON.stringify(result.rawData, null, 2));

    step('5. Re-checking entity status after submission');
    const after = await getEntityStatus(user.nuvionEntityId);
    console.log(JSON.stringify(after.rawData, null, 2));

    console.log('\n👉 Compare before/after entity.status — confirm it actually changed from');
    console.log('   "incomplete" to something else (e.g. "pending") after submission.');

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});