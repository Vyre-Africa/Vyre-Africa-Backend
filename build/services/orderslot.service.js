"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const logger_1 = __importDefault(require("../config/logger"));
const decimal_js_1 = __importDefault(require("decimal.js"));
/**
 * Order Slot Helper
 * Prevents overbooking by checking pending awaiting orders
 */
class OrderSlotService {
    /**
     * Atomically reserve a slot on an order using database-level atomic operations.
     * This approach handles 1000s of concurrent requests without queuing or race conditions.
     */
    async reserveOrderSlot(orderId, requestedAmount) {
        try {
            const requestedDecimal = new decimal_js_1.default(requestedAmount);
            logger_1.default.info('Starting atomic slot reservation', {
                orderId,
                requestedAmount: requestedDecimal.toString(),
            });
            // Step 1: Get order details to determine conversion logic
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                select: {
                    id: true,
                    type: true,
                    amount: true,
                    amountProcessed: true,
                    amountReserved: true,
                    amountMinimum: true,
                    status: true,
                    price: true
                }
            });
            if (!order) {
                return {
                    success: false,
                    requestedAmount: requestedDecimal.toString(),
                    reason: 'Order not found'
                };
            }
            if (order.status !== 'OPEN') {
                return {
                    success: false,
                    requestedAmount: requestedDecimal.toString(),
                    orderAmount: order.amount.toString(),
                    amountProcessed: order.amountProcessed.toString(),
                    amountReserved: order.amountReserved.toString(),
                    reason: `Order is ${order.status.toLowerCase()}`
                };
            }
            const orderPrice = new decimal_js_1.default(order.price);
            const orderMinimum = new decimal_js_1.default(order.amountMinimum);
            const amountInBase = order.type === 'SELL'
                ? requestedDecimal.dividedBy(orderPrice)
                : requestedDecimal;
            if (amountInBase.lessThan(orderMinimum)) {
                console.log('Requested amount is below order minimum');
                return {
                    success: false,
                    requestedAmount: requestedDecimal.toString(),
                    orderAmount: order.amount.toString(),
                    amountProcessed: order.amountProcessed.toString(),
                    amountReserved: order.amountReserved.toString(),
                    reason: `Order is below minimum amount of ${orderMinimum.toFixed(8)} in base currency`
                };
            }
            // Step 2: Convert requested amount to order's base currency
            // This is what we'll reserve on the order
            let amountToReserve;
            if (order.type === 'SELL') {
                // SELL: User sends QUOTE currency, order.amount is in BASE
                // Pending amount is in QUOTE, convert to BASE for reservation
                amountToReserve = requestedDecimal.dividedBy(orderPrice);
            }
            else {
                // BUY: User sends BASE currency, order.amount is in QUOTE
                // Pending amount is in BASE, convert to QUOTE for reservation
                amountToReserve = requestedDecimal.times(orderPrice);
            }
            logger_1.default.info('Calculated amount to reserve', {
                orderId,
                requestedAmount: requestedDecimal.toString(),
                amountToReserve: amountToReserve.toString(),
                orderType: order.type,
                orderPrice: orderPrice.toString()
            });
            // Step 3: Atomic reservation using single UPDATE query
            // This is the magic - no race conditions possible!
            const updated = await prisma_config_1.default.$executeRaw `
        UPDATE "Order"
        SET "amountReserved" = "amountReserved" + ${amountToReserve.toString()}::numeric
        WHERE id = ${orderId}
          AND status = 'OPEN'
          AND (amount - "amountProcessed" - "amountReserved") >= ${amountToReserve.toString()}::numeric
      `;
            // Step 4: Check if update succeeded
            if (updated === 0) {
                // Reservation failed - calculate why
                const currentOrder = await prisma_config_1.default.order.findUnique({
                    where: { id: orderId },
                    select: {
                        amount: true,
                        amountProcessed: true,
                        amountReserved: true,
                        status: true
                    }
                });
                if (!currentOrder) {
                    return {
                        success: false,
                        requestedAmount: requestedDecimal.toString(),
                        reason: 'Order not found'
                    };
                }
                if (currentOrder.status !== 'OPEN') {
                    return {
                        success: false,
                        requestedAmount: requestedDecimal.toString(),
                        orderAmount: currentOrder.amount.toString(),
                        amountProcessed: currentOrder.amountProcessed.toString(),
                        amountReserved: currentOrder.amountReserved.toString(),
                        reason: `Order status changed to ${currentOrder.status.toLowerCase()}`
                    };
                }
                const available = new decimal_js_1.default(currentOrder.amount)
                    .minus(currentOrder.amountProcessed)
                    .minus(currentOrder.amountReserved);
                logger_1.default.warn('Insufficient amount for reservation', {
                    orderId,
                    available: available.toString(),
                    requestedAmount: requestedDecimal.toString(),
                    amountToReserve: amountToReserve.toString()
                });
                return {
                    success: false,
                    availableAmount: available.toString(),
                    requestedAmount: requestedDecimal.toString(),
                    orderAmount: currentOrder.amount.toString(),
                    amountProcessed: currentOrder.amountProcessed.toString(),
                    amountReserved: currentOrder.amountReserved.toString(),
                    reason: `Insufficient amount. Available: ${available.toFixed(8)}, Requested: ${amountToReserve.toFixed(8)}`
                };
            }
            // Step 5: Reservation successful! Create awaiting record
            const awaiting = await prisma_config_1.default.awaiting.create({
                data: {
                    orderId,
                    amount: requestedDecimal,
                    status: 'PENDING',
                    orderType: order.type
                }
            });
            logger_1.default.info('Slot reserved successfully', {
                orderId,
                awaitingId: awaiting.id,
                requestedAmount: requestedDecimal.toString(),
                amountReserved: amountToReserve.toString(),
            });
            // Step 6: Get final state for response
            const updatedOrder = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                select: {
                    amount: true,
                    amountProcessed: true,
                    amountReserved: true
                }
            });
            const finalAvailable = new decimal_js_1.default(updatedOrder.amount)
                .minus(updatedOrder.amountProcessed)
                .minus(updatedOrder.amountReserved);
            return {
                success: true,
                awaitingId: awaiting.id,
                availableAmount: finalAvailable.toString(),
                requestedAmount: requestedDecimal.toString(),
                orderAmount: updatedOrder.amount.toString(),
                amountProcessed: updatedOrder.amountProcessed.toString(),
                amountReserved: updatedOrder.amountReserved.toString()
            };
        }
        catch (error) {
            logger_1.default.error('Atomic slot reservation failed', {
                orderId,
                requestedAmount,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    /**
     * Release a reservation when awaiting is cancelled, expired, or completed.
     * This frees up the reserved amount for other requests.
     */
    async releaseReservation(awaitingId) {
        try {
            // Get the awaiting record
            const awaiting = await prisma_config_1.default.awaiting.findUnique({
                where: { id: awaitingId },
                select: {
                    id: true,
                    orderId: true,
                    amount: true,
                    status: true,
                    orderType: true,
                    order: {
                        select: {
                            price: true,
                            type: true
                        }
                    }
                }
            });
            if (!awaiting) {
                throw new Error('Awaiting not found');
            }
            // Only release if it was pending (not already completed/processed)
            if (awaiting.status !== 'PENDING') {
                console.log('awaiting to release', awaiting);
                logger_1.default.info('Awaiting not in PENDING status, skipping release', {
                    awaitingId,
                    status: awaiting.status
                });
                return;
            }
            // Calculate amount to release (convert back to order currency)
            const awaitingAmount = new decimal_js_1.default(awaiting.amount);
            const orderPrice = new decimal_js_1.default(awaiting.order?.price);
            let amountToRelease;
            if (awaiting.order?.type === 'SELL') {
                // SELL: awaiting.amount is in QUOTE, convert to BASE
                amountToRelease = awaitingAmount.dividedBy(orderPrice);
            }
            else {
                // BUY: awaiting.amount is in BASE, convert to QUOTE
                amountToRelease = awaitingAmount.times(orderPrice);
            }
            logger_1.default.info('Releasing reservation', {
                awaitingId,
                orderId: awaiting.orderId,
                amountToRelease: amountToRelease.toString()
            });
            // Atomic release
            await prisma_config_1.default.$executeRaw `
        UPDATE "Order"
        SET "amountReserved" = "amountReserved" - ${amountToRelease.toString()}::numeric
        WHERE id = ${awaiting.orderId}
          AND "amountReserved" >= ${amountToRelease.toString()}::numeric
      `;
            logger_1.default.info('Reservation released successfully', {
                awaitingId,
                orderId: awaiting.orderId,
                amountReleased: amountToRelease.toString()
            });
        }
        catch (error) {
            logger_1.default.error('Failed to release reservation', {
                awaitingId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    /**
     * Cancel an awaiting and release its reservation.
     */
    async cancelAwaiting(awaitingId, reason) {
        try {
            // Release the reservation
            await this.releaseReservation(awaitingId);
            await prisma_config_1.default.$transaction(async (tx) => {
                // Update awaiting status
                const awaiting = await tx.awaiting.update({
                    where: { id: awaitingId },
                    data: {
                        status: 'FAILED',
                        metadata: {
                            cancelledAt: new Date(),
                            cancellationReason: reason,
                        }
                    },
                    include: {
                        postDetails: true
                    }
                });
                if (awaiting?.postDetails.length > 0) {
                    await tx.postDetails.updateMany({
                        where: {
                            awaitingId,
                        },
                        data: {
                            status: 'FAILED'
                        }
                    });
                }
            });
            logger_1.default.info('Awaiting cancelled successfully', {
                awaitingId,
                reason
            });
        }
        catch (error) {
            logger_1.default.error('Failed to cancel awaiting', {
                awaitingId,
                reason,
                error: error.message
            });
            throw error;
        }
    }
    /**
     * Check if order has available slot for the requested amount
     */
    async checkAvailableSlot(orderId, requestedAmount) {
        try {
            const requestedAmountDecimal = new decimal_js_1.default(requestedAmount);
            logger_1.default.info('Checking order slot availability', {
                orderId,
                requestedAmount: requestedAmountDecimal.toString()
            });
            // 1. Fetch order details
            const order = await prisma_config_1.default.order.findUnique({
                where: { id: orderId },
                select: {
                    id: true,
                    type: true,
                    amount: true,
                    amountProcessed: true,
                    status: true,
                    price: true
                }
            });
            if (!order) {
                throw new Error('Order not found');
            }
            if (order.status !== 'OPEN') {
                return {
                    hasAvailableSlot: false,
                    availableAmount: '0',
                    requestedAmount: requestedAmountDecimal.toString(),
                    orderAmount: order.amount.toString(),
                    amountProcessed: order.amountProcessed.toString(),
                    pendingAmount: '0',
                    reason: `Order is ${order.status.toLowerCase()}`
                };
            }
            const orderAmount = new decimal_js_1.default(order.amount);
            const amountProcessed = new decimal_js_1.default(order.amountProcessed);
            // 2. Calculate remaining unprocessed amount
            const remainingAmount = orderAmount.minus(amountProcessed);
            logger_1.default.info('Order amounts', {
                orderId,
                orderAmount: orderAmount.toString(),
                amountProcessed: amountProcessed.toString(),
                remainingAmount: remainingAmount.toString()
            });
            if (remainingAmount.lessThanOrEqualTo(0)) {
                return {
                    hasAvailableSlot: false,
                    availableAmount: '0',
                    requestedAmount: requestedAmountDecimal.toString(),
                    orderAmount: orderAmount.toString(),
                    amountProcessed: amountProcessed.toString(),
                    pendingAmount: '0',
                    reason: 'Order is fully processed'
                };
            }
            // 3. Fetch all pending awaiting orders for this order
            const pendingAwaitings = await prisma_config_1.default.awaiting.findMany({
                where: {
                    orderId,
                    status: {
                        in: ['PENDING', 'PROCESSING']
                    }
                },
                select: {
                    id: true,
                    amount: true,
                    status: true,
                    orderType: true
                }
            });
            logger_1.default.info('Pending awaiting orders found', {
                orderId,
                count: pendingAwaitings.length
            });
            // 4. Calculate total pending amount
            let totalPendingAmount = new decimal_js_1.default(0);
            for (const awaiting of pendingAwaitings) {
                const awaitingAmount = new decimal_js_1.default(awaiting.amount);
                totalPendingAmount = totalPendingAmount.plus(awaitingAmount);
            }
            let totalEffectiveAmount;
            if (order.type === 'SELL') {
                // totalPendingAmount would be BASE
                // totalEffectiveAmount would be QUOTE
                totalEffectiveAmount = totalPendingAmount.dividedBy(order.price);
            }
            else {
                // totalPendingAmount would be QUOTE
                // totalEffectiveAmount would be BASE
                totalEffectiveAmount = totalPendingAmount.times(order.price);
            }
            // const availableAmount = orderAmount.minus(amountProcessed).plus(totalEffectiveAmount);
            const availableAmount = remainingAmount.minus(totalEffectiveAmount);
            logger_1.default.info('Total effective pending amount calculated', {
                orderId,
                totalPendingAmount: totalPendingAmount.toString(),
                totalEffectiveAmount: totalEffectiveAmount.toString(),
                availableAmount: availableAmount.toString()
            });
            if (availableAmount.lessThan(0)) {
                logger_1.default.warn('Order is overbooked', {
                    orderId,
                    availableAmount: availableAmount.toString(),
                    overbookedBy: availableAmount.abs().toString()
                });
                return {
                    hasAvailableSlot: false,
                    availableAmount: '0',
                    requestedAmount: requestedAmountDecimal.toString(),
                    orderAmount: orderAmount.toString(),
                    amountProcessed: amountProcessed.toString(),
                    pendingAmount: totalPendingAmount.toString(),
                    reason: `Order is overbooked by ${availableAmount.abs().toFixed(8)}`
                };
            }
            let requestedInOrderCurrency;
            if (order.type === 'SELL') {
                requestedInOrderCurrency = requestedAmountDecimal.dividedBy(order.price);
            }
            else {
                requestedInOrderCurrency = requestedAmountDecimal.times(order.price);
            }
            logger_1.default.info('Requested amount in order currency', {
                orderId,
                requestedAmount: requestedAmountDecimal.toString(),
                requestedInOrderCurrency: requestedInOrderCurrency.toString(),
                orderType: order.type
            });
            const hasAvailableSlot = availableAmount.greaterThanOrEqualTo(requestedInOrderCurrency);
            if (!hasAvailableSlot) {
                const shortfall = requestedInOrderCurrency.minus(availableAmount);
                return {
                    hasAvailableSlot: false,
                    availableAmount: availableAmount.toString(),
                    requestedAmount: requestedAmountDecimal.toString(),
                    orderAmount: orderAmount.toString(),
                    amountProcessed: amountProcessed.toString(),
                    pendingAmount: totalPendingAmount.toString(),
                    reason: `Insufficient available amount. Available: ${availableAmount.toFixed(8)}, Requested: ${requestedInOrderCurrency.toFixed(8)}, Shortfall: ${shortfall.toFixed(8)}`
                };
            }
            logger_1.default.info('Slot check passed', {
                orderId,
                hasAvailableSlot: true,
                availableAmount: availableAmount.toString()
            });
            return {
                hasAvailableSlot: true,
                availableAmount: availableAmount.toString(),
                requestedAmount: requestedAmountDecimal.toString(),
                orderAmount: orderAmount.toString(),
                amountProcessed: amountProcessed.toString(),
                pendingAmount: totalPendingAmount.toString()
            };
        }
        catch (error) {
            logger_1.default.error('Order slot check failed', {
                orderId,
                requestedAmount,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    /**
     * Get maximum available amount for an order
     */
    async getMaxAvailableAmount(orderId) {
        const slotCheck = await this.checkAvailableSlot(orderId, 0);
        return slotCheck.availableAmount;
    }
    /**
     * Get order slot statistics
     */
    async getOrderSlotStats(orderId) {
        try {
            const [order, pendingAwaitings] = await Promise.all([
                prisma_config_1.default.order.findUnique({
                    where: { id: orderId },
                    select: {
                        id: true,
                        type: true,
                        amount: true,
                        amountProcessed: true,
                        status: true,
                        price: true
                    }
                }),
                prisma_config_1.default.awaiting.findMany({
                    where: {
                        orderId,
                        status: {
                            in: ['PENDING', 'PROCESSING']
                        }
                    },
                    select: {
                        id: true,
                        amount: true,
                        status: true,
                        createdAt: true
                    }
                })
            ]);
            if (!order)
                throw new Error('Order not found');
            const orderAmount = new decimal_js_1.default(order.amount);
            const amountProcessed = new decimal_js_1.default(order.amountProcessed);
            const remainingAmount = orderAmount.minus(amountProcessed);
            let totalPendingAmount = new decimal_js_1.default(0);
            for (const awaiting of pendingAwaitings) {
                const awaitingAmount = new decimal_js_1.default(awaiting.amount);
                const effectiveAmount = order.type === 'BUY'
                    ? awaitingAmount.times(order.price)
                    : awaitingAmount.dividedBy(order.price);
                totalPendingAmount = totalPendingAmount.plus(effectiveAmount);
            }
            const availableAmount = remainingAmount.minus(totalPendingAmount);
            const utilizationRate = remainingAmount.greaterThan(0)
                ? totalPendingAmount.dividedBy(remainingAmount).times(100)
                : new decimal_js_1.default(0);
            return {
                orderId: order.id,
                orderType: order.type,
                orderStatus: order.status,
                totalAmount: orderAmount.toString(),
                amountProcessed: amountProcessed.toString(),
                remainingAmount: remainingAmount.toString(),
                pendingAmount: totalPendingAmount.toString(),
                availableAmount: availableAmount.toString(),
                utilizationRate: utilizationRate.toFixed(2) + '%',
                pendingOrders: pendingAwaitings.length
            };
        }
        catch (error) {
            logger_1.default.error('Failed to get order slot stats', {
                orderId,
                error: error.message
            });
            throw error;
        }
    }
}
exports.default = new OrderSlotService();
