import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.config';
import walletService from '../services/wallet.service';
import config from '../config/env.config';
import Decimal from 'decimal.js';
// import { OrderStatus } from '@prisma/client'
import { Wallet, Pair, OrderType } from '@prisma/client';
import {hasSufficientBalance,amountSufficient} from '../utils'
import notificationService from './notification.service';
import { Queue } from 'bullmq'; // Using BullMQ for job queue
// import connection from '../config/redis.config';
import connection from '../config/redis.config';
import logger from '../config/logger';
import { DecimalUtil } from './decimal.util';
import { getMinimumOrderAmount, getMinimumOrderDescription } from '../config/minimum.config';

interface ProcessOrderPayload {
  userId: string;
  orderId: string;
  amount: number;
  userBaseWallet: Wallet;
  userQuoteWallet: Wallet;
  retryCount?: number;
}

class OrderService {

  private generalQueue: Queue;  
  private readonly MAX_DIRECT_RETRIES = 2;
  private readonly RETRY_DELAY_MS = 50;

  constructor() {
    // Initialize the processing queue
    this.generalQueue = new Queue('general-process', {
      connection
    });
  }


  // ============================================
  // CREATE ORDER
  // ============================================

  async createOrder(payload: {
    orderId: string;
    userId: string;
    rate: number;
    amount: number;
    orderType: OrderType;
    pairId: string;
    minimumAmount: number;
    baseWallet: Wallet;
    quoteWallet: Wallet;
  }) {
    const { userId, orderId, rate, amount, orderType, pairId, minimumAmount, baseWallet, quoteWallet } = payload;

    try {
      logger.info('Creating order', { userId, orderType, amount });

      const pair = await prisma.pair.findUnique({
        where: { id: pairId },
        include: {
          quoteCurrency: { select: { id: true, ISO: true } },
          baseCurrency: { select: { id: true, ISO: true } }
        }
      });

      if (!pair) throw new Error('Trading pair not found');

      // ✅ Get configured minimum for the base currency
      const configuredMinimum = getMinimumOrderAmount(pair.baseCurrency?.ISO as string);

      // ✅ Convert to Decimal for calculations
      const amountDecimal = new Decimal(amount);
      const userMinimum = minimumAmount ? new Decimal(minimumAmount) : new Decimal(0);
      const enforcedMinimum = Decimal.max(userMinimum, configuredMinimum);

      // ✅ Validate order amount meets minimum
      if (amountDecimal.lessThan(enforcedMinimum)) {
        const description = getMinimumOrderDescription(pair.baseCurrency?.ISO as string);
        throw new Error(
          `Order amount ${amountDecimal.toString()} ${pair.baseCurrency?.ISO as string} is below minimum requirement of ${description}`
        );
      }
      
      const baseBalance = new Decimal(baseWallet.availableBalance);
      const quoteBalance = new Decimal(quoteWallet.availableBalance);

      // ✅ Balance checks with Decimal
      if (orderType === 'SELL' && baseBalance.lessThan(amountDecimal)) {
        throw new Error('Insufficient base balance');
      }
      if (orderType === 'BUY' && quoteBalance.lessThan(amountDecimal)) {
        throw new Error('Insufficient quote balance');
      }

      // ✅ Fee calculation with Decimal (1.2% fee)
      const feeRate = new Decimal('0.012');
      const fee = amountDecimal.times(feeRate);
      const adjustedAmount = amountDecimal.minus(fee);

      // ✅ Ensure adjusted amount (after fee) still meets minimum
      if (adjustedAmount.lessThan(enforcedMinimum)) {
        throw new Error(
          `Order amount after fees (${adjustedAmount.toString()} ${pair.baseCurrency?.ISO as string}) is below minimum. ` +
          `Please increase order amount to cover fees and meet minimum of ${enforcedMinimum.toString()} ${pair.baseCurrency?.ISO as string}`
        );
      }

      logger.info('Fee calculation', {
        amount: amountDecimal.toString(),
        fee: fee.toString(),
        adjustedAmount: adjustedAmount.toString()
      });

      const result = await prisma.$transaction(
        async (tx) => {
          // Transfer fee to admin (if not admin creating the order)
          if (config.Admin_Id !== userId) {
            await walletService.offchain_Transfer({
              userId,
              receipientId: config.Admin_Id,
              currencyId: orderType === 'SELL' 
                ? pair?.baseCurrency?.id as string 
                : pair?.quoteCurrency?.id as string,
              amount: fee.toString() // ✅ Convert for wallet service
            });
          }

          // Block the adjusted amount
          const blockId = await walletService.block_Amount(
            adjustedAmount.toNumber(), // ✅ Convert for wallet service
            orderType === 'SELL' ? baseWallet.id : quoteWallet.id
          );

          // Create order with Decimal values
          return await tx.order.create({
            data: {
              id: orderId,
              userId,
              blockId,
              amountMinimum: enforcedMinimum, // ✅ Prisma accepts number or Decimal
              amount: adjustedAmount,               // ✅ Prisma accepts number or Decimal
              type: orderType,
              pairId,
              price: rate,                  // ✅ Prisma accepts number or Decimal
              version: 0
            }
          });
        },
        {
          maxWait: 10000,
          timeout: 30000,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        }
      );

      // Notification with formatted amount
      await notificationService.queue({
        userId,
        title: 'Order is Live!',
        type: 'GENERAL',
        content: `Your <strong>${orderType}</strong> order for <strong>${DecimalUtil.formatWithCurrency(amountDecimal,pair.baseCurrency?.ISO as string)}</strong> is now active.`
      });

      logger.info('Order created successfully', {
        orderId: result.id,
        adjustedAmount: adjustedAmount.toString(),
        fee: fee.toString()
      });

      return result;

    } catch (error: any) {
      logger.error('Order creation failed:', {
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

  async cancelOrder(payload: { orderId: string; userId: string }) {
    const { orderId, userId } = payload;

    try {
      const order = await prisma.order.findUnique({
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

      if (!order) throw new Error('Order not found');
      if (order.userId !== userId) throw new Error('Unauthorized');
      if (order.status !== 'OPEN') throw new Error(`Cannot cancel ${order.status.toLowerCase()} order`);

      const pendingCount = await prisma.awaiting.count({
        where: {
          orderId: order.id,
          status: { in: ['PENDING', 'PROCESSING'] }
        }
      });

      if (pendingCount > 0) {
        throw new Error(`Cannot cancel. ${pendingCount} pending transaction(s).`);
      }

      const canceledOrder = await prisma.$transaction(async (tx) => {
        await walletService.unblock_Amount(order.blockId!);
        return await tx.order.update({
          where: { id: order.id },
          data: { status: 'CANCELED' }
        });
      },{
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

        const currencyISO = order.type === 'SELL'
          ? order.pair.baseCurrency?.ISO
          : order.pair.quoteCurrency?.ISO;

        await notificationService.queue({
          userId: order.userId,
          title: 'Order Cancelled',
          type: 'GENERAL',
          content: `Your <strong>${order.type}</strong> order for <strong>${DecimalUtil.formatWithCurrency(order.amount,currencyISO as string)}</strong> has been cancelled. Funds are now available.`
        });

        return canceledOrder;

      } catch (error) {
        logger.error('Order cancellation failed:', error);
        throw error;
    }
  }


  async validateOrderProcessing(
    order: any,
    amount: number,
    userBaseWallet: Wallet,
    userQuoteWallet: Wallet
  ) {
    if (order.status !== 'OPEN') {
      throw new Error(`Order is ${order.status.toLowerCase()}`);
    }

    // ✅ Convert to Decimal
    const orderAmount = new Decimal(order.amount);
    const orderAmountProcessed = new Decimal(order.amountProcessed || 0);
    const orderPrice = new Decimal(order.price);
    const amountDecimal = new Decimal(amount);

    const remainingAmount = orderAmount.minus(orderAmountProcessed);
    
    if (remainingAmount.lessThanOrEqualTo(0)) {
      throw new Error('Order fully processed');
    }

    const maxAmount = order.type === 'BUY'
      ? remainingAmount.dividedBy(orderPrice)
      : remainingAmount.times(orderPrice);

    if (amountDecimal.greaterThan(maxAmount)) {
      throw new Error(
        `Max available: ${maxAmount.toFixed(8)}, requested: ${amountDecimal.toFixed(8)}`
      );
    }

    // ✅ Convert wallet balances to Decimal
    const baseBalance = new Decimal(userBaseWallet.availableBalance);
    const quoteBalance = new Decimal(userQuoteWallet.availableBalance);

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

  async processOrder(payload: ProcessOrderPayload): Promise<any> {
    const { userId, orderId, amount, userBaseWallet, userQuoteWallet, retryCount = 0 } = payload;

    const startTime = Date.now();

    try {
      logger.info('Processing order', { userId, orderId, amount, retryCount });

      const result = await this.attemptDirectProcessing({
        userId,
        orderId,
        amount,
        userBaseWallet,
        userQuoteWallet
      });

      const duration = Date.now() - startTime;
      logger.info('Order processed successfully', { orderId, duration, retryCount });

      return result;

    } catch (error: any) {
      const duration = Date.now() - startTime;

      if (this.isVersionConflict(error)) {
        logger.warn('Version conflict detected', { orderId, retryCount, duration });

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

        logger.info('Queueing order due to contention', { orderId, retryCount });
        
        await this.generalQueue.add(
          'process-order',
          { userId, orderId, amount, userBaseWallet, userQuoteWallet },
          {
            delay: 100,
            attempts: 3,
            backoff: { type: 'exponential', delay: 100 }
          }
        );

        return {
          status: 'queued',
          message: 'Order queued for processing due to high demand'
        };
      }

      logger.error('Order processing failed', { orderId, error: error.message, duration });
      throw error;
      
    }
  }


  // ============================================
  // DIRECT PROCESSING WITH EARLY VERSION CHECK
  // ============================================

  private async attemptDirectProcessing(payload: {
    userId: string;
    orderId: string;
    amount: number;
    userBaseWallet: Wallet;
    userQuoteWallet: Wallet;
  }) {
    const { userId, orderId, amount, userBaseWallet, userQuoteWallet } = payload;

    return await prisma.$transaction(
      async (tx) => {
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

        logger.info('Order fetched (no lock)', { 
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

        if (!pair) throw new Error('Trading pair not found');

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
        const amountDecimal = new Decimal(amount);
        const priceDecimal = new Decimal(order.price);
        const orderAmountDecimal = new Decimal(order.amount);
        const orderAmountProcessedDecimal = new Decimal(order.amountProcessed || 0);
        const orderAmountReservedDecimal = new Decimal(order.amountReserved || 0);

        // Calculate amount to process
        const amountToProcess = order.type === 'BUY'
          ? amountDecimal.times(priceDecimal)      // base * price = quote
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

        logger.info('Amounts calculated', {
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
            amountProcessed: DecimalUtil.formatWithCurrency(newAmountProcessed, order.type === 'BUY' ? pair?.quoteCurrency?.ISO as string : pair?.baseCurrency?.ISO as string),    // Prisma accepts Decimal
            percentageProcessed: newPercentage.toNumber(), // Convert to number for float field
            status: newStatus,
            version: currentVersion + 1
          }
        });

        if (updateResult.count === 0) {
          logger.warn('Version conflict during update', { 
            orderId, 
            expectedVersion: currentVersion 
          });
          throw new Error('VERSION_CONFLICT: Order was modified by another transaction');
        }

        logger.info('Order updated successfully', { 
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
            walletService.unblock_Transfer(
              String(amountToProcess), // Convert for wallet service
              order?.blockId as string, 
              userQuoteWallet.id
            ),
            walletService.offchain_Transfer({
              userId,
              receipientId: order.userId as string,
              currencyId: pair?.baseCurrency?.id as string,
              amount: amountDecimal.toString() // Original amount (base currency)
            })
          ]);
        } else {
          await Promise.all([
            walletService.unblock_Transfer(
              String(amountToProcess), // Convert for wallet service
              order.blockId as string, 
              userBaseWallet.id
            ),
            walletService.offchain_Transfer({
              userId,
              receipientId: order.userId as string,
              currencyId: pair?.quoteCurrency?.id as string,
              amount: amountDecimal.toString() // Original amount (quote currency)
            })
          ]);
        }

        logger.info('Transfers completed', { orderId });

        // ============================================
        // STEP 6: LOG TRANSACTION
        // ============================================
        await tx.orderLog.create({
          data: {
            userId,
            orderId,
            baseAmount: order.type === 'BUY' 
              ? amount 
              : amountToProcess.toNumber(),
            quoteAmount: order.type === 'BUY' 
              ? amountToProcess.toNumber() 
              : amount,
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
        }).catch(err => logger.error('Notification failed', err));

        return {
          id: order.id,
          amountProcessed: newAmountProcessed.toNumber(), // Convert for response
          percentageProcessed: newPercentage.toNumber(),
          status: newStatus,
          version: currentVersion + 1
        };
      },
      {
        maxWait: 15000,
        timeout: 50000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }
    );
  }

    // ============================================
    // HELPER METHODS
    // ============================================

    private isVersionConflict(error: any): boolean {
      return error.message?.includes('VERSION_CONFLICT') ||
            error.code === 'P2034' ||
            error.message?.includes('was modified');
    }

    private sleep(ms: number): Promise<void> {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async sendOrderSuccessNotification(params: {
      userId: string;
      orderId: string;
      amount: number;
      baseCurrency?: string;
      quoteCurrency?: string;
    }) {
      const { userId, baseCurrency, quoteCurrency, amount, orderId } = params;

      const order = await prisma.order.findUnique({
        where: { id: orderId }
      });

      if (!order) return;

      // const amountProcessed = order.type === 'BUY'
      //   ? amount * order.price
      //   : amount / order.price;
      let amountProcessed;

      // Convert inputs to Decimal
      const amountDecimal = new Decimal(amount);
      const priceDecimal = new Decimal(order.price);
      
          
      if (order?.type === "BUY") {
        // User is sending base, calculate quote amount
        amountProcessed = amountDecimal.times(priceDecimal);
      } else {
        // User is sending quote, calculate base amount
        amountProcessed = amountDecimal.dividedBy(priceDecimal);
      }

      const baseAmount = order.type === 'BUY' ? amount : amountProcessed;
      const quoteAmount = order.type === 'BUY' ? amountProcessed : amount;

      await notificationService.queue({
        userId,
        title: '🎉 Order Completed!',
        type: 'GENERAL',
        content: `
          <div style="font-family: Arial, sans-serif;">
            <h3 style="color: #112044;">Your ${order.type} order completed!</h3>
            <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
              <p><strong>You ${order.type === 'BUY' ? 'Sent' : 'Received'}:</strong> ${DecimalUtil.formatWithCurrency(baseAmount, baseCurrency as string)}</p>
              <p><strong>You ${order.type === 'BUY' ? 'Received' : 'Sent'}:</strong> ${DecimalUtil.formatWithCurrency(quoteAmount, quoteCurrency as string)}</p>
              <p><strong>Rate:</strong> ${Number(order.price)?.toLocaleString('en-US', {
                style: 'currency',
                currency: quoteCurrency,
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              })}
              </p>
            </div>
          </div>
        `
      });
    }

    async queue(payload: any) {
      return await this.generalQueue.add('create-order', payload);
    }




    // async createOrder(payload:{
    //     userId: string,
    //     rate: number, 
    //     amount: number, 
    //     orderType: OrderType, 
    //     pairId: string, 
    //     minimumAmount:number,
    //     baseWallet: Wallet,
    //     quoteWallet: Wallet
    // }) {

    //     let blockId: any;
    //     let order: any;

    //    const {userId, rate, amount, orderType, pairId, minimumAmount, baseWallet, quoteWallet } = payload

    //   //  const amount =  orderType === 'SELL'? requestAmount : requestAmount * rate;

    //    console.log('create order payload received')

    //    const pair = await prisma.pair.findUnique({
    //       where:{id: pairId},
    //       include:{
    //         quoteCurrency:{
    //           select:{
    //             id:true,
    //             ISO:true  
    //           },
    //         },
    //         baseCurrency:{
    //           select:{
    //             id:true,
    //             ISO:true  
    //           },
    //         },
    //         quoteWallet:true,
    //         baseWallet:true,
    //       }
    //    })


    //     if(orderType === 'SELL' && !hasSufficientBalance(baseWallet.availableBalance,amount)){
    //        throw new Error('Available balance for base not sufficient');
    //     }
    //     if(orderType === 'BUY' && !hasSufficientBalance(quoteWallet.availableBalance,amount)){
    //        throw new Error('Available balance for quote not sufficient');
    //     }
  
    //     console.log('checked amount sufficiency')
    //     console.log('entering prisma transaction')

    //     const fee = amount * 0.012;
    //     const adjustedAmount = amount - fee;
    //     console.log(adjustedAmount,'adjustedAmount')
    //     console.log(fee,'fee')

    //     const result = await prisma.$transaction(
    //         async (prisma) => {

    //           console.log('inside transaction')
    //           // deduct fee amount

    //           if(config.Admin_Id !== userId){
    //             const transfer = await walletService.offchain_Transfer({
    //               userId,
    //               receipientId: config.Admin_Id,
    //               currencyId: orderType === 'SELL'? pair?.baseCurrency?.id as string : pair?.quoteCurrency?.id as string,
    //               amount: fee
    //             })

    //             console.log('---------------- FEE DEDUCTED -----------------')
    //           }
              

    //           console.log('done with offchain transfer')
    //           // block adjustedAmount
    //           blockId = await walletService.block_Amount(adjustedAmount, orderType === 'SELL'? baseWallet.id: quoteWallet.id)
    //           console.log('---------------- AMOUNT LOCKED -----------------')
    //           console.log('done with offchain transfer',blockId)

    //           order = await prisma.order.create({
    //             data:{
    //                 userId,
    //                 blockId,
    //                 amountMinimum: minimumAmount,
    //                 amount,
    //                 type: orderType,
    //                 pairId,
    //                 price: rate
    //             }
    //           })
      
    //           return {
    //             order
    //           }
    //         },
    //         {
    //           maxWait: 50000, // default: 2000
    //           timeout: 50000, // default: 5000
    //         }

    //     )

    //     await notificationService.queue({
    //       userId, 
    //       title:'Order is Live!',
    //       type:'GENERAL',
    //       content:`Your <strong>${orderType}</strong> order for <strong>${amount} ${pair?.baseCurrency?.ISO}</strong> on the <strong>${pair?.baseCurrency?.ISO}/${pair?.quoteCurrency?.ISO}</strong> pair has been placed successfully and is now active on the market,.`
    //     })
    //     console.log('---------------- NOTIFICATION QUEUED -----------------')

    //     return result.order

    // }

    // async processOrder(payload:{
    //     userId: string,
    //     orderId: string,
    //     amount: number, 
    //     userBaseWallet: Wallet,
    //     userQuoteWallet: Wallet
    // }) {        

    //    const { userId, orderId, amount, userBaseWallet, userQuoteWallet } = payload

    //     const order = await prisma.order.findUnique({
    //         where:{id: orderId}
    //     })

    //     if (order?.status !== "OPEN") {
    //         throw new Error('Order is not open');
    //     }

    //     const pair = await prisma.pair.findFirst({
    //         where:{id: order?.pairId},
    //         include:{
    //           quoteCurrency:{
    //             select:{
    //               id:true,
    //               ISO:true  
    //             },
    //           },
    //           baseCurrency:{
    //             select:{
    //               id:true,
    //               ISO:true  
    //             },
    //           },
    //           quoteWallet:true,
    //           baseWallet:true,
    //         }
    //     })


    //     const orderBaseWallet = await prisma.wallet.findFirst({
    //         where:{
    //         currencyId: pair?.baseCurrency?.id,
    //         userId: order?.userId as string
    //         }
    //     })
    
    //     const orderQuoteWallet = await prisma.wallet.findFirst({
    //         where:{
    //         currencyId: pair?.quoteCurrency?.id,
    //         userId: order?.userId as string
    //         }
    //     })
    
    //     if (!orderBaseWallet || !orderQuoteWallet) {
    //         throw new Error('Order wallet not found');
    //     }

    //     // Validate user balances
    //     if (order?.type === "BUY" && !hasSufficientBalance(userBaseWallet.availableBalance,amount)) {
    //         throw new Error('Insufficient base currency balance');
    //     }
    
    //     if (order?.type === "SELL" && !hasSufficientBalance(userQuoteWallet.availableBalance,amount)) {
    //         throw new Error('Insufficient quote currency balance');
    //     }

    //     const maxAmount = order?.type === "BUY"
    //     ? (order?.amount - order?.amountProcessed) / order?.price // order balance
    //     : (order?.amount! - order?.amountProcessed!) * order?.price!

    //     if (maxAmount < amount) {
    //       throw new Error('Max amount exceeded');
    //     }


    //     const result = await prisma.$transaction(
    //         async (prisma) => {
    
    //           let amountToProcess: number;
    
    //           amountToProcess = order?.type === "BUY"
    //           ? amount * order.price // User is sending base, calculate quote amount
    //           : amount / order.price; // User is sending quote, calculate base amount
    
    //           const amountLeft = order?.amount - (order?.amountProcessed + amount)
    
    //           let orderTransfer;
    //           let newBlockId;
    //           let userTransfer;
    
    //           if (order?.type === "BUY"){
    //             // User sends base currency, order sends quote currency
    
    //             // order sends quote currency
    //             orderTransfer = await walletService.unblock_Transfer(amountToProcess, order?.blockId as string, userQuoteWallet.id)
    //             console.log('orderTransfer success from unblocked amount',orderTransfer)

    //             // newBlockId = await walletService.block_Amount(amountLeft, orderQuoteWallet.id)

    //             // user sends base currency
    //             userTransfer = await walletService.offchain_Transfer({userId: userId,receipientId: order?.userId as string, currencyId: pair?.baseCurrency?.id!, amount})
    
    //           } else {
    //             // User sends quote currency, order sends base currency
    
    //             // order sends base currency
    //             orderTransfer = await walletService.unblock_Transfer(amountToProcess, order?.blockId as string, userBaseWallet.id)
    //             console.log('orderTransfer success from unblocked amount',orderTransfer)
    //             // newBlockId = await walletService.block_Amount(amountLeft, orderBaseWallet.id)

    //             // user sends quote currency
    //             userTransfer = await walletService.offchain_Transfer({userId: userId,receipientId: order?.userId as string, currencyId: pair?.quoteCurrency?.id!, amount})
    
    //           }
    
    //           const updatedOrder = await prisma.order.update({
    //             where:{id: order.id },
    //             data:{
    //               // blockId: newBlockId,
    //               amountProcessed: order?.amountProcessed + amountToProcess,
    //               percentageProcessed: ((order?.amountProcessed + amountToProcess) / order?.amount) * 100,
    //               status: (order.amountProcessed + amountToProcess) >= order?.amount ? 'CLOSED' :'OPEN'
    //             }
    //           })

    //           // log order transaction
    //           await prisma.orderLog.create({
    //             data:{
    //               userId,
    //               orderId,
    //               baseAmount: order?.type === "BUY" ? amount : amountToProcess ,
    //               quoteAmount: order?.type === "BUY" ? amountToProcess : amount ,
    //               rate: order.price,
    //               orderType: order?.type
    //             }
    //           })
    
              
    //           return {
    //             order: updatedOrder
    //           }
    //         },
    //         {
    //           maxWait: 50000, // default: 2000
    //           timeout: 50000, // default: 5000
    //         }
    
    //     )

    //     await this.sendOrderSuccessNotification({
    //       userId,
    //       orderId,
    //       amount,
    //       baseCurrency: pair?.baseCurrency?.ISO,
    //       quoteCurrency: pair?.quoteCurrency?.ISO
    //     })

    //     return result.order
        

    // }

    // async cancelOrder(payload:{orderId:string}){

    //   const {orderId} = payload

    //   try {
        
    //     const order = await prisma.order.findUnique({
    //         where: {id: orderId},
    //         include: {
    //             pair: {
    //                 include: {
    //                     baseCurrency: {select: {ISO: true}},
    //                     quoteCurrency: {select: {ISO: true}}
    //                 }
    //             }
    //         }
    //     })

    //     if(!order){
    //       throw new Error('Order not found');
    //     }

    //     const pendingOrders = await prisma.awaiting.findMany({
    //       where: {
    //         orderId: order.id,
    //         status: {
    //           in: ['PENDING', 'PROCESSING']
    //         }
    //       }
    //     });

    //     if(pendingOrders.length){
    //       throw new Error('Pending Orders exists');
    //     }

    //     await walletService.unblock_Amount(order.blockId as string)

    //     const canceledOrder = await prisma.order.update({
    //       where:{id: order?.id},
    //       data:{status:'CANCELED'}
    //     })

    //     // Determine which currency to show based on order type
    //     const currencyISO = order.type === 'SELL'
    //       ? (order?.pair?.baseCurrency?.ISO ?? order?.pair?.quoteCurrency?.ISO ?? '')
    //       : (order?.pair?.quoteCurrency?.ISO ?? order?.pair?.baseCurrency?.ISO ?? '')

    //     await notificationService.queue({
    //         userId: order?.userId as string, // Make sure to get userId from the order
    //         title: 'Order Cancelled',
    //         type: 'GENERAL',
    //         content: `Your <strong>${order?.type}</strong> order for <strong>${order?.amount} ${currencyISO||'currency'}</strong> has been cancelled successfully. The funds have been unblocked and are available in your wallet.`
    //     })

    //     return canceledOrder

    //   } catch (error) {
    //     console.log(error)
    //   }
      

    // }

    // async queue(payload:{
    //     userId: string,
    //     rate: number, 
    //     amount: number, 
    //     orderType: OrderType, 
    //     pairId: string, 
    //     minimumAmount:number,
    //     baseWallet: Wallet,
    //     quoteWallet: Wallet
    // }){
    //   console.log('queuing create order job')
    //   return await this.generalQueue.add('create-order', payload);
    // }

    

    // private async sendOrderSuccessNotification(params: {
    //   userId: string;
    //   orderId: string;
    //   amount: number;
    //   baseCurrency?: string;
    //   quoteCurrency?: string;
    // }) {
    //   const { userId, baseCurrency, quoteCurrency, amount, orderId } = params;

    //   let notificationContent: string;
    //   let notificationTitle: string;

    //   const order = await prisma.order.findUnique({
    //     where:{id: orderId}
    //   })

    //   if(!order){
    //     return 
    //   }

    //   let amountProcessed: number;

    //   amountProcessed = order?.type === "BUY"
    //     ? amount * order.price // User is sending base, calculate quote amount
    //     : amount / order.price; // User is sending quote, calculate base amount


    //   const baseAmount = order?.type === "BUY" ? amount : amountProcessed;
    //   const quoteAmount = order?.type === "BUY" ? amountProcessed : amount

    //   if (order.type === 'BUY') {

    //     notificationTitle = '🎉 Order Completed Successfully!';
    //     notificationContent = `
    //       <div style="font-family: Arial, sans-serif;">
    //         <h3 style="color: #112044; margin-bottom: 10px;">Your BUY order has been completed!</h3>
            
    //         <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
    //           <p style="margin: 5px 0;"><strong>Order Type:</strong> BUY ${baseCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Amount Sold:</strong> ${baseAmount} ${baseCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Amount Received:</strong> ${quoteAmount} ${quoteCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${order.price?.toLocaleString('en-US')} ${quoteCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Order ID:</strong> <code>${orderId}</code></p>
    //         </div>

    //         <p style="color: #666; font-size: 14px; margin-top: 15px;">
    //           Thanks for choosing Vyre! If you have any questions, please contact our support team.
    //         </p>
    //       </div>
    //     `;

    //   } else {
    //     // SELL: User paid fiat, received crypto

    //     notificationTitle = '🎉 Order Completed Successfully!';
    //     notificationContent = `
    //       <div style="font-family: Arial, sans-serif;">
    //         <h3 style="color: #112044; margin-bottom: 10px;">Your SELL order has been completed!</h3>
            
    //         <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 15px 0;">
    //           <p style="margin: 5px 0;"><strong>Order Type:</strong> SELL ${baseCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ${quoteAmount} ${quoteCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Amount Received:</strong> ${baseAmount} ${baseCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${order.price?.toLocaleString('en-US')} ${quoteCurrency}</p>
    //           <p style="margin: 5px 0;"><strong>Order ID:</strong> <code>${orderId}</code></p>
    //         </div>

    //         <p style="color: #666; font-size: 14px; margin-top: 15px;">
    //           Thanks for choosing Vyre! If you have any questions, please contact our support team.
    //         </p>
    //       </div>
    //     `;
    //   }

    //   // Queue the notification
    //   await notificationService.queue({
    //     userId,
    //     title: notificationTitle,
    //     type: 'GENERAL',
    //     content: notificationContent
    //   });
    // }



    // async getStoreOrders(cursor: string | null, status: string | null, limit: string | null, storeId: string) {
    //     let orders;

    //     if (cursor !== null) {

    //         if (status !== null) {
    //             orders = await prisma.order.findMany({
    //                 take: limit ? parseInt(limit as string) : 10,
    //                 skip: 1,
    //                 cursor: {
    //                     id: cursor as string,
    //                 },
    //                 where: {
    //                     storeId,
    //                     Status: status as OrderStatus
    //                 },
    //                 include: {
    //                     products: true,
    //                 },
    //             });
    //         }

    //         orders = await prisma.order.findMany({
    //             take: limit ? parseInt(limit as string) : 10,
    //             skip: 1,
    //             cursor: {
    //                 id: cursor as string,
    //             },
    //             where: {
    //                 storeId
    //             },
    //             include: {
    //                 products: true,
    //             },
    //         });
    //     } else {
    //         if (status !== null) {
    //             orders = await prisma.order.findMany({
    //                 take: limit ? parseInt(limit as string) : 10,
    //                 where: {
    //                     storeId,
    //                     Status: status as OrderStatus
    //                 },
    //                 include: {
    //                     products: true,
    //                 },
    //             });
    //         }

    //         orders = await prisma.order.findMany({
    //             take: limit ? parseInt(limit as string) : 10,
    //             where: {
    //                 storeId
    //             },
    //             include: {
    //                 products: true,
    //             },
    //         });
    //     }

    //     return orders;
    // }

    // async search(searchKeyword: string, limit: string | null, storeId: string) {
    //     let orders;

    //     orders = await prisma.order.findMany({
    //         take: limit ? parseInt(limit as string) : 10,
    //         where: {
    //             storeId,
    //             OR: [
    //                 {
    //                     user: {
    //                         firstName: {
    //                             contains: searchKeyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                 },
    //                 {
    //                     user: {
    //                         lastName: {
    //                             contains: searchKeyword,
    //                             mode: 'insensitive'
    //                         }
    //                     },
    //                 },
    //                 {
    //                     id: {
    //                         contains: searchKeyword,
    //                         mode: 'insensitive'
    //                     },
    //                 },
    //             ],
    //         },
    //         include: {
    //             products: true,
    //         },
    //     });

    //     return orders;
    // }
}

export default new OrderService()