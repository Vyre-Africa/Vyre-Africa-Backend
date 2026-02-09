import { PrismaClient } from '@prisma/client';
import { Paystack } from 'paystack-sdk';
import { Request, Response } from 'express';
import { KJUR } from 'jsrsasign';
import prisma from '../config/prisma.config';
import axios from "axios";
import orderService from '../services/order.service';
import paystackService from '../services/paystack.service';
import notificationService from '../services/notification.service';
import config from '../config/env.config';
import smsService from '../services/sms.service';
import mobilePushService from '../services/mobilePush.service';
import walletService from '../services/wallet.service';
import {currencyType} from '@prisma/client';
import { subMinutes } from 'date-fns';
import * as crypto from 'crypto';
import {createHmac} from 'node:crypto';
import { generateRefCode, generateSignature, isValidSignature } from '../utils';
import Decimal from 'decimal.js';
import transactionService from '../services/transaction.service';
import fernService from '../services/fern.service';


class WalletController {


  async getRate(req: Request, res: Response) {
    const { currency, basePair, amount } = req.query;

    try {
      console.log('query',req.query)

      if (!currency || !basePair) {
        return res.status(400).json({ 
          success: false, 
          msg: "Currency and basePair are required query parameters." 
        });
      }
  

      const response = await walletService.getRate(currency as string, basePair as string)

      let convertedAmount: any | undefined;

      if (amount && !isNaN(Number(amount))) {
        convertedAmount = (Number(amount) * response.value).toFixed(2); 
      }

      

      return res
        .status(200)
        .json({
          msg:`rate fetched successfully`,
          success: true,
          rate: response,
          value: convertedAmount
        });


    } catch (error) {
      console.log(error);
      res.status(500).send(error);
    }
  }


  async createWallet(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const currencyId = req.params.currencyId

    try {

      const currency = await prisma.currency.findUnique({
        where:{id:currencyId}
      })

      if(!currency){
        return res.status(400)
          .json({
            msg: `currency not found`,
            success: false,
          });
      }
  
      // const walletExists = await prisma.wallet.findFirst({
      //   where: { 
      //     userId: user.id,
      //     currencyId
      //   }
      // })
  
      // if(walletExists){
      //   return res.status(400)
      //     .json({
      //       msg: `${currency?.name} wallet already exists`,
      //       success: false,
      //     });
      // }

      const result = await walletService.createWallet({
        userId:user.id, 
        currencyId: currency.id as string
      })

      return res
        .status(200)
        .json({
          msg: 'Wallet created Successfully',
          success: true,
          wallet:result
        });

    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }

  async init_BankDeposit(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {currencyId, amount} = req.body

    if(!currencyId || !amount){
      return res.status(400)
        .json({
          msg: 'required details missing',
          success: false,
        });
    }

    const currency = await prisma.currency.findUnique({
      where:{id: currencyId}
    })

    if(!currency){
      return res.status(400)
        .json({
          msg: `currency not found`,
          success: false,
        });
    }

    try {

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      const wallet = await prisma.wallet.findFirst({
        where:{
          userId:userData?.id,
          currencyId
        }
      })
  
      const payment = await walletService.depositFiat({
        currency: currency.ISO,
        amount,
        email: userData?.email!,
        userId: userData?.id!, 
        walletId: wallet?.id!
      })
  
      return res
        .status(200)
        .json({
          msg: 'Deposit initiated Successfully',
          success: true,
          payment
        });

    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }

  async authorize_fiat_Withdrawal(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {currencyId, amount} = req.body

    console.log(req.body)

    if(!currencyId || !amount){
      return res.status(400)
        .json({
          msg: 'required details missing',
          success: false,
        });
    }

    const currency = await prisma.currency.findUnique({
      where:{id:currencyId}
    })

    if(!currency){
      return res.status(400)
        .json({
          msg: `currency not found`,
          success: false,
        });
    }

    try {

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      const walletExists = await prisma.wallet.findFirst({
        where: { 
          userId: user.id,
          currencyId
        }
      })
  
      if(!walletExists){
        return res.status(400)
          .json({
            msg: 'User wallet does not exist',
            success: false,
          });
      }

      if(amount > walletExists.availableBalance){
        return res.status(400)
          .json({
            msg: 'Available balance not sufficient',
            success: false,
          });
      }
  
      const payUrl = await walletService.authorize_Withdrawal(currency.ISO, amount, userData?.email!, userData?.phoneNumber!)

      if(payUrl){

        return res
        .status(200)
        .json({
          msg: 'Authorised Successfully',
          success: true,
          url: payUrl
        });

      }else{
        return res
        .status(400)
        .json({
          msg: 'Operation Failed',
          success: false,
        });
      }
  
      

    } catch (error) {
      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }

  async init_VyreTransfer(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      amount,
      currencyId,
      recipient_id,
      idempotencyKey
    } = req.body;

    // Validate idempotency key
    if (!idempotencyKey) {
      return res.status(400).json({
        msg: 'idempotencyKey is required',
        success: false
      });
    }

    try {

      // ✅ Check if this request was already processed
      const existingTransfer = await prisma.transferRequest.findUnique({
        where: { idempotencyKey }
      });

      if (existingTransfer) {
        // Return the original result (not an error!)
        return res.status(200).json({
          msg: 'Transfer already processed',
          success: true,
          transferId: existingTransfer.id,
          status: existingTransfer.status,
          duplicate: true
        });
      }



      const currency = await prisma.currency.findUnique({
        where:{id:currencyId}
      })

      if(!currency){
        return res.status(400)
          .json({
            msg: `currency not found`,
            success: false,
          });
      }

      const walletExists = await prisma.wallet.findFirst({
        where: { 
          userId: user.id,
          currencyId
        }
      })
  
      if(!walletExists){
        return res.status(400)
          .json({
            msg: 'User wallet does not exist',
            success: false,
          });
      }

      // ✅ Convert amount to Decimal immediately
      const amountDecimal = new Decimal(amount);
      // ✅ Check balance with Decimal comparison
      const availableBalance = new Decimal(walletExists.availableBalance);

      if(availableBalance.lessThan(amountDecimal)){
        return res.status(400)
          .json({
            msg: 'Available balance not sufficient',
            success: false,
          });
      }

        // const result = await walletService.offchain_Transfer
        // ({
        //   userId: user.id,
        //   receipientId: recipient_id,
        //   currencyId: currencyId,
        //   amount
        // })

        const transfer = await prisma.transferRequest.create({
          data: {
            idempotencyKey,
            userId: user.id,
            currencyId,
            amount: amount.toString(),
            type:'USER',
            status: 'PENDING',
            vyre:{
              amount,
              currencyId,
              recipient_id,
              idempotencyKey,
              currencyISO: currency.ISO
            }
          }
        });

 
        await walletService.queue({
          transferId: transfer.id,
          type: 'OFFCHAIN'
        })

        await notificationService.queue({
          userId: user.id,
          title: 'Vyre transfer Initiated',
          type: 'GENERAL',
          content: `Your vyre transfer of <strong>${amount} ${currency.ISO}</strong> is being processed. You will receive a notification once the transfer is complete.`
        });

        return res
        .status(202)
        .json({
          msg: 'Vyre transfer initiated',
          success: true,
          transferId: transfer.id,
          status: 'PENDING'
        });

    } catch (error: any) {
      if (error.code === 'P2002' && error.meta?.target?.includes('idempotencyKey')) {
        const existingTransfer = await prisma.transferRequest.findUnique({
          where: { idempotencyKey }
        });
        
        return res.status(200).json({
          msg: 'Vyre transfer already processed',
          success: true,
          transferId: existingTransfer?.id,
          status: existingTransfer?.status,
          duplicate: true
        });
      }

      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }

  async init_BlockchainTransfer(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      amount,
      currencyId,
      address, 
      destinationTag,
      idempotencyKey
    } = req.body;

    // Validate idempotency key
    if (!idempotencyKey) {
      return res.status(400).json({
        msg: 'idempotencyKey is required',
        success: false
      });
    }


    try {

       // ✅ Check if this request was already processed
      const existingTransfer = await prisma.transferRequest.findUnique({
        where: { idempotencyKey }
      });

      if (existingTransfer) {
        // Return the original result (not an error!)
        return res.status(200).json({
          msg: 'Transfer already processed',
          success: true,
          transferId: existingTransfer.id,
          status: existingTransfer.status,
          duplicate: true
        });
      }

      const currency = await prisma.currency.findUnique({
        where:{id: currencyId}
      })

      if(!currency){
        return res.status(400)
          .json({
            msg: `currency not valid`,
            success: false,
          });
      }


      const walletExists = await prisma.wallet.findFirst({
        where: { 
          userId: user.id,
          currencyId
        }
      })
  
      if(!walletExists){
        return res.status(400)
          .json({
            msg: 'User wallet does not exist',
            success: false,
          });
      }

      // ✅ Convert amount to Decimal immediately
      const amountDecimal = new Decimal(amount);
      // ✅ Check balance with Decimal comparison
      const availableBalance = new Decimal(walletExists.availableBalance);

      if(availableBalance.lessThan(amountDecimal)){
        return res.status(400)
          .json({
            msg: 'Available balance not sufficient',
            success: false,
          });
      }

        if(currency.ISO === 'XRP' && !destinationTag){
          return res.status(400)
          .json({
            msg: 'destination_Tag required for ripple widthdrawal',
            success: false,
          });
        }

        const transfer = await prisma.transferRequest.create({
          data: {
            idempotencyKey,
            userId: user.id,
            currencyId,
            amount: amount.toString(),
            type:'CRYPTO',
            status: 'PENDING',
            crypto:{
              amount,
              currencyId,
              address, 
              destinationTag,
              idempotencyKey,
              currencyISO: currency.ISO,
              chain: currency.chain as string
            }
          }
        });

 
        await walletService.queue({
          transferId: transfer.id,
          type: 'BLOCKCHAIN'
        })

        await notificationService.queue({
          userId: user.id,
          title: 'Blockchain transfer initiated',
          type: 'GENERAL',
          content: `Your blockchain transfer of <strong>${amount} ${currency.ISO}</strong> is being processed. You will receive a notification once the transfer is complete.`
        });


        return res
        .status(202)
        .json({
          msg: 'Blockchain transfer initiated',
          success: true,
          transferId: transfer.id,
          status: 'PENDING'
        });


    } catch (error:any) {

      if (error.code === 'P2002' && error.meta?.target?.includes('idempotencyKey')) {
        const existingTransfer = await prisma.transferRequest.findUnique({
          where: { idempotencyKey }
        });
        
        return res.status(200).json({
          msg: 'Blockchain transfer already processed',
          success: true,
          transferId: existingTransfer?.id,
          status: existingTransfer?.status,
          duplicate: true
        });
      }

      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }

  async init_BankTransfer(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      account_number,
      bank_code,
      bank_name,
      account_name,
      amount, 
      currencyId,
      idempotencyKey
    } = req.body;

    // Validate idempotency key
    if (!idempotencyKey) {
      return res.status(400).json({
        msg: 'idempotencyKey is required',
        success: false
      });
    }

    try {

      // ✅ Check if this request was already processed
      const existingTransfer = await prisma.transferRequest.findUnique({
        where: { idempotencyKey }
      });

      if (existingTransfer) {
        // Return the original result (not an error!)
        return res.status(200).json({
          msg: 'Transfer already processed',
          success: true,
          transferId: existingTransfer.id,
          status: existingTransfer.status,
          duplicate: true
        });
      }

      const currency = await prisma.currency.findUnique({
        where:{id:currencyId}
      })

      if(!currency){
        return res.status(400)
          .json({
            msg: `currency not found`,
            success: false,
          });
      }

      const walletExists = await prisma.wallet.findFirst({
        where: { 
          userId: user.id,
          currencyId
        }
      })
  
      if(!walletExists){
        return res.status(400)
          .json({
            msg: 'User wallet does not exist',
            success: false,
          });
      }

      // ✅ Convert amount to Decimal immediately
      const amountDecimal = new Decimal(amount);
      // ✅ Check balance with Decimal comparison
      const availableBalance = new Decimal(walletExists.availableBalance);

      if(availableBalance.lessThan(amountDecimal)){
        return res.status(400)
          .json({
            msg: 'Available balance not sufficient',
            success: false,
          });
      }


      // Create transfer request
      const transfer = await prisma.transferRequest.create({
          data: {
            idempotencyKey,
            userId: user.id,
            currencyId,
            amount: amount.toString(),
            type:'BANK',
            status: 'PENDING',
            bank:{
              amount,
              currencyId,
              email: user.email,
              phone: user.phoneNumber!,
              account_number,
              bank_code,
              bank_name,
              account_name,
              idempotencyKey,
              currencyISO: currency.ISO
            }
          }
      });

        await walletService.queue({
          transferId: transfer.id,
          type: 'BANK'
        })

        await notificationService.queue({
          userId: user.id,
          title: 'Bank transfer initiated',
          type: 'GENERAL',
          content: `Your bank transfer of <strong>${amount} ${currency.ISO}</strong> is being processed. You will receive a notification once the transfer is complete.`
        });

        return res
        .status(202)
        .json({
          msg: 'Bank transfer initiated',
          success: true,
          transferId: transfer.id,
          status: 'PENDING'
        });


    } catch (error:any) {

      if (error.code === 'P2002' && error.meta?.target?.includes('idempotencyKey')) {
        const existingTransfer = await prisma.transferRequest.findUnique({
          where: { idempotencyKey }
        });
        
        return res.status(200).json({
          msg: 'Bank transfer already processed',
          success: true,
          transferId: existingTransfer?.id,
          status: existingTransfer?.status,
          duplicate: true
        });
      }

      console.log(error)
      res.status(500)
        .json({
          msg: 'Internal Server Error',
          success: false,
        });
    }
  }





  async fetchPortfolio(req: Request & Record<string, any>, res: Response) {
    const { user } = req;

    try {

      const userPortfolio = await walletService.aggregateAllWallets(user.id,'NGN');
      console.log('user portfolio', userPortfolio)

    
      return res
        .status(200)
        .json({
          msg: 'wallets fetched Successfully',
          success: true,
          data: userPortfolio
        });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async fetchWallets(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { type } = req.query;

    let wallets;

    try {

      if(type){
        wallets = await prisma.wallet.findMany({
          where: {
            userId: user.id,
            currency: {  // Use the relation field name (currency) not the model name (Currency)
              type: type as currencyType  // This assumes 'type' is a variable containing the currency type you're filtering by
            }
          },
          include: {
            currency: true  // Optionally include the full currency data in the response
          }
        });
      }else{

        wallets = await prisma.wallet.findMany({
          where: {
            userId: user.id
          },
          include: {
            currency: true  // Optionally include the full currency data in the response
          }
        });
      }
      

      console.log('Fetched wallets: ', wallets);

      return res
        .status(200)
        .json({
          msg: 'wallets fetched Successfully',
          success: true,
          wallets
        });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async fetchWallet(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const walletId = req.params.id;

    try {

      const wallet = await walletService.getAccount(walletId)
      console.log('main wallet data', wallet)
      //  const wallet = await prisma.wallet.findUnique({
      //     where: {
      //       id: walletId
      //     }
      //   });

      // const wallet = await prisma.wallet.update({
      //   where: {
      //     id: walletId
      //   },
      //   data:{
      //     frozen: result.frozen,
      //     accountBalance:result.balance.accountBalance,
      //     availableBalance:result.balance.availableBalance
      //   }
      // });
      

      console.log('Fetched wallets: ', wallet);

      let Balance_rate: any | undefined;
      let Available_Balance_rate: any | undefined;

      if(wallet?.currency?.type === 'CRYPTO' ){
        const response = await walletService.getRate(wallet?.currency?.ISO, 'NGN')
      
        Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.accountBalance) * response.value).toFixed(2)}`;
        Available_Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.availableBalance) * response.value).toFixed(2)}`;
      }

      


      return res
        .status(200)
        .json({
          msg: 'wallet fetched Successfully',
          success: true,
          wallet,
          rate:{
            balance: Balance_rate,
            available: Available_Balance_rate
          }
          
        });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async fetchWalletByName(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const name = req.params.name;

    try {

      let wallet:any;

      const currency = await prisma.currency.findFirst({
        where:{
          ISO: name
        }
      })

      if(!currency){
        return res.status(400)
          .json({
            msg: 'currency not found',
            success: false,
        });
      }

      wallet = await prisma.wallet.findFirst({
        where: {
          userId: user.id,
          currencyId: currency.id
        }
      });

      if(!wallet){
        return res.status(400)
          .json({
            msg: 'wallet not found',
            success: false,
        });
      }

      wallet = await walletService.getAccount(wallet.id)
      console.log('main wallet data', wallet)
      

      console.log('Fetched wallets: ', wallet);

      let Balance_rate: any | undefined;
      let Available_Balance_rate: any | undefined;

      if(wallet?.type === 'CRYPTO' ){
        const response = await walletService.getRate(wallet?.currency, 'NGN')
      
        Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.accountBalance) * response.value).toFixed(2)}`;
        Available_Balance_rate = `${wallet.accountingCurrency} ${(Number(wallet?.availableBalance) * response.value).toFixed(2)}`;
      }

      return res
        .status(200)
        .json({
          msg: 'wallet fetched Successfully',
          success: true,
          wallet,
          rate:{
            balance: Balance_rate,
            available: Available_Balance_rate
          }
          
        });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

  async fetchTransactions(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const { walletId } = req.query;

    let transactions;

    try {

      if(walletId){

        transactions = await transactionService.getwalletRecords(walletId as string,20)
        
      }else{
        transactions = await transactionService.getUserRecords(user.id as string,20)
      }
      

      console.log('Fetched transactions: ', transactions);

      return res
        .status(200)
        .json({
          msg: 'transactions fetched Successfully',
          success: true,
          transactions
        });
    } catch (error) {
      console.log(error);
      return res.status(500).send({ msg: 'Internal Server Error', success: false, error });
    }
  }

 
}

export default new WalletController();