import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
// import Flutterwave from "flutterwave-node-v3";
import config from "../config/env.config";
import prisma from '../config/prisma.client';
import axios from "axios";
import { UserBank } from "@prisma/client";
import { generateRefCode } from "../utils";
import logger from "../config/logger";
import walletService from "./wallet.service";
import virtualAccountService from "./virtualAccount.service";
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

      try {


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

        await virtualAccountService.initiateBankWithdrawal({
          userId,
          currency,
          amount,
          bankDetails: {
              accountNumber: account_number,
              bankCode: bank_code,
              accountName: recipient_name
          },
          reference: result.data.reference,
          metadata: {
            qorepayPayoutId: result.data.id,
            brand_id: config.QOREPAY_BRAND_ID,
            bank_code,
            account_number
          }
        })

        // await walletService.debit_Wallet(Number(amount), walletId)
        // console.log('wallet debited')

        return {success:true, ...result}

      } catch (error:any) {

        logger.error('Bank transfer initialization failed:', error);
        throw error;
      }
      


    }

    // Reads BVN + bank details straight from the User record — both are
    // captured exactly once, elsewhere (BVN via KYC Tier 1, bank details
    // via the bank-account save endpoint), and never re-collected here.
    // The retired bvnSubmitted/bvnDetails JSON blob is no longer read.
    //
    // Caller (wallet.service.ts createWallet) is responsible for only
    // calling this once dojahBvnRef, bankCode, and bankAccountNumber are
    // all confirmed present — this function still defends against being
    // called out of order, but should not be the only gate.
    async create_virtual_Account(payload: { userId: string; walletId?: string }) {
      const { userId, walletId } = payload;

      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            email: true,
            phoneNumber: true,
            legalFirstName: true,
            legalLastName: true,
            firstName: true,
            lastName: true,
            dojahBvnRef: true,
            bankCode: true,
            bankAccountNumber: true,
            qorepayVirtualAccountId: true,
          }
        });

        if (!user) {
          throw new Error(`User not found with id: ${userId}`);
        }

        // Idempotency guard — never re-create for a user who already has
        // one. Without this, a retry (e.g. after the wallet-creation flow
        // above times out waiting on this call) creates a second, orphaned
        // Qorepay virtual account tied to nothing.
        if (user.qorepayVirtualAccountId) {
          logger.info(`Qorepay virtual account already exists for user ${userId}, skipping creation`);
          return null;
        }

        if (!user.dojahBvnRef) {
          throw new Error(`User has not completed BVN verification: ${userId}`);
        }

        if (!user.bankCode || !user.bankAccountNumber) {
          throw new Error(`Bank account details not found for user: ${userId}`);
        }

        const data = {
          brand_id: config.QOREPAY_BRAND_ID,
          email: user.email,
          first_name: user.legalFirstName || user.firstName,
          last_name: user.legalLastName || user.lastName,
          // phone: user.phoneNumber,
          bvn: user.dojahBvnRef,
          bank_code: user.bankCode,
          account_number: user.bankAccountNumber,
          // preferred_bank: 'wema-bank', // TODO: confirm static vs configurable with Qorepay
        };

        const response = await qorepayAxios.post('/v1/virtual-accounts', data);
        const axiosData = response.data;
        const result = axiosData.data;
        console.log('bank generation data', result)

        if (!result) throw new Error('Could not initialize virtual account');

        // Persist the Qorepay-side identifiers immediately so the
        // idempotency check above works on the very next call, even
        // before the DVA webhook confirms activation.
        await prisma.user.update({
          where: { id: userId },
          data: {
            qorepayVirtualAccountId: result.id,
            qorepayCustomerId: result.customer_id,
            qorepayStatus: result.status,
            qorepayProvisionedAt: new Date(),
          },
        });

        return result;

      } catch (error) {
        logger.error('Virtual account initialization failed:', error);
        throw error;
      }
    }


 
}

export default new QorepayService()