// scripts/checkDeposit.ts
//
// Diagnoses "I sent funds but got no webhook" for a specific deposit
// address. Checks two things:
//   1. What's actually in our DB — does a wallet exist for this address,
//      does it have a subscriptionId at all?
//   2. If a subscriptionId exists, what does Tatum ACTUALLY have on file
//      for it — fetched directly from their API, not assumed from our own
//      code. This is the same discipline used throughout this project:
//      don't guess what got registered, look at it.
//
// Usage:
//   npx ts-node --transpile-only -r dotenv/config scripts/checkDeposit.ts --address=<depositAddress>

import config from '../config/env.config';
import prisma from '../config/prisma.client';
import axios from 'axios';

const tatumAxiosV4 = axios.create({
    baseURL: 'https://api.tatum.io/v4',
    headers: {
        'x-api-key': config.TATUM_LIVE_KEY,
        'Content-Type': 'application/json'
    }
});

function arg(name: string): string | undefined {
    const match = process.argv.find(a => a.startsWith(`--${name}=`));
    return match?.split('=')[1];
}

function step(label: string) {
    console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 55 - label.length))}`);
}

async function main() {
    const address = arg('address');
    if (!address) {
        console.error('Usage: --address=<depositAddress>');
        process.exit(1);
    }

    step('1. Wallet lookup by depositAddress');
    const wallet = await prisma.wallet.findFirst({
        where: { depositAddress: address },
        include: { currency: true, user: { select: { id: true, email: true } } },
    });

    if (!wallet) {
        console.error(`❌ No Wallet row found with depositAddress = ${address}`);
        console.error('   This address may not be tracked by us at all, or may be stored under');
        console.error('   different casing (TRON addresses ARE case-sensitive Base58, unlike EVM).');
        await prisma.$disconnect();
        return;
    }

    console.log('Found wallet:', {
        walletId: wallet.id,
        userId: wallet.userId,
        isAdmin: wallet.userId === config.Admin_Id,
        userEmail: wallet.user?.email,
        currency: wallet.currency?.ISO,
        chain: wallet.currency?.chain,
        depositAddress: wallet.depositAddress,
        subscriptionId: wallet.subscriptionId,
        accountBalance: wallet.accountBalance,
        availableBalance: wallet.availableBalance,
    });

    step('2. Check for any GasPumpAddress record (TRON is a gas-pump chain)');
    const gasPumpAddress = await prisma.gasPumpAddress.findUnique({
        where: { depositAddress: address },
    });
    console.log(gasPumpAddress ?? 'No GasPumpAddress record — this was NOT generated via the gas-pump path.');
    if (gasPumpAddress) {
        console.log('activated:', gasPumpAddress.activated, '| activatedTxId:', gasPumpAddress.activatedTxId);
    }

    step('3. Check for any existing Transaction record for this wallet');
    const existingTx = await prisma.transaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
    });
    console.log(`Found ${existingTx.length} transaction(s) on this wallet:`);
    console.log(existingTx.map(t => ({ id: t.id, type: t.type, amount: t.amount.toString(), status: t.status, reference: t.reference, createdAt: t.createdAt })));

    if (!wallet.subscriptionId) {
        console.error('\n❌ subscriptionId is NULL/empty on this wallet.');
        console.error('   This means no subscription was ever successfully registered with Tatum for');
        console.error('   this address — the webhook was never going to fire, regardless of anything');
        console.error('   else. This wallet needs to be (re)subscribed.');
        await prisma.$disconnect();
        return;
    }

    step('4. Fetch the ACTUAL subscription config from Tatum directly');
    console.log(`Checking subscriptionId: ${wallet.subscriptionId}`);
    try {
        const res = await tatumAxiosV4.get(`/subscription/${wallet.subscriptionId}`);
        console.log('\nTatum subscription record:');
        console.log(JSON.stringify(res.data, null, 2));

        // Specifically call out the things that have bitten us before in
        // this project — chain value, and whether conditions are present.
        const attr = res.data?.attr ?? {};
        console.log('\nKey fields:');
        console.log('  chain:', attr.chain);
        console.log('  address:', attr.address);
        console.log('  url (webhook target):', attr.url);
        console.log('  conditions:', attr.conditions ?? '(none set)');
        console.log('  type:', res.data?.type);
        console.log('  isActive:', res.data?.isActive ?? res.data?.active ?? '(field not present in response)');

    } catch (err: any) {
        console.error('\n❌ Failed to fetch subscription from Tatum:');
        console.error('Status:', err?.response?.status);
        console.error('Data:', err?.response?.data);
        console.error('Message:', err.message);
        console.error('\nIf this returns 404, the subscriptionId we have stored does not exist on');
        console.error('Tatum\'s side (deleted, expired, or never actually created despite our DB');
        console.error('thinking it succeeded) — that alone would fully explain a missing webhook.');
    }

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error('Script crashed:', e);
    process.exit(1);
});