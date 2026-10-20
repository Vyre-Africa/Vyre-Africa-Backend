// scripts/check-my-transactions.ts
//
//   npx ts-node --transpile-only -r dotenv/config src/scripts/check-my-transactions.ts <walletId>
//
// WHY: "I can't find the transactions I just made." Before changing any more
// code, find out where those rows actually are. There are only four
// possibilities and this separates them in one run:
//
//   1. The rows are in VirtualTransaction and the endpoint is still serving
//      the legacy table      → apply the controller patch
//   2. The rows are in the legacy Transaction table only
//                            → something still writes there; say so and the
//                              reader can merge both
//   3. The rows exist but under a DIFFERENT account id than the wallet id
//                            → the Wallet.id === VirtualAccount.id assumption
//                              does not hold for this wallet, which changes
//                              the query
//   4. No rows anywhere      → the write never happened, which is a different
//                              bug entirely and not a display problem
//
// Read-only. Touches nothing.

import prisma from '../config/prisma.client';

const walletId = process.argv[2];

function line(n = 72) { console.log('─'.repeat(n)); }

async function main() {
    if (!walletId) {
        console.log('Pass a wallet id: the one in the URL on the wallet page.');
        console.log('  npx ts-node --transpile-only -r dotenv/config src/scripts/check-my-transactions.ts <walletId>');
        return;
    }

    line();
    console.log(`Wallet ${walletId}`);
    line();

    // ── 1. Does the wallet exist, and is there an account with the same id?
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) {
        console.log('No Wallet row with that id. Check the id from the URL.');
        return;
    }
    console.log(`  wallet.userId      ${wallet.userId}`);
    console.log(`  wallet.currencyId  ${wallet.currencyId}`);

    const sameIdAccount = await prisma.virtualAccount.findUnique({ where: { id: walletId } });
    console.log(`\n  VirtualAccount with the SAME id: ${sameIdAccount ? 'YES' : 'NO'}`);

    if (!sameIdAccount) {
        console.log('  ⚠️  This is the assumption the new reader rests on. Without it,');
        console.log('      filtering VirtualTransaction by walletId finds nothing.');
    } else {
        console.log(`      currency ${sameIdAccount.currency}  blockchain ${sameIdAccount.blockchain ?? 'null (fiat)'}`);
    }

    // ── 2. Every account this user owns, so we can see where rows really are
    const accounts = await prisma.virtualAccount.findMany({
        where: { userId: wallet.userId },
        select: { id: true, currency: true, blockchain: true },
    });
    console.log(`\n  This user has ${accounts.length} virtual account(s).`);

    const ids = accounts.map((a: { id: string }) => a.id);

    // ── 3. VirtualTransaction — the table the new reader uses
    const vtForWallet = await prisma.virtualTransaction.count({
        where: { OR: [{ fromAccountId: walletId }, { toAccountId: walletId }] },
    });
    const vtForUser = ids.length
        ? await prisma.virtualTransaction.count({
            where: { OR: [{ fromAccountId: { in: ids } }, { toAccountId: { in: ids } }] },
        })
        : 0;

    line();
    console.log('VirtualTransaction  (what the new history reads)');
    line();
    console.log(`  rows touching THIS wallet id      ${vtForWallet}`);
    console.log(`  rows touching ANY of their accounts ${vtForUser}`);

    const recent = await prisma.virtualTransaction.findMany({
        where: { OR: [{ fromAccountId: { in: ids } }, { toAccountId: { in: ids } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
    });

    if (recent.length) {
        console.log('\n  Most recent:');
        for (const r of recent) {
            const dir = r.fromAccountId === walletId ? 'OUT' : r.toAccountId === walletId ? 'IN ' : '－ ';
            console.log(
                `    ${dir} ${String(r.type).padEnd(18)} ${String(r.status).padEnd(10)} ` +
                `${String(r.amount).padStart(14)} ${String(r.currency).padEnd(6)} ${r.createdAt.toISOString()}`,
            );
            if (r.fromAccountId !== walletId && r.toAccountId !== walletId) {
                console.log(`         ↑ on another account: from=${r.fromAccountId} to=${r.toAccountId}`);
            }
        }
    }

    // ── 4. The legacy table, for comparison
    const legacyWallet = await prisma.transaction.count({ where: { walletId } });
    const legacyUser = await prisma.transaction.count({ where: { userId: wallet.userId } });

    line();
    console.log('Transaction  (legacy — what the endpoint still serves today)');
    line();
    console.log(`  rows for this wallet  ${legacyWallet}`);
    console.log(`  rows for this user    ${legacyUser}`);

    // ── Verdict
    line();
    console.log('VERDICT');
    line();

    if (vtForUser === 0 && legacyUser === 0) {
        console.log('  No transactions anywhere for this user.');
        console.log('  Nothing was written — this is not a display problem. Check that the');
        console.log('  flow you ran actually reached virtualAccount.service.');
    } else if (vtForWallet === 0 && vtForUser > 0) {
        console.log('  The rows exist, but NOT under this wallet id.');
        console.log('  Wallet.id === VirtualAccount.id does not hold here, so the reader has');
        console.log('  to resolve the account from userId + currency instead of trusting the');
        console.log('  wallet id. Send me this output and I will change the query.');
    } else if (vtForWallet > 0) {
        console.log(`  ${vtForWallet} row(s) are sitting in VirtualTransaction for this wallet.`);
        console.log('  They are not showing because /wallet/transactions still reads the');
        console.log('  legacy table. Apply the fetchTransactions patch in');
        console.log('  transactions-from-ledger.md and they appear.');
    } else if (legacyUser > 0) {
        console.log('  Rows are ONLY in the legacy Transaction table.');
        console.log('  Something still writes there. Tell me what, and the reader can merge');
        console.log('  both sources instead of switching outright.');
    }

    console.log('');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });