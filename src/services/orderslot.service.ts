import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import logger from '../config/logger';
import Decimal from 'decimal.js';


interface OrderSlotCheck {
  hasAvailableSlot: boolean;
  availableAmount: string;
  requestedAmount: string;
  orderAmount: string;
  amountProcessed: string;
  pendingAmount: string;
  reason?: string;
}

interface ReservationResult {
  success: boolean;
  awaitingId?: string;
  availableAmount?: string;
  requestedAmount: string;
  orderAmount?: string;
  amountProcessed?: string;
  amountReserved?: string;
  reason?: string;
}

/**
 * Order Slot Helper
 * Prevents overbooking by checking pending awaiting orders
 */
class OrderSlotService {


  /**
   * Atomically reserve a slot on an order using database-level atomic operations.
   * This approach handles 1000s of concurrent requests without queuing or race conditions.
   */
  async reserveOrderSlot(
    orderId: string,
    requestedAmount: string | number,
  ): Promise<ReservationResult> {
    try {
      const requestedDecimal = new Decimal(requestedAmount);

      logger.info('Starting atomic slot reservation', {
        orderId,
        requestedAmount: requestedDecimal.toString(),
      });

      // Step 1: Get order details to determine conversion logic
      const order = await prisma.order.findUnique({
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

      const orderPrice = new Decimal(order.price);
      const orderMinimum = new Decimal(order.amountMinimum);
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
      let amountToReserve: Decimal;

      if (order.type === 'SELL') {
        // SELL: User sends QUOTE currency, order.amount is in BASE
        // Pending amount is in QUOTE, convert to BASE for reservation
        amountToReserve = requestedDecimal.dividedBy(orderPrice);
      } else {
        // BUY: User sends BASE currency, order.amount is in QUOTE
        // Pending amount is in BASE, convert to QUOTE for reservation
        amountToReserve = requestedDecimal.times(orderPrice);
      }

      logger.info('Calculated amount to reserve', {
        orderId,
        requestedAmount: requestedDecimal.toString(),
        amountToReserve: amountToReserve.toString(),
        orderType: order.type,
        orderPrice: orderPrice.toString()
      });


      // Step 3: Atomic reservation using single UPDATE query
      // This is the magic - no race conditions possible!
      const updated = await prisma.$executeRaw`
        UPDATE "Order"
        SET "amountReserved" = "amountReserved" + ${amountToReserve.toString()}::numeric
        WHERE id = ${orderId}
          AND status = 'OPEN'
          AND (amount - "amountProcessed" - "amountReserved") >= ${amountToReserve.toString()}::numeric
      `;

      // Step 4: Check if update succeeded
      if (updated === 0) {
        // Reservation failed - calculate why
        const currentOrder = await prisma.order.findUnique({
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

        const available = new Decimal(currentOrder.amount)
          .minus(currentOrder.amountProcessed)
          .minus(currentOrder.amountReserved);

        logger.warn('Insufficient amount for reservation', {
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
      const awaiting = await prisma.awaiting.create({
        data: {
          orderId,
          amount: requestedDecimal,
          status: 'PENDING',
          orderType: order.type
        }
      });

      logger.info('Slot reserved successfully', {
        orderId,
        awaitingId: awaiting.id,
        requestedAmount: requestedDecimal.toString(),
        amountReserved: amountToReserve.toString(),
      });

      // Step 6: Get final state for response
      const updatedOrder = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          amount: true,
          amountProcessed: true,
          amountReserved: true
        }
      });

      const finalAvailable = new Decimal(updatedOrder!.amount)
        .minus(updatedOrder!.amountProcessed)
        .minus(updatedOrder!.amountReserved);

      return {
        success: true,
        awaitingId: awaiting.id,
        availableAmount: finalAvailable.toString(),
        requestedAmount: requestedDecimal.toString(),
        orderAmount: updatedOrder!.amount.toString(),
        amountProcessed: updatedOrder!.amountProcessed.toString(),
        amountReserved: updatedOrder!.amountReserved.toString()
      };

    } catch (error: any) {
      logger.error('Atomic slot reservation failed', {
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
  async releaseReservation(
    awaitingId: string
  ): Promise<void> {
    try {
      // Get the awaiting record
      const awaiting = await prisma.awaiting.findUnique({
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
        logger.info('Awaiting not in PENDING status, skipping release', {
          awaitingId,
          status: awaiting.status
        });
        return;
      }

      // Calculate amount to release (convert back to order currency)
      const awaitingAmount = new Decimal(awaiting.amount);
      const orderPrice = new Decimal(awaiting.order?.price as Decimal);
      
      let amountToRelease: Decimal;

      if (awaiting.order?.type === 'SELL') {
        // SELL: awaiting.amount is in QUOTE, convert to BASE
        amountToRelease = awaitingAmount.dividedBy(orderPrice);
      } else {
        // BUY: awaiting.amount is in BASE, convert to QUOTE
        amountToRelease = awaitingAmount.times(orderPrice);
      }

      logger.info('Releasing reservation', {
        awaitingId,
        orderId: awaiting.orderId,
        amountToRelease: amountToRelease.toString()
      });

      // Atomic release
      await prisma.$executeRaw`
        UPDATE "Order"
        SET "amountReserved" = "amountReserved" - ${amountToRelease.toString()}::numeric
        WHERE id = ${awaiting.orderId}
          AND "amountReserved" >= ${amountToRelease.toString()}::numeric
      `;

      logger.info('Reservation released successfully', {
        awaitingId,
        orderId: awaiting.orderId,
        amountReleased: amountToRelease.toString()
      });

    } catch (error: any) {
      logger.error('Failed to release reservation', {
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
  async cancelAwaiting(
    awaitingId: string,
    reason?: string
  ): Promise<void> {
    try {

      // Release the reservation
      await this.releaseReservation(awaitingId);


      await prisma.$transaction(async (tx) => {
        // Update awaiting status
        const awaiting = await tx.awaiting.update({
          where: { id: awaitingId },
          data: {
            status: 'FAILED',
            metadata:{
              cancelledAt: new Date(),
              cancellationReason: reason,
            }
          },
          include:{
            postDetails: true
          }
        });

        if(awaiting?.postDetails.length > 0){
          await tx.postDetails.updateMany({
            where:{
              awaitingId,
            },
            data:{
              status: 'FAILED'
            }
          });
        }

      });

      logger.info('Awaiting cancelled successfully', {
        awaitingId,
        reason
      });

    } catch (error: any) {
      logger.error('Failed to cancel awaiting', {
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
  async checkAvailableSlot(
    orderId: string,
    requestedAmount: string | number
  ): Promise<OrderSlotCheck> {
    try {
      const requestedAmountDecimal = new Decimal(requestedAmount);

      logger.info('Checking order slot availability', {
        orderId,
        requestedAmount: requestedAmountDecimal.toString()
      });

      // 1. Fetch order details
      const order = await prisma.order.findUnique({
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

      const orderAmount = new Decimal(order.amount);
      const amountProcessed = new Decimal(order.amountProcessed);

      // 2. Calculate remaining unprocessed amount
      const remainingAmount = orderAmount.minus(amountProcessed);

      logger.info('Order amounts', {
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
      const pendingAwaitings = await prisma.awaiting.findMany({
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

      logger.info('Pending awaiting orders found', {
        orderId,
        count: pendingAwaitings.length
      });

      // 4. Calculate total pending amount
      let totalPendingAmount = new Decimal(0);

      for (const awaiting of pendingAwaitings) {
        const awaitingAmount = new Decimal(awaiting.amount);

        totalPendingAmount = totalPendingAmount.plus(awaitingAmount);
      }

      let totalEffectiveAmount: Decimal;

      if (order.type === 'SELL') {
        // totalPendingAmount would be BASE
        // totalEffectiveAmount would be QUOTE
        totalEffectiveAmount = totalPendingAmount.dividedBy(order.price)
      }else{
        // totalPendingAmount would be QUOTE
        // totalEffectiveAmount would be BASE
        totalEffectiveAmount = totalPendingAmount.times(order.price)
      }

      // const availableAmount = orderAmount.minus(amountProcessed).plus(totalEffectiveAmount);
      const availableAmount = remainingAmount.minus(totalEffectiveAmount);

      logger.info('Total effective pending amount calculated', {
        orderId,
        totalPendingAmount: totalPendingAmount.toString(),
        totalEffectiveAmount: totalEffectiveAmount.toString(),
        availableAmount: availableAmount.toString()
      });

      if (availableAmount.lessThan(0)) {
        logger.warn('Order is overbooked', {
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

      let requestedInOrderCurrency: Decimal;

      if (order.type === 'SELL') {
        requestedInOrderCurrency = requestedAmountDecimal.dividedBy(order.price);
      } else {
        requestedInOrderCurrency = requestedAmountDecimal.times(order.price);
      }

      logger.info('Requested amount in order currency', {
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

      logger.info('Slot check passed', {
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

    } catch (error: any) {
      logger.error('Order slot check failed', {
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
  async getMaxAvailableAmount(orderId: string): Promise<string> {
    const slotCheck = await this.checkAvailableSlot(orderId, 0);
    return slotCheck.availableAmount;
  }

  /**
   * Get order slot statistics
   */
  async getOrderSlotStats(orderId: string) {
    try {
      const [order, pendingAwaitings] = await Promise.all([
        prisma.order.findUnique({
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
        prisma.awaiting.findMany({
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

      if (!order) throw new Error('Order not found');

      const orderAmount = new Decimal(order.amount);
      const amountProcessed = new Decimal(order.amountProcessed);
      const remainingAmount = orderAmount.minus(amountProcessed);

      let totalPendingAmount = new Decimal(0);
      for (const awaiting of pendingAwaitings) {
        const awaitingAmount = new Decimal(awaiting.amount);
        const effectiveAmount = order.type === 'BUY'
          ? awaitingAmount.times(order.price)
          : awaitingAmount.dividedBy(order.price);
        totalPendingAmount = totalPendingAmount.plus(effectiveAmount);
      }

      const availableAmount = remainingAmount.minus(totalPendingAmount);
      const utilizationRate = remainingAmount.greaterThan(0)
        ? totalPendingAmount.dividedBy(remainingAmount).times(100)
        : new Decimal(0);

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

    } catch (error: any) {
      logger.error('Failed to get order slot stats', {
        orderId,
        error: error.message
      });
      throw error;
    }
  }
}

export default new OrderSlotService();