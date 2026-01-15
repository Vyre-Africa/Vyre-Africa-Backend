import { Request, Response } from 'express';
import { Prisma, Wallet } from '@prisma/client';
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
import orderslotService from './orderslot.service';
import { verifyPin } from '../utils';

interface PreAction {
  orderId: string;
  currencyId: string;
  amount: string;
  userDetails: {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
    pin: string;
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

interface InstantAction {
  orderId: string;
  amount: string;
  userId: string;
  baseWallet: Wallet;
  quoteWallet: Wallet;
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
    accessPin: string;
  }) {
    const { firstName, lastName, phoneNumber, email, orderId, accessPin } = payload;

    try {
      logger.info('Starting user setup', { email, orderId });

      if (!accessPin || !/^\d{6}$/.test(accessPin)) {
        throw new Error('INVALID_PIN_FORMAT: PIN must be 6 digits');
      }

      // ============================================
      // STEP 1: Fetch order and user with retry
      // ============================================
      const [order, existingUser, tempUser] = await this.retryOperation(
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
            prisma.user.findFirst({ // ✅ Changed from findUnique
              where: { 
                email,
                phoneNumber 
              },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phoneNumber: true,
                isDeactivated: true,
                accessPin: true,
                pinExpiresAt: true,
                pinAttempts: true,
                pinLockedUntil: true
              }
            }),
            prisma.tempUser.findFirst({
              where: { 
                email,
                phoneNumber 
              },
              select: {
                id: true,
                email: true,
                phoneNumber: true,
                accessPin: true,
                pinExpiresAt: true
              }
            })
          ]);
        },
        'Fetch order, user and tempUser',
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
      // STEP 2: Validate user record exists
      // ============================================
      const userRecord = existingUser || tempUser;

      // ✅ Add null check
      if (!userRecord) {
        throw new Error('No PIN found. Please generate a PIN first.');
      }

      // ✅ Check lockout (existing users only)
      if (existingUser?.pinLockedUntil && new Date() < existingUser.pinLockedUntil) {
        const minutesLeft = Math.ceil((existingUser.pinLockedUntil.getTime() - Date.now()) / 60000);
        throw new Error(`PIN_LOCKED: Too many failed attempts. Try again in ${minutesLeft} minutes.`);
      }

      // ✅ Check expiry ONLY FOR TEMP USERS
      if (tempUser && tempUser.pinExpiresAt && new Date() > tempUser.pinExpiresAt) {
        // Delete expired temp user
        await prisma.tempUser.delete({ where: { id: tempUser.id } }).catch(() => {});
        throw new Error('PIN_EXPIRED: Your PIN has expired. Please request a new one.');
      }

      // ============================================
      // STEP 3: Verify PIN
      // ============================================
      // ✅ Remove type assertion (no longer needed with null check)
      const pinValid = await verifyPin(accessPin, userRecord.accessPin as string);

      if (!pinValid) {
        if (existingUser) {
          const attempts = (existingUser.pinAttempts || 0) + 1;
          const shouldLock = attempts >= 5;

          await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              pinAttempts: attempts,
              pinLockedUntil: shouldLock 
                ? new Date(Date.now() + 30 * 60 * 1000)
                : null
            }
          });

          if (shouldLock) {
            throw new Error('PIN_LOCKED: Too many failed attempts. Your PIN is locked for 30 minutes.');
          }

          throw new Error(`INVALID_PIN: Incorrect PIN. ${5 - attempts} attempts remaining.`);
        } else {
          throw new Error('INVALID_PIN: Incorrect PIN. Please check your email and try again.');
        }
      }

      logger.info('✅ PIN verified successfully', { 
        email,
        isExisting: !!existingUser 
      });

      // ============================================
      // STEP 4: CREATE OR UPDATE USER
      // ============================================
      let user: any;

      if (existingUser) {
        // Existing user - just update and reset attempts
        user = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            firstName,
            lastName,
            isDeactivated: false,
            pinAttempts: 0,
            pinLockedUntil: null,
            // ✅ Keep accessPin - it's reusable!
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phoneNumber: true
          }
        });
        
        logger.info('✅ Existing user updated', { userId: user.id });
      } else {
        // ✅ NEW USER: Convert temp to permanent, remove expiry
        user = await prisma.user.create({
          data: {
            firstName,
            lastName,
            phoneNumber,
            email,
            accessPin: tempUser!.accessPin,
            pinExpiresAt: null, // ✅ No expiry for permanent users
            pinAttempts: 0,
            isDeactivated: false
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phoneNumber: true
          }
        });

        // Delete temp user
        await prisma.tempUser.delete({
          where: { id: tempUser!.id }
        }).catch((err: any) => logger.warn('Failed to delete temp user', err));

        logger.info('✅ New user created with reusable PIN', { userId: user.id });

        // ✅ Send welcome email with PIN info
        setImmediate(async () => {
          await notificationService.queue({
            userId: user.id,
            title: 'Welcome! Your PIN is Now Reusable',
            type: 'GENERAL',
            content: `Hi ${firstName},

            Welcome! Your customer account has been linked successfully.

            Your PIN is now permanent and can be reused for all future orders. You do not need to check your email every time.

            If you forget your PIN, you can always regenerate a new one from the order page.

            Keep your PIN secure!`
          });
        });
      }

      // ============================================
      // STEP 5: Create wallets SEQUENTIALLY
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
        2000
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
    let reservationId: string | undefined;

    try {

      // ============================================
      // STEP 1: ATOMICALLY RESERVE ORDER SLOT (BEFORE ANYTHING ELSE)
      // ============================================
      logger.info('Attempting to reserve order slot', { orderId, amount });

      const reservation = await orderslotService.reserveOrderSlot(
        orderId,
        amount
      );

      if (!reservation.success) {
        logger.warn('Order slot reservation failed', {
          orderId,
          requestedAmount: amount,
          availableAmount: reservation.availableAmount,
          reason: reservation.reason
        });

        throw new Error(
          reservation.reason || 
          `Insufficient order capacity. Available: ${reservation.availableAmount}, Requested: ${amount}`
        );
      }

      // ✅ Track reservation for cleanup
      reservationId = reservation.awaitingId;

      logger.info('Order slot reserved successfully', {
        orderId,
        awaitingId: reservation.awaitingId,
        availableAmount: reservation.availableAmount,
        requestedAmount: amount
      });

      // Calculate expiry upfront
      const expiryDuration = moment().add(30, 'minutes').toDate();

      // Fetch order and currency in parallel
      const [order, currency] = await this.retryOperation(
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
                    baseCurrency: { select: { id: true, ISO: true, chain: true } }, 
                    quoteCurrency: { select: { id: true, ISO: true, chain: true } } 
                  } 
                } 
              }
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
      if (!order.pair) throw new Error('Order pair not found'); // ✅ Added null check
      if (!currency) throw new Error('Currency not found');

      // Setup user (includes parallel wallet creation)
      const userSetup = await this.setUpUser({
        firstName: userDetails.firstName,
        lastName: userDetails.lastName,
        phoneNumber: userDetails.phoneNumber,
        email: userDetails.email,
        orderId,
        accessPin: userDetails.pin
      });

      if (!userSetup) throw new Error('Failed to set up user');

      const { user, baseWallet, quoteWallet } = userSetup;

      // ============================================
      // CRITICAL: PAYMENT INITIALIZATION FOR SELL ORDERS
      // ============================================
      
      let payments: any = null;

      // For SELL orders (user pays fiat), initialize payment FIRST
      if (order.type === 'SELL') {
        if (!quoteWallet) throw new Error('Quote wallet not created');

        logger.info('Initializing payment for SELL order', { 
          orderId, 
          currency: currency.ISO,
          method: paymentMethod 
        });

        try {
          // Wait for payment initialization with timeout
          payments = await Promise.race([
            this.retryOperation(
              async () => {
                return await walletService.getPaymentMethod({
                  currency: currency.ISO,
                  amount: parseFloat(amount),
                  email: user.email,
                  userId: user.id,
                  walletId: quoteWallet.id,
                  method: paymentMethod
                });
              },
              'Initialize payment method',
              3, // 3 retries
              2000 // 2 second delay between retries
            ),
            this.timeoutPromise(45000, 'Payment initialization timeout')
          ]);

          if (!payments) {
            throw new Error('Payment initialization returned null');
          }

          logger.info('Payment initialized successfully', {
            reference: payments.id,
            bank: payments.bank,
            accountNumber: payments.account_number
          });

        } catch (paymentError: any) {
          logger.error('Payment initialization failed completely', {
            orderId,
            currency: currency.ISO,
            error: paymentError.message,
            stack: paymentError.stack
          });

          // ❌ Release the reservation
          try {
            await orderslotService.cancelAwaiting(
              reservation.awaitingId!,
              `Payment initialization failed: ${paymentError.message}`
            );
            logger.info('Reservation released after payment failure', {
              awaitingId: reservation.awaitingId
            });
            
            // ✅ Clear reservationId to prevent double cleanup in catch block
            reservationId = undefined;
            
          } catch (releaseError: any) {
            logger.error('Failed to release reservation', {
              awaitingId: reservation.awaitingId,
              error: releaseError.message
            });
          }

          // Determine error message based on error type
          let errorMessage = 'Failed to initialize payment. Please try again.';
          
          if (paymentError.message.includes('timeout')) {
            errorMessage = 'Payment initialization timed out. Please check your network connection and try again.';
          } else if (paymentError.message.includes('network') || paymentError.code === 'ECONNREFUSED') {
            errorMessage = 'Network error. Please check your internet connection and try again.';
          } else if (paymentError.message.includes('Bank') || paymentError.message.includes('account')) {
            errorMessage = 'Unable to generate bank account details. Please contact support.';
          }

          // Throw error to stop the flow
          throw new Error(errorMessage);
        }
      }

      // ============================================
      // STEP 5: UPDATE AWAITING WITH COMPLETE DETAILS
      // ============================================

      const result = await this.retryOperation(
        async () => {
          return await prisma.$transaction(
            async (tx) => {
              const awaiting = await tx.awaiting.update({
                where: { id: reservation.awaitingId },
                data: {
                  userId: user.id,
                  triggerAddress: order.type === 'BUY' 
                    ? baseWallet.depositAddress 
                    : quoteWallet.depositAddress,
                  walletId: order.type === 'BUY' ? baseWallet.id : quoteWallet.id,
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
                  paymentDetails: payments,
                  // ✅ Conditional spread - only add crypto for BUY orders
                  ...(order.type === 'BUY' && crypto && {
                    crypto: {
                      amount,
                      address: baseWallet.depositAddress,
                      currency: order?.pair?.baseCurrency?.ISO as string, // ✅ No optional chaining (already checked)
                      chain: order.pair.baseCurrency?.chain
                    }
                  }),
                  // ✅ Conditional spread - only add bank for SELL orders
                  ...(order.type === 'SELL' && payments && {
                    bank: {
                      amount,
                      ...payments,
                      currency: order.pair.quoteCurrency?.ISO // ✅ No optional chaining (already checked)
                    }
                  })
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
                  // ✅ Safe handling for optional bank data
                  bankCode: bank?.bank_code || null,
                  accountNumber: bank?.accountNumber || null,
                  recipient_Name: bank?.recipient || null,
                  // ✅ Safe handling for optional crypto data
                  chain: currency?.chain || null,
                  address: crypto?.address || null
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
        'Update awaiting with complete details',
        2,
        3000
      );

      // Schedule expiry job
      try {
        await this.retryOperation(
          async () => {
            return await this.awaitingQueue.add(
              'expire-awaiting',
              { awaitingId: result.awaiting.id },
              {
                delay: 30 * 60 * 1000,
                jobId: `awaiting-expiry-${result.awaiting.id}`
              }
            );
          },
          'Schedule expiry job',
          3,
          2000
        );
      } catch (jobError: any) {
        logger.error('Failed to schedule expiry job', {
          awaitingId: result.awaiting.id,
          error: jobError.message
        });
        // Don't fail the whole operation if job scheduling fails
      }

      const duration = Date.now() - startTime;
      logger.info('PreActions completed successfully', { 
        awaitingId: result.awaiting.id,
        orderType: order.type,
        hasPaymentDetails: !!payments,
        duration: `${duration}ms` 
      });

      return result.awaiting;

    } catch (error: any) {
      const duration = Date.now() - startTime;

      // ❌ Cleanup reservation if something failed (and not already cleaned up)
      if (reservationId) {
        logger.warn('Releasing reservation due to error', {
          awaitingId: reservationId,
          error: error.message
        });

        try {
          await orderslotService.cancelAwaiting(
            reservationId,
            `PreActions failed: ${error.message}`
          );
        } catch (cleanupError: any) {
          logger.error('Failed to cleanup reservation', {
            awaitingId: reservationId,
            cleanupError: cleanupError.message
          });
        }
      }

      logger.error('PreActions failed', { 
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms` 
      });
      throw error;
    }
  }

 
  async instantOrder(payload: InstantAction) {
    const { orderId,amount, userId, baseWallet, quoteWallet } = payload;

    const startTime = Date.now();
    let reservationId: string | undefined;

    try {

      // ============================================
      // STEP 1: ATOMICALLY RESERVE ORDER SLOT (BEFORE ANYTHING ELSE)
      // ============================================
      logger.info('Attempting to reserve order slot', { orderId, amount });

      const reservation = await orderslotService.reserveOrderSlot(
        orderId,
        amount
      );

      if (!reservation.success) {
        logger.warn('Order slot reservation failed', {
          orderId,
          requestedAmount: amount,
          availableAmount: reservation.availableAmount,
          reason: reservation.reason
        });

        throw new Error(
          reservation.reason || 
          `Insufficient order capacity. Available: ${reservation.availableAmount}, Requested: ${amount}`
        );
      }

      // ✅ Track reservation for cleanup
      reservationId = reservation.awaitingId;

      logger.info('Order slot reserved successfully', {
        orderId,
        awaitingId: reservation.awaitingId,
        availableAmount: reservation.availableAmount,
        requestedAmount: amount
      });

      // Calculate expiry upfront
      const expiryDuration = moment().add(30, 'minutes').toDate();

      // Fetch order and currency in parallel
      const [order] = await this.retryOperation(
        async () => {
          return await Promise.all([
            prisma.order.findUnique({ 
              where: { id: orderId },
              select: { id: true, type: true }
            }),
          
          ]);
        },
        'Fetch order and currency',
        3,
        1500
      );

      if (!order) throw new Error('Order not found');
      // ============================================
      // STEP 5: UPDATE AWAITING WITH COMPLETE DETAILS
      // ============================================

      const result = await this.retryOperation(
        async () => {
          return await prisma.$transaction(
            async (tx) => {
              const awaiting = await tx.awaiting.update({
                where: { id: reservation.awaitingId },
                data: {
                  userId,
                  walletId: order.type === 'BUY' ? baseWallet.id : quoteWallet.id,
                  duration: expiryDuration,
                }
              });

              return { awaiting};
            },
            {
              maxWait: 10000,
              timeout: 30000,
              isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            }
          );
        },
        'Update awaiting with complete details',
        2,
        3000
      );

      // Queue order processing
      await orderService.process_Order_Queue({
        awaitingId: result.awaiting.id,
      })

      return result.awaiting;

    } catch (error: any) {

      const duration = Date.now() - startTime;

      // ❌ Cleanup reservation if something failed
      if (reservationId) {
        logger.warn('Releasing reservation due to error', {
          awaitingId: reservationId,
          error: error.message
        });

        try {
          await orderslotService.cancelAwaiting(
            reservationId,
            `instant Actions failed: ${error.message}`
          );
        } catch (cleanupError: any) {
          logger.error('Failed to cleanup reservation', {
            awaitingId: reservationId,
            cleanupError: cleanupError.message
            
          });
        }
      }

      logger.error('Instant Action failed', { 
        error: error.message,
        stack: error.stack,
        duration: `${duration}ms` 
      });
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

        await orderslotService.releaseReservation(awaitingId)

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