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
   
    QorePay_Event?: 'purchase' | 'payout';
    QorePay_EventType?: 'purchase.paid' | 'purchase.payment_failure' | 'payout.created' | 'payout.success';
    QorePay_Reference?: string;

    Tatum_Address?: string;
    Tatum_SenderAddress?: string;
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
      QorePay_EventType, 
      QorePay_Reference, 
      
      Tatum_Address, 
      Tatum_SenderAddress, 
      Tatum_Amount, 
      Tatum_SubscriptionId, 
      Tatum_EventType,
      Tatum_TxId
    } = payload

    if(type === 'QOREPAY'){
      return await this.orderProcessingQueue.add('Qorepay_Event', {
        event: QorePay_Event,
        eventType: QorePay_EventType,
        reference: QorePay_Reference
      });
    }

    if(type === 'TATUM'){
      return await this.orderProcessingQueue.add('Tatum_Event', {
        address: Tatum_Address,
        senderAddress: Tatum_SenderAddress,
        amount: Tatum_Amount,
        subscriptionId: Tatum_SubscriptionId,
        type: Tatum_EventType,
        txId: Tatum_TxId
      });
    }

  }


  public async handleQorepayEvent(payload: {
    event: 'purchase' | 'payout';
    eventType: 'purchase.paid' | 'purchase.payment_failure' | 'payout.created' | 'payout.success';
    reference: string;
  }) {
    const {event, eventType, reference } = payload;


    try {

      // FOR FIAT DEPOSITS

      if(event === 'purchase'){

        if(eventType === 'purchase.paid'){
          const result = await this.handleFiatEvent({event:'CREDIT', reference })
          return result
        } 
        
        if(eventType === 'purchase.payment_failure'){
          const result = await this.handleFiatEvent({event:'CREDIT_FAILED', reference })
          return result
        }

      }

      // FOR FIAT WITHDRAWALS

      if(event === 'payout'){

        if(eventType === 'payout.created'){

          return { status: 'processed', action: 'wallet-payout-created' }

        }else if(eventType === 'payout.success'){
          const result = await this.handleFiatEvent({event:'DEBIT', reference })
          return result
        }else{
          const result = await this.handleFiatEvent({event:'DEBIT_FAILED', reference })
          return result
        }

      }
     

    } catch (error) {
      logger.error(`Error handling webhook for : ${reference}:`, error);
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  public async handleTatumEvent(payload: {
    address: string;
    senderAddress: string;
    amount: any;
    subscriptionId: string;
    txId: string;
    type: string;
  }) {
    console.log('-----------handling tatum event current payload------------')
    console.log(payload)

    const {address, amount, subscriptionId, type, txId, senderAddress } = payload;

    const parseAmount = parseFloat(amount);
    console.log('parseAmount', parseAmount)


    try {

      // This path is for POSITIVE amounts (0 or greater)
      // Example: "0.001", "50.00", "100"

      const result = await this.handleCryptoEvent({
        address,
        subscriptionId,
        amount: Math.abs(parseAmount),
        sender: senderAddress,
        txId
      })

    } catch (error) {
      logger.error(`Error handling webhook for : ${address}:`, error);
      console.error('Error handling webhook:', error);
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
    amount: number;
    sender: string;
    txId: string;
  }) {
    const { address, amount, sender, subscriptionId, txId } = payload;

    try {

      // 1. Find wallet with relations
      const wallet = await prisma.wallet.findFirst({
        where: {
          depositAddress: address,
          subscriptionId
        },
        include: {
          currency: true,
          user: true
        }
      });

      if(!wallet){
        return { status: 'ignored', message: 'No matching wallet' };
      }

      // 2. Check for duplicate transaction (IDEMPOTENCY)
      const existingTx = await prisma.transaction.findFirst({
        where: {
          reference: txId,
          walletId: wallet.id
        }
      });

      if (existingTx) {
        console.log(`Duplicate transaction detected: ${txId}`);
        return { status: 'ignored', message: 'Duplicate transaction' };
      }


      // 3. Sync current blockchain balance
      const syncedWallet = await walletService.getAccount(wallet.id);
        
      if (!syncedWallet) {
        throw new Error(`Failed to sync wallet ${wallet.id}`);
      }

      // 4. Find awaiting payment
      const awaiting = await prisma.awaiting.findFirst({
        where: {
          triggerAddress: address,
          status: 'PENDING'
        },
        include: {
          currency: true,
          wallet: true
        }
      });

      console.log('awaiting', awaiting)

      // Determine transfer type by comparing with stored balance
      const previousBalance = wallet.accountBalance;
      const currentBalance = syncedWallet.accountBalance;
      const receivedAmount = amount;
      const transferType = DecimalUtil.isGreaterThan(currentBalance.toString(), previousBalance.toString()) ? 'CREDIT' : 'DEBIT';

      console.log('Transfer Analysis:', {
        previousBalance,
        currentBalance,
        receivedAmount,
        transferType
      })


    // 6. Use database transaction for atomicity
    return await prisma.$transaction(async (tx) => {
      if (transferType === 'CREDIT') {
        return await this.handleCreditTransaction({
          tx,
          wallet,
          syncedWallet,
          amount,
          sender,
          awaiting,
          txId,
          receivedAmount
        });
      } else if (transferType === 'DEBIT') {
        return await this.handleDebitTransaction({
          tx,
          wallet,
          syncedWallet,
          amount,
          txId
        });
      } else {
        throw new Error(`Unable to determine transfer type.`);
      }

    },{
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

      // if(transferType === 'CREDIT'){

      //   await prisma.transaction.create({
      //     data:{
      //         userId: syncedWallet?.userId,
      //         currency: syncedWallet?.currency?.ISO,
      //         amount,
      //         status: 'SUCCESSFUL',
      //         reference: txId,
      //         walletId: syncedWallet.id,
      //         type:'CRYPTO_DEPOSIT',
      //         description:`Wallet credited with ${amount}`
      //       }
      //   })


      //   if(awaiting){

      //     // Verify payment amount
      //     if (!amountSufficient(Number(syncedWallet.availableBalance), Number(awaiting.amount))) {
      //       await this.orderProcessingQueue.add('initiate-refund', {
      //         awaitingId: awaiting.id,
      //         senderAddress: sender,
      //         currencyType: awaiting?.currency?.type
      //       });
      //       return { status: 'queued', action: 'refund' };
      //     }

      //     // Queue order processing
      //     await this.orderProcessingQueue.add('process-order', {
      //       awaitingId: awaiting.id
      //     });

      //     // Cancel the scheduled expiry
      //     await anonService.cancelAwaitingExpiry(awaiting.id);

      //     return { status: 'queued', action: 'order-processing' };

      //   }

      //   await notificationService.queue({
      //       userId: syncedWallet?.userId as string,
      //       title: 'Transaction Notification',
      //       type: 'GENERAL',
      //       content: `<strong>${amount} ${syncedWallet?.currency?.ISO}</strong> was sent to you and available in your wallet. Thanks for choosing Vyre.`
      //   });

      //   return { status: 'success', action: 'credit-completed' };
        
        
      // }

      // if(transferType === 'DEBIT'){

      //   await prisma.transaction.create({
      //     data:{
      //         userId: syncedWallet?.userId,
      //         currency: syncedWallet?.currency?.ISO,
      //         amount,
      //         status: 'SUCCESSFUL',
      //         reference: txId,
      //         walletId: syncedWallet.id,
      //         type:'CRYPTO_WITHDRAWAL',
      //         description:`Wallet debited`
      //       }
      //   })


      //   if(config.Admin_Id !== syncedWallet?.userId){

      //     await notificationService.queue({
      //       userId: syncedWallet?.userId as string,
      //         title: 'Transaction Notification',
      //         type: 'GENERAL',
      //         content: `Transfer of <strong>${amount} ${syncedWallet?.currency?.ISO}</strong> was successful. Thanks for choosing Vyre.`
      //     });

      //   }

       

      //   return { status: 'success', action: 'debit-completed' };

      // }


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
    reference: string;
    event: 'CREDIT'|'DEBIT'|'CREDIT_FAILED'|'DEBIT_FAILED'
  }) {
    const { reference, event} = payload;

    // 1. Find and validate transaction
    const transaction = await prisma.transaction.findUnique({
        where: { id: reference },
        include: { 
          wallet: {
            include: { currency: true }
          } 
        }
    });

    console.log('transaction',transaction)

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

    if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return { status: 'rejected', reason: 'transaction_not_found' };
    }

    if (transaction?.status !== 'PENDING') {
        return { status: 'Already processed', reason: 'transaction_already_processed' };
    }


    try {

      if(event === 'CREDIT'){

        // 2. Credit wallet for ALL successful transactions first
        await walletService.credit_Wallet(
          Number(transaction.amount),
          transaction.walletId as string
        );

        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { 
            status: 'SUCCESSFUL',
            metadata: {
              type:'Anon-Order',
              amount: transaction.amount,
              reference
            }
          }
          
        });

        // CHECK FOR AWAITING TRANSFER 

        if (awaiting) {
          // For transactions WITH awaiting transfers:
          // Queue for order processing (NO notification)
          await this.orderProcessingQueue.add('process-order', {
            awaitingId: awaiting.id
          });

          logger.info(`Fiat payment processed and queued for order processing, reference: ${reference}`);

          // Cancel the scheduled expiry
          await anonService.cancelAwaitingExpiry(awaiting.id);

          return { status: 'queued', action: 'order-processing' };

        } else {
          // For transactions WITHOUT awaiting transfers:
          // Send notification only
          await notificationService.queue({
            userId: transaction.userId as string,
            title: 'Deposit Successful',
            type: 'GENERAL',
            content: `Your deposit of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> has been processed successfully. The funds are now available in your wallet.`
          });

          console.log('notification hit the queue here')

          logger.info(`Direct deposit processed and notification sent, reference: ${reference}`);
          return { status: 'processed', action: 'wallet-credit-and-notify' };
        }

      }

      if(event === 'CREDIT_FAILED'){

        if(transaction){
          await prisma.transaction.update({
            where:{id:transaction?.id!},
            data:{status:'FAILED'}
          })
        }

        logger.info(`Failed deposit processed, reference: ${reference}`);
        return { status: 'processed', action: 'wallet-credit-failed' };
        
      }


      if(event === 'DEBIT'){

        if(transaction){
          await prisma.transaction.update({
            where:{id:transaction?.id},
            data:{
              status: 'SUCCESSFUL',
              metadata: {
              type:'Anon-Order',
              amount: transaction.amount,
              reference
            }
            }
          })
        }

        if(!awaiting){
          await notificationService.queue({
            userId: transaction.userId as string,
            title: 'Withdrawal Successful',
            type: 'GENERAL',
            content: `Your withdrawal of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> has been processed successfully. Thanks for choosing Vyre.`
          });
        }

        logger.info(`Successful payout processed, reference: ${reference}`);
        return { status: 'processed', action: 'wallet-payout-and-notify' };
        
      }


      if(event === 'DEBIT_FAILED'){

        // // refund the user wallet 
        await walletService.credit_Wallet(
          Number(transaction.amount),
          transaction.walletId as string
        );

        if(transaction){
          await prisma.transaction.update({
            where:{id:transaction?.id},
            data:{status: 'FAILED',}
          })
        }

        if(!awaiting){
          await notificationService.queue({
            userId: transaction.userId as string,
            title: 'Withdrawal Failed',
            type: 'GENERAL',
            content: `Your withdrawal of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> could not be processed at this time. Please try again later.`
          });
        }
        
        logger.info(`Failed payout processed, reference: ${reference}`);
        return { status: 'processed', action: 'wallet-payout-failed' };
        
      }

      

    } catch (error) {
      logger.error(`Error handling webhook for : ${reference}:`, error);
      console.error('Error handling webhook:', error);
      throw error;
    }
  }



  private async handleCreditTransaction(params: {
    tx: any;
    wallet: any;
    syncedWallet: any;
    amount: number;
    sender: string;
    awaiting: any;
    txId: string;
    receivedAmount: number;
  }) {
    const { tx, wallet, syncedWallet, amount, sender, awaiting, txId, receivedAmount } = params;

    // 1. Create transaction record
    const transaction = await tx.transaction.create({
      data: {
        userId: wallet.userId,
        currency: wallet.currency.ISO,
        amount,
        status: 'SUCCESSFUL',
        reference: txId,
        walletId: wallet.id,
        type: 'CRYPTO_DEPOSIT',
        description: `Wallet credited with ${amount}`,
        metadata: { 
          sender,
          blockchainBalance: syncedWallet.accountBalance,
          previousBalance: wallet.accountBalance
        }
      }
    });

    // 2. Handle awaiting order
    if (awaiting) {
      
      const expectedAmount = new Decimal(awaiting.amount.toString());
      const received = new Decimal(receivedAmount.toString());
      
      console.log('Amount Verification:', {
        expected: expectedAmount.toString(),
        received: received.toString(),
        walletBalance: syncedWallet.availableBalance.toString(),
      });

      // Verify available updated wallet balance against awaiting amount
      if (!amountSufficient(Number(syncedWallet.availableBalance), Number(awaiting.amount))) {
        // Queue refund for insufficient payment
        await this.orderProcessingQueue.add('initiate-refund', {
          awaitingId: awaiting.id,
          senderAddress: sender,
          currencyType: awaiting.currency?.type,
          receivedAmount: received.toString(),
          expectedAmount: expectedAmount.toString(),
          transactionId: transaction.id
        });

        // Update awaiting status
        await tx.awaiting.update({
          where: { id: awaiting.id },
          data: { 
            metadata: {
              receivedAmount: received.toString(),
              expectedAmount: expectedAmount.toString()
            }
          }
        });

        return { 
          status: 'queued', 
          action: 'refund-insufficient-amount',
          details: {
            expected: expectedAmount.toString(),
            received: received.toString()
          }
        };
      }

      // Queue order processing
      await this.orderProcessingQueue.add('process-order', {
        awaitingId: awaiting.id,
        transactionId: transaction.id
      });

      // Cancel the scheduled expiry
      await anonService.cancelAwaitingExpiry(awaiting.id);

      return { 
        status: 'queued', 
        action: 'order-processing',
        awaitingId: awaiting.id,
        transactionId: transaction.id
      };
    }

    // 3. No awaiting order - just notify user
    await notificationService.queue({
      userId: wallet.userId,
      title: 'Transaction Notification',
      type: 'GENERAL',
      content: `<strong>${amount} ${wallet.currency.ISO}</strong> was sent to you and is available in your wallet. Thanks for choosing Vyre.`
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
    amount: number;
    txId: string;
  }) {
    const { tx, wallet, syncedWallet, amount, txId } = params;

    // 1. Create transaction record
    const transaction = await tx.transaction.create({
      data: {
        userId: wallet.userId,
        currency: wallet.currency.ISO,
        amount,
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
        content: `Transfer of <strong>${amount} ${wallet.currency.ISO}</strong> was successful. Thanks for choosing Vyre.`
      });
    }

    return { 
      status: 'success', 
      action: 'debit-completed',
      transactionId: transaction.id
    };
  }


  /**
   * Process queued order (called by worker)
  */
  public async processOrderJob(jobData: { awaitingId: string }) {
    const { awaitingId } = jobData;

    try {
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
          currency: true,
          wallet: true
        }
      });

      if (!awaiting) {
        throw new Error(`Awaiting record ${awaitingId} not found`);
      }

      // Update status to processing
      await prisma.awaiting.update({
        where: { id: awaitingId },
        data: { status: 'PROCESSING' }
      });

      await ablyService.awaiting_Order_Update(awaitingId);

      // Find required wallets
      const [userBaseWallet, userQuoteWallet] = await Promise.all([
        prisma.wallet.findFirst({
          where: {
            userId: awaiting.userId,
            currencyId: awaiting.order?.pair?.baseId
          }
        }),
        prisma.wallet.findFirst({
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
      const result = await orderService.processOrder({
        userId: awaiting?.userId as string,
        orderId: awaiting?.orderId as string,
        amount: Number(awaiting.amount),
        userBaseWallet,
        userQuoteWallet
      });


      // Queue order for post Action processing
      await this.orderProcessingQueue.add('process-post-action', {
        awaitingId
      });
      logger.info(`order processed and queued for post action: ${result?.id}`);

      return { status: 'queued', action: 'process-post-action' };

    } catch (error) {
      console.error(`Order processing failed for ${awaitingId}:`, error);

      // Use database transaction for atomicity
      const updated = await prisma.$transaction(async (tx) => {
        // Update status to SUCCESS
        const updated_Awaiting = await prisma.awaiting.update({
          where: { id: awaitingId },
          data: {
            status: 'FAILED'
          }
        });

        // Update postDetails status to SUCCESS
        const updated_PostDetails = await tx.postDetails.updateMany({
          where:{
            awaitingId,
          },
          data:{
            status: 'FAILED'
          }
        });

        return {
          awaiting: updated_Awaiting,
          postDetails: updated_PostDetails
        }
      
      }, {
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

      await ablyService.awaiting_Order_Update(awaitingId);
      
      throw error;
    }
  }

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
          amount: Number(awaiting.wallet?.availableBalance),
          address: senderAddress
        });
      } else {
        // FIAT refund logic would go here
      }

      // Use database transaction for atomicity
      const updated = await prisma.$transaction(async (tx) => {
        // Update status to REFUNDED
        const updated_Awaiting = await tx.awaiting.update({
          where: { id: awaitingId },
          data: {
            status: 'REFUNDED',
          }
        });

        // Update postDetails status to REFUNDED
        const updated_PostDetails = await tx.postDetails.updateMany({
          where:{
            awaitingId,
            userId: awaiting.userId
          },
          data:{
            status: 'REFUNDED'
          }
        });

        return {
          awaiting: updated_Awaiting,
          postDetails: updated_PostDetails
        }
      
      },{
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

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
      if (awaiting.status !== 'PROCESSING') {
        logger.warn(`Awaiting ${awaitingId} is not in PROCESSING state: ${awaiting.status}`);
        return { status: 'skipped', reason: 'invalid_status', currentStatus: awaiting.status };
      }

      // 3. Fetch user details
      const user = await prisma.user.findUnique({
        where: { id: awaiting.userId as string }
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

      if (!postDetails || postDetails?.status !== 'PENDING') {
        throw new Error(`Post details not found for awaiting ${awaitingId} or already processed`);
      }

      // 5. Fetch wallet with currency details
      const wallet = await prisma.wallet.findUnique({
        where:{id: postDetails?.walletId as string},
        include:{
          currency: {
            select:{
              ISO: true,
              isStablecoin:true
            }
          }
        }
      })

      if (!wallet) {
        throw new Error(`Wallet ${postDetails.walletId} not found`);
      }

      //   // 6. Validate wallet has sufficient balance
      // if (!wallet.availableBalance || wallet.availableBalance <= 0) {
      //   throw new Error(`Insufficient balance in wallet ${wallet.id}`);
      // }

      logger.info(`Processing post action for awaiting ${awaitingId}`, {
        orderType: awaiting.order?.type,
        amount: wallet.availableBalance.toString(),
        currency: wallet?.currency?.ISO as string
      });

      // 7. Execute transfer based on order type
      let transferResult;
      const transferAmount = Number(wallet.availableBalance);


      if(awaiting?.order?.type === 'BUY' ){

        if (!postDetails.accountNumber || !postDetails.bankCode || !postDetails.recipient_Name) {
          throw new Error('Missing bank details for fiat transfer');
        }

        logger.info(`Initiating bank transfer for awaiting ${awaitingId}`, {
          amount: transferAmount,
          currency: wallet?.currency?.ISO,
          recipient: postDetails.recipient_Name
        });

        transferResult = await walletService.direct_bank_Transfer({
          userId: awaiting.userId as string,
          currencyId: wallet?.currencyId as string,
          amount: transferAmount,
          email: user?.email as string, 
          phone: user?.phoneNumber as string,
      
          account_number: postDetails?.accountNumber as string,
          bank_code: postDetails?.bankCode as string, 
          recipient_name: postDetails?.recipient_Name as string
        })

      } else if (awaiting.order?.type === 'SELL') {

        if (!postDetails.address) {
          throw new Error('Missing crypto address for blockchain transfer');
        }

        logger.info(`Initiating blockchain transfer for awaiting ${awaitingId}`, {
          amount: transferAmount,
          currency: wallet?.currency?.ISO,
          address: postDetails.address
        });

        transferResult = await walletService.blockchain_Transfer({
          userId: wallet?.userId as string,
          currencyId: wallet?.currencyId as string,
          amount: transferAmount,
          address: postDetails?.address as string
        });

      } else {
        throw new Error(`Unknown order type: ${awaiting.order?.type}`);
      }

      // 8. Verify transfer was successful
      if (!transferResult) {
        throw new Error(`Transfer failed: ${transferResult || 'Unknown error'}`);
      }

      logger.info(`Transfer successful for awaiting ${awaitingId}`, {
        currency: wallet?.currencyId,
        amount: transferAmount,
      });

      // Use database transaction for atomicity
      const updated = await prisma.$transaction(async (tx) => {
        // Update status to SUCCESS
        const updated_Awaiting = await prisma.awaiting.update({
          where: { id: awaitingId },
          data: {
            status: 'SUCCESS',
            metadata: {
              transferCompleted: true,
              // transferId: transferResult.id,
              // transferReference: transferResult.reference,
              completedAt: new Date().toISOString()
            }
          }
        });

        // Update postDetails status to SUCCESS
        const updated_PostDetails = await tx.postDetails.updateMany({
          where:{
            awaitingId,
            userId: awaiting.userId
          },
          data:{
            status: 'SUCCESS'
          }
        });

        return {
          awaiting: updated_Awaiting,
          postDetails: updated_PostDetails
        }
      
      },{
        maxWait: 10000,   // 10 seconds to get connection
        timeout: 30000,   // 30 seconds for transaction (increased from 5s)
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, // Less restrictive
      });

      // 10. Trigger Ably update
      await ablyService.awaiting_Order_Update(awaitingId);



      // await notificationService.queue({
      //   userId: postDetails?.userId as string,
      //   title: 'Order Notification',
      //   type: 'GENERAL',
      //   content: `Transfer of <strong></strong> was successful. Thanks for choosing Vyre.`
      // });

    } catch (error) {
      console.error(`postAction failed for ${awaitingId}:`, error);
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

    let amountProcessed: number;

    amountProcessed = order?.type === "BUY"
      ? amount * order.price // User is sending base, calculate quote amount
      : amount / order.price; // User is sending quote, calculate base amount


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
            <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${order.price?.toLocaleString('en-US')} ${quoteCurrency}</p>
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
            <p style="margin: 5px 0;"><strong>Exchange Rate:</strong> ${order.price?.toLocaleString('en-US')} ${quoteCurrency}</p>
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


   
}

export default new eventService()