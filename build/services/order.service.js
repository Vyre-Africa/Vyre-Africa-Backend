"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const wallet_service_1 = __importDefault(require("../services/wallet.service"));
const env_config_1 = __importDefault(require("../config/env.config"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const notification_service_1 = __importDefault(require("./notification.service"));
const bullmq_1 = require("bullmq"); // Using BullMQ for job queue
// import connection from '../config/redis.config';
const redis_config_1 = __importDefault(require("../config/redis.config"));
const logger_1 = __importDefault(require("../config/logger"));
const decimal_util_1 = require("./decimal.util");
const minimum_config_1 = require("../config/minimum.config");
const ably_service_1 = __importDefault(require("./ably.service"));
const orderslot_service_1 = __importDefault(require("./orderslot.service"));
const moment_1 = __importDefault(require("moment"));
class OrderService {
    constructor() {
        this.MAX_DIRECT_RETRIES = 2;
        this.RETRY_DELAY_MS = 50;
        // Initialize the processing queue
        this.generalQueue = new bullmq_1.Queue('general-process', {
            connection: redis_config_1.default
        });
    }
    // ============================================
    // CREATE ORDER
    // ============================================
    async createOrder(payload) {
        const { userId, orderId, rate, amount, orderType, pairId, minimumAmount, baseWallet, quoteWallet } = payload;
        try {
            logger_1.default.info('Creating order', { userId, orderType, amount });
            const pair = await prisma_config_1.default.pair.findUnique({
                where: { id: pairId },
                include: {
                    quoteCurrency: { select: { id: true, ISO: true } },
                    baseCurrency: { select: { id: true, ISO: true } }
                }
            });
            if (!pair)
                throw new Error('Trading pair not found');
            // ✅ Get configured minimum for the base currency
            const configuredMinimum = (0, minimum_config_1.getMinimumOrderAmount)(pair.baseCurrency?.ISO);
            // ✅ Convert to Decimal for calculations
            const amountDecimal = new decimal_js_1.default(amount);
            const userMinimum = minimumAmount ? new decimal_js_1.default(minimumAmount) : new decimal_js_1.default(0);
            const enforcedMinimum = decimal_js_1.default.max(userMinimum, configuredMinimum);
            // ✅ Validate order amount meets minimum
            if (amountDecimal.lessThan(enforcedMinimum)) {
                const description = (0, minimum_config_1.getMinimumOrderDescription)(pair.baseCurrency?.ISO);
                throw new Error(`Order amount ${amountDecimal.toString()} ${pair.baseCurrency?.ISO} is below minimum requirement of ${description}`);
            }
            const baseBalance = new decimal_js_1.default(baseWallet.availableBalance);
            const quoteBalance = new decimal_js_1.default(quoteWallet.availableBalance);
            // ✅ Balance checks with Decimal
            if (orderType === 'SELL' && baseBalance.lessThan(amountDecimal)) {
                throw new Error('Insufficient base balance');
            }
            if (orderType === 'BUY' && quoteBalance.lessThan(amountDecimal)) {
                throw new Error('Insufficient quote balance');
            }
            // ✅ Fee calculation with Decimal (1.2% fee)
            const feeRate = new decimal_js_1.default('0.012');
            const fee = amountDecimal.times(feeRate);
            const adjustedAmount = amountDecimal.minus(fee);
            // ✅ Ensure adjusted amount (after fee) still meets minimum
            if (adjustedAmount.lessThan(enforcedMinimum)) {
                throw new Error(`Order amount after fees (${adjustedAmount.toString()} ${pair.baseCurrency?.ISO}) is below minimum. ` +
                    `Please increase order amount to cover fees and meet minimum of ${enforcedMinimum.toString()} ${pair.baseCurrency?.ISO}`);
            }
            logger_1.default.info('Fee calculation', {
                amount: amountDecimal.toString(),
                fee: fee.toString(),
                adjustedAmount: adjustedAmount.toString()
            });
            const result = await prisma_config_1.default.$transaction(async (tx) => {
                // Transfer fee to admin (if not admin creating the order)
                if (env_config_1.default.Admin_Id !== userId) {
                    await wallet_service_1.default.offchain_Transfer({
                        userId,
                        receipientId: env_config_1.default.Admin_Id,
                        currencyId: orderType === 'SELL'
                            ? pair?.baseCurrency?.id
                            : pair?.quoteCurrency?.id,
                        amount: fee.toString() // ✅ Convert for wallet service
                    });
                }
                // Block the adjusted amount
                const blockId = await wallet_service_1.default.block_Amount(adjustedAmount.toNumber(), // ✅ Convert for wallet service
                orderType === 'SELL' ? baseWallet.id : quoteWallet.id);
                // Create order with Decimal values
                return await tx.order.create({
                    data: {
                        id: orderId,
                        userId,
                        blockId,
                        amountMinimum: enforcedMinimum, // ✅ Prisma accepts number or Decimal
                        amount: adjustedAmount, // ✅ Prisma accepts number or Decimal
                        type: orderType,
                        pairId,
                        price: rate, // ✅ Prisma accepts number or Decimal
                        version: 0
                    }
                });
            }, {
                maxWait: 10000,
                timeout: 30000,
                isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted,
            });
            // Notification with formatted amount
            await notification_service_1.default.queue({
                userId,
                title: 'Order is Live!',
                type: 'GENERAL',
                content: `Your <strong>${orderType}</strong> order for <strong>${decimal_util_1.DecimalUtil.formatWithCurrency(amountDecimal, pair.baseCurrency?.ISO)}</strong> is now active.`
            });
            logger_1.default.info('Order created successfully', {
                orderId: result.id,
                adjustedAmount: adjustedAmount.toString(),
                fee: fee.toString()
            });
            return result;
        }
        catch (error) {
            logger_1.default.error('Order creation failed:', {
                error: error.message,
                userId,
                orderType,
                amount
            });
            throw error;
        }
    }
    // ============================================
    // CANCEL ORDER
    // ============================================
    async cancelOrder(payload) {
        const { orderId, userId } = payload;
        try {
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                include: {
                    pair: {
                        include: {
                            baseCurrency: true,
                            quoteCurrency: true
                        }
                    }
                }
            });
            if (!order)
                throw new Error('Order not found');
            if (order.userId !== userId)
                throw new Error('Unauthorized');
            if (order.status !== 'OPEN')
                throw new Error(`Cannot cancel ${order.status.toLowerCase()} order`);
            const pendingCount = await prisma_config_1.default.awaiting.count({
                where: {
                    orderId: order.id,
                    status: { in: ['PENDING', 'PROCESSING'] }
                }
            });
            if (pendingCount > 0) {
                throw new Error(`Cannot cancel. ${pendingCount} pending transaction(s).`);
            }
            const canceledOrder = await prisma_config_1.default.$transaction(async (tx) => {
                await wallet_service_1.default.unblock_Amount(order.blockId);
                return await tx.order.update({
                    where: { id: order.id },
                    data: { status: 'CANCELED' }
                });
            }, {
                maxWait: 10000, // 10 seconds to get connection
                timeout: 30000, // 30 seconds for transaction (increased from 5s)
                isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
            });
            const currencyISO = order.type === 'SELL'
                ? order.pair.baseCurrency?.ISO
                : order.pair.quoteCurrency?.ISO;
            await notification_service_1.default.queue({
                userId: order.userId,
                title: 'Order Cancelled',
                type: 'GENERAL',
                content: `Your <strong>${order.type}</strong> order for <strong>${decimal_util_1.DecimalUtil.formatWithCurrency(order.amount, currencyISO)}</strong> has been cancelled. Funds are now available.`
            });
            return canceledOrder;
        }
        catch (error) {
            logger_1.default.error('Order cancellation failed:', error);
            throw error;
        }
    }
    async validateOrderProcessing(order, amount, userBaseWallet, userQuoteWallet) {
        if (order.status !== 'OPEN') {
            throw new Error(`Order is ${order.status.toLowerCase()}`);
        }
        // ✅ Convert to Decimal
        const orderAmount = new decimal_js_1.default(order.amount);
        const orderAmountProcessed = new decimal_js_1.default(order.amountProcessed || 0);
        const orderPrice = new decimal_js_1.default(order.price);
        const amountDecimal = new decimal_js_1.default(amount);
        const remainingAmount = orderAmount.minus(orderAmountProcessed);
        if (remainingAmount.lessThanOrEqualTo(0)) {
            throw new Error('Order fully processed');
        }
        const maxAmount = order.type === 'BUY'
            ? remainingAmount.dividedBy(orderPrice)
            : remainingAmount.times(orderPrice);
        if (amountDecimal.greaterThan(maxAmount)) {
            throw new Error(`Max available: ${maxAmount.toFixed(8)}, requested: ${amountDecimal.toFixed(8)}`);
        }
        // ✅ Convert wallet balances to Decimal
        const baseBalance = new decimal_js_1.default(userBaseWallet.availableBalance);
        const quoteBalance = new decimal_js_1.default(userQuoteWallet.availableBalance);
        if (order.type === 'BUY' && baseBalance.lessThan(amountDecimal)) {
            throw new Error('Insufficient base balance');
        }
        if (order.type === 'SELL' && quoteBalance.lessThan(amountDecimal)) {
            throw new Error('Insufficient quote balance');
        }
        return {
            remainingAmount: remainingAmount.toNumber(), // Convert back for compatibility
            maxAmount: maxAmount.toNumber(),
            isValid: true
        };
    }
    // ============================================
    // PROCESS ORDER - TRANSACTION-SAFE VERSION
    // ============================================
    async processOrder(payload) {
        const { userId, orderId, amount, userBaseWallet, userQuoteWallet, retryCount = 0 } = payload;
        const startTime = Date.now();
        try {
            logger_1.default.info('Processing order', { userId, orderId, amount, retryCount });
            const result = await this.attemptDirectProcessing({
                userId,
                orderId,
                amount,
                userBaseWallet,
                userQuoteWallet
            });
            const duration = Date.now() - startTime;
            logger_1.default.info('Order processed successfully', { orderId, duration, retryCount });
            return result;
        }
        catch (error) {
            const duration = Date.now() - startTime;
            if (this.isVersionConflict(error)) {
                logger_1.default.warn('Version conflict detected', { orderId, retryCount, duration });
                if (retryCount < this.MAX_DIRECT_RETRIES) {
                    await this.sleep(this.RETRY_DELAY_MS * (retryCount + 1));
                    return this.processOrder({
                        userId,
                        orderId,
                        amount,
                        userBaseWallet,
                        userQuoteWallet,
                        retryCount: retryCount + 1
                    });
                }
                logger_1.default.info('Queueing order due to contention', { orderId, retryCount });
                await this.generalQueue.add('process-order', { userId, orderId, amount, userBaseWallet, userQuoteWallet }, {
                    delay: 100,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 100 }
                });
                return {
                    status: 'queued',
                    message: 'Order queued for processing due to high demand'
                };
            }
            logger_1.default.error('Order processing failed', { orderId, error: error.message, duration });
            throw error;
        }
    }
    // ============================================
    // DIRECT PROCESSING WITH EARLY VERSION CHECK
    // ============================================
    async attemptDirectProcessing(payload) {
        const { userId, orderId, amount, userBaseWallet, userQuoteWallet } = payload;
        return await prisma_config_1.default.$transaction(async (tx) => {
            // ============================================
            // STEP 1: LOCK ORDER & CHECK VERSION
            // ============================================
            // const [orderRow] = await tx.$queryRaw<any[]>`
            //   SELECT * FROM "Order" 
            //   WHERE id = ${orderId}
            //   FOR UPDATE
            // `;
            const order = await tx.order.findUnique({
                where: { id: orderId }
            });
            if (!order) {
                throw new Error('Order not found');
            }
            logger_1.default.info('Order fetched (no lock)', {
                orderId,
                version: order.version,
                amountProcessed: order.amountProcessed,
                amountReserved: order.amountReserved
            });
            const currentVersion = order.version;
            // const order = orderRow;
            // logger.info('Order locked', { 
            //   orderId, 
            //   version: currentVersion,
            //   amountProcessed: order.amountProcessed 
            // });
            // ============================================
            // STEP 2: VALIDATE
            // ============================================
            const pair = await tx.pair.findUnique({
                where: { id: order.pairId },
                include: {
                    quoteCurrency: {
                        select: { id: true, ISO: true },
                    },
                    baseCurrency: {
                        select: { id: true, ISO: true },
                    },
                    quoteWallet: true,
                    baseWallet: true,
                }
            });
            if (!pair)
                throw new Error('Trading pair not found');
            this.validateOrderProcessing(order, amount, userBaseWallet, userQuoteWallet);
            const [orderBaseWallet, orderQuoteWallet] = await Promise.all([
                tx.wallet.findFirst({
                    where: { currencyId: pair.baseCurrency?.id, userId: order.userId }
                }),
                tx.wallet.findFirst({
                    where: { currencyId: pair.quoteCurrency?.id, userId: order.userId }
                })
            ]);
            if (!orderBaseWallet || !orderQuoteWallet) {
                throw new Error('Order owner wallets not found');
            }
            // ============================================
            // STEP 3: CALCULATE AMOUNTS WITH DECIMAL
            // ============================================
            const amountDecimal = new decimal_js_1.default(amount);
            const priceDecimal = new decimal_js_1.default(order.price);
            const orderAmountDecimal = new decimal_js_1.default(order.amount);
            const orderAmountProcessedDecimal = new decimal_js_1.default(order.amountProcessed || 0);
            const orderAmountReservedDecimal = new decimal_js_1.default(order.amountReserved || 0);
            // Calculate amount to process
            const amountToProcess = order.type === 'BUY'
                ? amountDecimal.times(priceDecimal) // base * price = quote
                : amountDecimal.dividedBy(priceDecimal); // quote / price = base
            // Calculate new totals
            const newAmountProcessed = orderAmountProcessedDecimal.plus(amountToProcess);
            //Release the reserved amount as we process it
            const newAmountReserved = orderAmountReservedDecimal.minus(amountToProcess);
            const newPercentage = newAmountProcessed
                .dividedBy(orderAmountDecimal)
                .times(100)
                .toDecimalPlaces(2);
            const newStatus = newAmountProcessed.greaterThanOrEqualTo(orderAmountDecimal)
                ? 'CLOSED'
                : 'OPEN';
            logger_1.default.info('Amounts calculated', {
                orderId,
                amountToProcess: amountToProcess.toString(),
                newAmountProcessed: newAmountProcessed.toString(),
                newAmountReserved: newAmountReserved.toString(),
                newPercentage: newPercentage.toString(),
                newStatus
            });
            // ============================================
            // STEP 4: UPDATE ORDER
            // ============================================
            const updateResult = await tx.order.updateMany({
                where: {
                    id: orderId,
                    version: currentVersion
                },
                data: {
                    amountProcessed: decimal_util_1.DecimalUtil.roundForStorage(newAmountProcessed, order.type === 'BUY' ? pair?.quoteCurrency?.ISO : pair?.baseCurrency?.ISO), // Prisma accepts Decimal
                    percentageProcessed: newPercentage.toNumber(), // Convert to number for float field
                    status: newStatus,
                    version: currentVersion + 1
                }
            });
            if (updateResult.count === 0) {
                logger_1.default.warn('Version conflict during update', {
                    orderId,
                    expectedVersion: currentVersion
                });
                throw new Error('VERSION_CONFLICT: Order was modified by another transaction');
            }
            logger_1.default.info('Order updated successfully', {
                orderId,
                newVersion: currentVersion + 1,
                newAmountProcessed: newAmountProcessed.toString(),
                newAmountReserved: newAmountReserved.toString()
            });
            // ============================================
            // STEP 5: EXECUTE TRANSFERS
            // ============================================
            if (order.type === 'BUY') {
                await Promise.all([
                    wallet_service_1.default.unblock_Transfer(String(amountToProcess), // Convert for wallet service
                    order?.blockId, userQuoteWallet.id),
                    wallet_service_1.default.direct_offchain_Transfer({
                        userId,
                        receipientId: order.userId,
                        currencyId: pair?.baseCurrency?.id,
                        amount: amountDecimal.toString() // Original amount (base currency)
                    })
                ]);
            }
            else {
                await Promise.all([
                    wallet_service_1.default.unblock_Transfer(String(amountToProcess), // Convert for wallet service
                    order.blockId, userBaseWallet.id),
                    wallet_service_1.default.direct_offchain_Transfer({
                        userId,
                        receipientId: order.userId,
                        currencyId: pair?.quoteCurrency?.id,
                        amount: amountDecimal.toString() // Original amount (quote currency)
                    })
                ]);
            }
            logger_1.default.info('Transfers completed', { orderId });
            // ============================================
            // STEP 6: LOG TRANSACTION
            // ============================================
            const logResult = await tx.orderLog.create({
                data: {
                    userId,
                    orderId,
                    baseAmount: order.type === 'BUY'
                        ? amount
                        : amountToProcess.toNumber(),
                    quoteAmount: order.type === 'BUY'
                        ? amountToProcess.toNumber()
                        : amount,
                    baseCurrency: order.type === 'BUY' ? pair?.baseCurrency?.ISO : pair?.quoteCurrency?.ISO,
                    quoteCurrency: order.type === 'BUY' ? pair?.quoteCurrency?.ISO : pair?.baseCurrency?.ISO,
                    rate: order.price, // Prisma accepts Decimal
                    orderType: order.type
                }
            });
            // ============================================
            // STEP 7: NOTIFICATION
            // ============================================
            this.sendOrderSuccessNotification({
                userId,
                orderId,
                amount,
                baseCurrency: pair?.baseCurrency?.ISO,
                quoteCurrency: pair?.quoteCurrency?.ISO
            }).catch(err => logger_1.default.error('Notification failed', err));
            return {
                id: order.id,
                log: logResult,
                amountProcessed: newAmountProcessed.toNumber(), // Convert for response
                percentageProcessed: newPercentage.toNumber(),
                status: newStatus,
                version: currentVersion + 1
            };
        }, {
            maxWait: 15000,
            timeout: 120000,
            isolationLevel: client_1.Prisma.TransactionIsolationLevel.ReadCommitted,
        });
    }
    // ============================================
    // HELPER METHODS
    // ============================================
    isVersionConflict(error) {
        return error.message?.includes('VERSION_CONFLICT') ||
            error.code === 'P2034' ||
            error.message?.includes('was modified');
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async sendOrderSuccessNotification(params) {
        const { userId, baseCurrency, quoteCurrency, amount, orderId } = params;
        const order = await prisma_config_1.default.order.findUnique({
            where: { id: orderId }
        });
        if (!order)
            return;
        // const amountProcessed = order.type === 'BUY'
        //   ? amount * order.price
        //   : amount / order.price;
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
        const baseAmount = order.type === 'BUY' ? amount : amountProcessed;
        const quoteAmount = order.type === 'BUY' ? amountProcessed : amount;
        await notification_service_1.default.queue({
            userId,
            title: '🎉 Order Completed!',
            type: 'GENERAL',
            content: `Your ${order.type} order has been completed successfully!
            You ${order.type === 'BUY' ? 'Sent' : 'Received'}: ${decimal_util_1.DecimalUtil.formatWithCurrency(baseAmount, baseCurrency)}
            You ${order.type === 'BUY' ? 'Received' : 'Sent'}: ${decimal_util_1.DecimalUtil.formatWithCurrency(quoteAmount, quoteCurrency)}
            Rate: ${Number(order.price)?.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 8
            })} ${quoteCurrency}/${baseCurrency}`
        });
    }
    /**
    * Process queued order (called by worker)
    */
    async processOrderJob(jobData) {
        const { awaitingId } = jobData;
        try {
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
                    currency: true,
                    wallet: true,
                    postDetails: true
                }
            });
            if (!awaiting) {
                throw new Error(`Awaiting record ${awaitingId} not found`);
            }
            // Update status to processing
            await prisma_config_1.default.awaiting.update({
                where: { id: awaitingId },
                data: { status: 'PROCESSING' }
            });
            await ably_service_1.default.awaiting_Order_Update(awaitingId);
            // Find required wallets
            const [userBaseWallet, userQuoteWallet] = await Promise.all([
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        userId: awaiting.userId,
                        currencyId: awaiting.order?.pair?.baseId
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: {
                        userId: awaiting.userId,
                        currencyId: awaiting.order?.pair?.quoteId
                    }
                })
            ]);
            if (!userBaseWallet || !userQuoteWallet) {
                throw new Error('Required wallets not found');
            }
            // Process the order
            const result = await this.processOrder({
                userId: awaiting?.userId,
                orderId: awaiting?.orderId,
                amount: Number(awaiting.amount),
                userBaseWallet,
                userQuoteWallet
            });
            const { log } = result;
            await prisma_config_1.default.awaiting.update({
                where: { id: awaitingId },
                data: {
                    status: 'SUCCESS',
                    log: result.log
                }
            });
            await ably_service_1.default.awaiting_Order_Update(awaitingId);
            // Queue order for post Action processing
            if (awaiting?.postDetails.length > 0) {
                logger_1.default.info(`Queuing post action for awaiting: ${awaitingId}`);
                await this.generalQueue.add('process-post-action', {
                    awaitingId
                });
                logger_1.default.info(`order processed and queued for post action: ${result?.id}`);
            }
            return { status: 'processed', action: 'process-post-action' };
        }
        catch (error) {
            console.error(`Order processing failed for ${awaitingId}:`, error);
            await orderslot_service_1.default.cancelAwaiting(awaitingId, `Order processing failed for ${awaitingId}:`);
            await ably_service_1.default.awaiting_Order_Update(awaitingId);
            throw error;
        }
    }
    // ============================================
    // Initiates and instantly queues an order
    // ============================================
    async instantOrder(payload) {
        const { orderId, amount, userId, baseWallet, quoteWallet } = payload;
        let reservationId;
        try {
            logger_1.default.info('Processing instant order', { orderId, userId, amount });
            // ============================================
            // STEP 1: FETCH ORDER DETAILS
            // ============================================
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                select: {
                    id: true,
                    type: true,
                    pairId: true,
                    price: true,
                    amount: true
                }
            });
            if (!order) {
                return {
                    success: false,
                    message: 'Order not found'
                };
            }
            // ============================================
            // STEP 2: RESERVE ORDER SLOT
            // ============================================
            const reservation = await orderslot_service_1.default.reserveOrderSlot(orderId, amount);
            if (!reservation.success) {
                return {
                    success: false,
                    message: reservation.reason ||
                        `Insufficient order capacity. Available: ${reservation.availableAmount}, Requested: ${amount}`
                };
            }
            reservationId = reservation.awaitingId;
            logger_1.default.info('Order slot reserved', {
                orderId,
                awaitingId: reservationId,
                amount
            });
            // ============================================
            // STEP 3: UPDATE AWAITING WITH USER DETAILS
            // ============================================
            const expiryDuration = (0, moment_1.default)().add(30, 'minutes').toDate();
            const walletId = order.type === 'BUY' ? baseWallet.id : quoteWallet.id;
            const awaiting = await prisma_config_1.default.awaiting.update({
                where: { id: reservationId },
                data: {
                    userId,
                    walletId,
                    duration: expiryDuration,
                },
                select: {
                    id: true,
                    orderId: true,
                    userId: true,
                    amount: true,
                    duration: true,
                    status: true
                }
            });
            // ============================================
            // STEP 4: QUEUE ORDER PROCESSING
            // ============================================
            await this.process_Order_Queue({
                awaitingId: awaiting.id,
            });
            logger_1.default.info('Instant order queued successfully', {
                awaitingId: awaiting.id,
                orderId,
                userId
            });
            return {
                success: true,
                message: 'Order processing initiated successfully',
                data: {
                    awaitingId: awaiting.id,
                    orderId,
                    amount: awaiting.amount.toString(),
                    expiresAt: awaiting.duration,
                    status: awaiting.status
                }
            };
        }
        catch (error) {
            // ❌ CLEANUP: Release reservation if failed
            if (reservationId) {
                logger_1.default.warn('Releasing reservation due to error', {
                    awaitingId: reservationId,
                    error: error.message
                });
                await orderslot_service_1.default.cancelAwaiting(reservationId, `Instant order failed: ${error.message}`).catch(cleanupError => {
                    logger_1.default.error('Failed to cleanup reservation', {
                        awaitingId: reservationId,
                        error: cleanupError.message
                    });
                });
            }
            logger_1.default.error('Instant order failed', {
                orderId,
                userId,
                error: error.message
            });
            return {
                success: false,
                message: error.message || 'Failed to process instant order'
            };
        }
    }
    async create_Order_Queue(payload) {
        return await this.generalQueue.add('create-order', payload);
    }
    async process_Order_Queue(payload) {
        return await this.generalQueue.add('process-order', payload);
    }
}
exports.default = new OrderService();
