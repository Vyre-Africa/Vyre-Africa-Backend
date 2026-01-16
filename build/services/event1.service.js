"use strict";
// import { Request, Response } from 'express';
// import prisma from '../config/prisma.config';
// import { OrderType, AwaitingStatus, Awaiting, Wallet, Currency } from '@prisma/client';
// import walletService from './wallet.service';
// import orderService from './order.service';
// import ablyService from './ably.service';
// import { hasSufficientBalance, amountSufficient } from '../utils';
// import { Queue } from 'bullmq'; // Using BullMQ for job queue
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
// class eventService {
//   private currentAwaiting: Awaiting | null = null; // Private state to store the awaiting record
//   private wallet: Wallet | null = null;
//   private currency: Currency | null = null // Private state to store the currency 
//   private senderAddress: string | null = null // Private state to store the currency 
//   private async initiateRefund(): Promise<void> {
//     try {
//       if (!this.currentAwaiting) {
//         throw new Error('No awaiting record available for refund');
//       }
//       const { id: awaitingId, currencyId, amount, userId  } = this.currentAwaiting;
//       if(this.currency?.type === "CRYPTO"){
//         // 1. Create blockchain refund transaction
//         await walletService.blockchain_Transfer({
//           userId: userId as string, 
//           currencyId: currencyId as string,
//           amount:(this.wallet?.availableBalance as unknown) as number,
//           address: this.senderAddress as string
//           // destination_Tag?: number
//         });
//       }else{
//         // create fiat refund transaction
//         // as fiat transfer would already been confirmed 
//         // this function block might not matter as payment provider handles this automatically
//       }
//       // 2. Update awaiting status
//       await prisma.awaiting.update({
//         where: { id: this.currentAwaiting.id },
//         data: { status: 'REFUNDED' as const }
//       });
//       await ablyService.awaiting_Order_Update(this.currentAwaiting.id)
//       // 3. Clear state after successful processing
//       this.currentAwaiting = null;
//     } catch (error) {
//       this.currentAwaiting = null; // Clear state on error too
//       console.error('Refund failed:', error);
//       throw error;
//     }
//   }
//   private async handle_Awaiting_Order() {
//     try {
//       const order = await prisma.order.findUnique({
//         where: {
//           id: this.currentAwaiting?.orderId // Remove optional chaining since we've already checked 'awaiting'
//         },
//         include: {
//           pair: {
//             include: {
//               quoteCurrency: {
//                 select: {
//                   id: true,
//                   ISO: true
//                 }
//               },
//               baseCurrency: {
//                 select: {
//                   id: true,
//                   ISO: true
//                 }
//               }
//             }
//           },
//         }
//       });
//       if (!order) {
//         throw new Error('Order not found');
//       }
//       const userBaseWallet = await prisma.wallet.findFirst({
//         where: {
//           userId: this.currentAwaiting?.userId,
//           currencyId: order?.pair?.baseCurrency?.id!
//         }
//       });
//       console.log('baseWalletExists', userBaseWallet)
//       const userQuoteWallet = await prisma.wallet.findFirst({
//         where: {
//           userId: this.currentAwaiting?.userId,
//           currencyId: order?.pair?.baseCurrency?.id!
//         }
//       });
//       console.log('quoteWalletExists', userQuoteWallet)
//       await prisma.awaiting.update({
//         where: { id: this.currentAwaiting?.id },
//         data: { status: 'PROCESSING' as const }
//       });
//       // update user with realtime data
//       await ablyService.awaiting_Order_Update(this.currentAwaiting?.id as string)
//       console.log("=============== Process about to start ==============")
//       const result = await orderService.processOrder({
//         userId: this.currentAwaiting?.userId as string,
//         orderId: order?.id,
//         amount: (this.currentAwaiting?.amount as unknown) as number, 
//         userBaseWallet,
//         userQuoteWallet
//       })
//       return result;
//     } catch (error) {
//       console.error('Error processing order:', error);
//       throw error; // Consider throwing the error or returning a specific error object
//     }
//   }
//   async handleTatumEvent (payload:{
//       address: string; 
//       type: string, 
//       amount: number,
//       sender: string
//     }){
//       const { address, type, amount, sender } = payload
//       console.log('at handleTatumEvent',payload)
//       try {
//         const awaiting = await prisma.awaiting.findFirst({
//           where:{
//             triggerAddress: address,
//             status: 'PENDING' as AwaitingStatus
//           },
//           include:{
//             currency: true
//           }
//         })
//         if(awaiting){
//           this.currentAwaiting = awaiting;
//           this.currency = awaiting?.currency;
//           this.senderAddress = sender;
//           this.wallet = await prisma.wallet.findUnique({
//             where:{id: awaiting.walletId}
//           })
//           console.log("wallet:::", this.wallet)
//           if(!amountSufficient((this.wallet?.availableBalance as unknown) as number, (this.currentAwaiting?.amount as unknown) as number)){
//             //  initiate refunds
//             await this.initiateRefund()
//             return
//           }
//           // send realtime notification
//           // initiate awaiting order
//           const result = this.handle_Awaiting_Order()
//           return result 
//         }
//       } catch (error) {
//         console.error('Error setting up user:', error)
//       }
//   }
//   // async preActions(payload: PreAction) {
//   //   const { orderId, currencyId, amount, email, bank, crypto } = payload;
//   //   try {
//   //     const order = await prisma.order.findUnique({
//   //       where: { id: orderId }
//   //     });
//   //     if (!order) {
//   //       throw new Error('Order not found');
//   //     }
//   //     const currency = await prisma.currency.findUnique({
//   //       where: { id: currencyId }
//   //     });
//   //     if (!currency) {
//   //       throw new Error('Currency not found');
//   //     }
//   //     const userSetup = await this.setUpUser({ email, orderId });
//   //     if (!userSetup) {
//   //       throw new Error('Failed to set up user');
//   //     }
//   //     const { user, baseWallet, quoteWallet } = userSetup;
//   //     let payments: any;
//   //     // initiate fiat payment url from provider if user is paying fiat
//   //     if (order.type === 'SELL') {
//   //       if (!quoteWallet) {
//   //         throw new Error('Quote wallet not created');
//   //       }
//   //       payments = await walletService.depositFiat({
//   //         currency: currency.ISO,
//   //         amount: parseFloat(amount),
//   //         email: email,
//   //         userId: user.id, 
//   //         walletId: quoteWallet.id
//   //       });
//   //     }
//   //     const awaiting = await prisma.awaiting.create({
//   //       data: {
//   //         triggerAddress: order.type ==='BUY'? baseWallet?.depositAddress : quoteWallet?.depositAddress, //address to trigger transaction
//   //         walletId: order.type ==='BUY'? baseWallet?.id : quoteWallet?.id, // Provide fallback or handle undefined
//   //         userId: user.id,
//   //         orderId,
//   //         amount,
//   //         orderType: order.type as OrderType, // Cast to ensure type safety
//   //         currencyId,
//   //         paymentUrl: payments?.url || ''
//   //       }
//   //     });
//   //     const postDetails = await prisma.postDetails.create({
//   //       data: {
//   //         awaitingId: awaiting.id,
//   //         walletId: order.type === 'BUY'? quoteWallet?.id : baseWallet?.id,
//   //         userId: user.id,
//   //         orderId,
//   //         amount,
//   //         currencyId,
//   //         bankCode: bank.bank_code,
//   //         accountNumber: bank.accountNumber,
//   //         recipient_Name: bank.recipient,
//   //         chain: currency?.chain,
//   //         // address: currency?.address
//   //       }
//   //     });
//   //     return awaiting;
//   //   } catch (error) {
//   //     console.error('Error initiating actions:', error);
//   //     throw error; // Consider throwing the error or returning a specific error object
//   //   }
//   // }
// }
// export default new eventService()
