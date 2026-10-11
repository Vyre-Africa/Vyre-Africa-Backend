// scripts/which-payout-path.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/which-payout-path.ts
//
// Reads only. Answers one question from the data instead of from the source:
// which function actually creates your global payouts?
//
// The two candidates leave different fingerprints on a TransferRequest:
//
//                        initiateNuvionPayout    blockNuvionPayout / blockCryptoPayout
//   payoutProvider       'NUVION'                null
//   currencyId           the ISO ('USD')         a Currency.id (a cuid)
//   VirtualTransaction   none                    one, with a blockId
//   beneficiaryId        null                    set
//
// The VirtualTransaction row is the decisive one: outflows.completed looks it up
// by `reference: transferRequest.idempotencyKey` and gives up without it, so any
// payout that has none could never have been completed by the webhook.

import prisma from '../config/prisma.client';

const LIMIT = 20;

async function main() {
    console.log(`The ${LIMIT} most recent TransferRequests...\n`);

    const requests = await prisma.transferRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
    });

    if (requests.length === 0) {
        console.log('None at all. No payout has ever been created.');
        return;
    }

    const currencies = await prisma.currency.findMany({ select: { id: true, ISO: true } });
    const byId = new Map(currencies.map((c: any) => [c.id, c.ISO]));
    const isoSet = new Set(currencies.map((c: any) => c.ISO));

    const rows: any[] = [];
    let looksOld = 0;
    let looksNew = 0;

    for (const r of requests as any[]) {
        const txn = await prisma.virtualTransaction.findFirst({ where: { reference: r.idempotencyKey } });

        // Does currencyId point at a real Currency row, or is it an ISO code?
        const currencyIso = byId.get(r.currencyId);
        const currencyVerdict = currencyIso
            ? `ok (${currencyIso})`
            : isoSet.has(r.currencyId)
                ? `ISO "${r.currencyId}", NOT an id`
                : 'unknown value';

        const fingerprint =
            txn ? 'block* (has a VirtualTransaction)' :
            r.payoutProvider === 'NUVION' ? 'initiateNuvionPayout?' :
            'neither (no transaction, no provider)';

        if (txn) looksNew++; else looksOld++;

        rows.push({
            id: r.id.slice(0, 8),
            created: r.createdAt?.toISOString?.().slice(0, 16),
            type: r.type,
            status: r.status,
            provider: r.payoutProvider ?? '-',
            currencyId: currencyVerdict,
            txn: txn ? (txn.blockId ? 'yes + block' : 'yes, NO block') : 'NONE',
            beneficiary: r.beneficiaryId ? 'set' : '-',
            createdBy: fingerprint,
        });
    }

    console.table(rows);

    console.log(`\n   ${looksNew} with a VirtualTransaction, ${looksOld} without.\n`);

    if (looksNew > 0 && looksOld === 0) {
        console.log('✅ Every recent payout has a VirtualTransaction, so they all come from');
        console.log('   blockNuvionPayout / blockCryptoPayout. initiateNuvionPayout is not in use.');
    } else if (looksOld > 0 && looksNew === 0) {
        console.log('🔴 None of them has a VirtualTransaction. They are NOT coming from the block* path.');
        console.log('   outflows.completed looks the transaction up by reference and gives up without it,');
        console.log('   so none of these could ever be completed by the webhook. Check the ones above that');
        console.log('   are still PROCESSING: their funds are frozen with nothing to release them.');
    } else if (looksOld > 0) {
        console.log('⚠️  BOTH shapes are present, so two payout paths are live at once.');
        console.log('   The ones without a transaction cannot be completed by the webhook.');
    }

    const badCurrency = rows.filter((r) => !r.currencyId.startsWith('ok'));
    if (badCurrency.length) {
        console.log(`\n🔴 ${badCurrency.length} row(s) have a currencyId that is not a Currency.id.`);
        console.log('   If any say ISO, the foreign key is not being enforced on that column.');
        console.log('   Worth knowing either way: the relation is declared in the schema.');
    }

    console.log('\nStuck payouts (PENDING or PROCESSING, older than an hour)...');
    const stuck = await prisma.transferRequest.findMany({
        where: { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: new Date(Date.now() - 3_600_000) } },
        orderBy: { createdAt: 'desc' },
        take: 20,
    });
    if (stuck.length === 0) {
        console.log('   None.');
    } else {
        console.table(stuck.map((r: any) => ({
            id: r.id.slice(0, 8), created: r.createdAt?.toISOString?.().slice(0, 16),
            type: r.type, status: r.status, amount: String(r.amount), reference: r.reference ?? '-',
        })));
        console.log('   Each of these has funds frozen that nothing is going to release on its own.');
    }
}

main()
    .catch((err) => { console.error('Script crashed:', err); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });