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
          rate:response,
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
  
      const walletExists = await prisma.wallet.findFirst({
        where: { 
          userId: user.id,
          currencyId
        }
      })
  
      if(walletExists){
        return res.status(400)
          .json({
            msg: `${currency?.name} wallet already exists`,
            success: false,
          });
      }

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
      receipient_id
    } = req.body;

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

        // const result = await walletService.offchain_Transfer
        // ({
        //   userId: user.id,
        //   receipientId: receipient_id,
        //   currencyId: currencyId,
        //   amount
        // })

        await walletService.queue({
          userId: user.id,
          receipientId: receipient_id,
          currencyId: currencyId,
          amount,
          type:'OFFCHAIN'
        })

        return res
        .status(200)
        .json({
          msg: 'Transfer Successful',
          success: true
          // wallet:result
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

  async init_BlockchainTransfer(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      amount,
      currencyId,
      address, 
      destinationTag
    } = req.body;

    try {

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

      if(amount > walletExists.availableBalance){
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

        // Handle crypto withdrawal logic here
        // const result = await walletService.blockchain_Transfer
        // ({
        //   userId: user.id, 
        //   currencyId: currency.id,
        //   amount: amount,
        //   address: address,
        //   destination_Tag: destinationTag
        // })

        await walletService.queue({
          userId: user.id, 
          currencyId: currency.id,
          amount: amount,
          address: address,
          destination_Tag: destinationTag,
          type:'BLOCKCHAIN'
        })

        return res
        .status(200)
        .json({
          msg: 'Transfer Initiated',
          success: true
          // wallet:result
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

  async init_BankTransfer(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      account_number,
      bank_code,
      recipient_name, 
      endpoint_url
    } = req.body;

    try {

        const result = await walletService.bank_Transfer
        ({
          account_number,
          bank_code,
          recipient_name: recipient_name,
          endpoint: endpoint_url
        })

        // await walletService.queue({
        //   account_number,
        //   bank_code,
        //   recipient_name: recipient_name,
        //   endpoint: endpoint_url,
        //   type:'BANK'
        // })

        return res
        .status(200)
        .json({
          msg: 'Transfer Initiated',
          success: true,
          result
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



  // async withdrawal(req: Request & Record<string, any>, res: Response) {
  //   const { user } = req;
  //   const {
  //     TRANSFER_TYPE,
  //     AMOUNT,
  //     CURRENCY,
  //     RECEIPIENT_ID,
  //     BLOCKCHAIN,
  //     BANK,
  //     bank_Account_Number, 
  //     bank
  //   } = req.body;

  //   try {

  //     const walletExists = await prisma.wallet.findFirst({
  //       where: { 
  //         userId: user.id,
  //         currency: CURRENCY
  //       }
  //     })
  
  //     if(!walletExists){
  //       return res.status(400)
  //         .json({
  //           msg: 'User wallet does not exist',
  //           success: false,
  //         });
  //     }

  //     if(AMOUNT > walletExists.availableBalance){
  //       return res.status(400)
  //         .json({
  //           msg: 'Available balance not sufficient',
  //           success: false,
  //         });
  //     }

  //     if ( TRANSFER_TYPE == 'VYRE') {
  //       // offchain transfer
  //       if (!blockchain_Address) {
  //         return res.status(400)
  //         .json({
  //           msg: 'Blockchain address is required for crypto withdrawals',
  //           success: false,
  //         });
  //       }

  //       if(CURRENCY === 'XRP' && !destination_Tag){
  //         return res.status(400)
  //         .json({
  //           msg: 'destination_Tag required for ripple widthdrawal',
  //           success: false,
  //         });
  //       }

  //       // Handle crypto withdrawal logic here
  //       const result = await walletService.blockchain_Transfer
  //       (
  //         user.id,
  //         CURRENCY,
  //         AMOUNT,
  //         blockchain_Address,
  //         destination_Tag
  //       )

  //       return res
  //       .status(200)
  //       .json({
  //         msg: 'Withdrawal Initiated',
  //         success: true,
  //         wallet:result
  //       });



  //     }

  //     if (walletExists.type === 'CRYPTO' && TRANSFER_TYPE == 'BLOCKCHAIN') {
  //       // Crypto withdrawal
  //       if (!BLOCKCHAIN.address) {
  //         return res.status(400)
  //         .json({
  //           msg: 'Blockchain address is required for crypto withdrawals',
  //           success: false,
  //         });
  //       }

  //       if(CURRENCY === 'XRP' && !BLOCKCHAIN.destinationTag){
  //         return res.status(400)
  //         .json({
  //           msg: 'destination_Tag required for ripple widthdrawal',
  //           success: false,
  //         });
  //       }

  //       // Handle crypto withdrawal logic here
  //       const result = await walletService.blockchain_Transfer
  //       (
  //         user.id,
  //         CURRENCY,
  //         AMOUNT,
  //         BLOCKCHAIN.address,
  //         BLOCKCHAIN.destinationTag
  //       )

  //       return res
  //       .status(200)
  //       .json({
  //         msg: 'Withdrawal Initiated',
  //         success: true,
  //         wallet:result
  //       });



  //     }

  //     if (walletExists.type === 'FIAT' && TRANSFER_TYPE == 'BANK') {
  //       // Fiat withdrawal
  //       if (!bank_Account_Number || !bank) {
  //         return res.status(400)
  //         .json({
  //           msg: 'Bank account number and bank name are required for fiat withdrawals',
  //           success: false,
  //         });
  //       }
  //     }


  //       // Handle fiat withdrawal logic here
  //     // } else {
  //     //   return res.status(400).json({ error: 'Invalid withdrawal type' });
  //     // }



  
      
  //     // return res
  //     //   .status(200)
  //     //   .json({
  //     //     msg: 'Wallet created Successfully',
  //     //     success: true,
  //     //     wallet:result
  //     //   });

  //   } catch (error) {
  //     console.log(error)
  //     res.status(500)
  //       .json({
  //         msg: 'Internal Server Error',
  //         success: false,
  //       });
  //   }
  // }


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