"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const env_config_1 = __importDefault(require("../config/env.config"));
const crypto = __importStar(require("crypto"));
const node_crypto_1 = require("node:crypto");
const utils_1 = require("../utils");
const fern_service_1 = __importDefault(require("../services/fern.service"));
const event_service_1 = __importDefault(require("../services/event.service"));
const webhooks_1 = require("@clerk/express/webhooks");
const clerk_service_1 = __importDefault(require("../services/clerk.service"));
const logger_1 = __importDefault(require("../config/logger"));
class EventController {
    async clerk_WebHook(req, res) {
        try {
            const evt = await (0, webhooks_1.verifyWebhook)(req, { signingSecret: env_config_1.default.clerk.SIGNING_SECRET });
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
            clerk_service_1.default.processEvent(evt).catch(error => {
                logger_1.default.error('Webhook processing failed', {
                    eventId: id,
                    eventType,
                    error: error.message,
                    stack: error.stack
                });
            });
        }
        catch (error) {
            console.error('Error verifying webhook:', error);
            return res.status(400).json({
                error: 'Webhook verification failed',
                message: error.message
            });
        }
    }
    async fern_WebHook(req, res) {
        const signature = req.header("x-api-signature");
        const timestamp = req.header("x-api-timestamp");
        const rawBody = req.body.toString(); //
        const body = JSON.parse(rawBody); // Explicit parsing
        console.log('Webhook received:', {
            type: body.type,
            transactionId: body.resource?.transactionId,
            signature,
            timestamp
        });
        if (!signature || !timestamp || !(0, utils_1.isValidSignature)(rawBody, timestamp, signature, env_config_1.default.fern.Secret)) {
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
                    const customer = body.resource;
                    console.log('case customer updated,', customer);
                    const updated = await fern_service_1.default.customer_updated(customer.customerStatus, customer.email);
                    if (updated) {
                        return res.status(200).json({
                            msg: 'Event Successful',
                            success: true,
                        });
                    }
                    break;
                case 'transaction.updated':
                    const transaction = body.resource;
                    console.log('case transaction update start', transaction);
                    const transactionUpdated = await fern_service_1.default.transaction_updated(transaction.transactionStatus, transaction.transactionId);
                    if (!transactionUpdated) {
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
        }
        catch (error) {
            console.error('Error verifying webhook:', error);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    }
    async qorepay_WebHook(req, res) {
        async function verifySignature(content, signature) {
            try {
                // Step 1: Get the public key from the provided URL
                const publicKey = env_config_1.default.QOREPAY_PUBLIC_KEY;
                // Step 2: Decode the Base64-encoded signature
                const decodedSignature = Buffer.from(signature, "base64");
                // Step 3: Create a verifier object with RSA + SHA256
                const verifier = crypto.createVerify("RSA-SHA256");
                // Step 4: Update the verifier with the raw request body (exact form received)
                verifier.update(content);
                // Step 5: Verify the signature using the public key
                const isVerified = verifier.verify(publicKey, decodedSignature);
                return isVerified;
            }
            catch (error) {
                console.log("Error verifying signature:", error);
                return false;
            }
        }
        try {
            const { body } = req;
            console.log('qorepay request body', body);
            const signatureHeader = req.headers["x-signature"];
            const rawBody = JSON.stringify(req.body);
            // const rawBody = await req.json();
            console.log('rawBody', rawBody);
            const isValid = await verifySignature(rawBody, signatureHeader);
            console.log(isValid);
            console.log('qorepay event type', body.type);
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
            await event_service_1.default.queue({
                type: 'QOREPAY',
                QorePay_Event: body.type,
                QorePay_EventType: body.event_type,
                QorePay_Reference: body.id,
            });
            return res.status(200).json({
                msg: 'Event verified',
                success: true,
            });
        }
        catch (error) {
            console.error('Error verifying webhook:', error);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    }
    async tatum_WebHook(req, res) {
        try {
            const { body } = req;
            console.log('request body', req.body);
            const xPayloadHash = req.headers['x-payload-hash'];
            const rawBody = req.body.toString(); //
            const stringifybody = JSON.stringify(req.body);
            // const body = JSON.parse(rawBody);
            console.log('body', body);
            // Step 4: Calculate digest as a Base64 string using the HMAC Secret, the webhook payload, and the HMAC SHA512 algorithm.
            const base64Hash = (0, node_crypto_1.createHmac)("sha512", env_config_1.default.HMACSECRET)
                .update(JSON.stringify(body))
                .digest("base64");
            // Step 5: Compare x-payload-hash value with calculated digest as a Base64 string
            const checkValues = xPayloadHash == base64Hash;
            console.log(`x-payload-hash and base64Hash are equal? ${checkValues}`);
            // ... (your webhook processing logic here) ...
            await event_service_1.default.queue({
                type: 'TATUM',
                Tatum_Address: body?.address,
                Tatum_SenderAddress: body.counterAddress,
                Tatum_Amount: body.amount,
                Tatum_SubscriptionId: body.subscriptionId,
                Tatum_EventType: body.subscriptionType,
                Tatum_TxId: body.txId
            });
            return res.status(200).json({
                msg: 'Event verified',
                success: true,
            });
        }
        catch (error) {
            console.error('Error verifying webhook:', error);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    }
}
exports.default = new EventController();
