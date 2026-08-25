// scripts/diagnose-treasury.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/diagnose-treasury.ts
//
// Walks through every possible reason getSupportedCurrencies could be
// returning empty, in order of likelihood.

import prisma from '../../src/config/prisma.client';

async function main() {
    console.log('\n=== 1. Every NuvionTreasuryAccount row, ignoring isActive ===');
    const all = await prisma.nuvionTreasuryAccount.findMany();
    console.log(`Found ${all.length} row(s):`);
    console.table(all.map(t => ({
        id: t.id,
        currency: t.currency,
        chain: t.chain,
        isActive: t.isActive,
        nuvionAccountId: t.nuvionAccountId,
        walletStatus: t.walletStatus,
    })));

    if (all.length === 0) {
        console.log('\n⚠️  NO ROWS AT ALL. The accounts.created webhook likely never');
        console.log('   finished processing. Checking NuvionWebhookEvent next...\n');
    }

    console.log('\n=== 2. Was the accounts.created webhook ever logged? ===');
    const events = await prisma.nuvionWebhookEvent.findMany({
        where: { eventType: 'accounts.created' },
        orderBy: { receivedAt: 'desc' },
    });
    console.log(`Found ${events.length} accounts.created event(s):`);
    events.forEach(e => {
        console.log(`  - ${e.eventId} at ${e.receivedAt}`);
        console.log(`    rawPayload:`, JSON.stringify(e.rawPayload, null, 2).slice(0, 500));
    });

    if (events.length > 0 && all.length === 0) {
        console.log('\n🔴 CONFIRMED: webhook arrived and was logged, but no');
        console.log('   NuvionTreasuryAccount row exists. The async handler either');
        console.log('   never ran, or ran with an outdated version of the code.');
        console.log('   This event needs to be replayed once the correct handler is deployed.\n');
    }

    console.log('\n=== 3. The EXACT query getSupportedCurrencies actually runs ===');
    const supported = await prisma.nuvionTreasuryAccount.findMany({
        where: { isActive: true },
        select: { currency: true },
        distinct: ['currency'],
    });
    console.log('Result:', supported);

    if (all.length > 0 && supported.length === 0) {
        console.log('\n⚠️  Rows exist, but none have isActive: true.');
        console.log('   Check the "isActive" column values in section 1 above.\n');
    }

    if (supported.length > 0) {
        console.log('\n✅ getSupportedCurrencies should be returning:', supported.map(s => s.currency));
        console.log('   If the real endpoint still returns empty, the deployed code');
        console.log('   may not match this query — check imports/route registration.\n');
    }
}

main()
    .catch((err) => console.error('Script failed:', err))
    .finally(async () => { await prisma.$disconnect(); });