import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.config';
import { OrderType, AwaitingStatus, Awaiting, Wallet, Currency } from '@prisma/client';
import walletService from './wallet.service';
import orderService from './order.service';
import ablyService from './ably.service';
import Decimal from 'decimal.js';
import { hasSufficientBalance, amountSufficient } from '../utils';
import { Queue } from 'bullmq'; // Using BullMQ for job queue
import config from '../config/env.config';
import logger from '../config/logger'
import notificationService from './notification.service';
import connection from '../config/redis.config';
import anonService from './anon.service';
import { DecimalUtil } from './decimal.util';
import orderslotService from './orderslot.service';
import sweepService from './sweep.service';
import gaspumpService from './gaspump.service';


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

//   {
// 	"chain": "base-mainnet",
// 	"type": "native",
// 	"address": "0xb0a7a90ec013d3897a8a861bb499fad985936e81",
// 	"counterAddress": "0xf6efbde3b57ff9413c8262315ab0ca350881b1e1",
// 	"amount": "0.0004",
// 	"asset": "ETH_BASE",
// 	"currency": "ETH_BASE",
// 	"subscriptionId": "699d1ef9f927dbe59141fa4a",
// 	"subscriptionType": "ADDRESS_EVENT",
// 	"txId": "0x565fd6d8a6a8dd988bde406d360359e68eeda90412474ce2ff525eb83af8b8d5",
// 	"blockNumber": 43876905,
// 	"timestamp": 1774543157000
// }

// {
// 	"chain": "base-mainnet",
// 	"type": "token",
// 	"address": "0xf6efbde3b57ff9413c8262315ab0ca350881b1e1",
// 	"counterAddress": "0xc7263ca36bf6cf7cb6c94ad47b4638a40192f487",
// 	"amount": "2.5",
// 	"asset": "0x9e023532926d8f39f14f5242cd364787a090a0f0",
// 	"currency": "ETH_BASE",
// 	"contractAddress": "0x9e023532926d8f39f14f5242cd364787a090a0f0",
// 	"tokenId": "2500000",
// 	"subscriptionId": "694debfef186c15820f75302",
// 	"subscriptionType": "ADDRESS_EVENT",
// 	"txId": "0x81813e112285d2a5b6776346ca7d32f2cfe6dfee38754248e6b220cdadcc9803",
// 	"blockNumber": 43853661,
// 	"timestamp": 1774496669000
// }

  interface QorepayDVAPayload {
      payment_intent_id: string;
      reference: string;
      paid_amount: number;
      fees: number;
      currency: string;
      provider: 'PAYSTACK' | 'FLUTTERWAVE' | string;
      channel: 'TRANSFER' | 'CARD' | 'BANK' | string;
      customer_id: string;
      dva: {
        id: string;
        account_number: string;
        account_name: string;
        bank_name: string;
        customer_id: string;
      };
  }

  interface QorepayPurchasePayload {
    reference: string;
    brand_id: string;
    amount: number;
    currency: string;
    status: string;
    fees: number;
    customer: {
      name: string;
      email: string;
    };
    metadata: any;
  }

  interface QorepayVirtualAccount {
    id: string;
    account_number: string;
    account_name: string;
    bank_name: string;
    status: string;
    customer_id: string;
    merchant_id: string;
  }

class eventService {

  private orderProcessingQueue: Queue;  

  constructor() {
    // Initialize the processing queue
    this.orderProcessingQueue = new Queue('general-process', {
      connection
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

  async queue(payload:{
   
    // QorePay_Event?: 'purchase' | 'payout';
    QorePay_Event?: 'transaction.created' | 'dva.created' | 'purchase.success' | 'purchase.failed' | 'payout.pending' | 'payout.completed' | 'payout.failed' | 'payment.expired' | 'payment.failed' | 'payment.success';
    data?: object;

    Tatum_Address?: string;
    Tatum_CounterAddress?: string;
    Tatum_Chain?: string; 
    Tatum_Type?: string;
    Tatum_ContractAddress?: string;
    Tatum_Asset?: string;
    Tatum_Amount?: any;
    Tatum_SubscriptionId?: string;
    Tatum_EventType?: string;
    Tatum_TxId?: string;


    type: 'TATUM' | 'QOREPAY' | 'FERN'
  }){
    console.log('new event queue', payload)

    const {
      type, 
      QorePay_Event, 
      data,
      
      Tatum_Address, 
      Tatum_CounterAddress,
      Tatum_Chain,
      Tatum_Type,
      Tatum_ContractAddress,
      Tatum_Asset,
      Tatum_Amount, 
      Tatum_SubscriptionId, 
      Tatum_EventType,
      Tatum_TxId
    } = payload


    if(type === 'QOREPAY'){
      return await this.orderProcessingQueue.add('Qorepay_Event', {
        event: QorePay_Event,
        data
      });
    }

    if(type === 'TATUM'){
      return await this.orderProcessingQueue.add('Tatum_Event', {
        address: Tatum_Address,
        counterAddress: Tatum_CounterAddress,

        chain: Tatum_Chain,
        type: Tatum_Type,
        contractAddress: Tatum_ContractAddress,
        asset: Tatum_Asset,

        amount: Tatum_Amount,
        subscriptionId: Tatum_SubscriptionId,
        eventType: Tatum_EventType,
        txId: Tatum_TxId,

        
      });
    }

  }


  public async handleQorepayEvent(payload: {
    // event: 'purchase' | 'payout';
    event: 'transaction.created'| 'dva.created' | 'purchase.success' | 'purchase.failed' | 'payout.pending' | 'payout.completed' | 'payout.failed' | 'payment.expired' | 'payment.failed' | 'payment.success';
    data: any;
  }) {
    const {event, data} = payload;


    try {

      if(event ==='dva.created'){
        const result = await this.handle_DVA_Created(data)
        return result
      }

      // FOR DVA DEPOSITS
      if(event === 'transaction.created'){
        const result = await this.handle_DVA_Event(data)
        return result
      } 

      // FOR FIAT DEPOSITS
      if(event === 'purchase.success'){
        const result = await this.handleFiatEvent({event:'CREDIT', data })
        return result
      } 
        
      if(event === 'purchase.failed'){
        const result = await this.handleFiatEvent({event:'CREDIT_FAILED', data })
        return result
      }


      // FOR FIAT WITHDRAWALS OR PAYOUTS
      if(event === 'payout.pending'){
        return { status: 'processed', action: 'wallet-payout-created' }
      }

      if(event === 'payout.completed'){
        const result = await this.handleFiatEvent({event:'DEBIT', data })
        return result
      }
        
      if(event === 'payout.failed'){
        const result = await this.handleFiatEvent({event:'DEBIT_FAILED', data })
        return result
      }

     

    } catch (error:any) {
      logger.error(`Error handling webhook for : ${data.reference}:`, error);
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  public async handleTatumEvent(payload: {
    address: string;
    counterAddress: string;
    chain: string;
    type: string;
    contractAddress?: string;
    asset: string;


    amount: any;
    subscriptionId: string;
    txId: string;
    eventType: string;

  }) {
    console.log('-----------Tatum event received------------')
    console.log(payload)

    const {
      address, 
      amount, 
      subscriptionId, 
      type, 
      txId,


      asset,
      eventType,
      chain, 
      contractAddress,
      counterAddress
    } = payload;

    try {

      // Gate 1 — only process token transfers
      if (type !== 'token') {
        logger.info('Ignored — non-token transfer', { type, txId, chain })
        return { status: 'ignored', reason: 'native_transfer' }
      }

      // Gate 2 — token must have a contract address
      if (!contractAddress) {
        logger.warn('Ignored — token missing contractAddress', { txId, chain })
        return { status: 'ignored', reason: 'missing_contract' }
      }

      await this.handleCryptoEvent({
        address,
        subscriptionId,
        amount,
        counterAddress,
        contractAddress,
        txId,

        type, 
        asset, 
        eventType, 
        chain
      })

    } catch (error) {
      logger.error(`Error handling tatum event : ${address}:`, error);
      console.error('Error handling tatum event:', error);
      throw error;
    }
  }

  /**
   * Handles incoming webhook events from payment provider
   * Responds immediately and queues processing work
   */
  public async handleCryptoEvent(payload: {
    address: string;
    subscriptionId: string;
    amount: string;
    contractAddress: string;
    counterAddress: string;
    txId: string;

    type: string;
    asset: string;
    eventType: string;
    chain: string;

  }) {
    const { type, asset, eventType, chain, address, amount, contractAddress, counterAddress, subscriptionId, txId } = payload;

    try {

      logger.info('Received crypto webhook event', {
        address,
        amount,
        counterAddress,
        txId
      });

      // ✅ CRITICAL: Check for zero or invalid amount FIRST
      const amountDecimal = new Decimal(amount);

      if (amountDecimal.lessThanOrEqualTo(0)) {
          logger.warn('Ignoring zero or negative amount transaction', {
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

      logger.info('Valid amount detected', {
          amount: amountDecimal.toString(),
          txId
      });

      const chainKey = this.WEBHOOK_CHAIN_MAP[chain]

      // 1. Find wallet with relations
      

      const [wallet, adminWallet] = await Promise.all([
         prisma.wallet.findFirst({
              where: {
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
        }),

        prisma.wallet.findFirst({
          where: { userId: config.Admin_Id },
          select: { depositAddress: true }
        })

      ])

      console.log('wallet',wallet)

      if (!wallet) {
        logger.warn('Ignored — no matching wallet', { subscriptionId, txId })
        return { status: 'ignored', reason: 'wallet_not_found' }
      }

      if (!adminWallet) {
        logger.warn('Ignored — admin wallet not found', { txId })
        return { status: 'ignored', reason: 'admin_wallet_not_found' }
      }

      // ── Step 3: Validate token contract ──────────────────────────────
      const ignored = this.validateContract(contractAddress, chain, wallet, txId)
      if (ignored) return ignored

      // ── Step 4: Ignore our own sweep transactions ─────────────────────
      if (this.isSweepFeedback(address, counterAddress, wallet, adminWallet)) {
        logger.info('Ignored — sweep feedback', { txId, chain })
        return { status: 'ignored', reason: 'sweep_feedback' }
      }

      // ── Step 5: Idempotency check ─────────────────────────────────────
      const existingTx = await prisma.transaction.findFirst({
        where: { reference: txId, walletId: wallet.id }
      })

      if (existingTx) {
        logger.info('Ignored — duplicate transaction', { txId })
        return { status: 'ignored', reason: 'duplicate' }
      }


      // ── Step 6: Sync VA balance from Tatum ───────────────────────────
      logger.info('Syncing wallet balance', { walletId: wallet.id });
      const syncedWallet = await walletService.getAccount(wallet.id);
      if (!syncedWallet) {
        throw new Error(`Failed to sync wallet ${wallet.id}`);
      }
      logger.info('Wallet synced', {
        walletId: wallet.id,
        newBalance: syncedWallet.accountBalance?.toString()
      });


      // ── Step 7: Detect transfer direction ─────────────────────────────
      const { transferType, balanceDifference } = this.detectTransferType(
        wallet.accountBalance,
        syncedWallet.accountBalance,
        amountDecimal,
        txId
      )

      // ── Step 8: Resolve actual sender ─────────────────────────────────
      const actualSender = wallet.depositAddress === address ? counterAddress : address

      // ── Step 9: Find pending awaiting order ───────────────────────────
      const awaiting = await prisma.awaiting.findFirst({
        where:   { triggerAddress: wallet.depositAddress, status: 'PENDING' },
        include: { currency: true, wallet: true, order: true }
      })

      logger.info('Awaiting payment check', {
        found: !!awaiting,
        awaitingId: awaiting?.id,
        expectedAmount: awaiting?.amount?.toString()
      });

      // ── Step 10: Process in DB transaction ────────────────────────────
      const roundedAmount = DecimalUtil.roundForStorage(
        amountDecimal,
        wallet.currency?.ISO as string
      ).toString()


      return await prisma.$transaction(async (tx) => {
        if (transferType === 'CREDIT') {
          return await this.handleCreditTransaction({
            tx, wallet, syncedWallet,
            amount: roundedAmount,
            sender: actualSender,
            awaiting, txId, chain, contractAddress
          })
        }

        if (transferType === 'DEBIT') {
          return await this.handleDebitTransaction({
            tx, wallet, syncedWallet,
            amount: roundedAmount,
            txId
          })
        }

        throw new Error(`Unable to determine transfer type`)

      }, {
        maxWait:        10000,
        timeout:        30000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
      })


    } catch (error) {
      logger.error('Error handling crypto event:', {
        address,
        txId,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  public async handleFiatEvent(payload: {
    data: QorepayPurchasePayload;
    event: 'CREDIT'|'DEBIT'|'CREDIT_FAILED'|'DEBIT_FAILED'
  }) {
    const {event} = payload;
    const {reference, amount, metadata } = payload.data
    const {walletId, userId, currency, BlockId} = metadata
  
    console.log('event', event)
    const processedAmount = (Number(amount)) / 100
  
    // Find awaiting transfer (used by both CREDIT and DEBIT)
    const awaiting = await prisma.awaiting.findFirst({
      where: {
        reference,
        status: 'PENDING'
      },
      include: {
        currency: true,
        wallet: true
      }
    });
  
    console.log('awaiting', awaiting)
  
    try {
  
      // ========================================
      // CREDIT: User deposits money INTO Vyre
      // ========================================
      if(event === 'CREDIT'){
        console.log('CREDIT TRANSACTION - User depositing money')
  
        // Credit wallet for successful deposit
        await Promise.all([
          walletService.credit_Wallet(processedAmount, walletId),
          prisma.transaction.create({
            data:{
              userId,
              currency,
              amount: processedAmount,
              reference,
              status: 'SUCCESSFUL',
              walletId,
              type: 'FIAT_DEPOSIT', // ✅ Changed from WITHDRAWAL
              description: `${currency} deposit via bank transfer`,
              metadata: {
                type: 'Bank-Deposit',
                amount: processedAmount,
                reference
              }
            }
          })
        ])
  
        // CHECK FOR AWAITING TRANSFER 
        if (awaiting) {
          // User deposited to complete an order
          await this.orderProcessingQueue.add('process-order', {
            awaitingId: awaiting.id
          });
  
          await prisma.awaiting.update({
            where: { id: awaiting.id },
            data: { status: 'CONFIRMED' }
          });
  
          await ablyService.awaiting_Order_Update(awaiting.id);
          await anonService.cancelAwaitingExpiry(awaiting.id);
  
          logger.info(`Deposit processed and queued for order, reference: ${reference}`);
          return { status: 'queued', action: 'order-processing' };
  
        } else {
          // Regular deposit (no order)
          await notificationService.queue({
            userId,
            title: '💰 Deposit Successful',
            type: 'GENERAL',
            content: `Your deposit of <strong>${processedAmount} ${currency}</strong> has been processed successfully. The funds are now available in your wallet.`
          });
  
          logger.info(`Direct deposit processed and notification sent, reference: ${reference}`);
          return { status: 'processed', action: 'wallet-credit-and-notify' };
        }
      }
  
      // ========================================
      // CREDIT_FAILED: Deposit failed
      // ========================================
      if(event === 'CREDIT_FAILED'){
        await prisma.transaction.create({
          data:{
            userId,
            currency,
            amount: processedAmount,
            reference,
            status: 'FAILED',
            walletId,
            type: 'FIAT_DEPOSIT', // ✅ Changed from WITHDRAWAL
            description: `${currency} deposit failed`
          }
        })
  
        // Notify user of failed deposit
        await notificationService.queue({
          userId,
          title: '❌ Deposit Failed',
          type: 'GENERAL',
          content: `Your deposit of <strong>${processedAmount} ${currency}</strong> could not be processed. Please contact support if funds were debited from your account.`
        });
  
        logger.info(`Failed deposit processed, reference: ${reference}`);
        return { status: 'processed', action: 'deposit-failed' };
      }
  
      // ========================================
      // DEBIT: User withdraws money FROM Vyre wallet
      // Withdrawal was successful - DEBIT their Vyre wallet
      // ========================================
      if(event === 'DEBIT'){
        console.log('DEBIT TRANSACTION - User withdrawing to bank (successful)')
  
        if(!walletId || !userId || !currency){
          logger.warn(`WalletId or userId not provided for withdrawal: ${reference}`);
          return { status: 'failed', action: 'WalletId-or-userId-not-found' };
        }
  
        // ✅ DEBIT wallet (user is withdrawing OUT of Vyre)
        await Promise.all([
          walletService.debit_Wallet(processedAmount, walletId),
          // 2. Unblock the amount (since it's now successfully debited)
          BlockId ? walletService.unblock_Amount(BlockId) : Promise.resolve(),
          prisma.transaction.create({
            data:{
              userId,
              currency,
              amount: processedAmount,
              reference,
              status: 'SUCCESSFUL',
              walletId,
              type: 'FIAT_WITHDRAWAL',
              description: `${currency} withdrawal to bank account`,
              metadata: {
                type: 'Bank-Withdrawal',
                amount: processedAmount,
                reference,
                BlockId,
                account_number: metadata.account_number,
                bank_code: metadata.bank_code
              }
            }
          })
        ])
  
        // CHECK FOR AWAITING TRANSFER (order completion)
        if (awaiting) {
          // User withdrew to complete an order
          await this.orderProcessingQueue.add('process-order', {
            awaitingId: awaiting.id
          });
  
          await prisma.awaiting.update({
            where: { id: awaiting.id },
            data: { status: 'CONFIRMED' }
          });
  
          await ablyService.awaiting_Order_Update(awaiting.id);
          await anonService.cancelAwaitingExpiry(awaiting.id);
  
          logger.info(`Withdrawal processed and queued for order, reference: ${reference}`);
          return { status: 'queued', action: 'order-processing' };
  
        } else {
          // Regular withdrawal (no order)
          await notificationService.queue({
            userId,
            title: '✅ Withdrawal Successful',
            type: 'GENERAL',
            content: `Your withdrawal of <strong>${processedAmount} ${currency}</strong> has been sent to your bank account. It should arrive within 24 hours.`
          });
  
          logger.info(`Withdrawal processed and notification sent, reference: ${reference}`);
          return { status: 'processed', action: 'withdrawal-success-and-notify' };
        }
      }
  
      // ========================================
      // DEBIT_FAILED: Withdrawal failed
      // ========================================
      if(event === 'DEBIT_FAILED'){
        console.log('DEBIT_FAILED - Withdrawal failed, releasing blocked funds');

        // ✅ Unblock the amount (return it to available balance)
        if(BlockId){
          await walletService.unblock_Amount(BlockId);
          logger.info(`Blocked amount released for failed withdrawal: ${BlockId}`);
        }

        await prisma.transaction.create({
          data:{
            userId,
            currency,
            amount: processedAmount,
            reference,
            status: 'FAILED',
            walletId,
            type: 'FIAT_WITHDRAWAL',
            description: `${currency} withdrawal failed`,
            metadata: {
              type: 'Bank-Withdrawal-Failed',
              amount: processedAmount,
              reference,
              BlockId
            }
          }
        })
  
        // Notify user of failed withdrawal
        if(!awaiting){
          await notificationService.queue({
            userId,
            title: '❌ Withdrawal Failed',
            type: 'GENERAL',
            content: `Your withdrawal of <strong>${processedAmount} ${currency}</strong> could not be processed. Your funds remain in your wallet. Please try again or contact support.`
          });
        }
  
        logger.info(`Failed withdrawal processed, reference: ${reference}`);
        return { status: 'processed', action: 'withdrawal-failed' };
      }
  
    } catch (error) {
      logger.error(`Error handling webhook for: ${reference}:`, error);
      console.error('Error handling webhook:', error);

      // ✅ Emergency fallback: Unblock amount if webhook processing fails
      if(event === 'DEBIT_FAILED' && BlockId){
        try {
          await walletService.unblock_Amount(BlockId);
          logger.warn(`Emergency unblock executed for BlockId: ${BlockId}`);
        } catch (unblockError) {
          logger.error(`Failed to emergency unblock BlockId: ${BlockId}`, unblockError);
        }
      }

      throw error;
    }
  }

  public async handle_DVA_Event(payload: QorepayDVAPayload) {
    
    console.log('data', payload)

    const {payment_intent_id,
      reference,
      paid_amount,
      fees,
      provider,
      channel,
      customer_id, 
      currency, 
      dva 
    } = payload

    try {

      // 1. Check for duplicate
      const existingTransaction = await prisma.transaction.findFirst({
        where: { reference }
      });

      if (existingTransaction) {
        console.log(`Duplicate webhook for reference: ${reference}`);
        logger.warn(`Duplicate webhook for reference: ${reference}`);
        return { status: 'success', reason: 'already_processed', transactionId: existingTransaction.id };
      }

      // 3. Find bank details
      const bankDetails = await prisma.bankDetails.findUnique({
        where: { id: dva.id },
        include: { wallet: true }
      });


      if (!bankDetails || !bankDetails.wallet) {
        logger.warn(`Bank details or wallet not found for DVA id: ${dva.id}`);
        return { status: 'rejected', reason: 'wallet_not_found' };
      }

      const wallet = bankDetails.wallet;
      const amount = paid_amount / 100; // convert back to naira from Kobo
      const feeAmount = fees / 100;
      const netAmount = amount - feeAmount;

      await walletService.credit_Wallet(Number(amount), wallet.id)

      // 1. create transaction record
      const transaction = await prisma.transaction.create({
          data: {
            userId: wallet.userId,
            currency,
            amount,
            reference,
            status: 'SUCCESSFUL',
            
            walletId: wallet.id,
            type: 'FIAT_DEPOSIT',
            description: `${currency} deposit`,

            metadata: {
              payment_intent_id,
              reference,
              paid_amount,
              fees,
              currency,
              provider,
              channel,
              customer_id,
              dva
            }
          }
      });

      console.log('transaction',transaction)

      await notificationService.queue({
        userId: transaction.userId as string,
        title: 'Deposit Successful',
        type: 'GENERAL',
        content: `Your deposit of <strong>${transaction.amount} ${currency}</strong> has been processed successfully. The funds are now available in your wallet.`
      });

      await walletService.getAccount(wallet.id)

      return { status: 'success', transactionId: transaction.id };

    } catch (error:any) {
        logger.error(`Error handling webhook for: ${reference}`, {
          error: error.message,
          stack: error.stack
        });
        
        return { 
          status: 'error', 
          reason: error.message || 'internal_error',
          reference 
        };
    }
  }

  public async handle_DVA_Created(payload: QorepayVirtualAccount) {

    console.log('DVA Created webhook data:', payload);

    const {
      id,
      account_number,
      account_name,
      bank_name,
      status,
      customer_id,
      merchant_id
    } = payload;

    try {
      // 1. Find bank details with wallet and currency
      const bankDetails = await prisma.bankDetails.findUnique({
        where: { id },
        include: { 
          wallet: {
            include: {
              currency: true
            }
          } 
        }
      });

      if (!bankDetails || !bankDetails.wallet) {
        logger.warn(`Bank details or wallet not found for DVA id: ${id}`);
        return { status: 'rejected', reason: 'wallet_not_found' };
      }

      // 2. Check if already active (idempotency)
      if (bankDetails.status === 'ACTIVE') {
        logger.info(`Bank details already active for DVA id: ${id}`);
        return { status: 'success', reason: 'already_active', id: bankDetails.id };
      }

      // 3. Check if status is PENDING
      if (bankDetails.status !== 'PENDING') {
        logger.warn(`Invalid status transition for DVA id: ${id}. Current status: ${bankDetails.status}`);
        return { status: 'rejected', reason: 'invalid_status_transition' };
      }

      const wallet = bankDetails.wallet;
      const currency = wallet.currency?.ISO || 'NGN';

      // 4. Update bank details to ACTIVE
      const updated = await prisma.bankDetails.update({
        where: { id: bankDetails.id },
        data: {
          account_number,
          account_name,
          bank_name,
          status: 'ACTIVE'
        }
      });

      logger.info(`Bank account activated: ${updated.id}`, {
        account_number,
        bank_name,
        customer_id
      });

      // 5. Send notification to user
      await notificationService.queue({
        userId: wallet.userId as string,
        title: 'Bank Account Activated',
        type: 'GENERAL',
        content: `Your ${currency} bank account has been successfully activated! You can now deposit funds to <strong>${account_number}</strong> (${bank_name}). Deposits will be automatically credited to your wallet.`
      });

      return { 
        status: 'success', 
        id: updated.id,
        account_number: updated.account_number 
      };

    } catch (error: any) {
      logger.error(`Error handling DVA created webhook for: ${id}`, {
        error: error.message,
        stack: error.stack,
        payload
      });
      
      return { 
        status: 'error', 
        reason: error.message || 'internal_error',
        id
      };
    }
  }

  



  private async handleCreditTransaction(params: {
    tx: any;
    wallet: any;
    syncedWallet: any;
    amount: string;
    sender: string;
    awaiting: any;
    txId: string;

    chain: string
    contractAddress: string
  }) {
    const { tx, wallet, syncedWallet, sender, awaiting, txId, amount, chain, contractAddress } = params;

    console.log('in credit transaction handling')

    // 1. Record the credit
    const transaction = await tx.transaction.create({
        data: {
            userId:      wallet.userId,
            currency:    wallet.currency.ISO,
            amount:      DecimalUtil.roundForStorage(amount, wallet.currency?.ISO as string),
            status:      'SUCCESSFUL',
            reference:   txId,
            walletId:    wallet.id,
            type:        'CRYPTO_DEPOSIT',
            description: `Wallet credited with ${amount}`,
            metadata: {
                sender,
                blockchainBalance: syncedWallet.accountBalance,
                previousBalance:   wallet.accountBalance
            }
        }
    })

    console.log('created transaction',transaction)


    // 2. Queue sweep — deferred until after prisma tx commits
    // ── Queue sweep for ALL credit transactions ───────────────────────────
    // Always sweep to master regardless of awaiting order
    // VA handles accounting, master holds actual tokens
    this.queueSweep({ wallet, txId, amount, chain, contractAddress })
    
    // 3. Route — awaiting order or plain deposit
    if (awaiting) {
      return await this.handleAwaitingOrder({ tx, awaiting, syncedWallet, amount, sender, transaction })
    }

    // Plain deposit — notify user
    console.log('finally queuing notification ')

    await notificationService.queue({
      userId: wallet.userId,
      title: 'Transaction Notification',
      type: 'GENERAL',
      content: `<strong>${DecimalUtil.formatWithCurrency(amount,wallet.currency?.ISO as string)}</strong> was sent to you and is available in your wallet. Thanks for choosing Vyre.`
    });

    return { 
      status: 'success', 
      action: 'credit-completed',
      transactionId: transaction.id
    };
  }

  private async handleDebitTransaction(params: {
    tx: any;
    wallet: any;
    syncedWallet: any;
    amount: string;
    txId: string;
  }) {
    const { tx, wallet, syncedWallet, amount, txId } = params;

    // 1. Create transaction record
    const transaction = await tx.transaction.create({
      data: {
        userId: wallet.userId,
        currency: wallet.currency.ISO,
        amount: DecimalUtil.roundForStorage(amount,wallet.currency?.ISO as string),
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
    if (config.Admin_Id !== wallet.userId) {
      await notificationService.queue({
        userId: wallet.userId,
        title: 'Transaction Notification',
        type: 'GENERAL',
        content: `Transfer of <strong>${DecimalUtil.formatWithCurrency(amount,wallet.currency?.ISO as string)}</strong> was successful. Thanks for choosing Vyre.`
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
  public async processRefundJob(jobData: { 
    awaitingId: string;
    senderAddress: string;
    currencyType: string;
  }) {
    const { awaitingId, senderAddress, currencyType } = jobData;

    try {
      const awaiting = await prisma.awaiting.findUnique({
        where: { id: awaitingId },
        include: {
          wallet: true
        }
      });

      if (!awaiting) {
        throw new Error(`Awaiting record ${awaitingId} not found`);
      }

      if (currencyType === "CRYPTO") {
        await walletService.blockchain_Transfer({
          userId: awaiting?.userId as string,
          currencyId: awaiting?.currencyId as string,
          amount: awaiting.wallet?.availableBalance.toString() as string,
          address: senderAddress
        });
      } else {
        // FIAT refund logic would go here, already handled by service provider:QOREPAY 
      }

      await orderslotService.cancelAwaiting(
        awaitingId,
        `Amount refunded for ${awaitingId}:`
      );

      await ablyService.awaiting_Order_Update(awaitingId);

    } catch (error) {
      console.error(`Refund failed for ${awaitingId}:`, error);
      throw error;
    }
  }

  /**
   * Process queued postActions (called by worker)
  */
  public async process_Post_Action_Job(jobData: { 
    awaitingId: string
  }) {
    const { awaitingId } = jobData;

    try {
      // 1. Fetch awaiting record with all relations
      const awaiting = await prisma.awaiting.findUnique({
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
        logger.warn(`Awaiting ${awaitingId} was not SUCCESSFUL: ${awaiting.status}`);
        return { 
          status: 'skipped', 
          reason: 'awaiting_status_not_successful', 
          currentStatus: awaiting.status 
        };
      }

      // 3. Fetch user details
      const user = await prisma.user.findUnique({
        where: { id: awaiting.userId as string },
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
      const postDetails = await prisma.postDetails.findFirst({
        where: { 
          awaitingId, 
          userId: awaiting.userId 
        }
      });

      if (!postDetails || postDetails.status !== 'PENDING') {
        logger.warn(`Post details for awaiting ${awaitingId} not found or already processed`);
        return { 
          status: 'Not Found or Already Processed', 
          reason: `Post details not found for awaiting ${awaitingId} or already processed. Status: ${postDetails?.status || 'NOT_FOUND'}`, 
        };
      }

      // 5. Fetch wallet with currency details
      const wallet = await prisma.wallet.findUnique({
        where: { id: postDetails.walletId as string },
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
      const availableBalance = new Decimal(wallet.availableBalance);
      const accountBalance = new Decimal(wallet.accountBalance);

      // ✅ Validate balance is greater than 0
      if (availableBalance.lessThanOrEqualTo(0)) {
        throw new Error(
          `Insufficient balance in wallet. Available: ${availableBalance.toString()} ${wallet.currency?.ISO}`
        );
      }

      logger.info(`Processing post action for awaiting ${awaitingId}`, {
        orderType: awaiting.order?.type,
        availableBalance: availableBalance.toString(),
        accountBalance: accountBalance.toString(),
        currency: wallet.currency?.ISO as string,
        walletId: wallet.id
      });

      // 7. Execute transfer based on order type
      let transferResult;

      if (awaiting.order?.type === 'BUY') {
        // BUY order: Send fiat to user's bank account
        
        if (!postDetails.accountNumber || !postDetails.bankCode || !postDetails.recipient_Name) {
          throw new Error('Missing bank details for fiat transfer');
        }

        logger.info(`Initiating bank transfer for awaiting ${awaitingId}`, {
          amount: availableBalance.toString(),
          currency: wallet.currency?.ISO,
          recipient: postDetails.recipient_Name,
          accountNumber: postDetails.accountNumber,
          bankCode: postDetails.bankCode
        });

        transferResult = await walletService.direct_bank_Transfer({
          userId: awaiting.userId as string,
          currencyId: wallet.currencyId as string,
          amount: availableBalance.toString(), // ✅ Pass as string
          email: user.email as string,
          phone: user.phoneNumber as string,
          account_number: postDetails.accountNumber as string,
          bank_code: postDetails.bankCode as string,
          recipient_name: postDetails.recipient_Name as string
        });

      } else if (awaiting.order?.type === 'SELL') {
        // SELL order: Send crypto to user's wallet address
        
        if (!postDetails.address) {
          throw new Error('Missing crypto address for blockchain transfer');
        }

        // if (!postDetails.chain) {
        //   throw new Error('Missing blockchain network/chain information');
        // }

        logger.info(`Initiating blockchain transfer for awaiting ${awaitingId}`, {
          amount: availableBalance.toString(),
          currency: wallet.currency?.ISO,
          chain: postDetails.chain,
          address: postDetails.address
        });

        transferResult = await walletService.blockchain_Transfer({
          userId: wallet.userId as string,
          currencyId: wallet.currencyId as string,
          amount: availableBalance.toString(), // ✅ Pass as string
          address: postDetails.address as string,
        });

      } else {
        throw new Error(`Unknown order type: ${awaiting.order?.type}`);
      }

      // 8. Verify transfer was successful
      if (!transferResult) {
        throw new Error('Transfer failed: No result returned from transfer service');
      }

      logger.info(`Transfer successful for awaiting ${awaitingId}`, {
        currency: wallet.currency?.ISO,
        amount: availableBalance.toString(),
        transferId: transferResult.id,
        orderType: awaiting.order?.type
      });

      // 9. Update database records atomically
      const updated = await prisma.$transaction(
        async (tx) => {
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
            where: { id: awaiting.userId as string },
            data: { isDeactivated: true, deactivationReason: 'Completed anon order' }
          });

          return {
            awaiting: updated_Awaiting,
            postDetails: updated_PostDetails,
            user: deactivatedUser
          };
        },
        {
          maxWait: 10000,
          timeout: 30000,
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        }
      );

      logger.info(`Post action completed successfully`, {
        awaitingId,
        awaitingStatus: updated.awaiting.status,
        postDetailsUpdated: updated.postDetails.count
      });

      // 10. Trigger Ably real-time update
      try {
        await ablyService.awaiting_Order_Update(awaitingId);
        logger.info(`Ably notification sent for awaiting ${awaitingId}`);
      } catch (ablyError) {
        logger.error(`Failed to send Ably notification for ${awaitingId}`, {
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

    } catch (error: any) {
      logger.error(`Post action failed for ${awaitingId}`, {
        error: error.message,
        stack: error.stack
      });
      
      // Update awaiting to FAILED status
      try {
        await prisma.awaiting.update({
          where: { id: awaitingId },
          data: {
            status: 'FAILED',
            metadata: {
              error: error.message,
              failedAt: new Date().toISOString()
            }
          }
        });
      } catch (updateError) {
        logger.error(`Failed to update awaiting status to FAILED`, {
          awaitingId,
          error: updateError
        });
      }
      
      throw error;
    }
  }

  private async sendOrderSuccessNotification(params: {
    userId: string;
    orderId: string;
    amount: number;
    baseCurrency?: string;
    quoteCurrency?: string;
  }) {
    const { userId, baseCurrency, quoteCurrency, amount, orderId } = params;

    let notificationContent: string;
    let notificationTitle: string;

    const order = await prisma.order.findUnique({
      where:{id: orderId}
    })

    if(!order){
      return 
    }

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


    const baseAmount = order?.type === "BUY" ? amount : amountProcessed;
    const quoteAmount = order?.type === "BUY" ? amountProcessed : amount

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

    } else {
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
    await notificationService.queue({
      userId,
      title: notificationTitle,
      type: 'GENERAL',
      content: notificationContent
    });
  }

  SUPPORTED_CONTRACTS: Record<string, string> = {
    // USDC
    'USDC_BASE':      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'USDC_ETHEREUM':  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'USDC_POLYGON':   '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    'USDC_BSC':       '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    'USDC_ARBITRUM':  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    'USDC_OPTIMISM':  '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    // USDT
    'USDT_ETHEREUM':  '0xdac17f958d2ee523a2206206994597c13d831ec7',
    'USDT_BASE':      '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2',
    'USDT_POLYGON':   '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    'USDT_BSC':       '0x55d398326f99059ff775485246999027b3197955',
    'USDT_ARBITRUM':  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    'USDT_OPTIMISM':  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
    'USDT_TRON':      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
}

WEBHOOK_CHAIN_MAP: Record<string, string> = {
  'ethereum-mainnet': 'ETHEREUM',
  'base-mainnet':     'BASE',
  'bsc-mainnet':      'BSC',
  'polygon-mainnet':  'POLYGON',
  'arb-one-mainnet':  'ARBITRUM',
  'optimism-mainnet': 'OPTIMISM',
  'tron-mainnet':     'TRON'
}


private validateContract(
    contractAddress: string,
    chain: string,
    wallet: any,
    txId: string
): { status: string; reason: string; message: string } | null {

    const chainKey        = this.WEBHOOK_CHAIN_MAP[chain]
    const lookupKey       = `${wallet.currency?.ISO}_${chainKey}`
    const expectedContract = this.SUPPORTED_CONTRACTS[lookupKey]

    if (!expectedContract) {
        logger.warn('Ignored — no contract configured', { lookupKey, txId })
        return { status: 'ignored', reason: 'unsupported_chain_currency', message: `No contract for ${lookupKey}` }
    }

    if (contractAddress.toLowerCase() !== expectedContract.toLowerCase()) {
        logger.warn('Ignored — contract mismatch', {
            received: contractAddress,
            expected: expectedContract,
            txId
        })
        return { status: 'ignored', reason: 'unsupported_token', message: `Token ${contractAddress} not supported` }
    }

    return null  // ← validation passed
}

private isSweepFeedback(
  address:      string,
  counterAddress: string,
  wallet:       any,
  adminWallet:  any
): boolean {
    if (!adminWallet?.depositAddress) return false

    const masterAddress  = adminWallet.depositAddress.toLowerCase()
    const isInvolved     = counterAddress?.toLowerCase() === masterAddress || address?.toLowerCase() === masterAddress
    const isNotMaster    = wallet.depositAddress?.toLowerCase() !== masterAddress

    return isInvolved && isNotMaster
}

private detectTransferType(
    previousBalance: any,
    currentBalance:  any,
    receivedAmount:  Decimal,
    txId:            string
): { transferType: 'CREDIT' | 'DEBIT'; balanceDifference: Decimal } {

    const prev             = new Decimal(previousBalance)
    const curr             = new Decimal(currentBalance)
    const balanceDifference = curr.minus(prev)
    const transferType     = balanceDifference.greaterThan(0) ? 'CREDIT' : 'DEBIT'

    logger.info('Transfer analysis', {
        previousBalance:  prev.toString(),
        currentBalance:   curr.toString(),
        balanceDifference: balanceDifference.toString(),
        receivedAmount:   receivedAmount.toString(),
        transferType,
        txId
    })

    // Warn on discrepancy but don't block
    if (transferType === 'CREDIT') {
        const discrepancy   = balanceDifference.minus(receivedAmount).abs()
        const maxDiscrepancy = new Decimal('0.00001')

        if (discrepancy.greaterThan(maxDiscrepancy)) {
            logger.warn('Balance increase mismatch', {
                expected:    receivedAmount.toString(),
                actual:      balanceDifference.toString(),
                discrepancy: discrepancy.toString(),
                txId
            })
        }
    }

    return { transferType, balanceDifference }
}

// ── Awaiting order handler — extracted from handleCreditTransaction ────────
private async handleAwaitingOrder(params: {
    tx:           any
    awaiting:     any
    syncedWallet: any
    amount:       string
    sender:       string
    transaction:  any
}) {
    const { tx, awaiting, syncedWallet, amount, sender, transaction } = params

    const expectedAmount   = new Decimal(awaiting.amount.toString())
    const availableBalance = new Decimal(syncedWallet.availableBalance)

    // Insufficient payment — queue refund
    if (availableBalance.lessThan(expectedAmount)) {
        const shortfall = expectedAmount.minus(availableBalance)

        logger.warn('Insufficient payment — queuing refund', {
            awaitingId:       awaiting.id,
            availableBalance: availableBalance.toString(),
            expectedAmount:   expectedAmount.toString(),
            shortfall:        shortfall.toString()
        })

        await this.orderProcessingQueue.add('initiate-refund', {
            awaitingId:     awaiting.id,
            senderAddress:  sender,
            currencyType:   awaiting.currency?.type,
            receivedAmount: amount,
            expectedAmount: expectedAmount.toString(),
            transactionId:  transaction.id
        })

        await tx.awaiting.update({
            where: { id: awaiting.id },
            data:  { metadata: { receivedAmount: amount, expectedAmount: expectedAmount.toString() } }
        })

        return {
            status: 'queued',
            action: 'refund-insufficient-amount',
            details: { expected: expectedAmount.toString(), received: amount }
        }
    }

    // Sufficient payment — process order
    await orderService.process_Order_Queue({
        awaitingId:    awaiting.id,
        transactionId: transaction.id
    })

    await prisma.awaiting.update({ where: { id: awaiting.id }, data: { status: 'CONFIRMED' } })
    await ablyService.awaiting_Order_Update(awaiting.id)
    await anonService.cancelAwaitingExpiry(awaiting.id)

    return {
        status:        'queued',
        action:        'order-processing',
        awaitingId:    awaiting.id,
        transactionId: transaction.id
    }
}

// ── Sweep queuing — extracted from handleCreditTransaction ────────────────
private queueSweep(params: {
    wallet:          any
    txId:            string
    amount:          string
    chain:           string
    contractAddress: string
}) {
    const { wallet, txId, amount, chain, contractAddress } = params
    const internalChain = this.WEBHOOK_CHAIN_MAP[chain]

    if (!internalChain) return

    setImmediate(async () => {
        let sweepLog: any = null

        try {
            // Activate gas pump address first if needed
            if (gaspumpService.isGasPumpChain(internalChain)) {
                console.log(`[GasPump] Activating ${wallet.depositAddress} on ${internalChain}`)
                await gaspumpService.activateAddress(wallet.depositAddress, internalChain, wallet.currencyId)
                console.log(`[GasPump] Activation complete`)
            }

            const shouldSweep =
                wallet.userId      !== config.Admin_Id &&
                wallet.derivationKey !== null &&
                wallet.derivationKey !== undefined &&
                wallet.depositAddress &&
                wallet.currencyId

            if (!shouldSweep) return

            sweepLog = await prisma.sweepLog.create({
                data: {
                    walletId:    wallet.id,
                    userId:      wallet.userId,
                    depositTxId: txId,
                    amount,
                    stablecoin:  wallet.currency?.ISO || '',
                    chain:       internalChain,
                    status:      'QUEUED'
                }
            })

            await sweepService.getSweepQueue(internalChain).add(
                `sweep-${txId}`,
                {
                    currencyId:     wallet.currencyId,
                    userId:         wallet.userId,
                    depositAddress: wallet.depositAddress,
                    derivationKey:  wallet.derivationKey,
                    amount,
                    chain:          internalChain,
                    contractAddress,
                    depositTxId:    txId,
                    sweepLogId:     sweepLog.id
                },
                { jobId: txId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
            )

            console.log(`[Sweep] Queued — chain: ${internalChain}, txId: ${txId}`)

        } catch (err) {
            console.error(`[Sweep] Failed for ${txId}:`, err)
            if (sweepLog?.id) {
                await prisma.sweepLog.update({
                    where: { id: sweepLog.id },
                    data:  { status: 'FAILED', error: (err as Error).message }
                }).catch(console.error)
            }
        }
    })
}



   
}

export default new eventService()


