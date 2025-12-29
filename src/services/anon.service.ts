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
    };
    paymentMethod?: string
  }

class AnonService {

  private awaitingQueue: Queue;  
  
  constructor() {
    // Initialize the processing queue
    this.awaitingQueue = new Queue('general-process', {
      connection
    });
  }

    
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


        // if(order?.type ==='BUY'){
        //     await walletService.subscribe_address({
        //       address: baseWallet?.depositAddress as string,
        //       chain: pair?.baseCurrency?.tatumChain as string
        //     })
        //   }

        // Now you have both wallets
          console.log('Base wallet:', baseWallet);
          console.log('Quote wallet:', quoteWallet);

          if(!baseWallet || !quoteWallet){
            throw new Error('wallets creation not complete');
          }
    
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
    const { orderId, currencyId, amount, userDetails, bank, crypto, paymentMethod} = payload;
  
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

        payments = await walletService.getPaymentMethod({
          currency: currency.ISO,
          amount: parseFloat(amount),
          email: user.email,
          userId: user.id, 
          walletId: quoteWallet.id
        })

      }

      // Calculate expiry time (1 hour from now) using moment
      const expiryDuration = moment().add(1, 'hour').toDate();

      const awaiting = await prisma.awaiting.create({
        data: {
          triggerAddress: order.type ==='BUY'? baseWallet?.depositAddress : quoteWallet?.depositAddress, //address to trigger transaction
          walletId: order.type ==='BUY'? baseWallet?.id : quoteWallet?.id, // Provide fallback or handle undefined
          userId: user.id,
          orderId,
          amount,
          orderType: order.type as OrderType,
          currencyId,

          method: paymentMethod,
          duration: expiryDuration,

          // bank details
          reference: payments?.id,
          bank_Name: payments?.bank,
          bank_Account_Number: payments?.account_number,
          bank_Account_Name: payments?.account_name,
          bank_expires_At: new Date(payments?.expires_at.replace(' ', 'T')).toISOString(),

          paymentDetails: payments

        }// Remember to add momo payment details to this awaiting object also
      });

      // Schedule expiry job to run in 1 hour
      await this.awaitingQueue.add(
        'expire-awaiting',
        { awaitingId: awaiting.id },
        {
          delay: 60 * 60 * 1000, // 1 hour in milliseconds
          jobId: `awaiting-expiry-${awaiting.id}`, // Unique job ID to prevent duplicates
        }
      );

      console.log(`Scheduled expiry for awaiting ${awaiting.id} at ${expiryDuration.toISOString()}`);

      const postDetails = await prisma.postDetails.create({
        data: {
          awaitingId: awaiting.id,
          walletId: order.type === 'BUY'? quoteWallet?.id : baseWallet?.id,
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
  
      
      return awaiting;
  
    } catch (error) {
      console.error('Error initiating actions:', error);
      throw error; // Consider throwing the error or returning a specific error object
    }
  }


  /**
   * Cancel pending queued awaiting job
  */
  async cancelAwaitingExpiry(awaitingId: string) {

    try {
      const jobId = `awaiting-expiry-${awaitingId}`;
      const job = await this.awaitingQueue.getJob(jobId);

      if (job) {
        await job.remove();
        console.log(`Cancelled expiry job for awaiting ${awaitingId}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`Error cancelling expiry for awaiting ${awaitingId}:`, error);
      throw error;
    }
  }

  /**
   * Process expired awaiting order (called by worker)
  */
  async cancelAwaitingJob(jobData: { 
      awaitingId: string;
    }) {
      const { awaitingId } = jobData;
  
      try {

      console.log(`Processing expiry for awaiting: ${awaitingId}`);

      // Get the awaiting record
      const awaiting = await prisma.awaiting.findUnique({
        where: { id: awaitingId },
        include: {
          order: true,
          user: true,
          currency: true
        }
      });

      if (!awaiting) {
        console.log(`Awaiting ${awaitingId} not found`);
        return { status: 'not_found' };
      }

      // Only expire if still pending
      if (awaiting.status !== 'PENDING') {
        console.log(`Awaiting ${awaitingId} is already ${awaiting.status}`);
        return { status: 'already_processed', currentStatus: awaiting.status };
      }

      // Update status to EXPIRED
      const updated = await prisma.awaiting.update({
        where: { id: awaitingId },
        data: {
          status: 'EXPIRED'
        }
      });

      console.log(`Awaiting ${awaitingId} marked as EXPIRED`);

      // Send notification to user
      if (awaiting.userId) {
        await notificationService.queue({
          userId: awaiting.userId,
          title: 'Payment Expired',
          type: 'GENERAL',
          content: `Your awaiting payment request has expired. Please create a new order if you still wish to proceed.`
        });
      }

      return {
        status: 'expired',
        awaitingId,
        expiredAt: new Date().toISOString()
      };

    } catch (error) {
      console.error(`Error expiring awaiting ${awaitingId}:`, error);
      throw error;
    }
  }
      
    
}

export default new AnonService()