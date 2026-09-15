// scripts/replay-outflows-completed.ts
//
//   npx ts-node --transpile-only -r dotenv/config scripts/replay-outflows-completed.ts

import prisma from '../config/prisma.client';
import eventService from '../services/event.service'; // ⚠️ adjust if the real export shape differs

const OUTFLOWS_COMPLETED_PAYLOAD = {
    eventType: 'outflows.completed',
    data: {
        id: '01M2J0NH04W2K1KXTP0JCFRXM1',
        amount: 200,
        currency: 'USD',
        unique_reference: 'NVPAY-01M2J0NDZ1J45X6H19ENZMRQGD',
        counterparty_id: '01M25W2R39GMGVH69C5M6WPT18',
        account_id: '01M1W086TX52RXWD4RKVQA34DX',
        entity_id: '01KYFPWFGTBR2WNFDXQ1AG8YYW',
        status: 'successful',
        status_reason: 'processing_complete',
        narration: 'Transfer',
        type: 'outflow',
        payment_type: 'bank-transfer',
        applicable_fee: 688,
        meta: {
            fx_quote_id: '01M2J0NGTSAP00MBY38SN5W5PJ',
            provider_reference: 'a94f4f75-e165-4765-b0ba-be902c5321fd',
        },
        account: { meta: { asset_type: '', network: '' }, id: '01M1W086TX52RXWD4RKVQA34DX', display_name: 'USD general' },
        created: 1789458564100,
        updated: 1789458568211,
    },
    rawBody: null as any,
};
OUTFLOWS_COMPLETED_PAYLOAD.rawBody = { event: 'outflows.completed', data: OUTFLOWS_COMPLETED_PAYLOAD.data };

async function main() {
    // Find the real TransferRequest first, to show before/after state clearly
    const transferRequest = await prisma.transferRequest.findUnique({
        where: { idempotencyKey: 'NVPAY-01M2J0NDZ1J45X6H19ENZMRQGD' },
    });

    if (!transferRequest) {
        console.error('❌ No TransferRequest found for this idempotencyKey — check the reference is correct.');
        process.exit(1);
    }

    console.log('=== Before ===');
    console.log({ status: transferRequest.status, completedAt: transferRequest.completedAt });

    console.log('\n=== Replaying outflows.completed directly ===');
    await eventService.handleNuvionEvent(OUTFLOWS_COMPLETED_PAYLOAD);

    const after = await prisma.transferRequest.findUnique({ where: { id: transferRequest.id } });
    console.log('\n=== After ===');
    console.log({ status: after?.status, completedAt: after?.completedAt });

    if (after?.status === 'COMPLETED') {
        console.log('\n✅ Correctly reconciled to COMPLETED.');
    } else {
        console.log('\n⚠️  Status did not change as expected — check logs above for the real error.');
    }
}

main()
    .catch((err) => console.error('Script crashed:', err))
    .finally(async () => { await prisma.$disconnect(); });