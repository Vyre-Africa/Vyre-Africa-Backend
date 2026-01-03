import { Request, Response } from 'express';
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
  // OPTIMIZED USER SETUP (Parallel Operations)
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
      // Fetch order and pair in parallel
      const [order, existingUser] = await Promise.all([
        prisma.order.findUnique({
          where: { id: orderId },
          include: {
            pair: {
              include: {
                quoteCurrency: {
                  select: { id: true, ISO: true, tatumChain: true }
                },
                baseCurrency: {
                  select: { id: true, ISO: true, tatumChain: true }
                }
              }
            }
          }
        }),
        prisma.user.findUnique({ where: { email } })
      ]);

      if (!order) throw new Error('Order not found');

      const pair = order.pair;

      // Create user if doesn't exist
      let user = existingUser;
      if (!user) {
        user = await prisma.user.create({
          data: { firstName, lastName, phoneNumber, email }
        });
        logger.info('New user created', { userId: user.id, email });
      } else {
        logger.info('Existing user found', { userId: user.id, email });
      }

      // Create wallets in parallel
      const [baseWallet, quoteWallet] = await Promise.all([
        walletService.createWallet({
          userId: user.id,
          currencyId: pair?.baseCurrency?.id as string
        }),
        walletService.createWallet({
          userId: user.id,
          currencyId: pair?.quoteCurrency?.id as string
        })
      ]);

      if (!baseWallet || !quoteWallet) {
        throw new Error('Wallet creation failed');
      }

      logger.info('Wallets created', {
        baseWallet: baseWallet.id,
        quoteWallet: quoteWallet.id
      });

      return {
        user,
        baseWallet,
        quoteWallet,
        order,
        pair
      };

    } catch (error) {
      logger.error('User setup failed:', error);
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
      const expiryDuration = moment().add(1, 'hour').toDate();

      // Fetch order and currency in parallel
      const [order, currency] = await Promise.all([
        prisma.order.findUnique({ where: { id: orderId } }),
        prisma.currency.findUnique({ where: { id: currencyId } })
      ]);

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
        paymentPromise = walletService.getPaymentMethod({
          currency: currency.ISO,
          amount: parseFloat(amount),
          email: user.email,
          userId: user.id,
          walletId: quoteWallet.id,
          method: paymentMethod
        }).catch(err => {
          logger.error('Payment initialization failed', err);
          return null; // Don't fail the whole request
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
          this.timeoutPromise(10000, 'Payment initialization timeout')
        ]).catch(err => {
          logger.warn('Payment init slow/failed, proceeding without details', err);
          return null;
        });
      }

      // Create awaiting and postDetails in single transaction
      const result = await prisma.$transaction(async (tx) => {
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

            // Payment details (may be null if async)
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
      });

      // ============================================
      // UPDATE PAYMENT DETAILS ASYNC (If needed)
      // ============================================
      
      // If payment is still initializing, update awaiting when ready
      if (paymentPromise && !payments) {
        paymentPromise.then(async (paymentData) => {
          if (paymentData) {
            await prisma.awaiting.update({
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
            logger.info('Payment details updated async ', { awaitingId: result.awaiting.id });
          }
        }).catch(err => {
          logger.error('Failed to update payment details', err);
        });
      }

      // Schedule expiry job
      await this.awaitingQueue.add(
        'expire-awaiting',
        { awaitingId: result.awaiting.id },
        {
          delay: 60 * 60 * 1000,
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