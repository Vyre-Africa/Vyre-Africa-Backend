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

/**
 * Order Slot Helper
 * Prevents overbooking by checking pending awaiting orders
 */
class OrderSlotService {
  
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