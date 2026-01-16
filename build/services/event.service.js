"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const wallet_service_1 = __importDefault(require("./wallet.service"));
const order_service_1 = __importDefault(require("./order.service"));
const ably_service_1 = __importDefault(require("./ably.service"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const bullmq_1 = require("bullmq"); // Using BullMQ for job queue
const env_config_1 = __importDefault(require("../config/env.config"));
const logger_1 = __importDefault(require("../config/logger"));
const notification_service_1 = __importDefault(require("./notification.service"));
const redis_config_1 = __importDefault(require("../config/redis.config"));
const anon_service_1 = __importDefault(require("./anon.service"));
const decimal_util_1 = require("./decimal.util");
const orderslot_service_1 = __importDefault(require("./orderslot.service"));
// {
//   "address": "0xF64E82131BE01618487Da5142fc9d289cbb60E9d",
//   "amount": "0.001",
//   "asset": "ETH",
//   "blockNumber": 2913059,
//   "counterAddress": "0x690B9A9E9aa1C9dB991C7721a92d351Db4FaC990",
//   "txId": "0x062d236ccc044f68194a04008e98c3823271dc26160a4db9ae9303f9ecfc7bf6",
//   "type": "native",
//   "chain": "ethereum-mainnet",
//   "subscriptionType": "ADDRESS_EVENT"
// }
class eventService {
    constructor() {
        // Initialize the processing queue
        this.orderProcessingQueue = new bullmq_1.Queue('general-process', {
            connection: redis_config_1.default
        });
    }
    // private async processRefundJob(jobData: { 
    //   awaitingId: string;
    //   senderAddress: string;
    //   currencyType: string;
    // }) {
    //   const { awaitingId, senderAddress, currencyType } = jobData;
    //   try {
    //     const awaiting = await prisma.awaiting.findUnique({
    //       where: { id: awaitingId },
    //       include: {
    //         wallet: true
    //       }
    //     });
    //     if (!awaiting) {
    //       throw new Error(`Awaiting record ${awaitingId} not found`);
    //     }
    //     if (currencyType === "CRYPTO") {
    //       await walletService.blockchain_Transfer({
    //         userId: awaiting?.userId as string,
    //         currencyId: awaiting?.currencyId as string,
    //         amount: Number(awaiting.wallet?.availableBalance),
    //         address: senderAddress
    //       });
    //     } else {
    //       // FIAT refund logic would go here
    //     }
    //     await prisma.awaiting.update({
    //       where: { id: awaitingId },
    //       data: { status: 'REFUNDED' }
    //     });
    //     await ablyService.awaiting_Order_Update(awaitingId);
    //   } catch (error) {
    //     console.error(`Refund failed for ${awaitingId}:`, error);
    //     throw error;
    //   }
    // }
    async queue(payload) {
        console.log('new event queue', payload);
        const { type, QorePay_Event, QorePay_EventType, QorePay_Reference, Tatum_Address, Tatum_SenderAddress, Tatum_Amount, Tatum_SubscriptionId, Tatum_EventType, Tatum_TxId } = payload;
        if (type === 'QOREPAY') {
            return await this.orderProcessingQueue.add('Qorepay_Event', {
                event: QorePay_Event,
                eventType: QorePay_EventType,
                reference: QorePay_Reference
            });
        }
        if (type === 'TATUM') {
            return await this.orderProcessingQueue.add('Tatum_Event', {
                address: Tatum_Address,
                senderAddress: Tatum_SenderAddress,
                amount: Tatum_Amount,
                subscriptionId: Tatum_SubscriptionId,
                type: Tatum_EventType,
                txId: Tatum_TxId
            });
        }
    }
    async handleQorepayEvent(payload) {
        const { event, eventType, reference } = payload;
        try {
            // FOR FIAT DEPOSITS
            if (event === 'purchase') {
                if (eventType === 'purchase.paid') {
                    const result = await this.handleFiatEvent({ event: 'CREDIT', reference });
                    return result;
                }
                if (eventType === 'purchase.payment_failure') {
                    const result = await this.handleFiatEvent({ event: 'CREDIT_FAILED', reference });
                    return result;
                }
            }
            // FOR FIAT WITHDRAWALS
            if (event === 'payout') {
                if (eventType === 'payout.created') {
                    return { status: 'processed', action: 'wallet-payout-created' };
                }
                else if (eventType === 'payout.success') {
                    const result = await this.handleFiatEvent({ event: 'DEBIT', reference });
                    return result;
                }
                else {
                    const result = await this.handleFiatEvent({ event: 'DEBIT_FAILED', reference });
                    return result;
                }
            }
        }
        catch (error) {
            logger_1.default.error(`Error handling webhook for : ${reference}:`, error);
            console.error('Error handling webhook:', error);
            throw error;
        }
    }
    async handleTatumEvent(payload) {
        console.log('-----------handling tatum event current payload------------');
        console.log(payload);
        const { address, amount, subscriptionId, type, txId, senderAddress } = payload;
        // const parseAmount = parseFloat(amount);
        // console.log('parseAmount', parseAmount)
        try {
            // This path is for POSITIVE amounts (0 or greater)
            // Example: "0.001", "50.00", "100"
            const result = await this.handleCryptoEvent({
                address,
                subscriptionId,
                amount,
                sender: senderAddress,
                txId
            });
        }
        catch (error) {
            logger_1.default.error(`Error handling webhook for : ${address}:`, error);
            console.error('Error handling webhook:', error);
            throw error;
        }
    }
    /**
     * Handles incoming webhook events from payment provider
     * Responds immediately and queues processing work
     */
    async handleCryptoEvent(payload) {
        const { address, amount, sender, subscriptionId, txId } = payload;
        try {
            logger_1.default.info('Received crypto webhook event', {
                address,
                amount,
                sender,
                txId
            });
            // ✅ CRITICAL: Check for zero or invalid amount FIRST
            const amountDecimal = new decimal_js_1.default(amount);
            if (amountDecimal.lessThanOrEqualTo(0)) {
                logger_1.default.warn('Ignoring zero or negative amount transaction', {
                    address,
                    amount: amountDecimal.toString(),
                    txId
                });
                return {
                    status: 'ignored',
                    reason: 'zero_amount',
                    message: 'Transaction amount is zero or negative'
                };
            }
            logger_1.default.info('Valid amount detected', {
                amount: amountDecimal.toString(),
                txId
            });
            // 1. Find wallet with relations
            const wallet = await prisma_config_1.default.wallet.findFirst({
                where: {
                    depositAddress: address,
                    subscriptionId
                },
                include: {
                    currency: {
                        select: {
                            id: true,
                            ISO: true,
                            name: true,
                            type: true,
                            chain: true
                        }
                    },
                    user: {
                        select: {
                            id: true,
                            email: true,
                            firstName: true,
                            lastName: true
                        }
                    }
                }
            });
            if (!wallet) {
                logger_1.default.warn('No matching wallet found', {
                    address,
                    subscriptionId,
                    txId
                });
                return {
                    status: 'ignored',
                    reason: 'wallet_not_found',
                    message: 'No matching wallet'
                };
            }
            logger_1.default.info('Wallet found', {
                walletId: wallet.id,
                currency: wallet.currency?.ISO,
                userId: wallet.userId
            });
            // 2. Check for duplicate transaction (IDEMPOTENCY)
            const existingTx = await prisma_config_1.default.transaction.findFirst({
                where: {
                    reference: txId,
                    walletId: wallet.id
                }
            });
            if (existingTx) {
                logger_1.default.info('Duplicate transaction detected', {
                    txId,
                    existingTxId: existingTx.id,
                    walletId: wallet.id
                });
                return {
                    status: 'ignored',
                    reason: 'duplicate',
                    message: 'Duplicate transaction'
                };
            }
            // 3. Sync current blockchain balance
            logger_1.default.info('Syncing wallet balance', { walletId: wallet.id });
            const syncedWallet = await wallet_service_1.default.getAccount(wallet.id);
            if (!syncedWallet) {
                throw new Error(`Failed to sync wallet ${wallet.id}`);
            }
            logger_1.default.info('Wallet synced', {
                walletId: wallet.id,
                newBalance: syncedWallet.accountBalance?.toString()
            });
            // 4. Find awaiting payment
            const awaiting = await prisma_config_1.default.awaiting.findFirst({
                where: {
                    triggerAddress: address,
                    status: 'PENDING'
                },
                include: {
                    currency: true,
                    wallet: true,
                    order: true
                }
            });
            logger_1.default.info('Awaiting payment check', {
                found: !!awaiting,
                awaitingId: awaiting?.id,
                expectedAmount: awaiting?.amount?.toString()
            });
            // 5. Determine transfer type by comparing balances
            const previousBalance = new decimal_js_1.default(wallet.accountBalance);
            const currentBalance = new decimal_js_1.default(syncedWallet.accountBalance);
            const receivedAmount = amountDecimal;
            // ✅ More reliable transfer type detection
            const balanceDifference = currentBalance.minus(previousBalance);
            const transferType = balanceDifference.greaterThan(0) ? 'CREDIT' : 'DEBIT';
            logger_1.default.info('Transfer analysis', {
                previousBalance: previousBalance.toString(),
                currentBalance: currentBalance.toString(),
                balanceDifference: balanceDifference.toString(),
                receivedAmount: receivedAmount.toString(),
                transferType,
                txId
            });
            // ✅ Additional validation for CREDIT transactions
            if (transferType === 'CREDIT') {
                // Verify the received amount makes sense
                const expectedIncrease = receivedAmount;
                const actualIncrease = balanceDifference;
                // Allow small discrepancy (gas fees, rounding)
                const discrepancy = actualIncrease.minus(expectedIncrease).abs();
                const maxDiscrepancy = new decimal_js_1.default('0.00001'); // 0.00001 tolerance
                if (discrepancy.greaterThan(maxDiscrepancy)) {
                    logger_1.default.warn('Balance increase mismatch', {
                        expected: expectedIncrease.toString(),
                        actual: actualIncrease.toString(),
                        discrepancy: discrepancy.toString(),
                        txId
                    });
                }
            }
            // 6. Use database transaction for atomicity
            return await prisma_config_1.default.$transaction(async (tx) => {
                if (transferType === 'CREDIT') {
                    return await this.handleCreditTransaction({
                        tx,
                        wallet,
                        syncedWallet,
                        amount: decimal_util_1.DecimalUtil.roundForStorage(receivedAmount, wallet.currency?.ISO).toString(),
                        sender,
                        awaiting,
                        txId,
                    });
                }
                else if (transferType === 'DEBIT') {
                    return await this.handleDebitTransaction({
                        tx,
                        wallet,
                        syncedWallet,
                        amount: decimal_util_1.DecimalUtil.roundForStorage(receivedAmount, wallet.currency?.ISO).toString(),
                        txId
                    });
                }
                else {
                    throw new Error(`Unable to determine transfer type.`);
                }
            }, {
                maxWait: 10000, // 10 seconds to get connection
                timeout: 30000, // 30 seconds for transaction (increased from 5s)
                isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
            });
        }
        catch (error) {
            logger_1.default.error('Error handling crypto event:', {
                address,
                txId,
                error: error instanceof Error ? error.message : error
            });
            throw error;
        }
    }
    async handleFiatEvent(payload) {
        const { reference, event } = payload;
        console.log('event', event);
        // 1. Find and validate transaction
        const transaction = await prisma_config_1.default.transaction.findUnique({
            where: { id: reference },
            include: {
                wallet: {
                    include: { currency: true }
                }
            }
        });
        console.log('transaction', transaction);
        const awaiting = await prisma_config_1.default.awaiting.findFirst({
            where: {
                reference,
                status: 'PENDING'
            },
            include: {
                currency: true,
                wallet: true
            }
        });
        console.log('awaiting', awaiting);
        if (!transaction) {
            logger_1.default.warn(`Transaction not found for reference: ${reference}`);
            return { status: 'rejected', reason: 'transaction_not_found' };
        }
        if (transaction?.status !== 'PENDING') {
            return { status: 'Already processed', reason: 'transaction_already_processed' };
        }
        try {
            if (event === 'CREDIT') {
                console.log('CREDIT TRANSACTION');
                // 2. Credit wallet for ALL successful transactions first
                await wallet_service_1.default.credit_Wallet(Number(transaction.amount), transaction.walletId);
                await prisma_config_1.default.transaction.update({
                    where: { id: transaction.id },
                    data: {
                        status: 'SUCCESSFUL',
                        metadata: {
                            type: 'Anon-Order',
                            amount: transaction.amount,
                            reference
                        }
                    }
                });
                // CHECK FOR AWAITING TRANSFER 
                if (awaiting) {
                    // For transactions WITH awaiting transfers:
                    // Queue for order processing (NO notification)
                    await this.orderProcessingQueue.add('process-order', {
                        awaitingId: awaiting.id
                    });
                    await prisma_config_1.default.awaiting.update({
                        where: { id: awaiting.id },
                        data: { status: 'CONFIRMED' }
                    });
                    await ably_service_1.default.awaiting_Order_Update(awaiting.id);
                    logger_1.default.info(`Fiat payment processed and queued for order processing, reference: ${reference}`);
                    // Cancel the scheduled expiry
                    await anon_service_1.default.cancelAwaitingExpiry(awaiting.id);
                    return { status: 'queued', action: 'order-processing' };
                }
                else {
                    // For transactions WITHOUT awaiting transfers:
                    // Send notification only
                    await notification_service_1.default.queue({
                        userId: transaction.userId,
                        title: 'Deposit Successful',
                        type: 'GENERAL',
                        content: `Your deposit of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> has been processed successfully. The funds are now available in your wallet.`
                    });
                    console.log('notification hit the queue here');
                    logger_1.default.info(`Direct deposit processed and notification sent, reference: ${reference}`);
                    return { status: 'processed', action: 'wallet-credit-and-notify' };
                }
            }
            if (event === 'CREDIT_FAILED') {
                if (transaction) {
                    await prisma_config_1.default.transaction.update({
                        where: { id: transaction?.id },
                        data: { status: 'FAILED' }
                    });
                }
                logger_1.default.info(`Failed deposit processed, reference: ${reference}`);
                return { status: 'processed', action: 'wallet-credit-failed' };
            }
            if (event === 'DEBIT') {
                if (transaction) {
                    await prisma_config_1.default.transaction.update({
                        where: { id: transaction?.id },
                        data: {
                            status: 'SUCCESSFUL',
                            metadata: {
                                type: 'Anon-Order',
                                amount: transaction.amount,
                                reference
                            }
                        }
                    });
                }
                if (!awaiting) {
                    await notification_service_1.default.queue({
                        userId: transaction.userId,
                        title: 'Withdrawal Successful',
                        type: 'GENERAL',
                        content: `Your withdrawal of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> has been processed successfully. Thanks for choosing Vyre.`
                    });
                }
                logger_1.default.info(`Successful payout processed, reference: ${reference}`);
                return { status: 'processed', action: 'wallet-payout-and-notify' };
            }
            if (event === 'DEBIT_FAILED') {
                // // refund the user wallet 
                await wallet_service_1.default.credit_Wallet(Number(transaction.amount), transaction.walletId);
                if (transaction) {
                    await prisma_config_1.default.transaction.update({
                        where: { id: transaction?.id },
                        data: { status: 'FAILED', }
                    });
                }
                if (!awaiting) {
                    await notification_service_1.default.queue({
                        userId: transaction.userId,
                        title: 'Withdrawal Failed',
                        type: 'GENERAL',
                        content: `Your withdrawal of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> could not be processed at this time. Please try again later.`
                    });
                }
                logger_1.default.info(`Failed payout processed, reference: ${reference}`);
                return { status: 'processed', action: 'wallet-payout-failed' };
            }
        }
        catch (error) {
            logger_1.default.error(`Error handling webhook for : ${reference}:`, error);
            console.error('Error handling webhook:', error);
            throw error;
        }
    }
    async handleCreditTransaction(params) {
        const { tx, wallet, syncedWallet, sender, awaiting, txId, amount } = params;
        // 1. Create transaction record
        const transaction = await tx.transaction.create({
            data: {
                userId: wallet.userId,
                currency: wallet.currency.ISO,
                amount: decimal_util_1.DecimalUtil.roundForStorage(amount, wallet.currency?.ISO),
                status: 'SUCCESSFUL',
                reference: txId,
                walletId: wallet.id,
                type: 'CRYPTO_DEPOSIT',
                description: `Wallet credited with ${amount}`,
                metadata: {
                    sender,
                    blockchainBalance: syncedWallet.accountBalance,
                    previousBalance: wallet.accountBalance
                }
            }
        });
        // 2. Handle awaiting order
        if (awaiting) {
            const expectedAmount = new decimal_js_1.default(awaiting.amount.toString());
            const availableBalance = new decimal_js_1.default(syncedWallet.availableBalance);
            const received = amount;
            console.log('Amount Verification:', {
                expected: expectedAmount.toString(),
                received,
                walletBalance: syncedWallet.availableBalance.toString(),
            });
            // Verify available balance on updated wallet balance against awaiting amount
            if (availableBalance.lessThan(expectedAmount)) {
                const shortfall = expectedAmount.minus(availableBalance);
                logger_1.default.warn('Insufficient payment received - queueing refund', {
                    awaitingId: awaiting.id,
                    availableBalance: availableBalance.toString(),
                    expectedAmount: expectedAmount.toString(),
                    receivedAmount: received.toString(),
                    shortfall: shortfall.toString(),
                    currency: awaiting.currency?.ISO
                });
                // Queue refund for insufficient payment
                await this.orderProcessingQueue.add('initiate-refund', {
                    awaitingId: awaiting.id,
                    senderAddress: sender,
                    currencyType: awaiting.currency?.type,
                    receivedAmount: received.toString(),
                    expectedAmount: expectedAmount.toString(),
                    transactionId: transaction.id
                });
                // Update awaiting status
                await tx.awaiting.update({
                    where: { id: awaiting.id },
                    data: {
                        metadata: {
                            receivedAmount: received.toString(),
                            expectedAmount: expectedAmount.toString()
                        }
                    }
                });
                return {
                    status: 'queued',
                    action: 'refund-insufficient-amount',
                    details: {
                        expected: expectedAmount.toString(),
                        received: received.toString()
                    }
                };
            }
            // Queue order processing
            await order_service_1.default.process_Order_Queue({
                awaitingId: awaiting.id,
                transactionId: transaction.id
            });
            await prisma_config_1.default.awaiting.update({
                where: { id: awaiting.id },
                data: { status: 'CONFIRMED' }
            });
            await ably_service_1.default.awaiting_Order_Update(awaiting.id);
            // Cancel the scheduled expiry
            await anon_service_1.default.cancelAwaitingExpiry(awaiting.id);
            return {
                status: 'queued',
                action: 'order-processing',
                awaitingId: awaiting.id,
                transactionId: transaction.id
            };
        }
        // 3. No awaiting order - just notify user
        await notification_service_1.default.queue({
            userId: wallet.userId,
            title: 'Transaction Notification',
            type: 'GENERAL',
            content: `<strong>${decimal_util_1.DecimalUtil.formatWithCurrency(amount, wallet.currency?.ISO)}</strong> was sent to you and is available in your wallet. Thanks for choosing Vyre.`
        });
        return {
            status: 'success',
            action: 'credit-completed',
            transactionId: transaction.id
        };
    }
    async handleDebitTransaction(params) {
        const { tx, wallet, syncedWallet, amount, txId } = params;
        // 1. Create transaction record
        const transaction = await tx.transaction.create({
            data: {
                userId: wallet.userId,
                currency: wallet.currency.ISO,
                amount: decimal_util_1.DecimalUtil.roundForStorage(amount, wallet.currency?.ISO),
                status: 'SUCCESSFUL',
                reference: txId,
                walletId: wallet.id,
                type: 'CRYPTO_WITHDRAWAL',
                description: `Wallet debited with ${amount}`,
                metadata: {
                    blockchainBalance: syncedWallet.accountBalance,
                    previousBalance: wallet.accountBalance
                }
            }
        });
        // 2. Send notification (skip for admin)
        if (env_config_1.default.Admin_Id !== wallet.userId) {
            await notification_service_1.default.queue({
                userId: wallet.userId,
                title: 'Transaction Notification',
                type: 'GENERAL',
                content: `Transfer of <strong>${decimal_util_1.DecimalUtil.formatWithCurrency(amount, wallet.currency?.ISO)}</strong> was successful. Thanks for choosing Vyre.`
            });
        }
        return {
            status: 'success',
            action: 'debit-completed',
            transactionId: transaction.id
        };
    }
    // /**
    //  * Process queued order (called by worker)
    // */
    // public async processOrderJob(jobData: { awaitingId: string }) {
    //   const { awaitingId } = jobData;
    //   try {
    //     const awaiting = await prisma.awaiting.findUnique({
    //       where: { id: awaitingId },
    //       include: {
    //         order: {
    //           include: {
    //             pair: {
    //               include: {
    //                 baseCurrency: true,
    //                 quoteCurrency: true
    //               }
    //             }
    //           }
    //         },
    //         currency: true,
    //         wallet: true
    //       }
    //     });
    //     if (!awaiting) {
    //       throw new Error(`Awaiting record ${awaitingId} not found`);
    //     }
    //     // Update status to processing
    //     await prisma.awaiting.update({
    //       where: { id: awaitingId },
    //       data: { status: 'PROCESSING' }
    //     });
    //     await ablyService.awaiting_Order_Update(awaitingId);
    //     // Find required wallets
    //     const [userBaseWallet, userQuoteWallet] = await Promise.all([
    //       prisma.wallet.findFirst({
    //         where: {
    //           userId: awaiting.userId,
    //           currencyId: awaiting.order?.pair?.baseId
    //         }
    //       }),
    //       prisma.wallet.findFirst({
    //         where: {
    //           userId: awaiting.userId,
    //           currencyId: awaiting.order?.pair?.quoteId
    //         }
    //       })
    //     ]);
    //     if (!userBaseWallet || !userQuoteWallet) {
    //       throw new Error('Required wallets not found');
    //     }
    //     // Process the order
    //     const result = await orderService.processOrder({
    //       userId: awaiting?.userId as string,
    //       orderId: awaiting?.orderId as string,
    //       amount: Number(awaiting.amount),
    //       userBaseWallet,
    //       userQuoteWallet
    //     });
    //     await prisma.awaiting.update({
    //       where: { id: awaitingId },
    //       data: {
    //         status: 'SUCCESS',
    //       }
    //     });
    //     await ablyService.awaiting_Order_Update(awaitingId);
    //     // Queue order for post Action processing
    //     await this.orderProcessingQueue.add('process-post-action', {
    //       awaitingId
    //     });
    //     logger.info(`order processed and queued for post action: ${result?.id}`);
    //     return { status: 'queued', action: 'process-post-action' };
    //   } catch (error) {
    //     console.error(`Order processing failed for ${awaitingId}:`, error);
    //     await orderslotService.cancelAwaiting(
    //       awaitingId,
    //       `Order processing failed for ${awaitingId}:`
    //     );
    //     await ablyService.awaiting_Order_Update(awaitingId);
    //     throw error;
    //   }
    // }
    /**
     * Process queued refund (called by worker)
    */
    async processRefundJob(jobData) {
        const { awaitingId, senderAddress, currencyType } = jobData;
        try {
            const awaiting = await prisma_config_1.default.awaiting.findUnique({
                where: { id: awaitingId },
                include: {
                    wallet: true
                }
            });
            if (!awaiting) {
                throw new Error(`Awaiting record ${awaitingId} not found`);
            }
            if (currencyType === "CRYPTO") {
                await wallet_service_1.default.blockchain_Transfer({
                    userId: awaiting?.userId,
                    currencyId: awaiting?.currencyId,
                    amount: awaiting.wallet?.availableBalance.toString(),
                    address: senderAddress
                });
            }
            else {
                // FIAT refund logic would go here, already handled by service provider:QOREPAY 
            }
            await orderslot_service_1.default.cancelAwaiting(awaitingId, `Amount refunded for ${awaitingId}:`);
            await ably_service_1.default.awaiting_Order_Update(awaitingId);
        }
        catch (error) {
            console.error(`Refund failed for ${awaitingId}:`, error);
            throw error;
        }
    }
    /**
     * Process queued postActions (called by worker)
    */
    async process_Post_Action_Job(jobData) {
        const { awaitingId } = jobData;
        try {
            // 1. Fetch awaiting record with all relations
            const awaiting = await prisma_config_1.default.awaiting.findUnique({
                where: { id: awaitingId },
                include: {
                    order: {
                        include: {
                            pair: {
                                include: {
                                    baseCurrency: true,
                                    quoteCurrency: true
                                }
                            }
                        }
                    },
                    currency: true
                }
            });
            if (!awaiting) {
                throw new Error(`Awaiting record ${awaitingId} not found`);
            }
            // 2. Validate awaiting status
            if (awaiting.status !== 'SUCCESS') {
                logger_1.default.warn(`Awaiting ${awaitingId} was not SUCCESSFUL: ${awaiting.status}`);
                return {
                    status: 'skipped',
                    reason: 'awaiting_status_not_successful',
                    currentStatus: awaiting.status
                };
            }
            // 3. Fetch user details
            const user = await prisma_config_1.default.user.findUnique({
                where: { id: awaiting.userId },
                select: {
                    id: true,
                    email: true,
                    phoneNumber: true,
                    firstName: true,
                    lastName: true
                }
            });
            if (!user) {
                throw new Error(`User ${awaiting.userId} not found`);
            }
            // 4. Fetch post details
            const postDetails = await prisma_config_1.default.postDetails.findFirst({
                where: {
                    awaitingId,
                    userId: awaiting.userId
                }
            });
            if (!postDetails || postDetails.status !== 'PENDING') {
                logger_1.default.warn(`Post details for awaiting ${awaitingId} not found or already processed`);
                return {
                    status: 'Not Found or Already Processed',
                    reason: `Post details not found for awaiting ${awaitingId} or already processed. Status: ${postDetails?.status || 'NOT_FOUND'}`,
                };
            }
            // 5. Fetch wallet with currency details
            const wallet = await prisma_config_1.default.wallet.findUnique({
                where: { id: postDetails.walletId },
                include: {
                    currency: {
                        select: {
                            id: true,
                            ISO: true,
                            isStablecoin: true,
                            type: true
                        }
                    }
                }
            });
            if (!wallet) {
                throw new Error(`Wallet ${postDetails.walletId} not found`);
            }
            // ✅ Convert wallet balance to Decimal
            const availableBalance = new decimal_js_1.default(wallet.availableBalance);
            const accountBalance = new decimal_js_1.default(wallet.accountBalance);
            // ✅ Validate balance is greater than 0
            if (availableBalance.lessThanOrEqualTo(0)) {
                throw new Error(`Insufficient balance in wallet. Available: ${availableBalance.toString()} ${wallet.currency?.ISO}`);
            }
            logger_1.default.info(`Processing post action for awaiting ${awaitingId}`, {
                orderType: awaiting.order?.type,
                availableBalance: availableBalance.toString(),
                accountBalance: accountBalance.toString(),
                currency: wallet.currency?.ISO,
                walletId: wallet.id
            });
            // 7. Execute transfer based on order type
            let transferResult;
            if (awaiting.order?.type === 'BUY') {
                // BUY order: Send fiat to user's bank account
                if (!postDetails.accountNumber || !postDetails.bankCode || !postDetails.recipient_Name) {
                    throw new Error('Missing bank details for fiat transfer');
                }
                logger_1.default.info(`Initiating bank transfer for awaiting ${awaitingId}`, {
                    amount: availableBalance.toString(),
                    currency: wallet.currency?.ISO,
                    recipient: postDetails.recipient_Name,
                    accountNumber: postDetails.accountNumber,
                    bankCode: postDetails.bankCode
                });
                transferResult = await wallet_service_1.default.direct_bank_Transfer({
                    userId: awaiting.userId,
                    currencyId: wallet.currencyId,
                    amount: availableBalance.toString(), // ✅ Pass as string
                    email: user.email,
                    phone: user.phoneNumber,
                    account_number: postDetails.accountNumber,
                    bank_code: postDetails.bankCode,
                    recipient_name: postDetails.recipient_Name
                });
            }
            else if (awaiting.order?.type === 'SELL') {
                // SELL order: Send crypto to user's wallet address
                if (!postDetails.address) {
                    throw new Error('Missing crypto address for blockchain transfer');
                }
                // if (!postDetails.chain) {
                //   throw new Error('Missing blockchain network/chain information');
                // }
                logger_1.default.info(`Initiating blockchain transfer for awaiting ${awaitingId}`, {
                    amount: availableBalance.toString(),
                    currency: wallet.currency?.ISO,
                    chain: postDetails.chain,
                    address: postDetails.address
                });
                transferResult = await wallet_service_1.default.blockchain_Transfer({
                    userId: wallet.userId,
                    currencyId: wallet.currencyId,
                    amount: availableBalance.toString(), // ✅ Pass as string
                    address: postDetails.address,
                });
            }
            else {
                throw new Error(`Unknown order type: ${awaiting.order?.type}`);
            }
            // 8. Verify transfer was successful
            if (!transferResult) {
                throw new Error('Transfer failed: No result returned from transfer service');
            }
            logger_1.default.info(`Transfer successful for awaiting ${awaitingId}`, {
                currency: wallet.currency?.ISO,
                amount: availableBalance.toString(),
                transferId: transferResult.id,
                orderType: awaiting.order?.type
            });
            // 9. Update database records atomically
            const updated = await prisma_config_1.default.$transaction(async (tx) => {
                // Update awaiting status to SUCCESS
                const updated_Awaiting = await tx.awaiting.update({
                    where: { id: awaitingId },
                    data: {
                        // status: 'SUCCESS',
                        metadata: {
                            transferCompleted: true,
                            transferId: transferResult?.id || null,
                            transferReference: transferResult?.reference || null,
                            transferAmount: availableBalance.toString(),
                            completedAt: new Date().toISOString(),
                            orderType: awaiting.order?.type
                        }
                    }
                });
                // Update postDetails status to SUCCESS
                const updated_PostDetails = await tx.postDetails.updateMany({
                    where: {
                        awaitingId,
                        userId: awaiting.userId
                    },
                    data: {
                        status: 'SUCCESS'
                    }
                });
                const deactivatedUser = await tx.user.update({
                    where: { id: awaiting.userId },
                    data: { isDeactivated: true, deactivationReason: 'Completed anon order' }
                });
                return {
                    awaiting: updated_Awaiting,
                    postDetails: updated_PostDetails,
                    user: deactivatedUser
                };
            }, {
                maxWait: 10000,
                timeout: 30000,
                isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted,
            });
            logger_1.default.info(`Post action completed successfully`, {
                awaitingId,
                awaitingStatus: updated.awaiting.status,
                postDetailsUpdated: updated.postDetails.count
            });
            // 10. Trigger Ably real-time update
            try {
                await ably_service_1.default.awaiting_Order_Update(awaitingId);
                logger_1.default.info(`Ably notification sent for awaiting ${awaitingId}`);
            }
            catch (ablyError) {
                logger_1.default.error(`Failed to send Ably notification for ${awaitingId}`, {
                    error: ablyError
                });
                // Don't fail the whole job if notification fails
            }
            // 11. Send user notification
            // try {
            //   await notificationService.queue({
            //     userId: awaiting.userId as string,
            //     title: awaiting.order?.type === 'BUY' 
            //       ? 'Payment Sent!' 
            //       : 'Crypto Transfer Complete!',
            //     type: 'ORDER',
            //     content: awaiting.order?.type === 'BUY'
            //       ? `Your payment of ${wallet.currency?.ISO} ${availableBalance.toFixed(2)} has been sent to your bank account.`
            //       : `Your ${wallet.currency?.ISO} ${availableBalance.toFixed(8)} has been sent to your wallet.`
            //   });
            // } catch (notifError) {
            //   logger.error(`Failed to queue notification for ${awaitingId}`, {
            //     error: notifError
            //   });
            //   // Don't fail the job if notification fails
            // }
            return {
                status: 'success',
                awaitingId,
                transferAmount: availableBalance.toString(),
                currency: wallet.currency?.ISO,
                orderType: awaiting.order?.type
            };
        }
        catch (error) {
            logger_1.default.error(`Post action failed for ${awaitingId}`, {
                error: error.message,
                stack: error.stack
            });
            // Update awaiting to FAILED status
            try {
                await prisma_config_1.default.awaiting.update({
                    where: { id: awaitingId },
                    data: {
                        status: 'FAILED',
                        metadata: {
                            error: error.message,
                            failedAt: new Date().toISOString()
                        }
                    }
                });
            }
            catch (updateError) {
                logger_1.default.error(`Failed to update awaiting status to FAILED`, {
                    awaitingId,
                    error: updateError
                });
            }
            throw error;
        }
    }
    async sendOrderSuccessNotification(params) {
        const { userId, baseCurrency, quoteCurrency, amount, orderId } = params;
        let notificationContent;
        let notificationTitle;
        const order = await prisma_config_1.default.order.findUnique({
            where: { id: orderId }
        });
        if (!order) {
            return;
        }
        let amountProcessed;
        // Convert inputs to Decimal
        const amountDecimal = new decimal_js_1.default(amount);
        const priceDecimal = new decimal_js_1.default(order.price);
        if (order?.type === "BUY") {
            // User is sending base, calculate quote amount
            amountProcessed = amountDecimal.times(priceDecimal);
        }
        else {
            // User is sending quote, calculate base amount
            amountProcessed = amountDecimal.dividedBy(priceDecimal);
        }
        const baseAmount = order?.type === "BUY" ? amount : amountProcessed;
        const quoteAmount = order?.type === "BUY" ? amountProcessed : amount;
        if (order.type === 'BUY') {
            notificationTitle = '🎉 Order Completed Successfully!';
            notificationContent = `
        <div style="font-family: Arial, sans-serif;">
          <h3 style="color: #112044; margin-bottom: 10px;">Your BUY order has been completed!</h3>
          
          <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <p style="margin: 5px 0;"><strong>Order Type:</strong> BUY ${baseCurrency}</p>
            <p style="margin: 5px 0;"><strong>Amount Sold:</strong> ${baseAmount} ${baseCurrency}</p>
            <p style="margin: 5px 0;"><strong>Amount Received:</strong> ${quoteAmount} ${quoteCurrency}</p>
            <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${Number(order.price).toLocaleString('en-US')} ${quoteCurrency}</p>
            <p style="margin: 5px 0;"><strong>Order ID:</strong> <code>${orderId}</code></p>
          </div>

          <p style="color: #666; font-size: 14px; margin-top: 15px;">
            Thanks for choosing Vyre! If you have any questions, please contact our support team.
          </p>
        </div>
      `;
        }
        else {
            // SELL: User paid fiat, received crypto
            notificationTitle = '🎉 Order Completed Successfully!';
            notificationContent = `
        <div style="font-family: Arial, sans-serif;">
          <h3 style="color: #112044; margin-bottom: 10px;">Your SELL order has been completed!</h3>
          
          <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <p style="margin: 5px 0;"><strong>Order Type:</strong> SELL ${baseCurrency}</p>
            <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ${quoteAmount} ${quoteCurrency}</p>
            <p style="margin: 5px 0;"><strong>Amount Received:</strong> ${baseAmount} ${baseCurrency}</p>
            <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${Number(order.price).toLocaleString('en-US')} ${quoteCurrency}</p>
            <p style="margin: 5px 0;"><strong>Order ID:</strong> <code>${orderId}</code></p>
          </div>

          <p style="color: #666; font-size: 14px; margin-top: 15px;">
            Thanks for choosing Vyre! If you have any questions, please contact our support team.
          </p>
        </div>
      `;
        }
        // Queue the notification
        await notification_service_1.default.queue({
            userId,
            title: notificationTitle,
            type: 'GENERAL',
            content: notificationContent
        });
    }
}
exports.default = new eventService();
