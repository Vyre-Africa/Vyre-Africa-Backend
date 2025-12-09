import { Request, Response } from "express";
import { Paystack } from "paystack-sdk";
// import Flutterwave from "flutterwave-node-v3";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import axios from "axios";
import { UserBank } from "@prisma/client";
import { generateRefCode } from "../utils";
const Flutterwave = require('flutterwave-node-v3');

const qorepayAxios = axios.create({
  baseURL: 'https://gate.qorepay.com/',
  headers: {
      'accept':'application/json',
      'authorization': `Bearer ${config.QOREPAY_BEARER_TOKEN}`,
      'Content-Type': 'application/json'
  }
});

const qorepayServer = axios.create({
  baseURL: 'https://gate.qorepay.com',
  headers: {
      'accept':'application/json',
      'authorization': `Bearer ${config.QOREPAY_S2S_TOKEN}`,
      'Content-Type': 'multipart/form-data'
  }
});

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
            client: {
                email
              },
              purchase: {
                currency,
                products: [
                  {
                    name: "Deposit",
                    quantity: 1,
                    price: amount * 100
                  }
                ]
              },
              brand_id: config.QOREPAY_BRAND_ID,
              failure_redirect: `${config.urls.userDashboard}/failed`,
              success_redirect: `${config.urls.userDashboard}/successful`
        }
        const response = await qorepayAxios.post(`/api/v1/purchases/`, data)
        console.log(response.data)
        const result = response.data

        // create transaction record
        const transaction = await prisma.transaction.create({
            data:{
                userId,
                currency,
                amount,
                reference: result.id,
                status: 'PENDING',
                walletId,
                type:'FIAT_DEPOSIT',
                description:`${currency} deposit`
            }
        })
        const paymentDetails ={
            id: result.id,
            url:result.checkout_url,
            success_redirect:result.success_redirect,
            failure_redirect:result.failure_redirect,
        }
        return paymentDetails
    }

    async deposit_via_Bank(payload:{
      currency: string,
      amount: number, 
      email: string,
      userId: string,
      walletId: string
    })
    {
        const { currency, amount, email, userId, walletId } = payload
        
        const data = {
              client: {
                email
              },
              purchase: {
                currency,
                products: [
                  {
                    name: "Deposit",
                    quantity: 1,
                    price: amount * 100
                  }
                ]
              },
              brand_id: config.QOREPAY_BRAND_ID
        }
        const response = await qorepayAxios.post(`/api/v1/purchases/`, data)
        console.log(response.data)
        const result = response.data

        if(!result){
          throw new Error('Could not initialize payment');
        }

        const formData = new FormData();
        formData.append('s2s', 'true');
        formData.append('pm', 'sarepay_bank_transfer');

        // get bank details
        const account = await qorepayServer.post(`/p/${result.id}/`, formData);

        console.log(account.data)
        const details = account.data



        // create transaction record
        const transaction = await prisma.transaction.create({
            data:{
                userId,
                currency,
                amount,
                reference: result.id,
                status: 'PENDING',
                walletId,
                type:'FIAT_DEPOSIT',
                description:`${currency} deposit`
            }
        })
        const bankDetails ={
            id: result.id,
            account_number: details?.account_number,
            account_name: details?.account_name,
            bank: details?.bank,
            status: details?.status,
            type: details?.type,
            expires_at: details?.expires_at,
            validity_type: details?.validity_type
        }
        return bankDetails
    }


    async bank_Transfer(payload:{
       currency: string,
       amount:number,
       email:string, 
       phone:string,

       account_number: string,
       bank_code: string, 
       recipient_name: string

      })
    {

      const {currency,amount, email, phone, account_number, bank_code, recipient_name } = payload

      const data = {
            client: {
                email,
                phone
              },
              payment: {
                amount: amount * 100,
                currency,
                description: `${currency} withdrawal `,
              },
              sender_name:'Vyre Africa',
              brand_id: config.QOREPAY_BRAND_ID,
      }

      const response = await qorepayAxios.post(`/api/v1/payouts/`, data)
      console.log('first response',response.data)
      const result = response.data

      const registered = await axios.get(result?.execution_url)
      const payment = registered.data

        // const paymentDetails ={
        //     banks: payment?.detail.data,
        //     url: payment?.payout_url,
        // }

      if(payment?.status === 'error'){
        throw new Error('Could not initialize transfer');
      }

      // return payment?.payout_url

      const transferData = {
        account_number,
        bank_code,
        recipient_name
      }

      const transferResponse = await axios.post(payment?.payout_url, transferData)
      console.log('qorepay transfer response',transferResponse.data)
      const transferResult = transferResponse.data

      return transferResult


    }


 
}

export default new QorepayService()