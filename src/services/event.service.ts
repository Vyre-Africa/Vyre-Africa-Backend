import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import { OrderType, AwaitingStatus, Awaiting, Wallet, Currency } from '@prisma/client';
import walletService from './wallet.service';
import orderService from './order.service';
import ablyService from './ably.service';
import { hasSufficientBalance, amountSufficient } from '../utils';
import { Queue } from 'bullmq'; // Using BullMQ for job queue
import config from '../config/env.config';
import logger from '../config/logger'
import notificationService from './notification.service';


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
    this.orderProcessingQueue = new Queue('order-processing', {
      connection: {
        host: config.redisHost,
        port: parseInt(config.redisPort),
        username: "default",
        password: config.redisPassWord
      }
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

  /**
   * Handles incoming webhook events from payment provider
   * Responds immediately and queues processing work
   */
  public async handleCryptoEvent(payload: {
    address: string;
    type: string;
    amount: number;
    sender: string;
  }) {
    const { address, amount, sender } = payload;

    try {

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

      if (!awaiting) {
        console.warn(`No pending order found for address: ${address}`);
        return { status: 'ignored', message: 'No matching pending order' };
      }

      await prisma.transaction.create({
        data:{
            userId: awaiting?.userId,
            currency: awaiting?.currency?.ISO!,
            amount,
            status: 'SUCCESSFUL',
            walletId: awaiting?.walletId!,
            type:'CREDIT_PAYMENT',
            description:`ACCOUNT_TRANSACTION`
          }
      })


      // Verify payment amount
      if (!amountSufficient(Number(amount), Number(awaiting.amount))) {
        await this.orderProcessingQueue.add('initiate-refund', {
          awaitingId: awaiting.id,
          senderAddress: sender,
          currencyType: awaiting?.currency?.type
        });
        return { status: 'queued', action: 'refund' };
      }

      // Queue order processing
      await this.orderProcessingQueue.add('process-order', {
        awaitingId: awaiting.id
      });

      return { status: 'queued', action: 'order-processing' };

    } catch (error) {
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  public async handleFiatEvent(payload: {
    reference: string
  }) {
    const { reference } = payload;

    try {

      // 1. Find and validate transaction
      const transaction = await prisma.transaction.findFirst({
        where: { reference },
        include: { wallet: {
          include:{currency:true}
        } }
      });

      if (!transaction) {
        logger.warn(`Transaction not found for reference: ${reference}`);
        return { status: 'rejected', reason: 'transaction_not_found' };
      }

      if(transaction?.status !=='PENDING'){
        return { status: 'Already processed', reason: 'transaction_already_processed' };
      }

      // 2. Process wallet credit
      await walletService.credit_Wallet(
        Number(transaction.amount), // Explicit conversion
        transaction.walletId as string
      );

      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: 'SUCCESSFUL' }
      });

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

      // if (!awaiting) {
      //   logger.warn(`No pending order found for reference: ${reference}`);
      //   return { status: 'ignored', reason: 'no_pending_order' };
      // }

      if(awaiting){
        // Queue order processing
        await this.orderProcessingQueue.add('process-order', {
          awaitingId: awaiting.id
        });
        
      }else{
        await notificationService.queue({
          userId: transaction.userId as string, // Make sure to get userId from the order
          title: 'Deposit Successful',
          type: 'GENERAL',
          content: `Your deposit of <strong>${transaction.amount} ${transaction?.wallet?.currency?.ISO}</strong> has been processed successfully. The funds are now available in your wallet.`
        })

      }

      


      logger.info(`Fiat payment processed and queued for reference: ${reference}`);
      return { status: 'queued', action: 'order-processing' };

    } catch (error) {
      logger.error(`Error handling webhook for : ${reference}:`, error);
      console.error('Error handling webhook:', error);
      throw error;
    }
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
      
      // Update status to failed if needed
      await prisma.awaiting.update({
        where: { id: awaitingId },
        data: { status: 'FAILED' }
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

      await prisma.awaiting.update({
        where: { id: awaitingId },
        data: { status: 'REFUNDED' }
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
          }
        }
      });


      if (!awaiting) {
        throw new Error(`Awaiting record ${awaitingId} not found`);
      }

      const user = await prisma.user.findUnique({
        where:{id: awaiting.userId as string}
      })

      const postDetails = await prisma.postDetails.findFirst({
        where:{awaitingId, userId:awaiting.userId }
      })

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
        throw new Error('Required wallet not found');
      }

      if(awaiting?.order?.type === 'BUY' ){

        await walletService.direct_bank_Transfer({
          currency: wallet?.currency?.ISO as string,
          amount: Number(wallet?.availableBalance),
          email: user?.email as string, 
          phone: user?.phoneNumber as string,
      
          account_number: postDetails?.accountNumber as string,
          bank_code: postDetails?.bankCode as string, 
          recipient_name: postDetails?.recipient_Name as string
        })

      }else{

        await walletService.blockchain_Transfer({
          userId: wallet?.userId as string,
          currencyId: wallet?.currencyId as string,
          amount: Number(wallet?.availableBalance),
          address: postDetails?.address as string
        });

      }

    } catch (error) {
      console.error(`postAction failed for ${awaitingId}:`, error);
      throw error;
    }
  }


   
}

export default new eventService()