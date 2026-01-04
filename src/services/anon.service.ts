import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.config';
import { OrderType } from '@prisma/client';
import walletService from './wallet.service';
import moment from 'moment';
import { Queue } from 'bullmq'; // Using BullMQ for job queue
import connection from '../config/redis.config';
import orderService from './order.service';
import orderValidator from '../validators/order.validator';
import notificationService from './notification.service';
import logger from '../config/logger';

interface PreAction {
  orderId: string;
  currencyId: string;
  amount: string;
  userDetails: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
  };
  bank: {
    accountNumber: string;
    bank_code: string;
    recipient: string;
  };
  crypto: {
    address: string;
  };
  paymentMethod?: string;
}

class AnonService {

  private awaitingQueue: Queue;  
  
  constructor() {
    // Initialize the processing queue
    this.awaitingQueue = new Queue('general-process', {
      connection
    });
  }

  // ============================================
  // HELPER: Retry with exponential backoff
  // ============================================
  private async retryOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          logger.info(`${operationName} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error: any) {
        lastError = error;
        logger.warn(`${operationName} failed on attempt ${attempt}/${maxRetries}`, {
          error: error.message,
          code: error.code
        });
        
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1); // Exponential backoff
          logger.info(`Retrying ${operationName} in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  // ============================================
  // ROBUST USER SETUP (Simplified - Service is Idempotent)
  // ============================================
  async setUpUser(payload: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
    orderId: string;
  }) {
    const { firstName, lastName, phoneNumber, email, orderId } = payload;

    try {
      logger.info('Starting user setup', { email, orderId });

      // ============================================
      // STEP 1: Fetch order and user with retry
      // ============================================
      const [order, existingUser] = await this.retryOperation(
        async () => {
          return await Promise.all([
            prisma.order.findUnique({
              where: { id: orderId },
              select: {
                id: true,
                type: true,
                pair: {
                  select: {
                    id: true,
                    baseCurrency: {
                      select: { id: true, ISO: true, tatumChain: true }
                    },
                    quoteCurrency: {
                      select: { id: true, ISO: true, tatumChain: true }
                    }
                  }
                }
              }
            }),
            prisma.user.findUnique({ 
              where: { email },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phoneNumber: true
              }
            })
          ]);
        },
        'Fetch order and user',
        3,
        1500
      );

      if (!order) {
        throw new Error('Order not found');
      }

      const pair = order.pair;
      if (!pair) {
        throw new Error('Order pair not found');
      }

      // ============================================
      // STEP 2: Create or get user with retry
      // ============================================
      let user = existingUser;
      if (!user) {
        user = await this.retryOperation(
          async () => {
            return await prisma.user.create({
              data: { firstName, lastName, phoneNumber, email },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phoneNumber: true
              }
            });
          },
          'Create user',
          3,
          1500
        );
        logger.info('New user created', { userId: user.id, email });
      } else {
        logger.info('Existing user found', { userId: user.id, email });
      }

      // ============================================
      // STEP 3: Create wallets SEQUENTIALLY (not parallel)
      // Wallet service is idempotent, so safe to retry
      // ============================================
      
      // Create base wallet with retry
      const baseWallet = await this.retryOperation(
        async () => {
          return await walletService.createWallet({
            userId: user.id,
            currencyId: pair?.baseCurrency?.id as string
          });
        },
        'Create base wallet',
        3,
        2000 // Longer delay for external service calls
      );

      if (!baseWallet) {
        throw new Error('Base wallet creation failed');
      }
      
      logger.info('Base wallet ready', { 
        walletId: baseWallet.id,
        currency: pair?.baseCurrency?.ISO 
      });

      // Create quote wallet with retry
      const quoteWallet = await this.retryOperation(
        async () => {
          return await walletService.createWallet({
            userId: user.id,
            currencyId: pair?.quoteCurrency?.id as string
          });
        },
        'Create quote wallet',
        3,
        2000
      );

      if (!quoteWallet) {
        throw new Error('Quote wallet creation failed');
      }

      logger.info('Quote wallet ready', { 
        walletId: quoteWallet.id,
        currency: pair?.quoteCurrency?.ISO 
      });

      logger.info('User setup completed successfully', {
        userId: user.id,
        baseWalletId: baseWallet.id,
        quoteWalletId: quoteWallet.id
      });

      return {
        user,
        baseWallet,
        quoteWallet,
        order,
        pair
      };

    } catch (error: any) {
      logger.error('User setup failed completely', {
        email,
        orderId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // ============================================
  // OPTIMIZED PRE-ACTIONS (3x Faster!)
  // ============================================
  async preActions(payload: PreAction) {
    const { orderId, currencyId, amount, userDetails, bank, crypto, paymentMethod } = payload;

    const startTime = Date.now();

    try {
      // Calculate expiry upfront
      const expiryDuration = moment().add(30, 'minutes').toDate();

      // Fetch order and currency in parallel
      const [order, currency] = await this.retryOperation(
        async () => {
          return await Promise.all([
            prisma.order.findUnique({ 
              where: { id: orderId },
              select: { id: true, type: true }
            }),
            prisma.currency.findUnique({ 
              where: { id: currencyId },
              select: { id: true, ISO: true, chain: true }
            })
          ]);
        },
        'Fetch order and currency',
        3,
        1500
      );

      if (!order) throw new Error('Order not found');
      if (!currency) throw new Error('Currency not found');

      // Setup user (includes parallel wallet creation)
      const userSetup = await this.setUpUser({
        firstName: userDetails.firstName,
        lastName: userDetails.lastName,
        phoneNumber: userDetails.phoneNumber,
        email: userDetails.email,
        orderId
      });

      if (!userSetup) throw new Error('Failed to set up user');

      const { user, baseWallet, quoteWallet } = userSetup;

      // ============================================
      // CRITICAL OPTIMIZATION: ASYNC PAYMENT INIT
      // ============================================
      
      let paymentPromise: Promise<any> | null = null;
      let shouldWaitForPayment = false;

      // For SELL orders (user pays fiat), initialize payment
      if (order.type === 'SELL') {
        if (!quoteWallet) throw new Error('Quote wallet not created');

        // Start payment initialization but DON'T wait for it
        // We'll handle it asynchronously
        // paymentPromise = this.retryOperation(
        //   async () => {
        //     return await walletService.getPaymentMethod({
        //       currency: currency.ISO,
        //       amount: parseFloat(amount),
        //       email: user.email,
        //       userId: user.id,
        //       walletId: quoteWallet.id,
        //       method: paymentMethod
        //     });
        //   },
        //   'Initialize payment',
        //   2, // Only 2 retries for payment
        //   2000
        // ).catch(err => {
        //   logger.error('Payment initialization failed after retries', { 
        //     error: err.message 
        //   });
        //   return null;
        // });

        paymentPromise = walletService.getPaymentMethod({
          currency: currency.ISO,
          amount: parseFloat(amount),
          email: user.email,
          userId: user.id,
          walletId: quoteWallet.id,
          method: paymentMethod
        }).catch(err => {
          logger.error('Payment initialization failed', { error: err.message });
          return null;
        });

        // Only wait if it's a bank transfer (required for awaiting)
        shouldWaitForPayment = paymentMethod === 'BANK_TRANSFER' || !paymentMethod;
      }

      // ============================================
      // CREATE AWAITING RECORD (Fast Path)
      // ============================================

      let payments: any = null;

      // If we need payment details, wait for them
      // Otherwise, create awaiting immediately
      if (shouldWaitForPayment && paymentPromise) {
        // Wait for payment with timeout
        payments = await Promise.race([
          paymentPromise,
          this.timeoutPromise(55000, 'Payment initialization timeout')
        ]).catch(err => {
          logger.warn('Payment init slow/failed, proceeding without details', err);
          return null;
        });
      }

      // Create awaiting and postDetails in single transaction
      const result = await this.retryOperation(
        async () => {
          return await prisma.$transaction(
            async (tx) => {
              const awaiting = await tx.awaiting.create({
                data: {
                  triggerAddress: order.type === 'BUY' 
                    ? baseWallet.depositAddress 
                    : quoteWallet.depositAddress,
                  walletId: order.type === 'BUY' ? baseWallet.id : quoteWallet.id,
                  userId: user.id,
                  orderId,
                  amount,
                  orderType: order.type as OrderType,
                  currencyId,
                  method: paymentMethod,
                  duration: expiryDuration,
                  reference: payments?.id,
                  bank_Name: payments?.bank,
                  bank_Account_Number: payments?.account_number,
                  bank_Account_Name: payments?.account_name,
                  bank_expires_At: payments?.expires_at 
                    ? new Date(payments.expires_at.replace(' ', 'T')).toISOString() 
                    : null,
                  paymentDetails: payments
                }
              });

              const postDetails = await tx.postDetails.create({
                data: {
                  awaitingId: awaiting.id,
                  walletId: order.type === 'BUY' ? quoteWallet.id : baseWallet.id,
                  userId: user.id,
                  orderId,
                  amount,
                  currencyId,
                  bankCode: bank?.bank_code,
                  accountNumber: bank?.accountNumber,
                  recipient_Name: bank?.recipient,
                  chain: currency?.chain,
                  address: crypto.address
                }
              });

              return { awaiting, postDetails };
            },
            {
              maxWait: 10000,
              timeout: 30000,
              isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            }
          );
        },
       'Create awaiting transaction',
       2, // Only 2 retries for transaction
       3000
      );

      // ============================================
      // UPDATE PAYMENT DETAILS ASYNC (If needed)
      // ============================================
      
      // If payment is still initializing, update awaiting when ready
      if (paymentPromise && !payments) {
        paymentPromise.then(async (paymentData) => {
          if (paymentData) {
            try {
              await this.retryOperation(
                async () => {
                  return await prisma.awaiting.update({
                    where: { id: result.awaiting.id },
                    data: {
                      reference: paymentData.id,
                      bank_Name: paymentData.bank,
                      bank_Account_Number: paymentData.account_number,
                      bank_Account_Name: paymentData.account_name,
                      bank_expires_At: paymentData.expires_at 
                        ? new Date(paymentData.expires_at.replace(' ', 'T')).toISOString() 
                        : null,
                      paymentDetails: paymentData
                    }
                  });
                },
                'Update payment details async',
                3,
                2000
              );
              logger.info('Payment details updated async', { 
                awaitingId: result.awaiting.id 
              });
            } catch (err: any) {
              logger.error('Failed to update payment details after retries', {
                awaitingId: result.awaiting.id,
                error: err.message
              });
            }
          }
        }).catch(err => {
          logger.error('Payment promise failed', { error: err.message });
        });
      }

      // Schedule expiry job
      await this.awaitingQueue.add(
        'expire-awaiting',
        { awaitingId: result.awaiting.id },
        {
          delay:  30 * 60 * 1000,
          jobId: `awaiting-expiry-${result.awaiting.id}`
        }
      );

      const duration = Date.now() - startTime;
      logger.info('PreActions completed', { 
        awaitingId: result.awaiting.id, 
        duration: `${duration}ms` 
      });

      return result.awaiting;

    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('PreActions failed', { error, duration: `${duration}ms` });
      throw error;
    }
  }

  // ============================================
  // HELPER: TIMEOUT PROMISE
  // ============================================
  private timeoutPromise(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    );
  }


  // ============================================
  // CANCEL AWAITING EXPIRY
  // ============================================

  async cancelAwaitingExpiry(awaitingId: string) {
    try {
      const jobId = `awaiting-expiry-${awaitingId}`;
      const job = await this.awaitingQueue.getJob(jobId);

      if (job) {
        await job.remove();
        logger.info('Cancelled expiry job', { awaitingId });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error cancelling expiry', { awaitingId, error });
      throw error;
    }
  }


  // ============================================
  // PROCESS EXPIRED AWAITING
  // ============================================

  async cancelAwaitingJob(jobData: { awaitingId: string }) {
    const { awaitingId } = jobData;

    try {
      logger.info('Processing expiry', awaitingId );

      const awaiting = await prisma.awaiting.findUnique({
        where: { id: awaitingId },
        include: {
          order: true,
          user: true,
          currency: true
        }
      });

      if (!awaiting) {
        return { status: 'not_found' };
      }

      if (awaiting.status !== 'PENDING') {
        return { status: 'already_processed', currentStatus: awaiting.status };
      }

      // Update awaiting and postDetails in transaction
      await prisma.$transaction(async (tx) => {
        await tx.awaiting.update({
          where: { id: awaitingId },
          data: { status: 'EXPIRED' }
        });

        await tx.postDetails.updateMany({
          where: { awaitingId, userId: awaiting.userId },
          data: { status: 'EXPIRED' }
        });
      },{
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

      logger.info('Awaiting marked as expired', { awaitingId });

      // Send notification
      if (awaiting.userId) {
        await notificationService.queue({
          userId: awaiting.userId,
          title: 'Payment Expired',
          type: 'GENERAL',
          content: 'Your payment request has expired. Please create a new order if you wish to proceed.'
        });
      }

      return {
        status: 'expired',
        awaitingId,
        expiredAt: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Error expiring awaiting', { awaitingId, error });
      throw error;
    }
  }
}


export default new AnonService()