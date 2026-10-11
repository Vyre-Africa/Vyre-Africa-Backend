// scripts/record-master-base.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/record-master-base.ts
//   npx ts-node --transpile-only -r dotenv/config src/scripts/record-master-base.ts --yes
//
// Records the ONE stablecoin treasury that already exists but has no row:
// Master-Base, the USC account on Base. Everything after this gets its row from
// the webhooks as they arrive.
//
// It replays the three real Nuvion payloads below through the SAME handler the
// queue uses, in the order they happened. So the row is written by your own
// code, not by this script, and nothing here can drift from it.
//
// The payloads are the real ones Nuvion sent. Safe to run again: each branch of
// the handler skips what it has already recorded.
//
// ⚠️ Check this import path. The worker dispatches 'Nuvion_Event' to
// handleNuvionEvent; point this at whatever module that lives in.
import prisma from '../config/prisma.client';
import eventService from '../services/event.service';

const NUVION_ACCOUNT_ID = '01M0T7QZHBRAMKY93TC38Y3EJS';
const WALLET_ADDRESS = '0x291545355A36cdD1966BE59d74854675DACAf456';

// 1. the account
const ACCOUNTS_CREATED = {
    event: 'accounts.created',
    data: {
        account: {
            id: NUVION_ACCOUNT_ID,
            meta: { network: 'base', asset_type: 'stablecoin' },
            type: 'checking',
            config: { overdraft_limit: 0, is_overdraftable: false, balance_next_refresh: 0, balance_refresh_interval: 15 },
            balance: { current: 0, available: 0, overdraft_used: 0 },
            created: 1787586936363,
            deleted: 0,
            updated: 1787586936363,
            currency: 'USC',
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            nuvion_ban: '0018931027',
            system_meta: {},
            display_name: 'Master-Base',
            stablecoin_assets: {},
            maintenance_fee_opted_out: false,
        },
        entity_impact: {
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            account_type: ['checking'],
            total_accounts: 5,
            default_account_set: true,
        },
    },
};

// 2. its wallet, issued pending. This is where the deposit address comes from.
const ACCOUNT_DETAILS_CREATED = {
    event: 'account_details.created',
    data: {
        account_details: {
            id: '01M0T7WBGGREEV9AV7W4YAPWMP',
            meta: {},
            name: 'vyre africa',
            chain: 'base',
            config: { inflow_enabled: true, outflow_enabled: true, inflow_allowed_counterparties: [], outflow_allowed_counterparties: [] },
            issuer: { code: 'BASE_MAINNET', name: 'BASE_MAINNET', short_name: 'BASE_MAINNET' },
            status: 'pending',
            created: 1787587079696,
            deleted: 0,
            updated: 1787587079696,
            currency: 'USC',
            entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
            account_id: NUVION_ACCOUNT_ID,
            asset_type: 'stablecoin',
            account_number: WALLET_ADDRESS,
            beneficiary_name: 'Vyre Africa',
        },
    },
};

// 3. the wallet goes active
const ACCOUNT_DETAILS_UPDATED = {
    event: 'account_details.updated',
    data: {
        id: '01M0T7WBGGREEV9AV7W4YAPWMP',
        chain: 'base',
        config: { inflow_enabled: true, outflow_enabled: true, inflow_allowed_counterparties: [], outflow_allowed_counterparties: [] },
        issuer: { id: '6a8c6a0d8bf553c50d4ef3a4', code: 'BASE_MAINNET', name: 'BASE_MAINNET', scheme: 'nuvion' },
        status: 'active',
        created: 1787587079696,
        deleted: 0,
        updated: 1787587085242,
        currency: 'USC',
        provider: { id: '6a8c6a078bf553c50d4ef155', code: 'tnk', name: 'Turnkey Global Inc', detail_id: '01M0T7WBG1MSNW6W3SCGRM8KA7', reference: '01a0347e-2d67-7266-a267-85074c752230' },
        entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
        account_id: NUVION_ACCOUNT_ID,
        asset_type: 'stablecoin',
        account_number: WALLET_ADDRESS,
        beneficiary_name: 'Vyre Africa',
    },
};

const EVENTS = [ACCOUNTS_CREATED, ACCOUNT_DETAILS_CREATED, ACCOUNT_DETAILS_UPDATED];

const confirmed = process.argv.includes('--yes');

const show = (rows: any[]) =>
    console.table(rows.map((t: any) => ({
        id: t.id, currency: t.currency, chain: t.chain, isActive: t.isActive,
        nuvionAccountId: t.nuvionAccountId, walletAddress: t.walletAddress, walletStatus: t.walletStatus,
    })));

async function main() {
    console.log('Step 1: NuvionTreasuryAccount before...');
    show(await prisma.nuvionTreasuryAccount.findMany());
    console.log('');

    if (!confirmed) {
        console.log('Would replay, in this order, through handleNuvionEvent:');
        EVENTS.forEach((e, i) => console.log(`   ${i + 1}. ${e.event}`));
        console.log(`\nResult: a USC row on base for ${NUVION_ACCOUNT_ID}, wallet ${WALLET_ADDRESS}, status active.`);
        console.log('Nothing done. Add --yes to go ahead.');
        return;
    }

    console.log('Step 2: Replaying...');
    for (const payload of EVENTS) {
        try {
            await eventService.handleNuvionEvent({ eventType: payload.event, data: payload.data, rawBody: payload });
            console.log(`   ✅ ${payload.event}`);
        } catch (err: any) {
            console.error(`   ❌ ${payload.event}:`, err?.message);
            process.exit(1);
        }
    }
    console.log('');

    console.log('Step 3: NuvionTreasuryAccount after...');
    const after = await prisma.nuvionTreasuryAccount.findMany();
    show(after);
    console.log('');

    console.log('Step 4: Checking the row is actually usable...');
    const row: any = after.find((t: any) => t.nuvionAccountId === NUVION_ACCOUNT_ID);
    if (!row) {
        console.error('❌ No row for the account. The accounts.created branch did not create one.');
        process.exit(1);
    }
    const problems: string[] = [];
    if (!row.walletAddress) problems.push('no walletAddress: the flow would have nowhere to send the crypto');
    if (row.walletAddress && row.walletAddress !== WALLET_ADDRESS) problems.push(`walletAddress is ${row.walletAddress}, expected ${WALLET_ADDRESS}`);
    if (!row.chain) problems.push('no chain: the flow could not tell which chain to send on');
    if (!row.isActive) problems.push('not active: the lookup skips it');
    if (row.walletStatus !== 'active') problems.push(`walletStatus is "${row.walletStatus}", not active`);

    if (problems.length) {
        problems.forEach((p) => console.error(`   ⚠️  ${p}`));
    } else {
        console.log(`   ✅ ${row.currency} on ${row.chain}, wallet ${row.walletAddress}, active.`);
    }

    // The replenishment flow refuses to guess if more than one wallet fits.
    const candidates = after.filter((t: any) => ['USC', 'USDC'].includes(t.currency) && t.isActive);
    if (candidates.length === 1) {
        console.log('   ✅ Exactly one USDC wallet, so the lookup will use it.');
    } else {
        console.log(`   ⚠️  ${candidates.length} USDC rows are active. The flow REFUSES to guess between them and would send nothing.`);
        show(candidates);
    }

    console.log('\nFrom here, new treasuries record themselves from the webhooks as they arrive.');
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });