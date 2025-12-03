import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import walletService from '../services/wallet.service';
import config from '../config/env.config';
// import { OrderStatus } from '@prisma/client'
import { Wallet, Pair, OrderType } from '@prisma/client';
import {hasSufficientBalance,amountSufficient} from '../utils'
import notificationService from './notification.service';
import { Queue } from 'bullmq'; // Using BullMQ for job queue
// import connection from '../config/redis.config';
import connection from '../config/redis.config';

class OrderService {

  private generalQueue: Queue;  

  constructor() {
    // Initialize the processing queue
    this.generalQueue = new Queue('general-process', {
      connection
    });
  }



    async createOrder(payload:{
        userId: string,
        rate: number, 
        amount: number, 
        orderType: OrderType, 
        pairId: string, 
        minimumAmount:number,
        baseWallet: Wallet,
        quoteWallet: Wallet
    }) {

        let blockId: any;
        let order: any;

       const {userId, rate, amount, orderType, pairId, minimumAmount, baseWallet, quoteWallet } = payload

      //  const amount =  orderType === 'SELL'? requestAmount : requestAmount * rate;

       console.log('create order payload received')

       const pair = await prisma.pair.findUnique({
          where:{id: pairId},
          include:{
            quoteCurrency:{
              select:{
                id:true,
                ISO:true  
              },
            },
            baseCurrency:{
              select:{
                id:true,
                ISO:true  
              },
            },
            quoteWallet:true,
            baseWallet:true,
          }
       })


        if(orderType === 'SELL' && !hasSufficientBalance(baseWallet.availableBalance,amount)){
           throw new Error('Available balance for base not sufficient');
        }
        if(orderType === 'BUY' && !hasSufficientBalance(quoteWallet.availableBalance,amount)){
           throw new Error('Available balance for quote not sufficient');
        }
  
        console.log('checked amount sufficiency')
        console.log('entering prisma transaction')

        const fee = amount * 0.012;
        const adjustedAmount = amount - fee;
        console.log(adjustedAmount,'adjustedAmount')
        console.log(fee,'fee')

        const result = await prisma.$transaction(
            async (prisma) => {

              console.log('inside transaction')
              // deduct fee amount

              if(config.Admin_Id !== userId){
                const transfer = await walletService.offchain_Transfer({
                  userId,
                  receipientId: config.Admin_Id,
                  currencyId: orderType === 'SELL'? pair?.baseCurrency?.id as string : pair?.quoteCurrency?.id as string,
                  amount: fee
                })

                console.log('---------------- FEE DEDUCTED -----------------')
              }
              

              console.log('done with offchain transfer')
              // block adjustedAmount
              blockId = await walletService.block_Amount(adjustedAmount, orderType === 'SELL'? baseWallet.id: quoteWallet.id)
              console.log('---------------- AMOUNT LOCKED -----------------')
              console.log('done with offchain transfer',blockId)

              order = await prisma.order.create({
                data:{
                    userId,
                    blockId,
                    amountMinimum: minimumAmount,
                    amount,
                    type: orderType,
                    pairId,
                    price: rate
                }
              })
      
              return {
                order
              }
            },
            {
              maxWait: 50000, // default: 2000
              timeout: 50000, // default: 5000
            }

        )

        await notificationService.queue({
          userId, 
          title:'Order is Live!',
          type:'GENERAL',
          content:`Your <strong>${orderType}</strong> order for <strong>${amount} ${pair?.baseCurrency?.ISO}</strong> on the <strong>${pair?.baseCurrency?.ISO}/${pair?.quoteCurrency?.ISO}</strong> pair has been placed successfully and is now active on the market,.`
        })
        console.log('---------------- NOTIFICATION QUEUED -----------------')

        return result.order

    }

    async processOrder(payload:{
        userId: string,
        orderId: string,
        amount: number, 
        userBaseWallet: Wallet,
        userQuoteWallet: Wallet
    }) {        

       const { userId, orderId, amount, userBaseWallet, userQuoteWallet } = payload

        const order = await prisma.order.findUnique({
            where:{id: orderId}
        })

        if (order?.status !== "OPEN") {
            throw new Error('Order is not open');
        }

        const pair = await prisma.pair.findFirst({
            where:{id: order?.pairId},
            include:{
              quoteCurrency:{
                select:{
                  id:true,
                  ISO:true  
                },
              },
              baseCurrency:{
                select:{
                  id:true,
                  ISO:true  
                },
              },
              quoteWallet:true,
              baseWallet:true,
            }
        })


        const orderBaseWallet = await prisma.wallet.findFirst({
            where:{
            currencyId: pair?.baseCurrency?.id,
            userId: order?.userId as string
            }
        })
    
        const orderQuoteWallet = await prisma.wallet.findFirst({
            where:{
            currencyId: pair?.quoteCurrency?.id,
            userId: order?.userId as string
            }
        })
    
        if (!orderBaseWallet || !orderQuoteWallet) {
            throw new Error('Order wallet not found');
        }

        // Validate user balances
        if (order?.type === "BUY" && !hasSufficientBalance(userBaseWallet.availableBalance,amount)) {
            throw new Error('Insufficient base currency balance');
        }
    
        if (order?.type === "SELL" && !hasSufficientBalance(userQuoteWallet.availableBalance,amount)) {
            throw new Error('Insufficient quote currency balance');
        }

        const maxAmount = order?.type === "BUY"
        ? (order?.amount - order?.amountProcessed) / order?.price // User is sending base, calculate quote amount
        : (order?.amount! - order?.amountProcessed!) * order?.price!

        if (maxAmount < amount) {
          throw new Error('Max amount exceeded');
        }


        const result = await prisma.$transaction(
            async (prisma) => {
    
              let amountToProcess: number;
    
              amountToProcess = order?.type === "BUY"
              ? amount * order.price // User is sending base, calculate quote amount
              : amount / order.price; // User is sending quote, calculate base amount
    
              const amountLeft = order?.amount - (order?.amountProcessed + amount)
    
              let orderTransfer;
              let newBlockId;
              let userTransfer;
    
              if (order?.type === "BUY"){
                // User sends base currency, order sends quote currency
    
                // order sends quote currency
                orderTransfer = await walletService.unblock_Transfer(amountToProcess, order?.blockId as string, userQuoteWallet.id)
                console.log('orderTransfer success from unblocked amount',orderTransfer)

                // newBlockId = await walletService.block_Amount(amountLeft, orderQuoteWallet.id)

                // user sends base currency
                userTransfer = await walletService.offchain_Transfer({userId: userId,receipientId: order?.userId as string, currencyId: pair?.baseCurrency?.id!, amount})
    
              } else {
                // User sends quote currency, order sends base currency
    
                // order sends base currency
                orderTransfer = await walletService.unblock_Transfer(amountToProcess, order?.blockId as string, userBaseWallet.id)
                console.log('orderTransfer success from unblocked amount',orderTransfer)
                // newBlockId = await walletService.block_Amount(amountLeft, orderBaseWallet.id)

                // user sends quote currency
                userTransfer = await walletService.offchain_Transfer({userId: userId,receipientId: order?.userId as string, currencyId: pair?.quoteCurrency?.id!, amount})
    
              }
    
              const updatedOrder = await prisma.order.update({
                where:{id: order.id },
                data:{
                  // blockId: newBlockId,
                  amountProcessed: order?.amountProcessed + amountToProcess,
                  percentageProcessed: ((order?.amountProcessed + amountToProcess) / order?.amount) * 100,
                  status: (order.amountProcessed + amountToProcess) >= order?.amount ? 'CLOSED' :'OPEN'
                }
              })
    
              
              return {
                order: updatedOrder
              }
            },
            {
              maxWait: 50000, // default: 2000
              timeout: 50000, // default: 5000
            }
    
        )

        return result.order

    }

    async cancelOrder(payload:{orderId:string}){

      const {orderId} = payload

      try {
        
        const order = await prisma.order.findUnique({
            where: {id: orderId},
            include: {
                pair: {
                    include: {
                        baseCurrency: {select: {ISO: true}},
                        quoteCurrency: {select: {ISO: true}}
                    }
                }
            }
        })

        if(!order){
          throw new Error('Order not found');
        }

        await walletService.unblock_Amount(order.blockId as string)

        const canceledOrder = await prisma.order.update({
          where:{id: order?.id},
          data:{status:'CANCELED'}
        })

        // Determine which currency to show based on order type
        const currencyISO = order.type === 'SELL'
          ? (order?.pair?.baseCurrency?.ISO ?? order?.pair?.quoteCurrency?.ISO ?? '')
          : (order?.pair?.quoteCurrency?.ISO ?? order?.pair?.baseCurrency?.ISO ?? '')

        await notificationService.queue({
            userId: order?.userId as string, // Make sure to get userId from the order
            title: 'Order Cancelled',
            type: 'GENERAL',
            content: `Your <strong>${order?.type}</strong> order for <strong>${order?.amount} ${currencyISO||'currency'}</strong> has been cancelled successfully. The funds have been unblocked and are available in your wallet.`
        })

        return canceledOrder

      } catch (error) {
        console.log(error)
      }
      

    }

    async queue(payload:{
        userId: string,
        rate: number, 
        amount: number, 
        orderType: OrderType, 
        pairId: string, 
        minimumAmount:number,
        baseWallet: Wallet,
        quoteWallet: Wallet
    }){
      console.log('queuing create order job')
      return await this.generalQueue.add('create-order', payload);
    }



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