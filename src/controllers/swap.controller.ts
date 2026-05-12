// import { PrismaClient } from '@prisma/client';
import { Paystack } from 'paystack-sdk';
import { Request, Response } from 'express';
import { KJUR } from 'jsrsasign';
import prisma from '../config/prisma.client';
import axios from "axios";
import orderService from '../services/order.service';
import paystackService from '../services/paystack.service';
import notificationService from '../services/notification.service';
import config from '../config/env.config';
import smsService from '../services/sms.service';
import mobilePushService from '../services/mobilePush.service';
import walletService from '../services/wallet.service';
// import {Currency,walletType} from '@prisma/client';
import { subMinutes } from 'date-fns';
import * as crypto from 'crypto';
import {createHmac} from 'node:crypto';
import { getPaymentMethodByCurrency, getISOByCountry, calculateFee } from '../utils';
import transactionService from '../services/transaction.service';
import accountService from '../services/account.service';
import fernService from '../services/fern.service';


class SwapController {


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


  async addFiatAccount(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      accountNumber,
      accountName,
      bankId,
      type,

      bicSwift,
      routingNumber,
      sortCode,
      institutionNumber,
      bsbNumber,
      ifscCode,
      clabeNumber,
      cnapsCode,
      pixCode,
      clearingCode,

      // currency,
      // Address,
    } = req.body
      

    try {

      console.log('bicSwift',bicSwift)
      console.log('routingNumber', routingNumber)
      console.log('accountName', accountName)

      if(!bankId ||!type){
        return res.status(400)
        .json({
          msg: 'Incomplete Details',
          success: false,
        });
      }

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      if(!userData){
        return res.status(400)
          .json({
            msg: 'User not found',
            success: false,
          });
      }

      const bank = await prisma.bank.findUnique({
        where: { id: bankId }
      });

      console.log(bank)

      if (!bank) {
          return res.status(400).json({
              msg: 'bank not found',
              success: false,
          });
      }
  
      const account = await fernService.fiatAccount(
        {
          userId:user.id,
          bankName: bank.name,
          accountNumber,
          accountName,
          currency: bank?.currency!,
          bankAddress: {
            country: getISOByCountry(bank?.country as string)!,
            addressLine1: bank?.address!,
            city: bank?.city!,
            state: bank?.state!,
            postalCode: bank?.postalCode!,
            locale: "en-US"
          },

          ...(bank?.currency === 'USD' && { routingNumber }),
          ...(bank?.currency === 'NGN' && { nubanNumber: accountNumber }),
          ...(bank?.currency === 'EUR' && { iban: accountNumber }),
          ...(bank?.currency === 'GBP' && { sortCode }),
          ...(bank?.currency === 'AUD' && { bsbNumber }),
          ...(bank?.currency === 'CAD' && { institutionNumber }),
          ...(bank?.currency === 'INR' && { ifscCode }),
          ...(bank?.currency === 'MXN' && { clabeNumber }),
          ...(bank?.currency === 'CNY' && { cnapsCode }),
          ...(bank?.currency === 'BRL' && { pixCode }),
          ...(bank?.currency === 'HKD' && { clearingCode }),
          ...(bicSwift && { bicSwift }),
          accountType: type,
          bankMethod: getPaymentMethodByCurrency(bank?.currency as string) || '',
          isThirdParty: bank.country === userData?.country ? false : true
      
        }
      )

      if(account){
        const fiatAccount = await prisma.fiatAccount.create({
          data:{
            id: account.paymentAccountId,
            name: account.nickname,
            bank: account.externalBankAccount.bankName,
            accountNumber: accountNumber || sortCode || bsbNumber || institutionNumber || ifscCode || clabeNumber || cnapsCode || pixCode || clearingCode,
            currency: bank?.currency!,
            method:account.externalBankAccount.bankAccountPaymentMethod,
            country: userData?.country!,
            userId: user.id
          } 
        })
      }

      return res
        .status(200)
        .json({
          msg: 'Account Added Successfully',
          success: true,
          account
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

  async addCryptoAccount(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      currency,
      chain,
      address
    } = req.body

    try {

      if(!chain || !address){
        return res.status(400)
        .json({
          msg: 'Incomplete Details',
          success: false,
        });
      }

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      if(!userData){
        return res.status(400)
          .json({
            msg: 'User not found',
            success: false,
          });
      }
  
      const account = await fernService.cryptoAccount(
        {
          userId:user.id,
          chain,
          address      
        }
      )

      if(account){

        await prisma.cryptoAccount.create({
          data:{
            id: account.paymentAccountId,
            name: `${currency} ${account.nickname}`,
            cryptoWalletType: account.externalCryptoWallet.cryptoWalletType,
            chain:account.externalCryptoWallet.chain,
            address:account.externalCryptoWallet.address,   
            userId: user.id
          }
        })

      }

      
      return res
        .status(200)
        .json({
          msg: 'Account Linked Successfully',
          success: true,
          account
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

  async generateQuote(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {
      destination,
      source
    } = req.body

    try {

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      if(!userData){
        return res.status(400)
          .json({
            msg: 'User not found',
            success: false
          });
      }

      // const fromCurrency = source.sourceType === 'CRYPTO' 
      // ? source.sourceCurrency 
      // : 'USD';
      // const toCurrency = source.sourceType === 'CRYPTO' 
      // ? 'USD' 
      // : source.sourceCurrency;

      const rate = await walletService.getRate(source.sourceCurrency as string,'USD')
      // Calculate 4.5% of the 
      
      // const fee = (rate.value * source.sourceAmount * 0.045).toFixed(2);
      const fee = calculateFee(rate.value * source.sourceAmount)
     

      console.log('my rate',rate.value)
      console.log('my fee',fee)

      if(Number(fee) < 0.3){
        return res
        .status(400)
        .json({
          msg: 'Amount below minimum',
          success: false
        });
      }
  
      const quote = await fernService.generateQuote(
        {
          customerId: userData?.fernUserId!,
          source,
          destination,
          developerFee: {
            developerFeeType: "USD",
            developerFeeAmount: `${fee}`
          }
        }
      )

      if(quote){
        return res
        .status(200)
        .json({
          msg: 'Quote generated Successfully',
          success: true,
          quote,
          fee
        });
      }else{

        return res
        .status(400)
        .json({
          msg: 'operation failed',
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

  async initiateSwap(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {quoteId} = req.body

    try {

      // if(!chain || !address){
      //   return res.status(400)
      //   .json({
      //     msg: 'Incomplete Details',
      //     success: false,
      //   });
      // }

      const userData = await prisma.user.findUnique({
        where: { id: user.id }
      })

      if(!userData){
        return res.status(400)
          .json({
            msg: 'User not found',
            success: false
          });
      }
  
      const transaction = await fernService.initTransaction({quoteId})

      if(transaction){

        await prisma.swap.create({
          data:{
            id: transaction.transactionId,
            userId: userData?.id,
            status: transaction.transactionStatus,
            sourceCurrency: transaction.source?.sourceCurrency?.label,
            destinationCurrency:transaction?.destination?.destinationCurrency?.label,
            rate: parseFloat(transaction?.destination?.exchangeRate),
            sourceAmount: parseFloat(transaction?.source?.sourceAmount),
            destinationAmount: parseFloat(transaction?.destination?.destinationAmount),
            fee: parseFloat(transaction?.fees?.developerFee?.feeAmount) + parseFloat(transaction?.fees?.fernFee?.feeAmount)
          }
        })

        return res
        .status(200)
        .json({
          msg: 'transaction Initiated Successfully',
          success: true,
          transaction
        });

      }else{

        return res
        .status(400)
        .json({
          msg: 'operation failed',
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

  async fetchSwaps(req: Request | any, res: Response) {
    const { currency } = req.query;
    const { user } = req;

    console.log(req.query)

    try {
      // Build the where clause dynamically
      const whereClause: any = {
        userId: user.id,
        ...(currency && { sourceCurrency:currency })
      };

      const totalCount = await prisma.swap.count({
        where: whereClause
      });

      const swaps = await prisma.swap.findMany({
        where: whereClause,
        take: 20,
        orderBy: {
          createdAt: 'desc'  // newest orders first
        }
      });

      return res.status(200).json({
        msg: 'Successful',
        success: true,
        totalCount,
        swaps
      });

    } catch (error) {
      console.error(error);
      return res.status(500).send({ 
        msg: 'Internal Server Error', 
        success: false
      });
    }
  }

  async fetchSwap(req: Request | any, res: Response) {
    const { id } = req.params;

    console.log(req.query)

    if(!id){
      return res.status(400)
        .json({
          msg: 'swap id is required',
          success: false,
        });
    }

    try {
      // Build the where clause dynamically

      const swap = await prisma.swap.findUnique({
        where:{id}
      });

      if(!swap){
        return res.status(404)
          .json({
            msg: 'transaction not found',
            success: false,
          });
      }

      const result = await fernService.getTransaction(swap?.id)
      await prisma.swap.update({
        where:{id:swap?.id},
        data:{status:result?.transactionStatus}
      })

      return res.status(200).json({
        msg: 'Successful',
        success: true,
        transaction: result
      });

    } catch (error) {
      console.error(error);
      return res.status(500).send({ 
        msg: 'Internal Server Error', 
        success: false
      });
    }
  }


  async getLinkedAccounts(req: Request & Record<string, any>, res: Response) {
    const { type } = req.query;

    const { user } = req;

    try {
      console.log('query',req.query)

      let Accounts;

      if(!type){
        return res.status(400)
          .json({
            msg: 'Account type required',
            success: false,
          });
      }

      if (type && type == 'FIAT') {
        Accounts = await prisma.fiatAccount.findMany({
          where:{userId: user.id}
        })

      }

      if (type && type == 'CRYPTO') {
        Accounts = await prisma.cryptoAccount.findMany({
          where:{userId: user.id}
        })

      }

      
      return res
        .status(200)
        .json({
          msg:`Accounts fetched successfully`,
          success: true,
          accounts: Accounts,
      });


    } catch (error) {
      console.log(error);
      res.status(500).send(error);
    }
  }

  async deletePaymentAccount(req: Request & Record<string, any>, res: Response) {
    const user = req.user
    const accountId = req.params.accountId

    try {

      const success = await accountService.deleteAccountById(accountId)
        
      if(!success){
        return res.status(400).json({
          msg: 'Operation not successful',
          success: false
        });
      }

      return res.status(201).json({
          msg: 'Payment Account deleted',
          success: true,
      });

    } catch (error) {
        return res
            .status(500)
            .json({ msg: 'Internal Server Error', success: false, error });
    }
}

  // async init_BankDeposit(req: Request & Record<string, any>, res: Response) {
  //   const { user } = req;
  //   const {currency,amount} = req.body

  //   if(!currency || !amount){
  //     return res.status(400)
  //       .json({
  //         msg: 'required details missing',
  //         success: false,
  //       });
  //   }

  //   try {

  //     const userData = await prisma.user.findUnique({
  //       where: { id: user.id }
  //     })

  //     const wallet = await prisma.wallet.findFirst({
  //       where:{
  //         userId:userData?.id,
  //         currency
  //       }
  //     })
  
  //     const payment = await walletService.depositFiat
  //     (
  //       currency,
  //       amount,
  //       userData?.email!,
  //       userData?.id!, 
  //       wallet?.id!
  //     )
  
  //     return res
  //       .status(200)
  //       .json({
  //         msg: 'Deposit initiated Successfully',
  //         success: true,
  //         payment
  //       });

  //   } catch (error) {
  //     console.log(error)
  //     res.status(500)
  //       .json({
  //         msg: 'Internal Server Error',
  //         success: false,
  //       });
  //   }
  // }

  async authorize_fiat_Withdrawal(req: Request & Record<string, any>, res: Response) {
    const { user } = req;
    const {currency, amount} = req.body

    console.log(req.body)

    if(!currency || !amount){
      return res.status(400)
        .json({
          msg: 'required details missing',
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
          currency
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
  
      const payUrl = await walletService.authorize_Withdrawal(currency, amount, userData?.email!, userData?.phoneNumber!)

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

  

 
}

export default new SwapController();