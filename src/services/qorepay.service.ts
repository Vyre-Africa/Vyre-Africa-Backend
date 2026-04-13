import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
// import Flutterwave from "flutterwave-node-v3";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import axios from "axios";
import { UserBank } from "@prisma/client";
import { generateRefCode } from "../utils";
import logger from "../config/logger";
import walletService from "./wallet.service";
const Flutterwave = require('flutterwave-node-v3');

const qorepayAxios = axios.create({
  baseURL: 'https://api.qorepay.com',
  headers: {
      'accept':'application/json',
      'authorization': `Bearer ${config.QOREPAY_BEARER_TOKEN}`,
      'Content-Type': 'application/json'
  }
});

// const qorepayServer = axios.create({
//   baseURL: 'https://gate.qorepay.com',
//   headers: {
//       'accept':'application/json',
//       'authorization': `Bearer ${config.QOREPAY_S2S_TOKEN}`,
//       'Content-Type': 'multipart/form-data'
//   }
// });

class QorepayService {
    

    async deposit_via_Url(payload:{
      currency: string,
      amount: number, 
      email: string,
      userId: string,
      walletId: string
    })
    {
        const { currency, amount, email, userId, walletId } = payload
        
        const data = {
          amount:amount * 100,
          currency,
          brand_id: config.QOREPAY_BRAND_ID,
          customer_email: email,
          redirect_url: `${config.urls.userDashboard}/successful`,
          failure_url: `${config.urls.userDashboard}/failed`,
          metadata:{
            userId,
            walletId,
            amount,
            currency
          }            
        }

        const response = await qorepayAxios.post('/v1/purchases', data);
        console.log(response.data)
        const result = response.data

        // // create transaction record
        // const transaction = prisma.transaction.create({
        //     data: {
        //       userId,
        //       currency,
        //       amount,
        //       reference: result.reference,
        //       status: 'PENDING',
        //       walletId,
        //       type: 'FIAT_DEPOSIT',
        //       description: `${currency} deposit`
        //     }
        // })

        const paymentDetails = {
            id: result?.reference,
            url:result?.checkout_url,
            // success_redirect:result.success_redirect,
            // failure_redirect:result.failure_redirect,
        }

        return paymentDetails
    }

    async deposit_via_Bank(payload: {
      currency: string;
      amount: number;
      email: string;
      userId: string;
      walletId: string;
      awaitingId?: string;
    }) {
      const { currency, amount, email, userId, walletId, awaitingId } = payload;

      try {

        const data = {
          amount:amount * 100,
          currency,
          brand_id: config.QOREPAY_BRAND_ID,
          customer_email: email,
          channel:'TRANSFER',
          metadata:{
            awaitingId,
            userId,
            walletId,
            amount,
            currency,
          }
        };

        const response = await qorepayAxios.post('/v1/purchases', data);
        const result = response.data;

        if (!result) throw new Error('Could not initialize payment');

        // const transaction = prisma.transaction.create({
        //     data: {
        //       userId,
        //       currency,
        //       amount,
        //       reference: result.reference,
        //       status: 'PENDING',
        //       walletId,
        //       type: 'FIAT_DEPOSIT',
        //       description: `${currency} deposit`
        //     }
        //   })

        const details = result.data;

        console.log('payment result', details)

        return {
          id: details.reference,
          account_number: details?.account_number,
          account_name: details?.account_name,
          bank: details?.bank_name,
          status: details?.status,
          expires_at: details?.expires_at,
        };

      } catch (error) {
        logger.error('Bank transfer initialization failed:', error);
        throw error;
      }
    }

    async bank_Transfer(payload:{
       userId:string,
       currency: string,
       amount:string,
       email:string, 
       phone:string,
       walletId:string,

       account_number: string,
       bank_code: string, 
       recipient_name: string

      })
    {

      const {currency,amount,userId, walletId, email, phone, account_number, bank_code, recipient_name } = payload

      // let BlockId: string = '';

      try {

        // block amount in wallet before transfer
        // BlockId = await walletService.block_Amount(amount as any, walletId)


        const data = {
          amount: (Number(amount)) * 100,
          currency,
          brand_id: config.QOREPAY_BRAND_ID,
          bank_code,
          account_number,
          description: `${currency} withdrawal to ${recipient_name} `,
          metadata: {
            userId,
            walletId,
            amount,
            currency,
            brand_id: config.QOREPAY_BRAND_ID,
            bank_code,
            account_number
          }     
        }
        const response = await qorepayAxios.post(`/v1/payouts`, data)
        console.log('first response',response.data)
        const result = response.data

        await walletService.debit_Wallet(Number(amount), walletId)
        console.log('wallet debited')

        return {success:true, ...result}

      } catch (error:any) {

        logger.error('Bank transfer initialization failed:', error);
 
        // ========================================
        // ROLLBACK: UNBLOCK AMOUNT IF TRANSFER FAILS
        // ========================================
        // if (BlockId) {
        //   try {
        //     await walletService.unblock_Amount(BlockId);
        //     logger.info(`Amount unblocked after failed transfer: ${BlockId}`);
        //   } catch (unblockError) {
        //     logger.error(`Failed to unblock amount: ${BlockId}`, unblockError);            
        //   }
        // }

        logger.error('Bank transfer initialization failed:', error);
        throw error;
      }
      


    }

    async create_virtual_Account(payload: { userId: string }) {
    const { userId } = payload;

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          bvnSubmitted: true,
          bvnDetails: true,
        }
      });

      if (!user) {
        throw new Error(`User not found with id: ${userId}`);
      }

      if (!user.bvnSubmitted) {
        throw new Error(`User has not submitted BVN`);
      }

      if (!user.bvnDetails) {
        throw new Error(`BVN details not found for user: ${userId}`);
      }

      // Cast the Json field to a typed object
      const bvnDetails = user.bvnDetails as {
        bvn: string;
        bank_code: string;
        account_number: string;
        firstName: string,
        lastName: string
      };

      const data = {
        brand_id: config.QOREPAY_BRAND_ID,
        email: user.email,
        first_name: bvnDetails.firstName || user.firstName,
        last_name: bvnDetails.lastName || user.lastName,
        bvn: bvnDetails.bvn,
        bank_code: bvnDetails.bank_code,
        account_number: bvnDetails.account_number
      };

      const response = await qorepayAxios.post('/v1/virtual-accounts', data);
      const axiosData = response.data;
      const result = axiosData.data;
      console.log('bank generation data',result)

      if (!result) throw new Error('Could not initialize virtual account');

      return result;

    } catch (error) {
      logger.error('Virtual account initialization failed:', error);
      throw error;
    }
    }


 
}

export default new QorepayService()