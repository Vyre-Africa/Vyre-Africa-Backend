import { Request, Response } from 'express';
import { Prisma, Wallet } from '@prisma/client';
import prisma from '../config/prisma.client';
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
import walletpoolService from './walletpool.service';
import liquidityRampService from './liquidityRamp.service';
import ablyService from './ably.service';
import { checkKycLimit, toUsd } from '../services/kycLimits.service';


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
  mobileDetails?: { phoneNumber: string; networkProvider: string };
}

interface InstantAction {
  orderId: string;
  amount: string;
  userId: string;
  baseWallet: Wallet;
  quoteWallet: Wallet;
}

const VYRE_ADMIN_ID = process.env.Admin_Id || ''


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

  private async getAdminWallet(currencyId: string) {
        // const adminUser = await prisma.user.findUnique({
        //     where:  { id: VYRE_ADMIN_ID },
        //     select: { id: true }
        // })
    
        // if (!adminUser) {
        //     throw new Error(`Admin user not found: ${VYRE_ADMIN_ID}`)
        // }
    
        const adminWallet = await prisma.wallet.findFirst({
            where: { userId: VYRE_ADMIN_ID, currencyId }
        })
    
        if (!adminWallet?.depositAddress) {
            throw new Error(`Admin wallet not found or missing deposit address for currency ${currencyId}`)
        }
    
        return { adminUserId: VYRE_ADMIN_ID, adminWallet }
  }

  private async setUpSyntheticUser(payload: {
      firstName:   string
      lastName:    string
      phoneNumber: string
      email:       string
      orderId:     string
      accessPin:   string
  }) {
      const { firstName, lastName, phoneNumber, email, orderId, accessPin } = payload

      logger.info('Starting synthetic user setup', { email, orderId })

      if (!accessPin || !/^\d{6}$/.test(accessPin)) {
          throw new Error('INVALID_PIN_FORMAT: PIN must be 6 digits')
      }

      // ── Fetch order + tempUser in parallel ─────────────────
      const [order, tempUser] = await this.retryOperation(
          async () => Promise.all([
              prisma.order.findUnique({
                  where:  { id: orderId },
                  select: {
                      id:              true,
                      type:            true,
                      isSynthetic:     true,
                      liquiditySource: true,
                      metadata:        true,
                      pair: {
                          select: {
                              id:              true,
                              baseId:          true,
                              quoteId:        true,
                              baseCurrency:  { select: { id: true, ISO: true, chain: true } },
                              quoteCurrency: { select: { id: true, ISO: true, chain: true } }
                          }
                      }
                  }
              }),
              prisma.tempUser.findFirst({
                  where:  { email, phoneNumber },
                  select: { id: true, email: true, phoneNumber: true, accessPin: true, pinExpiresAt: true }
              })
          ]),
          'Fetch order and tempUser', 3, 1500
      )

      if (!order)      throw new Error('Order not found')
      if (!order.pair) throw new Error('Order pair not found')
      if (!tempUser)   throw new Error('No PIN found. Please generate a PIN first.')

      // ── PIN expiry check ────────────────────────────────────
      if (tempUser.pinExpiresAt && new Date() > tempUser.pinExpiresAt) {
          await prisma.tempUser.delete({ where: { id: tempUser.id } }).catch(() => {})
          throw new Error('PIN_EXPIRED: Your PIN has expired. Please request a new one.')
      }

      // ── PIN verification ────────────────────────────────────
      const pinValid = await verifyPin(accessPin, tempUser.accessPin)
      if (!pinValid) throw new Error('INVALID_PIN: Incorrect PIN. Please check your email and try again.')

      logger.info('PIN verified for synthetic user', { email })

      // ── Create anonymous user — NO wallets ──────────────────
      const user = await prisma.user.create({
          data: {
              email:         await this.resolveAnonymousEmail(email),
              realEmail:     email,
              firstName,
              lastName,
              phoneNumber,
              accessPin:     tempUser.accessPin,
              pinExpiresAt:  null,
              pinAttempts:   0,
              isDeactivated: false,
              isAnonymous:   true
          },
          select: {
              id:          true,
              email:       true,
              firstName:   true,
              lastName:    true,
              phoneNumber: true,
              realEmail:   true
          }
      })

      await prisma.tempUser.delete({ where: { id: tempUser.id } }).catch(
          (err: any) => logger.warn('Failed to delete temp user', err)
      )

      logger.info('Synthetic user created', { userId: user.id })

      return { user, order, pair: order.pair }
  }

  private async initOnramp(payload: {
        userId:      string
        order:       any
        amount:      string
        awaitingId:  string
        userDetails: {
            email:       string
            firstName:   string
            lastName:    string
            phoneNumber: string
        }
    }) {
        const { userId, order, amount, awaitingId, userDetails } = payload
    
        const reference      = `RAMP_${awaitingId}`
        const toCurrencyISO  = order.pair?.baseCurrency?.ISO  ?? 'USDT'
        const fromFiatISO    = order.pair?.quoteCurrency?.ISO ?? 'NGN'
        const baseCurrencyId = order.pair?.baseCurrencyId ?? order.pair?.baseCurrency?.id
        // const network        = liquidityRampService.getNetwork(toCurrencyISO)
        const network = liquidityRampService.getNetwork(order.pair?.baseCurrency?.chain)

    
        // Quidax delivers crypto to Vyre's shared admin wallet — NOT a per-user
        // deposit wallet. We credit the user internally once the webhook confirms
        // the onramp completed (see handleOnrampCompleted → process_Post_Action_Job)
        const { adminWallet } = await this.getAdminWallet(baseCurrencyId)
    
        logger.info('Admin wallet resolved for onramp', {
            userId, awaitingId, adminDepositAddress: adminWallet.depositAddress
        })
    
        // Step 1 — Initiate with Quidax
        const rampInit = await liquidityRampService.initiateRampBankTransfer({
            merchantReference: reference,
            fromCurrency:      fromFiatISO.toLowerCase(),
            toCurrency:        toCurrencyISO.toLowerCase(),
            fromAmount:        amount,
            walletAddress:     adminWallet?.depositAddress as string,
            walletNetwork:     network,
            customerEmail:     userDetails.email,
            customerFirstName: userDetails.firstName,
            customerLastName:  userDetails.lastName,
        })
    
        // Step 2 — Confirm onramp → returns bank account user pays fiat into
        const rampConfirm = await liquidityRampService.confirmRamp(reference)
    
        logger.info('Onramp initialized', {
            awaitingId, toAmount: rampInit.to_amount, bankName: rampConfirm.bank_name,
        })
    
        return {
            reference,
            rampInit,
            rampConfirm,
            adminWalletId: adminWallet.id,
            network,
        }
  }

    private async initOfframp(payload: {
        userId:     string
        order:      any
        amount:     string
        awaitingId: string
        bank: {
            bank_code:     string
            accountNumber: string
            recipient:     string
        }
        userEmail: string
    }) {
        const { order, amount, awaitingId, bank, userEmail } = payload
    
        const reference       = `OFFRAMP_${awaitingId}`
        const fromCurrencyISO = order.pair?.baseCurrency?.ISO  ?? 'USDT'
        const toFiatISO       = order.pair?.quoteCurrency?.ISO ?? 'NGN'
        // const network         = liquidityRampService.getNetwork(fromCurrencyISO)
        const network = liquidityRampService.getNetwork(order.pair?.baseCurrency?.chain)

    
        const nameParts = bank.recipient.trim().split(' ')
        const firstName = nameParts[0]
        const lastName  = nameParts.slice(1).join(' ') || nameParts[0]
    
        // Step 1 — Initiate offramp
        const offrampInit = await liquidityRampService.initiateOfframp({
            merchantReference: reference,
            fromCurrency:      fromCurrencyISO.toLowerCase(),
            toCurrency:        toFiatISO.toLowerCase(),
            fromAmount:        amount,
            network,
            customerEmail:     userEmail,
            customerFirstName: firstName,
            customerLastName:  lastName,
        })
    
        logger.info('Offramp initiated', {
            awaitingId, quidaxReference: offrampInit.reference, toAmount: offrampInit.to_amount
        })
    
        // Step 2 — Attach payout bank account BEFORE confirming
        const bankAccount = await liquidityRampService.addOfframpPayoutAccount({
            merchantReference: reference,
            bankCode:          bank.bank_code,
            accountNumber:     bank.accountNumber,
        })
    
        logger.info('Offramp bank account attached', {
            awaitingId, accountNumber: bankAccount.metadata?.account_number
        })
    
        // Step 3 — Confirm offramp → returns crypto deposit address user sends to
        const offrampConfirm = await liquidityRampService.confirmOfframp(reference)
    
        logger.info('Offramp confirmed', {
            awaitingId, address: offrampConfirm.address, network: offrampConfirm.network
        })
    
        return {
            reference,
            offrampInit,
            offrampConfirm,
            bankAccount,
            triggerAddress: offrampConfirm.address,
        }
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
        logger.info('Starting anonymous user setup', { email, orderId });

        if (!accessPin || !/^\d{6}$/.test(accessPin)) {
            throw new Error('INVALID_PIN_FORMAT: PIN must be 6 digits');
        }

        // ── Step 1: Fetch order and tempUser ─────────────────────
        const [order, tempUser] = await this.retryOperation(
            async () => Promise.all([
                prisma.order.findUnique({
                    where: { id: orderId },
                    select: {
                        id: true,
                        type: true,
                        pair: {
                            select: {
                                id: true,
                                baseCurrency:  { select: { id: true, ISO: true, tatumChain: true } },
                                quoteCurrency: { select: { id: true, ISO: true, tatumChain: true } }
                            }
                        }
                    }
                }),
                prisma.tempUser.findFirst({
                    where: { email, phoneNumber },
                    select: {
                        id: true,
                        email: true,
                        phoneNumber: true,
                        accessPin: true,
                        pinExpiresAt: true
                    }
                })
            ]),
            'Fetch order and tempUser', 3, 1500
        );

        if (!order)       throw new Error('Order not found');
        if (!order.pair)  throw new Error('Order pair not found');
        if (!tempUser)    throw new Error('No PIN found. Please generate a PIN first.');

        // ── Step 2: Check PIN expiry ──────────────────────────────
        if (tempUser.pinExpiresAt && new Date() > tempUser.pinExpiresAt) {
            await prisma.tempUser.delete({ where: { id: tempUser.id } }).catch(() => {});
            throw new Error('PIN_EXPIRED: Your PIN has expired. Please request a new one.');
        }

        // ── Step 3: Verify PIN ────────────────────────────────────
        const pinValid = await verifyPin(accessPin, tempUser.accessPin);
        if (!pinValid) throw new Error('INVALID_PIN: Incorrect PIN. Please check your email and try again.');

        logger.info('PIN verified successfully', { email });

        // ── Step 4: Create isolated anonymous user ────────────────
        // Always create a fresh anonymous user regardless of whether
        // email exists on a real Vyre account — never touch real accounts
        const user = await prisma.user.create({
            data: {
                // If email already exists on real account use internal email
                // Otherwise use their real email
                email: await this.resolveAnonymousEmail(email),
                realEmail: email,
                firstName,
                lastName,
                phoneNumber,
                accessPin:     tempUser.accessPin,
                pinExpiresAt:  null,
                pinAttempts:   0,
                isDeactivated: false,
                isAnonymous:   true,
            },
            select: {
                id:          true,
                email:       true,
                firstName:   true,
                lastName:    true,
                phoneNumber: true,
                realEmail:   true
            }
        });

        // Clean up temp user
        await prisma.tempUser.delete({ 
            where: { id: tempUser.id } 
        }).catch((err: any) => logger.warn('Failed to delete temp user', err));

        logger.info('Anonymous user created', { userId: user.id });

        if (!order.pair.baseCurrency)  throw new Error('Base currency not found');
        if (!order.pair.quoteCurrency) throw new Error('Quote currency not found');

        // ── Step 5: Create wallets ────────────────────────────────

        // ── Try pool first — fallback to fresh creation ───────────
        const [baseWallet, quoteWallet] = await Promise.all([

            // Base wallet
            (async () => {
                const pooled = await walletpoolService.getOrCreateWallet({
                    userId:     user.id,
                    currencyId: order.pair!.baseCurrency!.id
                });

                if (pooled) return pooled;

                // No pool wallet — create fresh
                return await this.retryOperation(
                    () => walletService.createWallet({
                        userId:     user.id,
                        currencyId: order.pair!.baseCurrency!.id
                    }),
                    'Create base wallet', 3, 2000
                );
            })(),

            // Quote wallet
            (async () => {
                const pooled = await walletpoolService.getOrCreateWallet({
                    userId:     user.id,
                    currencyId: order.pair!.quoteCurrency!.id
                });

                if (pooled) return pooled;

                return await this.retryOperation(
                    () => walletService.createWallet({
                        userId:     user.id,
                        currencyId: order.pair!.quoteCurrency!.id
                    }),
                    'Create quote wallet', 3, 2000
                );
            })()
        ]);


        // const baseWallet = await this.retryOperation(
        //     () => walletService.createWallet({
        //         userId:     user.id,
        //         currencyId: order.pair!.baseCurrency!.id
        //     }),
        //     'Create base wallet', 3, 2000
        // );

        if (!baseWallet) throw new Error('Base wallet creation failed');

        // const quoteWallet = await this.retryOperation(
        //     () => walletService.createWallet({
        //         userId:     user.id,
        //         currencyId: order.pair!.quoteCurrency!.id
        //     }),
        //     'Create quote wallet', 3, 2000
        // );

        if (!quoteWallet) throw new Error('Quote wallet creation failed');

        logger.info('Anonymous user setup completed', {
            userId:       user.id,
            baseWalletId: baseWallet.id,
            quoteWalletId: quoteWallet.id
        });

        return { user, baseWallet, quoteWallet, order, pair: order.pair };

    } catch (error: any) {
        logger.error('Anonymous user setup failed', {
            email,
            orderId,
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
  }

  private async handleSyntheticPreActions(payload: {
    order: any, currency: any, userDetails: any, bank: any, crypto: any, mobileDetails: any,
    amount: string, paymentMethod: string | undefined, reservation: any, expiryDuration: Date,
    orderId: string, currencyId: string
  }) {
        const { order, currency, userDetails, bank, crypto,
            amount, paymentMethod, reservation, expiryDuration,
            orderId, currencyId } = payload
    
        // ── Minimal user setup — no wallets ─────────────────────────────────────
        const syntheticSetup = await this.setUpSyntheticUser({
            firstName:   userDetails.firstName,
            lastName:    userDetails.lastName,
            phoneNumber: userDetails.phoneNumber,
            email:       userDetails.email,
            orderId,
            accessPin:   userDetails.pin
        })
    
        if (!syntheticSetup) throw new Error('Failed to set up synthetic user')
    
        const { user } = syntheticSetup
    
        // ── SELL: user pays fiat → receives crypto (Quidax ONRAMP) ──────────────
        if (order.type === 'SELL') {
    
            const onramp = await this.initOnramp({
                userId:    user.id,
                order,
                amount,
                awaitingId: reservation.awaitingId,
                userDetails: {
                    email:       user.realEmail ?? userDetails.email,
                    firstName:   userDetails.firstName,
                    lastName:    userDetails.lastName,
                    phoneNumber: userDetails.phoneNumber,
                }
            })
    
            const { rampConfirm, rampInit, adminWalletId } = onramp
    
            const result = await this.retryOperation(
                async () => prisma.$transaction(
                    async (tx) => {
                        const awaiting = await tx.awaiting.update({
                            where: { id: reservation.awaitingId },
                            data: {
                                userId:              user.id,
                                isSynthetic:         true,
                                amount:              rampConfirm.amount_expected,
                                currencyId,
                                method:              paymentMethod,
                                duration:            expiryDuration,
                                reference:           onramp.reference,
                                bank_Name:           rampConfirm.bank_name,
                                bank_Account_Number: rampConfirm.account_number,
                                bank_Account_Name:   rampConfirm.account_name,
                                bank_expires_At:     expiryDuration,
                                paymentDetails: {
                                    account_name:     rampConfirm.account_name,
                                    account_number:   rampConfirm.account_number,
                                    bank_name:        rampConfirm.bank_name,
                                    amount:           rampConfirm.amount,
                                    amount_expected:  rampConfirm.amount_expected,
                                    processor_fee:    rampConfirm.processor_fee,
                                    vat:              rampConfirm.vat,
                                    fromAmount:       rampConfirm.amount,
                                    fromCurrency:     order.pair.quoteCurrency.ISO, 
                                    toAmount:         rampInit.to_amount,
                                    toCurrency:       order.pair?.baseCurrency?.ISO,
                                    quidax_reference: rampInit.reference,
                                }
                            }
                        })
    
                        // CRITICAL: walletId = ADMIN wallet (crypto lands here from Quidax).
                        // address = user's own external wallet (crypto.address from request) —
                        // where Vyre sends the crypto FROM the admin wallet once confirmed.
                        const postDetails = await tx.postDetails.create({
                            data: {
                                awaitingId:     awaiting.id,
                                walletId:       adminWalletId,
                                userId:         user.id,
                                orderId,
                                amount:         reservation.amountReserved as string,
                                currencyId,
                                address:        crypto?.address || null,
                                chain:          currency?.chain || null,
                            }
                        })
    
                        return { awaiting, postDetails }
                    },
                    { maxWait: 10000, timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
                ),
                'Update synthetic onramp awaiting', 2, 3000
            )
    
            await this.scheduleExpiryJob(result.awaiting.id)
    
            logger.info('Synthetic SELL (onramp) preActions completed', {
                awaitingId: result.awaiting.id
            })
    
            return result.awaiting
        }
    
        // ── BUY: user sends crypto → receives fiat (Quidax OFFRAMP) ─────────────
        if (order.type === 'BUY') {
            if (!bank) throw new Error('Bank details required for offramp')
    
            const offramp = await this.initOfframp({
                userId:    user.id,
                order,
                amount,
                awaitingId: reservation.awaitingId,
                bank,
                userEmail: user.realEmail ?? userDetails.email
            })
    
            const { offrampConfirm, offrampInit, bankAccount, triggerAddress } = offramp
    
            const result = await this.retryOperation(
                async () => prisma.$transaction(
                    async (tx) => {
                        const awaiting = await tx.awaiting.update({
                            where: { id: reservation.awaitingId },
                            data: {
                                userId:              user.id,
                                isSynthetic:         true,
                                currencyId,
                                method:              paymentMethod,
                                duration:            expiryDuration,
                                reference:           offramp.reference,
                                triggerAddress,
                                bank_Account_Number: bankAccount.metadata?.account_number,
                                bank_Account_Name:   bankAccount.metadata?.account_name,
                                crypto: {
                                    address:  offrampConfirm.address,
                                    network:  offrampConfirm.network,
                                    currency: offrampConfirm.currency,
                                    tag:      offrampConfirm.tag ?? null,
                                },
                                paymentDetails: {
                                    address:             offrampConfirm.address,
                                    network:             offrampConfirm.network,
                                    currency:            offrampConfirm.currency,
                                    tag:                 offrampConfirm.tag ?? null,
                                    fromAmount:          offrampInit.from_amount,
                                    fromCurrency:        order.pair?.baseCurrency?.ISO,
                                    toAmount:            offrampInit.to_amount,
                                    toCurrency:          order.pair?.quoteCurrency?.ISO,
                                    bank_account_number: bankAccount.metadata?.account_number,
                                    bank_code:           bankAccount.metadata?.bank_code,
                                    bank_account_name:   bankAccount.metadata?.account_name,
                                    quidax_reference:    offrampInit.reference,
                                }
                            }
                        })
    
                        // No postDetails needed for offramp — Quidax sends fiat directly
                        // to the user's bank once crypto is confirmed received.
                        // handleOfframpCompleted is the final step, no further action required.
    
                        return { awaiting }
                    },
                    { maxWait: 10000, timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
                ),
                'Update synthetic offramp awaiting', 2, 3000
            )
    
            await this.scheduleExpiryJob(result.awaiting.id)
    
            logger.info('Synthetic BUY (offramp) preActions completed', {
                awaitingId: result.awaiting.id
            })
    
            return result.awaiting
        }
    
        throw new Error(`Unsupported order type: ${order.type}`)
  }

  private async handleNormalPreActions(payload: {
      order: any, currency: any, userDetails: any, bank: any, crypto: any,
      amount: string, paymentMethod: string | undefined, reservation: any, expiryDuration: Date,
      orderId: string, currencyId: string
  }) {
      const { order, currency, userDetails, bank, crypto, amount,
              paymentMethod, reservation, expiryDuration,
              orderId, currencyId } = payload

      // Setup user (includes wallet creation) — existing setUpUser()
      const userSetup = await this.setUpUser({
          firstName:   userDetails.firstName,
          lastName:    userDetails.lastName,
          phoneNumber: userDetails.phoneNumber,
          email:       userDetails.email,
          orderId,
          accessPin:   userDetails.pin
      })

      if (!userSetup) throw new Error('Failed to set up user')

      const { user, baseWallet, quoteWallet } = userSetup

      let payments: any = null

      if (order.type === 'SELL') {
          if (!quoteWallet) throw new Error('Quote wallet not created')

          const paymentEmail = user.realEmail || userDetails.email

          try {
              payments = await Promise.race([
                  this.retryOperation(
                      async () => walletService.getPaymentMethod({
                          currency:   currency.ISO,
                          amount:     parseFloat(amount),
                          email:      paymentEmail,
                          userId:     user.id,
                          walletId:   quoteWallet.id,
                          method:     paymentMethod,
                          awaitingId: reservation?.awaitingId
                      }),
                      'Initialize payment method', 3, 2000
                  ),
                  this.timeoutPromise(45000, 'Payment initialization timeout')
              ])

              if (!payments) throw new Error('Payment initialization returned null')

          } catch (paymentError: any) {
              try {
                  await orderslotService.cancelAwaiting(
                      reservation.awaitingId!,
                      `Payment initialization failed: ${paymentError.message}`
                  )
              } catch (releaseError: any) {
                  logger.error('Failed to release reservation', {
                      awaitingId: reservation.awaitingId,
                      error:      releaseError.message
                  })
              }

              let errorMessage = 'Failed to initialize payment. Please try again.'
              if (paymentError.message.includes('timeout')) errorMessage = 'Payment initialization timed out.'
              if (paymentError.message.includes('network')) errorMessage = 'Network error. Please try again.'
              if (paymentError.message.includes('Bank') || paymentError.message.includes('account'))
                  errorMessage = 'Unable to generate bank account details.'

              throw new Error(errorMessage)
          }
      }

      const result = await this.retryOperation(
          async () => prisma.$transaction(
              async (tx) => {
                  const awaiting = await tx.awaiting.update({
                      where: { id: reservation.awaitingId },
                      data: {
                          userId:         user.id,
                          triggerAddress: order.type === 'BUY'
                              ? baseWallet.depositAddress
                              : quoteWallet.depositAddress,
                          walletId:   order.type === 'BUY' ? baseWallet.id : quoteWallet.id,
                          currencyId,
                          method:     paymentMethod,
                          duration:   expiryDuration,
                          reference:           payments?.id,
                          bank_Name:           payments?.bank,
                          bank_Account_Number: payments?.account_number,
                          bank_Account_Name:   payments?.account_name,
                          bank_expires_At:     payments?.expires_at
                              ? new Date(payments.expires_at.replace(' ', 'T')).toISOString()
                              : null,
                          paymentDetails: payments,
                          ...(order.type === 'BUY' && crypto && {
                              crypto: {
                                  amount,
                                  address:  baseWallet.depositAddress,
                                  currency: order.pair.baseCurrency?.ISO as string,
                                  chain:    order.pair.baseCurrency?.chain
                              }
                          }),
                          ...(order.type === 'SELL' && payments && {
                              bank: {
                                  amount,
                                  ...payments,
                                  currency: order.pair.quoteCurrency?.ISO
                              }
                          })
                      }
                  })

                  const postDetails = await tx.postDetails.create({
                      data: {
                          awaitingId:     awaiting.id,
                          walletId:       order.type === 'BUY' ? quoteWallet.id : baseWallet.id,
                          userId:         user.id,
                          orderId,
                          amount:         reservation.amountReserved as string,
                          currencyId,
                          bankCode:       bank?.bank_code     || null,
                          accountNumber:  bank?.accountNumber  || null,
                          recipient_Name: bank?.recipient      || null,
                          chain:          currency?.chain      || null,
                          address:        crypto?.address      || null
                      }
                  })

                  return { awaiting, postDetails }
              },
              { maxWait: 10000, timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
          ),
          'Update awaiting with complete details', 2, 3000
      )

      await this.scheduleExpiryJob(result.awaiting.id)

      logger.info('PreActions completed successfully', {
          awaitingId:        result.awaiting.id,
          orderType:         order.type,
          hasPaymentDetails: !!payments,
      })

      return result.awaiting
  }

  async preActions(payload: PreAction) {
    const { orderId, currencyId, amount, userDetails, bank, crypto, paymentMethod, mobileDetails } = payload

    const startTime = Date.now()
    let reservationId: string | undefined

    try {

        // ── Step 1: Reserve order slot — same for both paths ──
        const reservation = await orderslotService.reserveOrderSlot(orderId, amount)

        if (!reservation.success) {
            throw new Error(
                reservation.reason ||
                `Insufficient order capacity. Available: ${reservation.availableAmount}, Requested: ${amount}`
            )
        }

        reservationId = reservation.awaitingId
        const expiryDuration = moment().add(30, 'minutes').toDate()

        // ── Step 2: Fetch order + currency — same for both ────
        const [order, currency] = await this.retryOperation(
            async () => Promise.all([
                prisma.order.findUnique({
                    where:  { id: orderId },
                    select: {
                        id:              true,
                        type:            true,
                        isSynthetic:     true,
                        liquiditySource: true,
                        metadata:        true,
                        pair: {
                            select: {
                                id:              true,
                                baseId:  true,
                                quoteId: true,
                                baseCurrency:  { select: { id: true, ISO: true, chain: true } },
                                quoteCurrency: { select: { id: true, ISO: true, chain: true } }
                            }
                        }
                    }
                }),
                prisma.currency.findUnique({
                    where:  { id: currencyId },
                    select: { id: true, ISO: true, chain: true }
                })
            ]),
            'Fetch order and currency', 3, 1500
        )

        if (!order)      throw new Error('Order not found')
        if (!order.pair) throw new Error('Order pair not found')
        if (!currency)   throw new Error('Currency not found')

        // ══════════════════════════════════════════════════
        // FORK POINT — synthetic vs normal
        // ══════════════════════════════════════════════════

        if (order.isSynthetic) {
            return await this.handleSyntheticPreActions({
                order, currency, userDetails, bank, crypto, mobileDetails,
                amount, paymentMethod, reservation, expiryDuration,
                orderId, currencyId
            })
        }

        return await this.handleNormalPreActions({
            order, currency, userDetails, bank, crypto, amount,
            paymentMethod, reservation, expiryDuration,
            orderId, currencyId
        })

    } catch (error: any) {
        if (reservationId) {
            try {
                await orderslotService.cancelAwaiting(
                    reservationId,
                    `PreActions failed: ${error.message}`
                )
            } catch (cleanupError: any) {
                logger.error('Failed to cleanup reservation', {
                    awaitingId:   reservationId,
                    cleanupError: cleanupError.message
                })
            }
        }

        logger.error('PreActions failed', {
            error:    error.message,
            stack:    error.stack,
            duration: `${Date.now() - startTime}ms`
        })
        throw error
    }
  }


  // ============================================
  // OPTIMIZED PRE-ACTIONS (3x Faster!)
  // ============================================
  // async preActions(payload: PreAction) {
  //   const { orderId, currencyId, amount, userDetails, bank, crypto, paymentMethod } = payload;

  //   const startTime = Date.now();
  //   let reservationId: string | undefined;

  //   try {

  //     // ============================================
  //     // STEP 1: ATOMICALLY RESERVE ORDER SLOT (BEFORE ANYTHING ELSE)
  //     // ============================================
  //     logger.info('Attempting to reserve order slot', { orderId, amount });

  //     const reservation = await orderslotService.reserveOrderSlot(
  //       orderId,
  //       amount
  //     );

  //     if (!reservation.success) {
  //       logger.warn('Order slot reservation failed', {
  //         orderId,
  //         requestedAmount: amount,
  //         availableAmount: reservation.availableAmount,
  //         reason: reservation.reason
  //       });

  //       throw new Error(
  //         reservation.reason || 
  //         `Insufficient order capacity. Available: ${reservation.availableAmount}, Requested: ${amount}`
  //       );
  //     }

  //     // ✅ Track reservation for cleanup
  //     reservationId = reservation.awaitingId;

  //     logger.info('Order slot reserved successfully', {
  //       orderId,
  //       awaitingId: reservation.awaitingId,
  //       availableAmount: reservation.availableAmount,
  //       requestedAmount: amount
  //     });

  //     // Calculate expiry upfront
  //     const expiryDuration = moment().add(30, 'minutes').toDate();

  //     // Fetch order and currency in parallel
  //     const [order, currency] = await this.retryOperation(
  //       async () => {
  //         return await Promise.all([
  //           prisma.order.findUnique({ 
  //             where: { id: orderId },
  //             select: { 
  //               id: true, 
  //               type: true, 
  //               pair: { 
  //                 select: { 
  //                   id: true, 
  //                   baseCurrency: { select: { id: true, ISO: true, chain: true } }, 
  //                   quoteCurrency: { select: { id: true, ISO: true, chain: true } } 
  //                 } 
  //               } 
  //             }
  //           }),
  //           prisma.currency.findUnique({ 
  //             where: { id: currencyId },
  //             select: { id: true, ISO: true, chain: true }
  //           })
  //         ]);
  //       },
  //       'Fetch order and currency',
  //       3,
  //       1500
  //     );

  //     if (!order) throw new Error('Order not found');
  //     if (!order.pair) throw new Error('Order pair not found'); // ✅ Added null check
  //     if (!currency) throw new Error('Currency not found');

  //     // Setup user (includes parallel wallet creation)
  //     const userSetup = await this.setUpUser({
  //       firstName: userDetails.firstName,
  //       lastName: userDetails.lastName,
  //       phoneNumber: userDetails.phoneNumber,
  //       email: userDetails.email,
  //       orderId,
  //       accessPin: userDetails.pin
  //     });

  //     if (!userSetup) throw new Error('Failed to set up user');

  //     const { user, baseWallet, quoteWallet } = userSetup;

  //     // ============================================
  //     // CRITICAL: PAYMENT INITIALIZATION FOR SELL ORDERS
  //     // ============================================
      
  //     let payments: any = null;

  //     // For SELL orders (user pays fiat), initialize payment FIRST
  //     if (order.type === 'SELL') {
  //       if (!quoteWallet) throw new Error('Quote wallet not created');

  //       logger.info('Initializing payment for SELL order', { 
  //         orderId, 
  //         currency: currency.ISO,
  //         method: paymentMethod 
  //       });

  //       // Use realEmail if available, fallback to userDetails.email
  //       const paymentEmail = user.realEmail || userDetails.email;

  //       try {
  //         // Wait for payment initialization with timeout
  //         payments = await Promise.race([
  //           this.retryOperation(
  //             async () => {
  //               return await walletService.getPaymentMethod({
  //                 currency: currency.ISO,
  //                 amount: parseFloat(amount),
  //                 email: paymentEmail,
  //                 userId: user.id,
  //                 walletId: quoteWallet.id,
  //                 method: paymentMethod,
  //                 awaitingId: reservation?.awaitingId
  //               });
  //             },
  //             'Initialize payment method',
  //             3, // 3 retries
  //             2000 // 2 second delay between retries
  //           ),
  //           this.timeoutPromise(45000, 'Payment initialization timeout')
  //         ]);

  //         console.log('payment info', payments )

  //         if (!payments) {
  //           throw new Error('Payment initialization returned null');
  //         }

  //         logger.info('Payment initialized successfully', {
  //           reference: payments.id,
  //           bank: payments.bank,
  //           accountNumber: payments.account_number
  //         });

  //       } catch (paymentError: any) {
  //         logger.error('Payment initialization failed completely', {
  //           orderId,
  //           currency: currency.ISO,
  //           error: paymentError.message,
  //           stack: paymentError.stack
  //         });

  //         // ❌ Release the reservation
  //         try {
  //           await orderslotService.cancelAwaiting(
  //             reservation.awaitingId!,
  //             `Payment initialization failed: ${paymentError.message}`
  //           );
  //           logger.info('Reservation released after payment failure', {
  //             awaitingId: reservation.awaitingId
  //           });
            
  //           // ✅ Clear reservationId to prevent double cleanup in catch block
  //           reservationId = undefined;
            
  //         } catch (releaseError: any) {
  //           logger.error('Failed to release reservation', {
  //             awaitingId: reservation.awaitingId,
  //             error: releaseError.message
  //           });
  //         }

  //         // Determine error message based on error type
  //         let errorMessage = 'Failed to initialize payment. Please try again.';
          
  //         if (paymentError.message.includes('timeout')) {
  //           errorMessage = 'Payment initialization timed out. Please check your network connection and try again.';
  //         } else if (paymentError.message.includes('network') || paymentError.code === 'ECONNREFUSED') {
  //           errorMessage = 'Network error. Please check your internet connection and try again.';
  //         } else if (paymentError.message.includes('Bank') || paymentError.message.includes('account')) {
  //           errorMessage = 'Unable to generate bank account details. Please contact support.';
  //         }

  //         // Throw error to stop the flow
  //         throw new Error(errorMessage);
  //       }
  //     }

  //     // ============================================
  //     // STEP 5: UPDATE AWAITING WITH COMPLETE DETAILS
  //     // ============================================

  //     const result = await this.retryOperation(
  //       async () => {
  //         return await prisma.$transaction(
  //           async (tx) => {
  //             const awaiting = await tx.awaiting.update({
  //               where: { id: reservation.awaitingId },
  //               data: {
  //                 userId: user.id,
  //                 triggerAddress: order.type === 'BUY' 
  //                   ? baseWallet.depositAddress 
  //                   : quoteWallet.depositAddress,
  //                 walletId: order.type === 'BUY' ? baseWallet.id : quoteWallet.id,
  //                 currencyId,
  //                 method: paymentMethod,
  //                 duration: expiryDuration,
  //                 reference: payments?.id,
  //                 bank_Name: payments?.bank,
  //                 bank_Account_Number: payments?.account_number,
  //                 bank_Account_Name: payments?.account_name,
  //                 bank_expires_At: payments?.expires_at 
  //                   ? new Date(payments.expires_at.replace(' ', 'T')).toISOString() 
  //                   : null,
  //                 paymentDetails: payments,
  //                 // ✅ Conditional spread - only add crypto for BUY orders
  //                 ...(order.type === 'BUY' && crypto && {
  //                   crypto: {
  //                     amount,
  //                     address: baseWallet.depositAddress,
  //                     currency: order?.pair?.baseCurrency?.ISO as string, // ✅ No optional chaining (already checked)
  //                     chain: order.pair.baseCurrency?.chain
  //                   }
  //                 }),
  //                 // ✅ Conditional spread - only add bank for SELL orders
  //                 ...(order.type === 'SELL' && payments && {
  //                   bank: {
  //                     amount,
  //                     ...payments,
  //                     currency: order.pair.quoteCurrency?.ISO // ✅ No optional chaining (already checked)
  //                   }
  //                 })
  //               }
  //             });

  //             const postDetails = await tx.postDetails.create({
  //               data: {
  //                 awaitingId: awaiting.id,
  //                 walletId: order.type === 'BUY' ? quoteWallet.id : baseWallet.id,
  //                 userId: user.id,
  //                 orderId,
  //                 amount: reservation.amountReserved as string,
  //                 currencyId,
  //                 // ✅ Safe handling for optional bank data
  //                 bankCode: bank?.bank_code || null,
  //                 accountNumber: bank?.accountNumber || null,
  //                 recipient_Name: bank?.recipient || null,
  //                 // ✅ Safe handling for optional crypto data
  //                 chain: currency?.chain || null,
  //                 address: crypto?.address || null
  //               }
  //             });

  //             return { awaiting, postDetails };
  //           },
  //           {
  //             maxWait: 10000,
  //             timeout: 30000,
  //             isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  //           }
  //         );
  //       },
  //       'Update awaiting with complete details',
  //       2,
  //       3000
  //     );

  //     // Schedule expiry job
  //     try {
  //       await this.retryOperation(
  //         async () => {
  //           return await this.awaitingQueue.add(
  //             'expire-awaiting',
  //             { awaitingId: result.awaiting.id },
  //             {
  //               delay: 30 * 60 * 1000,
  //               jobId: `awaiting-expiry-${result.awaiting.id}`
  //             }
  //           );
  //         },
  //         'Schedule expiry job',
  //         3,
  //         2000
  //       );
  //     } catch (jobError: any) {
  //       logger.error('Failed to schedule expiry job', {
  //         awaitingId: result.awaiting.id,
  //         error: jobError.message
  //       });
  //       // Don't fail the whole operation if job scheduling fails
  //     }

  //     const duration = Date.now() - startTime;
  //     logger.info('PreActions completed successfully', { 
  //       awaitingId: result.awaiting.id,
  //       orderType: order.type,
  //       hasPaymentDetails: !!payments,
  //       duration: `${duration}ms` 
  //     });

  //     return result.awaiting;

  //   } catch (error: any) {
  //     const duration = Date.now() - startTime;

  //     // ❌ Cleanup reservation if something failed (and not already cleaned up)
  //     if (reservationId) {
  //       logger.warn('Releasing reservation due to error', {
  //         awaitingId: reservationId,
  //         error: error.message
  //       });

  //       try {
  //         await orderslotService.cancelAwaiting(
  //           reservationId,
  //           `PreActions failed: ${error.message}`
  //         );
  //       } catch (cleanupError: any) {
  //         logger.error('Failed to cleanup reservation', {
  //           awaitingId: reservationId,
  //           cleanupError: cleanupError.message
  //         });
  //       }
  //     }

  //     logger.error('PreActions failed', { 
  //       error: error.message,
  //       stack: error.stack,
  //       duration: `${duration}ms` 
  //     });
  //     throw error;
  //   }
  // }

  // ── Resolve email for anonymous user ─────────────────────────
  // If email belongs to real Vyre account — use internal email
  // This prevents collision while keeping the trade isolated
  private async resolveAnonymousEmail(email: string): Promise<string> {
      const existingUser = await prisma.user.findUnique({
          where: { email },
          select: { id: true }
      });

      if (existingUser) {
          // Real account exists — use internal anonymous email
          return `anon_${Date.now()}_${email}`;
      }

      // No real account — use their real email
      return email;
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

      // ✅ Push live update so the frontend swaps to the expired/failed component
      await ablyService.awaiting_Order_Update(awaitingId);

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

  private async scheduleExpiryJob(awaitingId: string) {
      try {
          await this.retryOperation(
              async () => this.awaitingQueue.add(
                  'expire-awaiting',
                  { awaitingId },
                  { delay: 30 * 60 * 1000, jobId: `awaiting-expiry-${awaitingId}` }
              ),
              'Schedule expiry job', 3, 2000
          )
      } catch (jobError: any) {
          logger.error('Failed to schedule expiry job', { awaitingId, error: jobError.message })
      }
  }

}


export default new AnonService()


