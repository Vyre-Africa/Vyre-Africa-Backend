// src/scripts/retryWebhookEvent.ts
import dotenv from 'dotenv';
dotenv.config();

import eventService from '../services/event.service';
import prisma from '../config/prisma.client';

// ── Paste your webhook payload here ──────────────────────────
const WEBHOOK_PAYLOAD = {
    chain:            'base-mainnet',
    address:          '0xdc45ba3fd2ba10f01c4618c7a948eab0d98d5dc9',
    counterAddress:   '0x914d8ca1ea9f1fb566aa0014e26804c7df6e14e7',
    amount:           '20',
    currency:         'ETH_BASE',
    contractAddress:  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    tokenId:          '20000000',
    subscriptionId:   '6a12613482cc84ec81bae81d',
    subscriptionType: 'INCOMING_FUNGIBLE_TX',
    txId:             '0x5bfce7a9ef26edd30f15cba8e5504beb642541041c7c61200c505d9ba08ab973',
    blockNumber:      46628353,
    timestamp:        1780046053000
};

async function investigate() {
    console.log('─────────────────────────────────────────');
    console.log('Investigating webhook event');
    console.log('─────────────────────────────────────────');
    console.log('txId:', WEBHOOK_PAYLOAD.txId);
    console.log('address:', WEBHOOK_PAYLOAD.address);
    console.log('amount:', WEBHOOK_PAYLOAD.amount);
    console.log('chain:', WEBHOOK_PAYLOAD.chain);
    console.log('─────────────────────────────────────────');

    // ── 1. Check if transaction already exists ────────────────
    const existingTx = await prisma.transaction.findFirst({
        where: { reference: WEBHOOK_PAYLOAD.txId }
    });

    if (existingTx) {
        console.log('✅ Transaction already processed:');
        console.log('  id:        ', existingTx.id);
        console.log('  walletId:  ', existingTx.walletId);
        console.log('  amount:    ', existingTx.amount.toString());
        console.log('  status:    ', existingTx.status);
        console.log('  type:      ', existingTx.type);
        console.log('  createdAt: ', existingTx.createdAt);
        console.log('─────────────────────────────────────────');
        return;
    }

    console.log('❌ Transaction NOT found in DB');
    console.log('─────────────────────────────────────────');

    // ── 2. Check if wallet exists ─────────────────────────────
    const wallet = await prisma.wallet.findFirst({
        where: { subscriptionId: WEBHOOK_PAYLOAD.subscriptionId },
        include: {
            currency: { select: { id: true, ISO: true, chain: true } },
            user:     { select: { id: true, email: true } }
        }
    });

    if (wallet) {
        console.log('✅ Wallet found:');
        console.log('  walletId:       ', wallet.id);
        console.log('  depositAddress: ', wallet.depositAddress);
        console.log('  userId:         ', wallet.userId);
        console.log('  currency:       ', wallet.currency?.ISO);
        console.log('  chain:          ', wallet.currency?.chain);
        console.log('  accountBalance: ', wallet.accountBalance?.toString());
        console.log('  availableBalance:', wallet.availableBalance?.toString());
        console.log('  user email:     ', wallet.user?.email);
    } else {
        console.log('❌ Wallet NOT found for subscriptionId:', WEBHOOK_PAYLOAD.subscriptionId);
    }

    console.log('─────────────────────────────────────────');

    // ── 3. Check virtual account ──────────────────────────────
    if (wallet) {
        const virtualAccount = await prisma.virtualAccount.findFirst({
            where: { userId: wallet.user?.id, currency: wallet.currency?.ISO }
        });

        if (virtualAccount) {
            console.log('✅ Virtual account found:');
            console.log('  id:        ', virtualAccount.id);
            console.log('  balance:   ', virtualAccount.balance?.toString());
            console.log('  available: ', virtualAccount.available?.toString());
            console.log('  blockchain:', virtualAccount.blockchain);
        } else {
            console.log('❌ Virtual account NOT found');
        }
    }

    console.log('─────────────────────────────────────────');

    // ── 4. Check virtual transaction (idempotency) ────────────
    const virtualTx = await prisma.virtualTransaction.findFirst({
        where: { txHash: WEBHOOK_PAYLOAD.txId }
    });

    if (virtualTx) {
        console.log('✅ Virtual transaction found:');
        console.log('  id:        ', virtualTx.id);
        console.log('  amount:    ', virtualTx.amount?.toString());
        console.log('  status:    ', virtualTx.status);
        console.log('  type:      ', virtualTx.type);
        console.log('  createdAt: ', virtualTx.createdAt);
    } else {
        console.log('❌ Virtual transaction NOT found (not yet processed)');
    }

    console.log('─────────────────────────────────────────');

    // ── 5. Check sweep log ────────────────────────────────────
    if (wallet) {
        const sweepLog = await prisma.sweepLog.findFirst({
            where: { depositTxId: WEBHOOK_PAYLOAD.txId },
            orderBy: { createdAt: 'desc' }
        });

        if (sweepLog) {
            console.log('✅ Sweep log found:');
            console.log('  id:        ', sweepLog.id);
            console.log('  status:    ', sweepLog.status);
            console.log('  sweepTxId: ', sweepLog.sweepTxId);
            console.log('  error:     ', sweepLog.error);
            console.log('  createdAt: ', sweepLog.createdAt);
        } else {
            console.log('❌ Sweep log NOT found');
        }
    }

    console.log('─────────────────────────────────────────');
}

async function queueEvent() {
    console.log('─────────────────────────────────────────');
    console.log('Queuing webhook event for processing...');
    console.log('─────────────────────────────────────────');

    const job = await eventService.queue({
        type:                  'TATUM',
        Tatum_Address:         WEBHOOK_PAYLOAD.address,
        Tatum_CounterAddress:  WEBHOOK_PAYLOAD.counterAddress,
        Tatum_Chain:           WEBHOOK_PAYLOAD.chain,
        Tatum_Type:            undefined,
        Tatum_Amount:          WEBHOOK_PAYLOAD.amount,
        Tatum_SubscriptionId:  WEBHOOK_PAYLOAD.subscriptionId,
        Tatum_EventType:       WEBHOOK_PAYLOAD.subscriptionType,
        Tatum_TxId:            WEBHOOK_PAYLOAD.txId,
        Tatum_ContractAddress: WEBHOOK_PAYLOAD.contractAddress,
        Tatum_Asset:           undefined,
        Tatum_currency:        WEBHOOK_PAYLOAD.currency
    });

    console.log('✅ Event queued successfully');
    console.log('  Job ID:', (job as any)?.id);
    console.log('─────────────────────────────────────────');
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'investigate';

    try {
        if (command === 'investigate') {
            await investigate();
        } else if (command === 'queue') {
            await investigate();  // Always investigate first
            await queueEvent();
        } else if (command === 'force') {
            // Force queue even if already processed
            await queueEvent();
        } else {
            console.log('Usage:');
            console.log('  npm run retry-webhook investigate  — check status only');
            console.log('  npm run retry-webhook queue        — investigate then queue');
            console.log('  npm run retry-webhook force        — force queue without checks');
        }
    } catch (error: any) {
        console.error('Script failed:', error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();