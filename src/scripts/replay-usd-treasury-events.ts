// scripts/replay-usd-treasury-events.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/replay-usd-treasury-events.ts
//
// Directly calls handleNuvionEvent for the two real webhook payloads
// that were missed due to the eventType-mismatch bug. No queue involved
// — this calls the handler function synchronously, in order, so you see
// exactly what happens at each step.

import prisma from '../config/prisma.client';
import eventService from '../services/event.service'; // ⚠️ ADJUST if the real export shape differs

const ACCOUNTS_CREATED_PAYLOAD = {
    eventType: 'accounts.created',
    data: {
        account: {
            id: '01M1W086TX52RXWD4RKVQA34DX',
            meta: { network: '', asset_type: '' },
            type: 'checking',
            config: { overdraft_limit: 0, is_overdraftable: false, balance_next_refresh: 0, balance_refresh_interval: 15 },
            balance: { current: 0, available: 0, overdraft_used: 0 },
            created: 1788719930205,
            deleted: 0,
            updated: 1788719930205,
            currency: 'USD',
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            nuvion_ban: '0014797028',
            system_meta: { maintenance_fee_opted_out: false },
            display_name: 'USD general',
            stablecoin_assets: {},
        },
        entity_impact: {
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            account_type: ['checking'],
            total_accounts: 7,
            default_account_set: true,
        },
    },
    rawBody: null as any, // filled in below
};
ACCOUNTS_CREATED_PAYLOAD.rawBody = { event: 'accounts.created', data: ACCOUNTS_CREATED_PAYLOAD.data };

const ACCOUNT_DETAILS_CREATED_PAYLOAD = {
    eventType: 'account_details.created',
    data: {
        account_details: {
            id: '01M1XAA5S5XF0F5WKEB53PAJXP',
            name: 'Vyre Africa',
            config: { inflow_enabled: true, outflow_enabled: true, inflow_allowed_counterparties: [], outflow_allowed_counterparties: [] },
            issuer: { code: 'NUV', name: 'NUV', short_name: 'NUV' },
            status: 'pending',
            created: 1788764034853,
            deleted: 0,
            updated: 1788764034853,
            currency: 'USD',
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            account_id: '01M1W086TX52RXWD4RKVQA34DX',
            asset_type: 'fiat', // ← expected to make this event a no-op per existing handler logic
            beneficiary_name: 'Vyre Africa',
        },
    },
    rawBody: null as any,
};
ACCOUNT_DETAILS_CREATED_PAYLOAD.rawBody = { event: 'account_details.created', data: ACCOUNT_DETAILS_CREATED_PAYLOAD.data };

async function main() {
    console.log('\n=== Replaying accounts.created ===');
    await eventService.handleNuvionEvent(ACCOUNTS_CREATED_PAYLOAD);

    const treasury = await prisma.nuvionTreasuryAccount.findUnique({
        where: { nuvionAccountId: '01M1W086TX52RXWD4RKVQA34DX' },
    });

    if (!treasury) {
        console.error('❌ No NuvionTreasuryAccount was created. Check logs above for the real error.');
        process.exit(1);
    }
    console.log(`✅ NuvionTreasuryAccount created: ${treasury.id} (${treasury.currency}, active: ${treasury.isActive})\n`);

    console.log('=== Replaying account_details.created ===');
    console.log('   (expected to no-op — asset_type is "fiat", not "stablecoin")');
    await eventService.handleNuvionEvent(ACCOUNT_DETAILS_CREATED_PAYLOAD);

    const afterSecondEvent = await prisma.nuvionTreasuryAccount.findUnique({ where: { id: treasury.id } });
    console.log(`\nFinal state: walletStatus=${afterSecondEvent?.walletStatus ?? 'null (expected — fiat account, no wallet)'}\n`);

    console.log('✅ Replay complete. This USD treasury should now be usable for a real crypto-sourced payout test.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });