// scripts/replay-inflows-completed.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/replay-inflows-completed.ts

import prisma from '../config/prisma.client';
import eventService from '../services/event.service'; // ⚠️ ADJUST if the real export shape differs

const INFLOWS_COMPLETED_PAYLOAD = {
    eventType: 'inflows.completed',
    data: {
        id: '01M25A7QF0X78ZKXK9BCMFHWRY',
        meta: {
            funding_type: 'crypto',
            provider_code: 'dyn',
            funding_request_id: '01M25A8C66SA3BPS8E0A8RG5H9',
            funding_session_id: '01M25A8CMN9MS1SY8KVWV26E3B',
            provider_reference: '5c3d1552-8619-4a2a-b2f1-70325c2bd072',
        },
        type: 'inflow',
        amount: 10000,
        status: 'successful',
        account: {
            id: '01M1W086TX52RXWD4RKVQA34DX',
            meta: { network: '', asset_type: '' },
            display_name: 'USD general',
        },
        created: 1789032390112,
        updated: 1789032680867,
        currency: 'USD',
        entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
        narration: 'Funding session',
        account_id: '01M1W086TX52RXWD4RKVQA34DX',
        payment_type: 'funding-session',
        status_reason: 'completed',
        applicable_fee: 100,
        counterparty_id: '01M1W086TX52RXWD4RKVQA34DX',
        unique_reference: '1789032389044',
    },
    rawBody: null as any,
};
INFLOWS_COMPLETED_PAYLOAD.rawBody = { event: 'inflows.completed', data: INFLOWS_COMPLETED_PAYLOAD.data };

async function main() {
    const treasury = await prisma.nuvionTreasuryAccount.findUnique({
        where: { nuvionAccountId: '01M1W086TX52RXWD4RKVQA34DX' },
    });
    if (!treasury) {
        console.error('❌ Treasury not found — run replay-usd-treasury-events.ts first.');
        process.exit(1);
    }

    console.log('=== Before ===');
    console.log(`lastKnownAvailable: ${treasury.lastKnownAvailable}`);
    console.log(`pendingManualTopupUsd: ${treasury.pendingManualTopupUsd}\n`);

    console.log('=== Replaying inflows.completed ===');
    await eventService.handleNuvionEvent(INFLOWS_COMPLETED_PAYLOAD);

    const after = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: treasury.id } });

    console.log('\n=== After ===');
    console.log(`lastKnownAvailable: ${after?.lastKnownAvailable}`);
    console.log(`pendingManualTopupUsd: ${after?.pendingManualTopupUsd}`);
    console.log(`lastSyncedAt: ${after?.lastSyncedAt}\n`);

    if (after && toNumber(after.lastKnownAvailable) > toNumber(treasury.lastKnownAvailable)) {
        console.log('✅ Balance increased — treasury genuinely re-synced with your real $100 top-up.');
    } else {
        console.log('⚠️  Balance did not increase as expected — check the logs above for the real error from getAccount().');
    }
}

function toNumber(val: any): number {
    return val ? Number(val) : 0;
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });