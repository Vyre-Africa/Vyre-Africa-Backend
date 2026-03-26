import { PrismaClient } from '@prisma/client';
import { Paystack } from 'paystack-sdk';
import { Request, Response } from 'express';
import { KJUR } from 'jsrsasign';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import walletService from '../services/wallet.service';
import * as crypto from 'crypto';
import {createHmac} from 'node:crypto';
import { generateRefCode, generateSignature, isValidSignature } from '../utils';
import fernService from '../services/fern.service';
import eventService from '../services/event.service';
import { verifyWebhook } from '@clerk/express/webhooks'
import clerkService from '../services/clerk.service';
import logger from '../config/logger';



class EventController {

  async clerk_WebHook(req: Request | any, res: Response) {
      try {
          const evt = await verifyWebhook(req, { signingSecret: config.clerk.SIGNING_SECRET as string });

          const { id } = evt.data;
          const eventType = evt.type;

          console.log(`Received webhook with ID ${id} and event type of ${eventType}`);

          // ✅ RESPOND IMMEDIATELY to Clerk
          res.status(200).json({
              msg: 'Webhook received',
              success: true,
              eventId: id,
              eventType: eventType
          });

          // ✅ Process webhook asynchronously (don't await)
          clerkService.processEvent(evt).catch(error => {
              logger.error('Webhook processing failed', {
                  eventId: id,
                  eventType,
                  error: error.message,
                  stack: error.stack
              });
          });

      } catch (error) {
          console.error('Error verifying webhook:', error);
          return res.status(400).json({ 
              error: 'Webhook verification failed', 
              message: (error as Error).message 
          });
      }
  }

  async fern_WebHook(req: Request | any, res: Response) {

    const signature = req.header("x-api-signature");
    const timestamp = req.header("x-api-timestamp");
    const rawBody = req.body.toString();//

    const body = JSON.parse(rawBody); // Explicit parsing

    console.log('Webhook received:', {
      type: body.type,
      transactionId: body.resource?.transactionId,
      signature,
      timestamp
    });

    if (!signature || !timestamp || !isValidSignature(rawBody, timestamp, signature, config.fern.Secret)) {
      console.error("Invalid webhook signature – request possibly forged!");
      return res.sendStatus(400); // reject if signature doesn't match
    }

    try {
      // const { body } = req;
      

      // Customer Events

      // if(body.type === 'customer.created'){
      //   // const customer = body.resource

      //   // const updated = await fernService.customer_Created({
      //   //   customerId: customer.customerId, 
      //   //   status: customer.customerStatus, 
      //   //   kycLink: customer.kycLink, 
      //   //   email: customer.email

      //   // })

      //   // if(updated){
      //     return res.status(200).json({
      //       msg: 'Event Successful',
      //       success: true,
      //     });
      //   // }

      // }

      // if(body.type === 'customer.updated'){
      //   const customer = body.resource

      //   const updated = await fernService.customer_updated(
      //     customer.customerStatus,
      //     customer.email
      //   )

      //   if(updated){
      //     return res.status(200).json({
      //       msg: 'Event Successful',
      //       success: true,
      //     });
      //   }

       
      // }


      // if(body.type === 'payment_account.created'){

      // }

      // if(body.type === 'payment_account.deleted'){

      // }

      // if(body.type === 'transaction.created'){

      // }

      // if(body.type === 'transaction.updated'){
      //   const transaction = body.resource

      //   const updated = await fernService.transaction_updated(
      //     transaction.transactionStatus,
      //     transaction.transactionId
      //   )

      //   if(updated){
      //     return res.status(200).json({
      //       msg: 'Event Successful',
      //       success: true
      //     });
      //   }

      // }

      // if(body.type === 'transaction.updated'){

      // }


      // FOR FIAT WITHDRAWAL 

      // if(body.type === 'payout'){

      //   if(body.event_type === 'payout.created'){

      //     const user = await prisma.user.findFirst({
      //       where:{email:body.client.email}
      //     })
  
      //     const wallet = await prisma.wallet.findFirst({
      //       where:{
      //         currency: body.payment.currency,
      //         userId: user?.id
      //       }
      //     })
      //     // record transaction
      //     const transaction = await prisma.transaction.create({
      //       data:{
      //         userId: user?.id,
      //         currency: wallet?.currency!,
      //         amount: body?.payment.amount/100,
      //         reference: body.id,
      //         status: 'PENDING',
      //         walletId: wallet?.id,
      //         type:'FIAT_WITHDRAWAL',
      //         description:`${wallet?.currency} withdrawal transfer`
      //       }
      //     })


      //   }else if(body.event_type === 'payout.success'){

      //     const transaction = await prisma.transaction.findFirst({
      //       where:{reference: body.id}
      //     })
      //     // debit user wallet
      //     await walletService.debit_Wallet(transaction?.amount as any, transaction?.walletId!)

      //     await prisma.transaction.update({
      //       where:{id:transaction?.id},
      //       data:{status: 'SUCCESSFUL',}
      //     })

      //   }else{

      //     const transaction = await prisma.transaction.findFirst({
      //       where:{reference: body.id}
      //     })
          
      //     await prisma.transaction.update({
      //       where:{id:transaction?.id},
      //       data:{status: 'FAILED',}
      //     })

      //   }

      // }

      switch (body.type) {
        // case 'customer.created':
        //     // const customer = body.resource

        //     // const updated = await fernService.customer_Created({
        //     //   customerId: customer.customerId, 
        //     //   status: customer.customerStatus, 
        //     //   kycLink: customer.kycLink, 
        //     //   email: customer.email

        //     // })

        //     // if(updated){
        //       return res.status(200).json({
        //         msg: 'Event Successful',
        //         success: true,
        //       });

        //  break;

        case 'customer.updated':
          const customer = body.resource

          console.log('case customer updated,', customer)

          const updated = await fernService.customer_updated(
            customer.customerStatus,
            customer.email
          )
  
          if(updated){
            return res.status(200).json({
              msg: 'Event Successful',
              success: true,
            });
          }
  
          break;
          
        case 'transaction.updated':
          const transaction = body.resource

          console.log('case transaction update start', transaction)

          const transactionUpdated = await fernService.transaction_updated(
            transaction.transactionStatus,
            transaction.transactionId
          )

          if(!transactionUpdated){
            return res.status(400).json({
              msg: 'operation failed',
              success: true
            });
          }
          break;
        default:
          console.log(`Unhandled event type ${body.type}.`);
      }

      return res.status(200).json({
        msg: 'Event verified',
        success: true,
      });
  
    } catch (error) {
      console.error('Error verifying webhook:', error);
      return res.status(500).json({ 
        error: 'Internal Server Error', 
        message: (error as Error).message 
      });
    }
  }

  async qorepay_WebHook(req: Request | any, res: Response) {

    function verifyWebhook(rawBody:any, signature:any, secret:any) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      );
    }

    try {
      const { body } = req;

      console.log('qorepay request body',body)

      const signature = req.headers['x-qorepay-signature'];

      const rawBody = JSON.stringify(req.body)
      console.log('rawBody', rawBody)

      // if (!verifyWebhook(req.body, signature, process.env.WEBHOOK_SECRET)) {
      //   return res.status(401).json({ error: 'Invalid signature' });
      // }

      console.log("isValid", !verifyWebhook(req.body, signature, config.QOREPAY_WEBHOOK_SECRET))
      console.log('qorepay event type', body.event)

      const { event, data } = JSON.parse(req.body);

      // if (!isValid) {
      //   return res.status(401).json({ error: 'Invalid signature' });
      // }
      

      // FOR FIAT DEPOSITS 

      // if(body.type === 'purchase'){

      //   if(body.event_type === 'purchase.paid'){

      //     const result = await eventService.handleFiatEvent({reference: body.id })
      //   } 
        
      //   if(body.event_type === 'purchase.payment_failure'){

      //     const transaction = await prisma.transaction.findFirst({
      //       where:{reference: body.id}
      //     })
    
      //     console.log('transaction here', transaction)

      //     if(transaction){
      //       await prisma.transaction.update({
      //         where:{id:transaction?.id!},
      //         data:{status:'FAILED'}
      //       })
      //     }

          

      //   }

      // }


      // FOR FIAT WITHDRAWAL 

      // if(body.type === 'payout'){

      //   if(body.event_type === 'payout.created'){

      //     const user = await prisma.user.findFirst({
      //       where:{email:body.client.email}
      //     })

      //     const wallet = await prisma.wallet.findFirst({
      //       where: {
      //         userId: user?.id,
      //         currency: {  // Use the relation field name (currency) not the model name (Currency)
      //           ISO: body.payment.currency  // This assumes 'type' is a variable containing the currency type you're filtering by
      //         }
      //       },
      //       include: {
      //         currency:{
      //           select:{
      //             id:true,
      //             ISO:true
      //           }
      //         }  // Optionally include the full currency data in the response
      //       }
      //     });
      //     // record transaction
      //     const transaction = await prisma.transaction.create({
      //       data:{
      //         userId: user?.id,
      //         currency: wallet?.currency?.ISO!,
      //         amount: body?.payment.amount/100,
      //         reference: body.id,
      //         status: 'PENDING',
      //         walletId: wallet?.id,
      //         type:'FIAT_WITHDRAWAL',
      //         description:`${wallet?.currency?.ISO} withdrawal transfer`
      //       }
      //     })


      //   }else if(body.event_type === 'payout.success'){

      //     const transaction = await prisma.transaction.findFirst({
      //       where:{reference: body.id}
      //     })
      //     // debit user wallet
      //     await walletService.debit_Wallet(transaction?.amount as any, transaction?.walletId!)

      //     await prisma.transaction.update({
      //       where:{id:transaction?.id},
      //       data:{status: 'SUCCESSFUL',}
      //     })

      //   }else{

      //     const transaction = await prisma.transaction.findFirst({
      //       where:{reference: body.id}
      //     })
          
      //     await prisma.transaction.update({
      //       where:{id:transaction?.id},
      //       data:{status: 'FAILED',}
      //     })

      //   }

      // }

      await eventService.queue({
        type: 'QOREPAY', 
        QorePay_Event: event, 
        data
      })
  
      return res.status(200).json({
        msg: 'Event verified',
        success: true,
      });
  
    } catch (error) {
      console.error('Error verifying webhook:', error);
      return res.status(500).json({ 
        error: 'Internal Server Error', 
        message: (error as Error).message 
      });
    }
  }

  async tatum_WebHook(req: Request | any, res: Response) {

    try {
      const { body } = req;

      console.log('request body', req.body)
      const xPayloadHash = req.headers['x-payload-hash'] as string;
      const rawBody = req.body.toString();//
      const stringifybody = JSON.stringify(req.body);
      // const body = JSON.parse(rawBody);
    
      
      console.log('body',body)      

      // Step 4: Calculate digest as a Base64 string using the HMAC Secret, the webhook payload, and the HMAC SHA512 algorithm.
      const base64Hash = createHmac("sha512", config.HMACSECRET as string)
      .update(JSON.stringify(body))
      .digest("base64");

      // Step 5: Compare x-payload-hash value with calculated digest as a Base64 string
      const checkValues = xPayloadHash == base64Hash;

      console.log(`x-payload-hash and base64Hash are equal? ${checkValues}`);
  
  
      // ... (your webhook processing logic here) ...
      await eventService.queue({
        type: 'TATUM', 

        Tatum_Address:         body.address, 
        Tatum_CounterAddress:  body.counterAddress,
        Tatum_Chain:           body.chain,
        Tatum_Type:            body.type,
        Tatum_Amount:          body.amount, 
        Tatum_SubscriptionId:  body.subscriptionId, 
        Tatum_EventType:       body.subscriptionType,
        Tatum_TxId:            body.txId,
        Tatum_ContractAddress: body.contractAddress,
        Tatum_Asset:           body.asset
      })


    
      return res.status(200).json({
        msg: 'Event verified',
        success: true,
      });
  
    } catch (error) {
      console.error('Error verifying webhook:', error);
      return res.status(500).json({ 
        error: 'Internal Server Error', 
        message: (error as Error).message 
      });
    }
  }

 
}

export default new EventController();


// DEFAULT 2026-03-11T20:26:59.521813Z qorepay request body {
// DEFAULT 2026-03-11T20:26:59.521848Z event: 'dva.created',
// DEFAULT 2026-03-11T20:26:59.521855Z data: {
// DEFAULT 2026-03-11T20:26:59.521861Z id: '787c78f8-d3f5-4789-961e-1eac487f71a6',
// DEFAULT 2026-03-11T20:26:59.521867Z account_number: '9810268655',
// DEFAULT 2026-03-11T20:26:59.521874Z account_name: 'QOREPAY/ANAFUWE CALEB',
// DEFAULT 2026-03-11T20:26:59.521879Z bank_name: 'Wema Bank',
// DEFAULT 2026-03-11T20:26:59.521884Z status: 'ACTIVE',
// DEFAULT 2026-03-11T20:26:59.521890Z customer_id: '849bb283-90ea-4941-893e-947a263e78f0',
// DEFAULT 2026-03-11T20:26:59.521895Z merchant_id: 'e8e8153f-de33-4441-b409-ffec0ad87cab'
// DEFAULT 2026-03-11T20:26:59.521900Z }
// DEFAULT 2026-03-11T20:26:59.521905Z }





// DEFAULT 2026-03-10T16:07:34.120808Z qorepay request body {
// DEFAULT 2026-03-10T16:07:34.120830Z event: 'transaction.created',
// DEFAULT 2026-03-10T16:07:34.120834Z data: {
// DEFAULT 2026-03-10T16:07:34.120838Z payment_intent_id: '39c9af83-8b54-4261-a59e-c1559be4ff2d',
// DEFAULT 2026-03-10T16:07:34.120842Z reference: 'bf90272b-17dc-4ccb-843e-f4a36ffd772f',
// DEFAULT 2026-03-10T16:07:34.120846Z paid_amount: 20000,
// DEFAULT 2026-03-10T16:07:34.120849Z fees: 11073,
// DEFAULT 2026-03-10T16:07:34.120852Z currency: 'NGN',
// DEFAULT 2026-03-10T16:07:34.120856Z provider: 'PAYSTACK',
// DEFAULT 2026-03-10T16:07:34.120859Z channel: 'TRANSFER',
// DEFAULT 2026-03-10T16:07:34.120864Z customer_id: 'b78eb6a8-7142-4e5e-98ce-39ec56bdb820',
// DEFAULT 2026-03-10T16:07:34.120868Z dva: {
// DEFAULT 2026-03-10T16:07:34.120872Z id: '64f77d0d-2cfa-47ce-a842-1551cf9dccfb',
// DEFAULT 2026-03-10T16:07:34.120877Z account_number: '9810185693',
// DEFAULT 2026-03-10T16:07:34.120881Z account_name: 'QOREPAY/ANAFUWE HARVEY',
// DEFAULT 2026-03-10T16:07:34.120886Z bank_name: 'Wema Bank',
// DEFAULT 2026-03-10T16:07:34.120890Z customer_id: 'b78eb6a8-7142-4e5e-98ce-39ec56bdb820'
// DEFAULT 2026-03-10T16:07:34.120895Z }
// DEFAULT 2026-03-10T16:07:34.120899Z }
// DEFAULT 2026-03-10T16:07:34.120903Z }
