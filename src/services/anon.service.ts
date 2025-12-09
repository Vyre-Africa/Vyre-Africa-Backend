import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import { OrderType } from '@prisma/client';
import walletService from './wallet.service';
import orderService from './order.service';
import orderValidator from '../validators/order.validator';

  interface PreAction {
    orderId: string;
    currencyId: string;
    amount: string;
    userDetails:{
      firstName: string; 
      lastName: string; 
      phoneNumber: string;
      email: string;
    }
    bank:{
      accountNumber: string;
      bank_code: string;
      recipient: string;
    };
    crypto:{
      address: string,
    }

  }

class AnonService {

    
  async setUpUser (payload:{
    firstName:string,
    lastName:string,
    phoneNumber:string,
    email:string; 
    orderId:string
  }) {

    const {firstName,lastName,phoneNumber,email, orderId} = payload

    const order = await prisma.order.findUnique({
      where:{id: orderId}
    })

    const pair = await prisma.pair.findFirst({
      where:{id: order?.pairId},
      include:{
        quoteCurrency:{
          select:{
            id:true,
            ISO:true,
            tatumChain:true
          },
        },
        baseCurrency:{
          select:{
            id:true,
            ISO:true,
            tatumChain:true 
          },
        },
      }
     })

      try {

        let user:any;

        user = await prisma.user.findUnique({
          where: { email }
        });

          console.log('found user', user)
      
          if (!user) {
            user = await prisma.user.create({
              data: {
                  firstName,
                  lastName,
                  phoneNumber,
                  email,
                  // emailVerified: email_verified,
              }
            });
            console.log('newUser', user)
          }
      
        // const result = await prisma.$transaction(async (prisma) => {

        //   // create base wallet
        //   // const [baseWallet, quoteWallet] = await Promise.all([
        //   //   walletService.createWallet({
        //   //     userId: user.id,
        //   //     currencyId: pair?.baseCurrency?.id as string
        //   //   }),
        //   //   walletService.createWallet({
        //   //     userId: user.id,
        //   //     currencyId: pair?.quoteCurrency?.id as string
        //   //   })
        //   // ]);

        //   // // Now you have both wallets
        //   // console.log('Base wallet:', baseWallet);
        //   // console.log('Quote wallet:', quoteWallet);


        //   // if(!baseWallet || !quoteWallet){
        //   //   throw new Error('wallets creation not complete');
        //   // }

        //   // subscribe wallet address for event trigger
          

        //   // return {
        //   //   user,
        //   //   baseWallet,
        //   //   quoteWallet
        //   // };

        // });

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


        if(order?.type ==='BUY'){
            await walletService.subscribe_address({
              address: baseWallet?.depositAddress as string,
              chain: pair?.baseCurrency?.tatumChain as string
            })
          }

        // Now you have both wallets
          console.log('Base wallet:', baseWallet);
          console.log('Quote wallet:', quoteWallet);

          // if(!baseWallet || !quoteWallet){
          //   throw new Error('wallets creation not complete');
          // }
    
        // Return true if a crypto account was deleted
        return {
          user: user, 
          baseWallet: baseWallet,
          quoteWallet: quoteWallet
        }

      } catch (error) {
        console.error('Error setting up user:', error)
      }
  }

  async preActions(payload: PreAction) {
    const { orderId, currencyId, amount, userDetails, bank, crypto} = payload;
  
    try {

      const order = await prisma.order.findUnique({
        where: { id: orderId }
      });
  
      if (!order) {
        throw new Error('Order not found');
      }
  
      const currency = await prisma.currency.findUnique({
        where: { id: currencyId }
      });
  
      if (!currency) {
        throw new Error('Currency not found');
      }
  
      const userSetup = await this.setUpUser({
        firstName: userDetails.firstName,
        lastName: userDetails.lastName,
        phoneNumber: userDetails.phoneNumber,
        email: userDetails.email, 
        orderId
      });
      
      if (!userSetup) {
        throw new Error('Failed to set up user');
      }
  
      const { user, baseWallet, quoteWallet } = userSetup;
  
      let payments: any;
  
      // initiate fiat payment from provider if user is paying fiat
      if (order.type === 'SELL') {
        if (!quoteWallet) {
          throw new Error('Quote wallet not created');
        }
        
        payments = await walletService.depositFiat({
          currency: currency.ISO,
          amount: parseFloat(amount),
          email: user.email,
          userId: user.id, 
          walletId: quoteWallet.id
        });
      }

      const awaiting = await prisma.awaiting.create({
        data: {
          triggerAddress: order.type ==='BUY'? baseWallet?.depositAddress : quoteWallet?.depositAddress, //address to trigger transaction
          walletId: order.type ==='BUY'? baseWallet?.id : quoteWallet?.id, // Provide fallback or handle undefined
          userId: user.id,
          orderId,
          amount,
          orderType: order.type as OrderType,
          currencyId,

          // bank details
          reference: payments?.id,
          bank_Name: payments?.bank,
          bank_Account_Number: payments?.account_number,
          bank_Account_Name: payments?.account_name,
          bank_expires_At: payments?.expires_at

        }
      });

      const postDetails = await prisma.postDetails.create({
        data: {
          awaitingId: awaiting.id,
          walletId: order.type === 'BUY'? quoteWallet?.id : baseWallet?.id,
          userId: user.id,
          orderId,
          amount,
          currencyId,

          bankCode: bank.bank_code,
          accountNumber: bank.accountNumber,
          recipient_Name: bank.recipient,

          chain: currency?.chain,
          address: crypto.address
        }
      });
  
      
      return awaiting;
  
    } catch (error) {
      console.error('Error initiating actions:', error);
      throw error; // Consider throwing the error or returning a specific error object
    }
  }
      
    
}

export default new AnonService()