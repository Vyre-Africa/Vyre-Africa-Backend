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


class EventController {


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

    async function verifySignature(content: any, signature: string) {
      try {
        // Step 1: Get the public key from the provided URL
        const publicKey = config.QOREPAY_PUBLIC_KEY as string;
        // Step 2: Decode the Base64-encoded signature
        const decodedSignature = Buffer.from(signature, "base64");
    
        // Step 3: Create a verifier object with RSA + SHA256
        const verifier = crypto.createVerify("RSA-SHA256");
    
        // Step 4: Update the verifier with the raw request body (exact form received)
        verifier.update(content);
    
        // Step 5: Verify the signature using the public key
        const isVerified = verifier.verify(publicKey, decodedSignature);
    
        return isVerified;
      } catch (error) {
        console.log("Error verifying signature:", error);
        return false;
      }
    }

    try {
      const { body } = req;

      console.log('qorepay request body',body)

      const signatureHeader = req.headers["x-signature"] as string;

      const rawBody = JSON.stringify(req.body)
      // const rawBody = await req.json();
      console.log('rawBody', rawBody)

      const isValid = await verifySignature(rawBody, signatureHeader);

      console.log(isValid)
      console.log('qorepay event type', body.type)

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
        QorePay_Event: body.type,
        QorePay_EventType: body.event_type, 
        QorePay_Reference: body.id, 
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

  async tatum_WebHook(req: Request, res: Response) {

    try {
      const xPayloadHash = req.headers['x-payload-hash'] as string;
      const rawBody = req.body.toString();//
      const stringifybody = JSON.stringify(req.body);
      const body = JSON.parse(rawBody);
    
      // const { body } = req;
      console.log('body',body)      

      // Step 4: Calculate digest as a Base64 string using the HMAC Secret, the webhook payload, and the HMAC SHA512 algorithm.
      const base64Hash = createHmac("sha512", config.HMACSECRET as string)
      .update(JSON.stringify(body))
      .digest("base64");

      // Step 5: Compare x-payload-hash value with calculated digest as a Base64 string
      const checkValues = xPayloadHash == base64Hash;

      console.log(`x-payload-hash and base64Hash are equal? ${checkValues}`);
    
      // // FOR ACCOUNT_INCOMING_BLOCKCHAIN_TRANSACTION 

      // if(body.subscriptionType === 'ADDRESS_EVENT'){

      //   await eventService.handleCryptoEvent({
      //     address: body?.address,
      //     type: body?.subscriptionType,
      //     amount: body.amount,
      //     sender: body.counterAddress
      //   })
    
      // }
  
      // ... (your webhook processing logic here) ...
      await eventService.queue({
        type: 'TATUM', 

        Tatum_Address: body?.address, 
        Tatum_SenderAddress: body.counterAddress, 
        Tatum_Amount: body.amount, 
        Tatum_SubscriptionId: body.subscriptionId, 
        Tatum_EventType: body.subscriptionType
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