import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { Decimal } from 'decimal.js';
import { 
    LedgerEntryType,
    TransactionType, 
    TransactionStatus 
} from '@prisma/client';

import Ably from 'ably';
// import { TransactionType, TransactionStatus, LedgerEntryType } from '@prisma/client';
import { ulid } from 'ulid';
import axios from 'axios';
import { encrypt, decrypt } from '../utils/encryption';
import { CHAIN_CONFIG, ChainConfig, getChainConfigByCurrency } from '../config/blockchain.config';
import gaspumpService from './gaspump.service';

       
// ==================== HELPERS ====================

function generateRef(prefix: string = 'TXN'): string {
    return `${prefix}-${ulid()}`;
}

function toDecimal(value: number | string | Decimal): Decimal {
    return new Decimal(value.toString());
}

// ==================== SERVICE ====================


class VirtualAccountService {

    // ── Create Account ──────────────────────────────────────────

    async createAccount(payload:{
        userId: string,
        currency: string,
        type: string,
        label?: string,
        xpub?: string,
        blockchain?: string
    }) {

        const { userId, currency, type = 'STANDARD', label, xpub, blockchain } = payload;

        // const existing = await prisma.virtualAccount.findUnique({
        //     where: {
        //         userId_currency_type_blockchain: {
        //             userId,
        //             currency,
        //             type: type as any,
        //             blockchain: blockchain ?? ''
        //         }
        //     }
        // });

        const existing = await prisma.virtualAccount.findFirst({
            where: {
                userId,
                currency,
                type: type as any,
                blockchain: blockchain ?? null  // ← null for fiat
            }
        });

        if (existing) return existing;

        return await prisma.virtualAccount.create({
            data: {
                userId,
                currency,
                type: type as any,
                label,
                xpub,
                blockchain,
                balance: 0,
                frozen: 0,
                available: 0,
            }
        });
    }

    async createUserAccounts(userId: string) {
        const accounts = [
            { currency: 'NGN',  blockchain: null,       xpub: null },
            { currency: 'USD',  blockchain: null,       xpub: null },
            { currency: 'ETH',  blockchain: 'ETHEREUM',      xpub: process.env.ETH_XPUB },
            { currency: 'BTC',  blockchain: 'BTC',      xpub: process.env.BTC_XPUB },
            { currency: 'USDT', blockchain: 'TRON',     xpub: process.env.TRON_XPUB },
            { currency: 'USDC', blockchain: 'ETH',      xpub: process.env.ETH_XPUB },
            { currency: 'SOL',  blockchain: 'SOL',      xpub: null },
            { currency: 'TRX',  blockchain: 'TRON',     xpub: process.env.TRON_XPUB },
            { currency: 'LTC',  blockchain: 'LTC',      xpub: process.env.LTC_XPUB },
            { currency: 'XRP',  blockchain: 'XRP',      xpub: null },
        ];

        return await Promise.all(
            accounts.map(({ currency, blockchain, xpub }) =>
                this.createAccount({
                    userId,
                    currency,
                    type: 'STANDARD',
                    xpub: xpub ?? undefined,
                    blockchain: blockchain ?? undefined
                })
            )
        );
    }

    // ── Get Account ──────────────────────────────────────────────

    async getAccount(userId: string, currency: string, type = 'STANDARD', blockchain?: string) {

        const account = await prisma.virtualAccount.findFirst({
            where: {
                userId,
                currency,
                type: type as any,
                blockchain: blockchain ?? null  // ← null for fiat, chain name for crypto
            }
        });

        if (!account) throw new Error(`Account not found for ${currency}${blockchain ? ` on ${blockchain}` : ''}`);
        return account;
    }

    async getAccountById(accountId: string) {
        const account = await prisma.virtualAccount.findUnique({
            where: { id: accountId }
        });
        if (!account) throw new Error('Account not found');
        return account;
    }

    async getAllAccounts(userId: string) {
        return await prisma.virtualAccount.findMany({
            where: { userId, status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' }
        });
    }

    async getBalance(userId: string, currency: string,  blockchain?: string) {
        const account = await this.getAccount(userId, currency, 'STANDARD', blockchain);
        return {
            balance: account.balance,
            frozen: account.frozen,
            available: account.available,
            currency: account.currency
        };
    }

    // ── P2P Transfer ─────────────────────────────────────────────

    async p2pTransfer(payload:{
        fromUserId: string,
        toUserId: string,
        amount: string,
        currency: string,
        blockchain?: string,
        description?: string,
        metadata?: any
    }) {

        const {fromUserId, toUserId, amount, currency, blockchain ,description, metadata} = payload
        const decimalAmount = toDecimal(amount);

        if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');
        if (fromUserId === toUserId) throw new Error('Cannot transfer to yourself');

        // const fromAccount = await this.getAccount(fromUserId, currency);
        // const toAccount = await this.getAccount(toUserId, currency);
        const fromAccount = await this.getAccount(fromUserId, currency, 'STANDARD', blockchain);
        const toAccount = await this.getAccount(toUserId, currency, 'STANDARD', blockchain);
        const fee = await this.calculateFee('P2P_TRANSFER', decimalAmount, currency);
        const netAmount = decimalAmount.minus(fee);
        const reference = generateRef('P2P');

        return await prisma.$transaction(async (tx) => {

            // Pessimistic lock - consistent order prevents deadlock
            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id IN (${fromAccount.id}, ${toAccount.id})
                ORDER BY id
                FOR UPDATE
            `;

            // Re-fetch inside transaction with locked rows
            const from = await tx.virtualAccount.findUnique({
                where: { id: fromAccount.id }
            });

            if (!from) throw new Error('Sender account not found');
            if (from.status !== 'ACTIVE') throw new Error('Sender account is not active');
            if (toDecimal(from.available).lt(decimalAmount)) {
                throw new Error('Insufficient balance');
            }

            const transaction = await tx.virtualTransaction.create({
                data: {
                    fromAccountId: fromAccount.id,
                    toAccountId: toAccount.id,
                    amount: decimalAmount,
                    fee,
                    netAmount,
                    currency,
                    type: 'P2P_TRANSFER',
                    status: 'COMPLETED',
                    reference,
                    description,
                    metadata,
                    completedAt: new Date()
                }
            });

            // Debit sender
            await tx.virtualAccount.update({
                where: { id: fromAccount.id },
                data: {
                    balance: { decrement: decimalAmount },
                    available: { decrement: decimalAmount },
                }
            });

            // Credit receiver
            await tx.virtualAccount.update({
                where: { id: toAccount.id },
                data: {
                    balance: { increment: netAmount },
                    available: { increment: netAmount },
                }
            });

            // Ledger entries
            await tx.ledgerEntry.createMany({
                data: [
                    {
                        debitAccountId: fromAccount.id,
                        creditAccountId: toAccount.id,
                        amount: netAmount,
                        currency,
                        type: 'TRANSFER',
                        status: 'COMPLETED',
                        reference: generateRef('LE'),
                        description: `P2P transfer to ${toUserId}`,
                        transactionId: transaction.id
                    },
                    ...(fee.gt(0) ? [{
                        debitAccountId: fromAccount.id,
                        creditAccountId: fromAccount.id,
                        amount: fee,
                        currency,
                        type: 'FEE' as LedgerEntryType,
                        status: 'COMPLETED' as any,
                        reference: generateRef('FEE'),
                        description: 'P2P transfer fee',
                        transactionId: transaction.id
                    }] : [])
                ]
            });

            return { transaction, amount: decimalAmount, fee, netAmount, reference };

        }, { isolationLevel: 'Serializable' });
    }


    // ── Bank Withdrawal ─────────────────────────────────────────

    async initiateBankWithdrawal(payload: {
        userId: string,
        currency: string,
        amount: string,
        bankDetails: {
            accountNumber: string,
            bankCode: string,
            accountName: string
        },
        reference?: string,
        metadata?: any
    }) {

        const { userId, currency, amount, bankDetails, reference, metadata } = payload;
        
        const decimalAmount = toDecimal(amount);
        const account = await this.getAccount(userId, currency);
        const fee = await this.calculateFee('BANK_WITHDRAWAL', decimalAmount, currency);
        const totalDebit = decimalAmount.plus(fee);
        const generated_Reference = generateRef('WDR');

        return await prisma.$transaction(async (tx) => {

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${account.id}
                FOR UPDATE
            `;

            const acc = await tx.virtualAccount.findUnique({
                where: { id: account.id }
            });

            if (!acc) throw new Error('Account not found');
            if (acc.status !== 'ACTIVE') throw new Error('Account is not active');
            if (toDecimal(acc.available).lt(totalDebit)) {
                throw new Error('Insufficient balance');
            }

            // Create block for funds
            const block = await tx.block.create({
                data: {
                    walletId: account.id,
                    amount: totalDebit,
                    description: `Bank withdrawal pending - ${reference}`,
                    active: true,
                }
            });

            const transaction = await tx.virtualTransaction.create({
                data: {
                    fromAccountId: account.id,
                    amount: decimalAmount,
                    fee,
                    netAmount: decimalAmount,
                    currency,
                    type: 'BANK_WITHDRAWAL',
                    status: 'PENDING',
                    reference: reference ?? generated_Reference,
                    blockId: block.id,
                    bankDetails,
                    metadata
                }
            });

            // Freeze funds
            await tx.virtualAccount.update({
                where: { id: account.id },
                data: {
                    frozen: { increment: totalDebit },
                    available: { decrement: totalDebit },
                }
            });

            return { transaction, block, reference };

        }, { isolationLevel: 'Serializable' });
    }

    async completeBankWithdrawal(payload: {
        transactionId: string,
        blockId: string,
        externalRef?: string
    }) {

        const { transactionId, blockId, externalRef } = payload;

        return await prisma.$transaction(async (tx) => {

            const transaction = await tx.virtualTransaction.findUnique({
                where: { id: transactionId }
            });

            if (!transaction) throw new Error('Transaction not found');
            if (transaction.status !== 'PENDING') {
                throw new Error('Transaction is not pending');
            }

            const block = await tx.block.findUnique({
                where: { id: blockId }
            });

            if (!block) throw new Error('Block not found');
            if (!block.active) throw new Error('Block is not active');

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${transaction.fromAccountId}
                FOR UPDATE
            `;

            const totalDebit = toDecimal(transaction.amount)
                .plus(toDecimal(transaction.fee));

            // Deduct from balance and frozen permanently
            await tx.virtualAccount.update({
                where: { id: transaction.fromAccountId! },
                data: {
                    balance: { decrement: totalDebit },
                    frozen: { decrement: totalDebit },
                }
            });

            // Deactivate block
            await tx.block.update({
                where: { id: blockId },
                data: { active: false, amount: 0 }
            });

            // Ledger entry
            await tx.ledgerEntry.create({
                data: {
                    debitAccountId: transaction.fromAccountId!,
                    creditAccountId: transaction.fromAccountId!,
                    amount: transaction.amount,
                    currency: transaction.currency,
                    type: 'WITHDRAWAL',
                    status: 'COMPLETED',
                    reference: externalRef || generateRef('LE'),
                    description: 'Bank withdrawal completed',
                    transactionId
                }
            });

            return await tx.virtualTransaction.update({
                where: { id: transactionId },
                data: {
                    status: 'COMPLETED',
                    // externalRef,
                    completedAt: new Date()
                }
            });

        }, { isolationLevel: 'Serializable' });
    }


    async failBankWithdrawal(payload: {
        transactionId: string,
        blockId: string,
        reason: string
    }) {

        const { transactionId, blockId, reason } = payload;

        return await prisma.$transaction(async (tx) => {

            const transaction = await tx.virtualTransaction.findUnique({
                where: { id: transactionId }
            });

            if (!transaction) throw new Error('Transaction not found');

            const block = await tx.block.findUnique({
                where: { id: blockId }
            });

            if (!block || !block.active) throw new Error('Block not found or already inactive');

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${transaction.fromAccountId}
                FOR UPDATE
            `;

            const totalDebit = toDecimal(transaction.amount)
                .plus(toDecimal(transaction.fee));

            // Release frozen funds back to available
            await tx.virtualAccount.update({
                where: { id: transaction.fromAccountId! },
                data: {
                    frozen: { decrement: totalDebit },
                    available: { increment: totalDebit },
                }
            });

            // Deactivate block
            await tx.block.update({
                where: { id: blockId },
                data: { active: false, amount: 0 }
            });

            return await tx.virtualTransaction.update({
                where: { id: transactionId },
                data: { status: 'FAILED', failureReason: reason }
            });

        }, { isolationLevel: 'Serializable' });
    }

    // ── Crypto Deposit ───────────────────────────────────────────

    async cryptoDeposit(payload: {
        userId: string,
        accountId: string,
        currency: string,
        amount: string,
        txHash: string,
        // blockchain: string,
        walletAddress: string,
        contractAddress?: string,
        metadata?: any
    }) {

        const { userId, contractAddress, accountId, currency, amount, txHash, walletAddress, metadata } = payload;

        const decimalAmount = toDecimal(amount);
        const account = await this.getAccountById(accountId);
        const reference = generateRef('DEP');

        // ── Validate contract address against account's chain config ──
        if (contractAddress && account.blockchain) {
            const chainConfig = getChainConfigByCurrency(
                account.blockchain,
                account.currency
            );

            if (chainConfig?.tokenMint) {
                const expectedContract = chainConfig.tokenMint.toLowerCase();
                const receivedContract = contractAddress.toLowerCase();

                if (expectedContract !== receivedContract) {
                    throw new Error(
                        `Contract address mismatch for ${account.currency} on ${account.blockchain}. ` +
                        `Expected: ${expectedContract}, Received: ${receivedContract}`
                    );
                }
            }
        }

        return await prisma.$transaction(async (tx) => {

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${account.id}
                FOR UPDATE
            `;

            // Check for duplicate inside transaction
            const existing = await tx.virtualTransaction.findFirst({
                where: { txHash }
            });
            if (existing) throw new Error('Transaction already processed');

            const transaction = await tx.virtualTransaction.create({
                data: {
                    toAccountId: account.id,
                    amount: decimalAmount,
                    fee: 0,
                    netAmount: decimalAmount,
                    currency,
                    type: 'CRYPTO_DEPOSIT',
                    status: 'COMPLETED',
                    reference,
                    txHash,
                    blockchain: account.blockchain,
                    walletAddress,
                    metadata,
                    completedAt: new Date()
                }
            });

            // Credit account
            await tx.virtualAccount.update({
                where: { id: account.id },
                data: {
                    balance: { increment: decimalAmount },
                    available: { increment: decimalAmount },
                }
            });

            // Ledger entry
            await tx.ledgerEntry.create({
                data: {
                    debitAccountId: account.id,
                    creditAccountId: account.id,
                    amount: decimalAmount,
                    currency,
                    type: 'DEPOSIT',
                    status: 'COMPLETED',
                    reference: generateRef('LE'),
                    description: `Crypto deposit - ${txHash}`,
                    transactionId: transaction.id
                }
            });

            return { transaction, reference };

        }, { isolationLevel: 'Serializable' });
    }

    // ── Currency Exchange ────────────────────────────────────────

    async exchangeCurrency(
        userId: string,
        fromCurrency: string,
        toCurrency: string,
        amount: string,
        exchangeRate: string,
        metadata?: any
    ) {
        const decimalAmount = toDecimal(amount);
        const rate = toDecimal(exchangeRate);
        const convertedAmount = decimalAmount.times(rate);

        const fromAccount = await this.getAccount(userId, fromCurrency);
        const toAccount = await this.getAccount(userId, toCurrency);
        const fee = await this.calculateFee('CURRENCY_EXCHANGE', decimalAmount, fromCurrency);
        const totalDebit = decimalAmount.plus(fee);
        const reference = generateRef('EXC');

        return await prisma.$transaction(async (tx) => {

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id IN (${fromAccount.id}, ${toAccount.id})
                ORDER BY id
                FOR UPDATE
            `;

            const from = await tx.virtualAccount.findUnique({
                where: { id: fromAccount.id }
            });

            if (!from) throw new Error('Account not found');
            if (from.status !== 'ACTIVE') throw new Error('Account is not active');
            if (toDecimal(from.available).lt(totalDebit)) {
                throw new Error('Insufficient balance for exchange');
            }

            // Debit from account
            await tx.virtualAccount.update({
                where: { id: fromAccount.id },
                data: {
                    balance: { decrement: totalDebit },
                    available: { decrement: totalDebit },
                }
            });

            // Credit to account
            await tx.virtualAccount.update({
                where: { id: toAccount.id },
                data: {
                    balance: { increment: convertedAmount },
                    available: { increment: convertedAmount },
                }
            });

            const transaction = await tx.virtualTransaction.create({
                data: {
                    fromAccountId: fromAccount.id,
                    toAccountId: toAccount.id,
                    amount: decimalAmount,
                    fee,
                    netAmount: decimalAmount,
                    currency: fromCurrency,
                    fromCurrency,
                    toCurrency,
                    exchangeRate: rate,
                    convertedAmount,
                    type: 'CURRENCY_EXCHANGE',
                    status: 'COMPLETED',
                    reference,
                    metadata,
                    completedAt: new Date()
                }
            });

            await tx.ledgerEntry.createMany({
                data: [
                    {
                        debitAccountId: fromAccount.id,
                        creditAccountId: toAccount.id,
                        amount: decimalAmount,
                        currency: fromCurrency,
                        type: 'EXCHANGE',
                        status: 'COMPLETED',
                        reference: generateRef('LE'),
                        description: `Exchange ${fromCurrency} to ${toCurrency}`,
                        transactionId: transaction.id
                    },
                    ...(fee.gt(0) ? [{
                        debitAccountId: fromAccount.id,
                        creditAccountId: fromAccount.id,
                        amount: fee,
                        currency: fromCurrency,
                        type: 'FEE' as LedgerEntryType,
                        status: 'COMPLETED' as any,
                        reference: generateRef('FEE'),
                        description: 'Exchange fee',
                        transactionId: transaction.id
                    }] : [])
                ]
            });

            return {
                transaction,
                fromAmount: decimalAmount,
                toAmount: convertedAmount,
                rate,
                fee,
                reference
            };

        }, { isolationLevel: 'Serializable' });
    }

    // ── Fee Calculation ──────────────────────────────────────────

    async calculateFee(
        type: TransactionType,
        amount: Decimal,
        currency: string
    ): Promise<Decimal> {
        const feeConfig = await prisma.feeConfig.findFirst({
            where: {
                type,
                isActive: true,
                OR: [{ currency }, { currency: null }]
            },
            orderBy: { currency: 'desc' }
        });

        if (!feeConfig) return toDecimal(0);

        let fee: Decimal;

        if (feeConfig.feeType === 'PERCENTAGE') {
            fee = amount.times(feeConfig.feeValue).div(100);
        } else if (feeConfig.feeType === 'FLAT') {
            fee = toDecimal(feeConfig.feeValue);
        } else {
            // HYBRID
            fee = amount.times(feeConfig.feeValue).div(100)
                .plus(toDecimal(feeConfig.feeValue));
        }

        if (feeConfig.minFee && fee.lt(toDecimal(feeConfig.minFee))) {
            fee = toDecimal(feeConfig.minFee);
        }
        if (feeConfig.maxFee && fee.gt(toDecimal(feeConfig.maxFee))) {
            fee = toDecimal(feeConfig.maxFee);
        }

        return fee;
    }

    // ── Credit Virtual Account ───────────────────────────────────
    // Use for: deposits, incoming transfers, admin adjustments

    async creditAccount(payload: { 
        accountId: string,
        amount: string,
        description?: string,
        transactionId?: string,
        metadata?: any
    }) {
        const { accountId, amount, description, transactionId, metadata } = payload;

        const decimalAmount = toDecimal(amount);
        if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');

        return await prisma.$transaction(async (tx) => {

            // Pessimistic lock
            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${accountId}
                FOR UPDATE
            `;

            const account = await tx.virtualAccount.findUnique({
                where: { id: accountId }
            });

            if (!account) throw new Error('Account not found');
            if (account.status !== 'ACTIVE') throw new Error('Account is not active');

            // Credit balance
            const updated = await tx.virtualAccount.update({
                where: { id: accountId },
                data: {
                    balance:   { increment: decimalAmount },
                    available: { increment: decimalAmount },
                }
            });

            // Ledger entry
            await tx.ledgerEntry.create({
                data: {
                    debitAccountId:  accountId,
                    creditAccountId: accountId,
                    amount:          decimalAmount,
                    currency:        account.currency,
                    type:            'DEPOSIT',
                    status:          'COMPLETED',
                    reference:       generateRef('CR'),
                    description:     description ?? `Credit — ${account.currency}`,
                    metadata,
                    transactionId
                }
            });

            return updated;

        }, { isolationLevel: 'Serializable' });
    }

    // ── Debit Virtual Account ────────────────────────────────────
    // Use for: withdrawals, outgoing transfers, admin adjustments

    async debitAccount(payload: {
        accountId: string,
        amount: string,
        description?: string,
        transactionId?: string,
        metadata?: any
    }) {
        const { accountId, amount, description, transactionId, metadata } = payload;

        const decimalAmount = toDecimal(amount);
        if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');

        return await prisma.$transaction(async (tx) => {

            // Pessimistic lock
            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${accountId}
                FOR UPDATE
            `;

            const account = await tx.virtualAccount.findUnique({
                where: { id: accountId }
            });

            if (!account) throw new Error('Account not found');
            if (account.status !== 'ACTIVE') throw new Error('Account is not active');
            if (toDecimal(account.available).lt(decimalAmount)) {
                throw new Error('Insufficient balance');
            }

            // Debit balance
            const updated = await tx.virtualAccount.update({
                where: { id: accountId },
                data: {
                    balance:   { decrement: decimalAmount },
                    available: { decrement: decimalAmount },
                }
            });

            // Ledger entry
            await tx.ledgerEntry.create({
                data: {
                    debitAccountId:  accountId,
                    creditAccountId: accountId,
                    amount:          decimalAmount,
                    currency:        account.currency,
                    type:            'WITHDRAWAL',
                    status:          'COMPLETED',
                    reference:       generateRef('DR'),
                    description:     description ?? `Debit — ${account.currency}`,
                    metadata,
                    transactionId
                }
            });

            return updated;

        }, { isolationLevel: 'Serializable' });
    }



    // ── Transaction History ──────────────────────────────────────

    async getTransactions(
        userId: string,
        currency?: string,
        type?: TransactionType,
        status?: TransactionStatus,
        page: number = 1,
        limit: number = 20
    ) {
        const account = currency
            ? await this.getAccount(userId, currency)
            : null;

        const where: any = {
            ...(account ? {
                OR: [
                    { fromAccountId: account.id },
                    { toAccountId: account.id }
                ]
            } : {}),
            ...(type ? { type } : {}),
            ...(status ? { status } : {})
        };

        const [transactions, total] = await Promise.all([
            prisma.virtualTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.virtualTransaction.count({ where })
        ]);

        return {
            transactions,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        };
    }

    // ── Account Management ───────────────────────────────────────

    async freezeAccount(accountId: string) {
        return await prisma.virtualAccount.update({
            where: { id: accountId },
            data: { status: 'FROZEN' }
        });
    }

    async unfreezeAccount(accountId: string) {
        return await prisma.virtualAccount.update({
            where: { id: accountId },
            data: { status: 'ACTIVE' }
        });
    }

    // ── Reconciliation ───────────────────────────────────────────

    async reconcileAccount(accountId: string) {
        const account = await prisma.virtualAccount.findUnique({
            where: { id: accountId }
        });

        if (!account) throw new Error('Account not found');

        const credits = await prisma.ledgerEntry.aggregate({
            where: { creditAccountId: accountId, status: 'COMPLETED' },
            _sum: { amount: true }
        });

        const debits = await prisma.ledgerEntry.aggregate({
            where: { debitAccountId: accountId, status: 'COMPLETED' },
            _sum: { amount: true }
        });

        const expectedBalance = toDecimal(credits._sum.amount || 0)
            .minus(toDecimal(debits._sum.amount || 0));

        const difference = toDecimal(account.balance)
            .minus(expectedBalance);

        return await prisma.ledgerReconciliation.create({
            data: {
                accountId,
                currency: account.currency,
                expectedBalance,
                actualBalance: account.balance,
                difference,
                status: difference.isZero() ? 'MATCHED' : 'DISCREPANCY'
            }
        });
    }

    // ── Block Management ─────────────────────────────────────────
    // Block funds in an account (replaces AccountHold)

    async createBlock(payload: {
        accountId: string,
        amount: string,
        description: string,
    }) {
        const { accountId, amount, description } = payload;

        const decimalAmount = toDecimal(amount);

        return await prisma.$transaction(async (tx) => {

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${accountId}
                FOR UPDATE
            `;

            const account = await tx.virtualAccount.findUnique({
                where: { id: accountId }
            });

            if (!account) throw new Error('Account not found');
            if (account.status !== 'ACTIVE') throw new Error('Account is not active');
            if (toDecimal(account.available).lt(decimalAmount)) {
                throw new Error('Insufficient available balance to block');
            }

            const block = await tx.block.create({
                data: {
                    walletId: accountId,
                    amount: decimalAmount,
                    description,
                    active: true,
                }
            });

            await tx.virtualAccount.update({
                where: { id: accountId },
                data: {
                    frozen: { increment: decimalAmount },
                    available: { decrement: decimalAmount },
                }
            });

            return block;

        }, { isolationLevel: 'Serializable' });
    }

    // Transfer amount from a block (partial or full use of blocked funds)
    async transferFromBlock(payload: {
        blockId: string,
        toAccountId: string,
        amount: string,
        description?: string
    }) {

        const { blockId, toAccountId, amount, description } = payload;

        const decimalAmount = toDecimal(amount);

        return await prisma.$transaction(async (tx) => {

            const block = await tx.block.findUnique({
                where: { id: blockId }
            });

            if (!block) throw new Error('Block not found');
            if (!block.active) throw new Error('Block is not active');
            if (!block.walletId) throw new Error('Block has no associated account');

            const toAccount = await tx.virtualAccount.findUnique({
                where: { id: toAccountId }
            });

            if (!toAccount) throw new Error('Destination account not found');
            if (toAccount.status !== 'ACTIVE') {
                throw new Error('Destination account is not active');
            }

            if (toDecimal(block.amount).lt(decimalAmount)) {
                throw new Error('Transfer amount exceeds blocked amount');
            }

            // Pessimistic lock both accounts in consistent order
            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id IN (${block.walletId}, ${toAccountId})
                ORDER BY id
                FOR UPDATE
            `;

            const fromAccount = await tx.virtualAccount.findUnique({
                where: { id: block.walletId }
            });

            if (!fromAccount) throw new Error('Source account not found');

            const remainingAmount = toDecimal(block.amount).minus(decimalAmount);
            const isFullyUsed = remainingAmount.isZero();

            // Deduct from sender balance and frozen
            await tx.virtualAccount.update({
                where: { id: block.walletId },
                data: {
                    balance: { decrement: decimalAmount },
                    frozen: { decrement: decimalAmount },
                }
            });

            // Credit destination account
            await tx.virtualAccount.update({
                where: { id: toAccountId },
                data: {
                    balance: { increment: decimalAmount },
                    available: { increment: decimalAmount },
                }
            });

            // Update block
            const updatedBlock = await tx.block.update({
                where: { id: blockId },
                data: {
                    amount: remainingAmount,
                    active: !isFullyUsed,
                    description: description ?? block.description,
                }
            });

            // Ledger entry
            await tx.ledgerEntry.create({
                data: {
                    debitAccountId: block.walletId,
                    creditAccountId: toAccountId,
                    amount: decimalAmount,
                    currency: fromAccount.currency,
                    type: 'TRANSFER',
                    status: 'COMPLETED',
                    reference: generateRef('BLK'),
                    description: description ?? `Transfer from block ${blockId}`,
                }
            });

            return {
                block: updatedBlock,
                transferred: decimalAmount,
                remaining: remainingAmount,
                fullyUsed: isFullyUsed,
                fromAccountId: block.walletId,
                toAccountId,
            };

        }, { isolationLevel: 'Serializable' });
    }

    // Unblock - release all frozen funds back to available
    async unblock(blockId: string) {
        return await prisma.$transaction(async (tx) => {

            const block = await tx.block.findUnique({
                where: { id: blockId }
            });

            if (!block) throw new Error('Block not found');
            if (!block.active) throw new Error('Block is already inactive');
            if (!block.walletId) throw new Error('Block has no associated account');

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${block.walletId}
                FOR UPDATE
            `;

            await tx.virtualAccount.update({
                where: { id: block.walletId },
                data: {
                    frozen: { decrement: block.amount },
                    available: { increment: block.amount },
                }
            });

            return await tx.block.update({
                where: { id: blockId },
                data: { active: false, amount: 0 }
            });

        }, { isolationLevel: 'Serializable' });
    }

    // Get all active blocks for an account
    async getActiveBlocks(accountId: string) {
        return await prisma.block.findMany({
            where: { walletId: accountId, active: true },
            orderBy: { createdAt: 'desc' }
        });
    }

    // ── Blockchain Address Management ────────────────────────────\

    private async getNextIndex(xpub: string, blockchain: string): Promise<number> {
        const xpubIndex = await prisma.xpubIndex.upsert({
            where: { xpub_blockchain: { xpub, blockchain } },
            update: { lastIndex: { increment: 1 } },
            create: { xpub, blockchain, lastIndex: 0 }
        });

        return xpubIndex.lastIndex;
    }

    async generateHDAddress(
        blockchain: string,
        xpub: string,
        index: number
    ): Promise<string> {
        const config = CHAIN_CONFIG[blockchain.toUpperCase()];
        if (!config) throw new Error(`Unsupported blockchain: ${blockchain}`);
        if (config.walletType !== 'HD') throw new Error(`${blockchain} is not an HD wallet chain`);
        if (!config.tatumEndpoint) throw new Error(`No endpoint configured for ${blockchain}`);

        const response = await axios.get(
            `${config.tatumEndpoint}/${xpub}/${index}`,
            {
                headers: { 'x-api-key': process.env.TATUM_LIVE_KEY! }
            }
        );

        const address = response.data?.address;
        if (!address) throw new Error(`Failed to generate address for ${blockchain}`);

        return address;
    }

    async generateKeypairWallet(blockchain: string): Promise<{
        address: string;
        privateKey: string;
        mnemonic?: string;
    }> {
        const config = CHAIN_CONFIG[blockchain.toUpperCase()];
        if (!config) throw new Error(`Unsupported blockchain: ${blockchain}`);
        if (config.walletType !== 'KEYPAIR') throw new Error(`${blockchain} is not a keypair chain`);
        if (!config.tatumWalletEndpoint) throw new Error(`No wallet endpoint configured for ${blockchain}`);

        const response = await axios.get(
            config.tatumWalletEndpoint,
            {
                headers: { 'x-api-key': process.env.TATUM_LIVE_KEY! }
            }
        );

        const data = response.data;
        const address = data?.address || data?.account;
        const privateKey = data?.privateKey || data?.secret;
        const mnemonic = data?.mnemonic;
        

        if (!address || !privateKey) {
            throw new Error(`Failed to generate keypair wallet for ${blockchain}`);
        }

        return { address, privateKey, mnemonic };
    }

    async connectHDAddress(
        virtualAccountId: string,
        blockchain: string,
        address: string,
        xpub: string,
        index: number | null,
        chainConfig?: ChainConfig,
        metadata?: any
    ) {
        const existing = await prisma.virtualAccountAddress.findUnique({
            where: {
                address_blockchain_tokenMint: {
                    address,
                    blockchain,
                    tokenMint: chainConfig?.tokenMint ?? ''
                }
            }
        });
        if (existing) throw new Error('Address already connected');

        // Only check index uniqueness if index is provided
        // if (index !== null && index !== undefined) {
        //     const indexUsed = await prisma.virtualAccountAddress.findUnique({
        //         where: { xpub_index_blockchain: { xpub, index, blockchain } }
        //     });
        //     if (indexUsed) throw new Error(`Index ${index} already used for this xpub on ${blockchain}`);

        // }
    

        return await prisma.virtualAccountAddress.create({
            data: {
                virtualAccountId,
                blockchain,
                address,
                xpub,
                index: index ?? null,  // ← store null if no index
                isActive: true,
                isToken: chainConfig?.isToken ?? false,
                tokenMint: chainConfig?.tokenMint,
                tokenSymbol: chainConfig?.tokenSymbol,
                tokenStandard: chainConfig?.tokenStandard,
                metadata
            }
        });
    }

    async connectKeypairAddress(
        virtualAccountId: string,
        blockchain: string,
        address: string,
        privateKey: string,
        mnemonic?: string,
        chainConfig?: ChainConfig,
        metadata?: any
    ) {
        const existing = await prisma.virtualAccountAddress.findUnique({
            where: {
                address_blockchain_tokenMint: {
                    address,
                    blockchain,
                    tokenMint: chainConfig?.tokenMint ?? ''
                }
            }
        });
        if (existing) throw new Error('Address already connected');

        const encryptedPrivateKey = encrypt(privateKey);
        const encryptedMnemonic = mnemonic ? encrypt(mnemonic) : undefined;

        return await prisma.virtualAccountAddress.create({
            data: {
                virtualAccountId,
                blockchain,
                address,
                encryptedPrivateKey,
                encryptedMnemonic,
                isActive: true,
                isToken: chainConfig?.isToken ?? false,
                tokenMint: chainConfig?.tokenMint,
                tokenSymbol: chainConfig?.tokenSymbol,
                tokenStandard: chainConfig?.tokenStandard,
                metadata
            }
        });
    }

    async generateAndConnectAddress(
        virtualAccountId: string,
        chainKey: string,
        address?: string,  // pre-generated address from gas pump
        xpub?: string,
    ): Promise<{
        address: string;
        blockchain: string;
        walletType: 'HD' | 'KEYPAIR';
        index?: number;
        isToken: boolean;
        tokenSymbol?: string;
    }> {
        const account = await prisma.virtualAccount.findUnique({
            where: { id: virtualAccountId }
        });

        if (!account) throw new Error('Virtual account not found');

        const config = CHAIN_CONFIG[chainKey.toUpperCase()];
        console.log('chainconfig',config)
        if (!config) throw new Error(`Unsupported chain: ${chainKey}`);

        const { blockchain, walletType } = config;

        // ── HD wallet ────────────────────────────────────────────
        if (walletType === 'HD') {

            const accountXpub = config.xpub ?? xpub ?? account.xpub ?? undefined

            if (!accountXpub) throw new Error(`xpub is required for ${blockchain}`);

            // ── Gas pump address provided — connect it directly ──
            // No need to generate a new one from Tatum
            if (address) {

                // Check if address already connected to this account
                const existing = await prisma.virtualAccountAddress.findFirst({
                    where: { virtualAccountId, blockchain, isActive: true }
                });

                if (existing) {
                    return {
                        address: existing.address,
                        blockchain,
                        walletType: 'HD',
                        index: existing.index ?? undefined,
                        isToken: config.isToken ?? false,
                        tokenSymbol: config.tokenSymbol
                    };
                }

                // Connect the gas pump address directly
                // No index needed since gas pump manages its own index via GasPumpLog
                await this.connectHDAddress(
                    virtualAccountId,
                    blockchain,
                    address,
                    accountXpub,
                    null, // index managed by gas pump service
                    config
                );

                return {
                    address,
                    blockchain,
                    walletType: 'HD',
                    isToken: config.isToken ?? false,
                    tokenSymbol: config.tokenSymbol
                };
            }

            // ── No address provided — generate from Tatum ────────
            const index = await this.getNextIndex(accountXpub, blockchain);
            const generatedAddress = await this.generateHDAddress(blockchain, accountXpub, index);

            await this.connectHDAddress(
                virtualAccountId,
                blockchain,
                generatedAddress,
                accountXpub,
                index,
                config
            );

            return {
                address: generatedAddress,
                blockchain,
                walletType: 'HD',
                index,
                isToken: config.isToken ?? false,
                tokenSymbol: config.tokenSymbol
            };
        }

        // ── Keypair chain ────────────────────────────────────────
        if (walletType === 'KEYPAIR') {

            // Check if this account already has an address generated
            const existingAddress = await prisma.virtualAccountAddress.findFirst({
                where: {
                    virtualAccountId,
                    blockchain,
                    isActive: true
                }
            });

            // Already has an address - return it, don't generate a new one
            if (existingAddress) {
                return {
                    address: existingAddress.address,
                    blockchain,
                    walletType: 'KEYPAIR',
                    isToken: config.isToken ?? false,
                    tokenSymbol: config.tokenSymbol
                };
            }

            // Generate fresh keypair for this account
            const { address: generatedAddress, privateKey, mnemonic } =
                await this.generateKeypairWallet(blockchain);

            await this.connectKeypairAddress(
                virtualAccountId,
                blockchain,
                generatedAddress,
                privateKey,
                mnemonic,
                config
            );

            return {
                address: generatedAddress,
                blockchain,
                walletType: 'KEYPAIR',
                isToken: config.isToken ?? false,
                tokenSymbol: config.tokenSymbol
            };
        }

        throw new Error(`Unknown wallet type for ${chainKey}`);
    }

    async transferCryptoToExternal(payload:{
        virtualAccountId: string,
        toAddress: string,
        amount: string,
        chainKey: string,
        metadata?: any
    }): Promise<{
        txHash: string;
        reference: string;
        amount: Decimal;
        fee: Decimal;
        toAddress: string;
    }> {

        const { virtualAccountId, toAddress, amount, chainKey, metadata } = payload;

        const decimalAmount = toDecimal(amount);

        if (decimalAmount.lte(0)) throw new Error('Amount must be greater than 0');

        const config = CHAIN_CONFIG[chainKey.toUpperCase()];
        if (!config) throw new Error(`Unsupported chain: ${chainKey}`);

        // Get virtual account
        const account = await prisma.virtualAccount.findUnique({
            where: { id: virtualAccountId }
        });
        if (!account) throw new Error('Virtual account not found');
        if (account.status !== 'ACTIVE') throw new Error('Account is not active');

        // Get the blockchain address for this account
        const addressRecord = await prisma.virtualAccountAddress.findFirst({
            where: {
                virtualAccountId,
                blockchain: config.blockchain,
                isActive: true
            }
        });
        if (!addressRecord) throw new Error(`No ${config.blockchain} address found for this account`);

        // Calculate fee
        const fee = await this.calculateFee('CRYPTO_WITHDRAWAL', decimalAmount, account.currency);
        const totalDebit = decimalAmount.plus(fee);

        // Check balance
        if (toDecimal(account.available).lt(totalDebit)) {
            throw new Error('Insufficient balance');
        }

        const reference = generateRef('CWD');

        // ── Step 1: Create pending transaction and freeze funds ──────
        const { transaction, block } = await prisma.$transaction(async (tx) => {

            await tx.$queryRaw`
                SELECT id FROM "VirtualAccount"
                WHERE id = ${virtualAccountId}
                FOR UPDATE
            `;

            // Re-check balance inside transaction
            const acc = await tx.virtualAccount.findUnique({
                where: { id: virtualAccountId }
            });

            if (toDecimal(acc!.available).lt(totalDebit)) {
                throw new Error('Insufficient balance');
            }

            // Create pending transaction
            const transaction = await tx.virtualTransaction.create({
                data: {
                    fromAccountId: virtualAccountId,
                    amount: decimalAmount,
                    fee,
                    netAmount: decimalAmount,
                    currency: account.currency,
                    type: 'CRYPTO_WITHDRAWAL',
                    status: 'PENDING',
                    reference,
                    blockchain: config.blockchain,
                    walletAddress: toAddress,
                    metadata,
                }
            });

            // Freeze funds
            const block = await tx.block.create({
                data: {
                    walletId: virtualAccountId,
                    amount: totalDebit,
                    description: `Crypto withdrawal pending - ${reference}`,
                    active: true,
                }
            });

            // Move from available to frozen
            await tx.virtualAccount.update({
                where: { id: virtualAccountId },
                data: {
                    frozen: { increment: totalDebit },
                    available: { decrement: totalDebit },
                }
            });

            return { transaction, block };

        }, { isolationLevel: 'Serializable' });

        // ── Step 2: Call Tatum to broadcast transaction ──────────────
        try {
            // const txHash = await this.broadcastToTatum(
            //     config,
            //     addressRecord,
            //     toAddress,
            //     decimalAmount,
            //     fee
            // );

            const txHash = config.isToken
              ? await this.broadcastTokenToTatum(config, addressRecord, toAddress, decimalAmount)
              : await this.broadcastNativeToTatum(config, addressRecord, toAddress, decimalAmount, fee);

            // ── Step 3: Complete transaction on success ──────────────
            await prisma.$transaction(async (tx) => {

                await tx.$queryRaw`
                    SELECT id FROM "VirtualAccount"
                    WHERE id = ${virtualAccountId}
                    FOR UPDATE
                `;

                // Deduct from balance and frozen permanently
                await tx.virtualAccount.update({
                    where: { id: virtualAccountId },
                    data: {
                        balance: { decrement: totalDebit },
                        frozen: { decrement: totalDebit },
                    }
                });

                // Deactivate block
                await tx.block.update({
                    where: { id: block.id },
                    data: { active: false, amount: 0 }
                });

                // Ledger entry
                await tx.ledgerEntry.create({
                    data: {
                        debitAccountId: virtualAccountId,
                        creditAccountId: virtualAccountId,
                        amount: decimalAmount,
                        currency: account.currency,
                        type: 'WITHDRAWAL',
                        status: 'COMPLETED',
                        reference: generateRef('LE'),
                        description: `Crypto withdrawal to ${toAddress}`,
                        transactionId: transaction.id
                    }
                });

                // Fee ledger entry
                if (fee.gt(0)) {
                    await tx.ledgerEntry.create({
                        data: {
                            debitAccountId: virtualAccountId,
                            creditAccountId: virtualAccountId,
                            amount: fee,
                            currency: account.currency,
                            type: 'FEE',
                            status: 'COMPLETED',
                            reference: generateRef('FEE'),
                            description: `Crypto withdrawal fee`,
                            transactionId: transaction.id
                        }
                    });
                }

                // Mark transaction complete
                await tx.virtualTransaction.update({
                    where: { id: transaction.id },
                    data: {
                        status: 'COMPLETED',
                        txHash,
                        completedAt: new Date()
                    }
                });

            }, { isolationLevel: 'Serializable' });

            return { txHash, reference, amount: decimalAmount, fee, toAddress };

        } catch (error: any) {

            // ── Step 4: Rollback on Tatum failure ────────────────────
            await prisma.$transaction(async (tx) => {

                await tx.$queryRaw`
                    SELECT id FROM "VirtualAccount"
                    WHERE id = ${virtualAccountId}
                    FOR UPDATE
                `;

                // Release frozen funds back to available
                await tx.virtualAccount.update({
                    where: { id: virtualAccountId },
                    data: {
                        frozen: { decrement: totalDebit },
                        available: { increment: totalDebit },
                    }
                });

                // Deactivate block
                await tx.block.update({
                    where: { id: block.id },
                    data: { active: false, amount: 0 }
                });

                // Mark transaction failed
                await tx.virtualTransaction.update({
                    where: { id: transaction.id },
                    data: {
                        status: 'FAILED',
                        failureReason: error?.response?.data?.message || error.message
                    }
                });

            }, { isolationLevel: 'Serializable' });

            throw new Error(`Crypto withdrawal failed: ${error?.response?.data?.message || error.message}`);
        }
    }

    // ── Tatum Broadcast ──────────────────────────────────────────
    // Handles different endpoints per chain and token type

    private async broadcastToTatum(
        config: ChainConfig,
        addressRecord: any,
        toAddress: string,
        amount: Decimal,
        fee: Decimal
    ): Promise<string> {

        if (!config.tatumTransferEndpoint) {
            throw new Error(`No transfer endpoint configured for ${config.blockchain}`);
        }

        // Get private key for keypair chains
        let privateKey: string | undefined;
        if (config.walletType === 'KEYPAIR') {
            if (!addressRecord.encryptedPrivateKey) {
                throw new Error('No private key found for this address');
            }
            privateKey = decrypt(addressRecord.encryptedPrivateKey);
        }

        const headers = {
            'x-api-key': process.env.TATUM_LIVE_KEY!,
            'Content-Type': 'application/json'
        };

        let payload: any;
        let response: any;

        // ── SPL Token (USDC_SOL, USDT_SOL) ──────────────────────────
        if (config.tokenStandard === 'SPL') {
            payload = {
                from: addressRecord.address,
                to: toAddress,
                contractAddress: config.tokenMint,
                amount: amount.toString(),
                digits: config.decimals ?? 6,
                fromPrivateKey: privateKey,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── ERC20 / BEP20 / Polygon ERC20 ───────────────────────────
        else if (
            config.tokenStandard === 'ERC20' ||
            config.tokenStandard === 'BEP20'
        ) {
            payload = {
                to: toAddress,
                contractAddress: config.tokenMint,
                amount: amount.toString(),
                currency: config.tokenSymbol,
                fromPrivateKey: addressRecord.xpub
                    ? undefined
                    : privateKey,
                signatureId: addressRecord.xpub
                    ? undefined
                    : undefined,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── TRC20 ────────────────────────────────────────────────────
        else if (config.tokenStandard === 'TRC20') {
            payload = {
                to: toAddress,
                tokenAddress: config.tokenMint,
                amount: amount.toString(),
                fromPrivateKey: decrypt(addressRecord.encryptedPrivateKey!),
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── Native SOL ───────────────────────────────────────────────
        else if (config.blockchain === 'SOL' && !config.isToken) {
            payload = {
                from: addressRecord.address,
                to: toAddress,
                amount: amount.toString(),
                fromPrivateKey: privateKey,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── Native ETH / MATIC / BNB (EVM chains) ───────────────────
        else if (
            ['ETHEREUM', 'POLYGON', 'BSC', 'BASE', 'ARBITRUM', 'OPTIMISM'].includes(config.blockchain)
            && !config.isToken
        ) {
            payload = {
                to: toAddress,
                amount: amount.toString(),
                currency: config.currency,
                fromPrivateKey: privateKey,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── Native BTC / LTC ─────────────────────────────────────────
        else if (['BTC', 'LTC'].includes(config.blockchain) && !config.isToken) {
            payload = {
                fromAddress: [{
                    address: addressRecord.address,
                    privateKey: privateKey,
                }],
                to: [{
                    address: toAddress,
                    value: Number(amount.toString()),
                }],
                fee: fee.toString(),
                changeAddress: addressRecord.address, // send change back to same address
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── Native TRON ──────────────────────────────────────────────
        else if (config.blockchain === 'TRON' && !config.isToken) {
            payload = {
                to: toAddress,
                amount: Number(amount.toString()),
                fromPrivateKey: decrypt(addressRecord.encryptedPrivateKey!),
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── XRP ──────────────────────────────────────────────────────
        else if (config.blockchain === 'XRP') {
            payload = {
                fromAccount: addressRecord.address,
                to: toAddress,
                amount: amount.toString(),
                fromSecret: privateKey,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        // ── BNB Beacon Chain ─────────────────────────────────────────
        else if (config.blockchain === 'BNB') {
            payload = {
                to: toAddress,
                amount: amount.toString(),
                currency: 'BNB',
                fromPrivateKey: privateKey,
            };
            response = await axios.post(config.tatumTransferEndpoint, payload, { headers });
        }

        else {
            throw new Error(`Transfer not implemented for ${config.blockchain}`);
        }

        const txHash = response.data?.txId || response.data?.hash || response.data?.id;
        if (!txHash) throw new Error(`No txHash returned from Tatum for ${config.blockchain}`);

        return txHash;
    }


    // ── Native Chain Transfer ────────────────────────────────────

  private async broadcastNativeToTatum(
      config: ChainConfig,
      addressRecord: any,
      toAddress: string,
      amount: Decimal,
      fee: Decimal
  ): Promise<string> {

      if (!config.tatumTransferEndpoint) {
          throw new Error(`No transfer endpoint configured for ${config.blockchain}`);
      }

      const headers = {
          'x-api-key': process.env.TATUM_LIVE_KEY!,
          'Content-Type': 'application/json'
      };

      // Derive private key on the go for HD chains
      // For KEYPAIR chains (SOL tokens) use stored encrypted key
      let privateKey: string;

      if (config.walletType === 'HD') {
          privateKey = await this.derivePrivateKey(
              config.blockchain,
              config.mnemonic!,
              addressRecord.index!
          );
      } else {
          // KEYPAIR chain (SOL SPL tokens) - still need stored key
          if (!addressRecord.encryptedPrivateKey) {
              throw new Error('No private key found for this keypair address');
          }
          privateKey = decrypt(addressRecord.encryptedPrivateKey);
      }

      let payload: any;

      switch (config.blockchain) {

          // ── SOL ──────────────────────────────────────────────────
          case 'SOL':
              payload = {
                  from: addressRecord.address,
                  to: toAddress,
                  amount: amount.toString(),
                  fromPrivateKey: privateKey,
              };
              break;

          // ── EVM Chains (ETH, POLYGON, BSC, BASE, ARBITRUM, OPTIMISM)
          case 'ETHEREUM':
          case 'POLYGON':
          case 'BSC':
          case 'BASE':
          case 'ARBITRUM':
          case 'OPTIMISM':
              payload = {
                  to: toAddress,
                  amount: amount.toString(),
                  currency: config.currency,
                  fromPrivateKey: privateKey,
              };
              break;

          // ── BTC / LTC ────────────────────────────────────────────
          case 'BTC':
          case 'LTC':
              payload = {
                  fromAddress: [{
                      address: addressRecord.address,
                      privateKey: privateKey,
                  }],
                  to: [{
                      address: toAddress,
                      value: Number(amount.toString()),
                  }]
                  // fee: fee.toString(),
                  // changeAddress: addressRecord.address,
              };
              break;

          // ── TRON ─────────────────────────────────────────────────
          case 'TRON':
              payload = {
                  to: toAddress,
                  amount: Number(amount.toString()),
                  fromPrivateKey: privateKey,
              };
              break;

          // ── XRP ──────────────────────────────────────────────────
          case 'XRP':
              payload = {
                  fromAccount: addressRecord.address,
                  to: toAddress,
                  amount: amount.toString(),
                  fromSecret: privateKey,
              };
              break;

          // ── BNB Beacon Chain ─────────────────────────────────────
          case 'BNB':
              payload = {
                  to: toAddress,
                  amount: amount.toString(),
                  currency: 'BNB',
                  fromPrivateKey: privateKey,
              };
              break;

          default:
              throw new Error(`Native transfer not implemented for ${config.blockchain}`);
      }

      const response = await axios.post(config.tatumTransferEndpoint, payload, { headers });

      const txHash = response.data?.txId || response.data?.hash || response.data?.id;
      if (!txHash) throw new Error(`No txHash returned from Tatum for ${config.blockchain}`);

      return txHash;
  }

  // ── Token Transfer ───────────────────────────────────────────

  private async broadcastTokenToTatum(
      config: ChainConfig,
      addressRecord: any,
      toAddress: string,
      amount: Decimal,
  ): Promise<string> {

      if (!config.tatumTransferEndpoint) {
          throw new Error(`No transfer endpoint configured for ${config.blockchain} ${config.tokenSymbol}`);
      }

      if (!config.isToken || !config.tokenMint) {
          throw new Error(`${config.blockchain} is not a token config`);
      }

      const headers = {
          'x-api-key': process.env.TATUM_LIVE_KEY!,
          'Content-Type': 'application/json'
      };

      // Derive private key on the go for HD chains
      // For KEYPAIR chains (SOL tokens) use stored encrypted key
      let privateKey: string;

      if (config.walletType === 'HD') {
          privateKey = await this.derivePrivateKey(
              config.blockchain,
              config.mnemonic!,
              addressRecord.index!
          );
      } else {
          // KEYPAIR chain (SOL SPL tokens) - still need stored key
          if (!addressRecord.encryptedPrivateKey) {
              throw new Error('No private key found for this keypair address');
          }
          privateKey = decrypt(addressRecord.encryptedPrivateKey);
      }

      let payload: any;

      switch (config.tokenStandard) {

          // ── SPL (Solana tokens - USDC_SOL, USDT_SOL) ────────────
          case 'SPL':
              payload = {
                  chain: config.blockchain,
                  from: addressRecord.address,
                  to: toAddress,
                  contractAddress: config.tokenMint,
                  amount: amount.toString(),
                  digits: config.decimals ?? 6,
                  fromPrivateKey: privateKey
              };
              break;

          // ── ERC20 (ETHEREUM, POLYGON, BASE, ARBITRUM, OPTIMISM tokens)
          case 'ERC20':
              payload = {
                  to: toAddress,
                  // contractAddress: config.tokenMint,
                  amount: amount.toString(),
                  currency: config.tokenSymbol,
                  fromPrivateKey: privateKey,
              };
              break;

          // ── BEP20 (BSC tokens) ───────────────────────────────────
          case 'BEP20':
              payload = {
                  to: toAddress,
                  // contractAddress: config.tokenMint,
                  amount: amount.toString(),
                  currency: config.tokenSymbol,
                  fromPrivateKey: privateKey,
              };
              break;

          // ── TRC20 (TRON tokens - USDT_TRON, USDC_TRON) ──────────
          case 'TRC20':
              payload = {
                  to: toAddress,
                  tokenAddress: config.tokenMint,
                  amount: amount.toString(),
                  feeLimit: '0.5',
                  fromPrivateKey: privateKey,
              };
              break;

          default:
              throw new Error(`Token transfer not implemented for standard: ${config.tokenStandard}`);
      }

      const response = await axios.post(config.tatumTransferEndpoint, payload, { headers });

      const txHash = response.data?.txId || response.data?.hash || response.data?.id;
      if (!txHash) throw new Error(`No txHash returned from Tatum for ${config.tokenSymbol} on ${config.blockchain}`);

      return txHash;
  }

  // ── Derive Private Key On The Go (HD chains only) ────────────

  private async derivePrivateKey(
      blockchain: string,
      mnemonic: string,
      index: number
  ): Promise<string> {

      const config = CHAIN_CONFIG[blockchain.toUpperCase()];
      if (!config) throw new Error(`Unsupported blockchain: ${blockchain}`);
      if (config.walletType !== 'HD') throw new Error(`${blockchain} is not an HD wallet chain — use stored private key instead`);

      // Tatum endpoint per chain
      const endpoints: Record<string, string> = {
          ETHEREUM: 'ethereum',
          BTC:      'bitcoin',
          TRON:     'tron',
          LTC:      'litecoin',
          POLYGON:  'polygon',
          BSC:      'bsc',
          BASE:     'base',
          ARBITRUM: 'arbitrum',
          OPTIMISM: 'optimism',
      };

      const endpoint = endpoints[blockchain.toUpperCase()];
      if (!endpoint) throw new Error(`No private key derivation endpoint for ${blockchain}`);

      const response = await axios.post(
          `https://api.tatum.io/v3/${endpoint}/wallet/priv`,
          { mnemonic, index },
          {
              headers: {
                  'x-api-key': process.env.TATUM_LIVE_KEY!,
                  'Content-Type': 'application/json'
              }
          }
      );

      const privateKey = response.data?.key;
      if (!privateKey) throw new Error(`Failed to derive private key for ${blockchain} at index ${index}`);

      return privateKey;
  }




}

export default new VirtualAccountService();