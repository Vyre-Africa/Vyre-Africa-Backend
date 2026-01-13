import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import axios from "axios";
import stablecoinService from './stablecoin.service';
import nativecoinService from './nativecoin.service';
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
import qorepayService from './qorepay.service';
import { hasSufficientBalance } from '../utils';
import transferfeeService from './transferfee.service';
import { Queue } from 'bullmq';
import notificationService from './notification.service';
import IORedis from 'ioredis';
import connection from '../config/redis.config';
import { currency } from '../globals';
import Decimal from 'decimal.js';
import logger from '../config/logger';
import { DecimalUtil } from './decimal.util';

// import connection from '../config/redis.config';


    const tatumAxios = axios.create({
        baseURL: 'https://api.tatum.io/v3',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
    });

    const tatumAxiosV4 = axios.create({
        baseURL: 'https://api.tatum.io/v4',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
    });

    const qorepayAxios = axios.create({
        baseURL: 'https://gate.qorepay.com/api/v1',
        headers: {
            'accept':'application/json',
            'authorization': `Bearer ${config.QOREPAY_BEARER_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    // const connection = new IORedis({
    //     host: "13.244.198.250", // IP address
    //     port: 6379,
    //     password: "ATXcAAIncDI1Y2MzYTJhODc3ZjA0MzVkYmM2NjBlMDRmMmRiNGQ3ZHAyMTM3ODg",
    //     connectTimeout: 15000,
    //     tls: {
    //         servername: 'ideal-hedgehog-13788.upstash.io', // IMPORTANT!
    //     },
    //     maxRetriesPerRequest: 3,
    // });

class WalletService
{    

    private generalQueue: Queue;
    
    constructor() {
        // Initialize the processing queue
        this.generalQueue = new Queue('general-process', {
            connection, // Type assertion if necessary
        });
    }

    // Add these methods to the WalletService class

    /**
     * Aggregate total value of all fiat wallets for a user in a specified fiat currency
     * @param userId - User ID
     * @param targetCurrency - Target fiat currency ISO code (e.g., 'NGN', 'USD')
     * @returns Total value in target currency with locked balances
     */
    async aggregateFiatWallets(userId: string, targetCurrency: string = 'USD'): Promise<{
        totalValue: string;
        totalAccountBalance: string;
        lockedValue: string;
        targetCurrency: string;
        wallets: Array<{
            walletId: string;
            currency: string;
            availableBalance: string;
            accountBalance: string;
            lockedBalance: string;
            valueInTarget: string;
            rate: string;
        }>;
    }> {
        try {
            // Fetch all fiat wallets for the user
            const wallets = await prisma.wallet.findMany({
                where: {
                    userId,
                    currency: {
                        isStablecoin: false,
                        type: 'FIAT'
                    }
                },
                include: {
                    currency: {
                        select: {
                            ISO: true,
                            name: true
                        }
                    }
                }
            });

            if (wallets.length === 0) {
                return {
                    totalValue: '0.00',
                    totalAccountBalance: '0.00',
                    lockedValue: '0.00',
                    targetCurrency,
                    wallets: []
                };
            }

            let totalValue = new Decimal(0);
            let totalAccountBalance = new Decimal(0);
            let totalLockedValue = new Decimal(0);
            
            const walletDetails: Array<{
                walletId: string;
                currency: string;
                availableBalance: string;
                accountBalance: string;
                lockedBalance: string;
                valueInTarget: string;
                rate: string;
            }> = [];

            // Process each wallet
            for (const wallet of wallets) {
                const availableBalance = new Decimal(wallet.availableBalance || 0);
                const accountBalance = new Decimal(wallet.accountBalance || 0);
                const lockedBalance = accountBalance.minus(availableBalance);
                
                let rate: string;

                // If wallet currency is same as target, no conversion needed
                if (wallet.currency?.ISO === targetCurrency) {
                    rate = '1.00';
                } else {
                    // Fetch exchange rate
                    try {
                        const rateData = await this.getRate(wallet.currency?.ISO as string, targetCurrency);
                        const exchangeRate = new Decimal(rateData.value);
                        rate = exchangeRate.toFixed(2);
                    } catch (error) {
                        logger.error('Failed to fetch rate for fiat wallet', {
                            walletId: wallet.id,
                            from: wallet.currency?.ISO,
                            to: targetCurrency,
                            error
                        });
                        // Skip this wallet if rate fetch fails
                        continue;
                    }
                }

                const exchangeRate = new Decimal(rate);
                const availableValueInTarget = availableBalance.mul(exchangeRate);
                const accountValueInTarget = accountBalance.mul(exchangeRate);
                const lockedValueInTarget = lockedBalance.mul(exchangeRate);

                totalValue = totalValue.add(availableValueInTarget);
                totalAccountBalance = totalAccountBalance.add(accountValueInTarget);
                totalLockedValue = totalLockedValue.add(lockedValueInTarget);

                walletDetails.push({
                    walletId: wallet.id,
                    currency: wallet.currency?.ISO as string,
                    availableBalance: availableBalance.toFixed(2),
                    accountBalance: accountBalance.toFixed(2),
                    lockedBalance: lockedBalance.toFixed(2),
                    valueInTarget: availableValueInTarget.toFixed(2),
                    rate
                });
            }

            logger.info('Fiat wallets aggregated', {
                userId,
                targetCurrency,
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                walletCount: wallets.length
            });

            return {
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                targetCurrency,
                wallets: walletDetails
            };

        } catch (error: any) {
            logger.error('Failed to aggregate fiat wallets', {
                userId,
                targetCurrency,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Aggregate total value of all crypto wallets for a user in a specified fiat currency
     * @param userId - User ID
     * @param targetCurrency - Target fiat currency ISO code (e.g., 'NGN', 'USD')
     * @returns Total value in target currency with locked balances
     */
    async aggregateCryptoWallets(userId: string, targetCurrency: string = 'USD'): Promise<{
        totalValue: string;
        totalAccountBalance: string;
        lockedValue: string;
        targetCurrency: string;
        wallets: Array<{
            walletId: string;
            currency: string;
            availableBalance: string;
            accountBalance: string;
            lockedBalance: string;
            valueInTarget: string;
            rate: string;
            isStablecoin: boolean;
        }>;
    }> {
        try {
            // Fetch all crypto wallets for the user (including stablecoins)
            const wallets = await prisma.wallet.findMany({
                where: {
                    userId,
                    currency: {
                        type: 'CRYPTO'
                    }
                },
                include: {
                    currency: {
                        select: {
                            ISO: true,
                            name: true,
                            isStablecoin: true
                        }
                    }
                }
            });

            if (wallets.length === 0) {
                return {
                    totalValue: '0.00',
                    totalAccountBalance: '0.00',
                    lockedValue: '0.00',
                    targetCurrency,
                    wallets: []
                };
            }

            let totalValue = new Decimal(0);
            let totalAccountBalance = new Decimal(0);
            let totalLockedValue = new Decimal(0);
            
            const walletDetails: Array<{
                walletId: string;
                currency: string;
                availableBalance: string;
                accountBalance: string;
                lockedBalance: string;
                valueInTarget: string;
                rate: string;
                isStablecoin: boolean;
            }> = [];

            // Process each wallet
            for (const wallet of wallets) {
                const availableBalance = new Decimal(wallet.availableBalance || 0);
                const accountBalance = new Decimal(wallet.accountBalance || 0);
                const lockedBalance = accountBalance.minus(availableBalance);
                
                let rate: string;

                // Fetch exchange rate from crypto to target fiat
                try {
                    const rateData = await this.getRate(wallet?.currency?.ISO as string, targetCurrency);
                    const exchangeRate = new Decimal(rateData.value);
                    rate = exchangeRate.toFixed(2);
                } catch (error) {
                    logger.error('Failed to fetch rate for crypto wallet', {
                        walletId: wallet.id,
                        from: wallet?.currency?.ISO as string,
                        to: targetCurrency,
                        error
                    });
                    // Skip this wallet if rate fetch fails
                    continue;
                }

                const exchangeRate = new Decimal(rate);
                const availableValueInTarget = availableBalance.mul(exchangeRate);
                const accountValueInTarget = accountBalance.mul(exchangeRate);
                const lockedValueInTarget = lockedBalance.mul(exchangeRate);

                totalValue = totalValue.add(availableValueInTarget);
                totalAccountBalance = totalAccountBalance.add(accountValueInTarget);
                totalLockedValue = totalLockedValue.add(lockedValueInTarget);

                walletDetails.push({
                    walletId: wallet.id,
                    currency: wallet.currency?.ISO as string,
                    availableBalance: DecimalUtil.roundForDisplay(availableBalance, wallet.currency?.ISO as string),
                    accountBalance: DecimalUtil.roundForDisplay(accountBalance, wallet.currency?.ISO as string),
                    lockedBalance: DecimalUtil.roundForDisplay(lockedBalance, wallet.currency?.ISO as string),
                    valueInTarget: availableValueInTarget.toFixed(2),
                    rate,
                    isStablecoin: wallet?.currency?.isStablecoin as boolean
                });
            }

            logger.info('Crypto wallets aggregated', {
                userId,
                targetCurrency,
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                walletCount: wallets.length
            });

            return {
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                targetCurrency,
                wallets: walletDetails
            };

        } catch (error: any) {
            logger.error('Failed to aggregate crypto wallets', {
                userId,
                targetCurrency,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Aggregate total value of ALL wallets (fiat + crypto) for a user in a specified fiat currency
     * @param userId - User ID
     * @param targetCurrency - Target fiat currency ISO code (e.g., 'NGN', 'USD')
     * @returns Combined total value in target currency with locked balances
     */
    async aggregateAllWallets(userId: string, targetCurrency: string = 'USD'): Promise<{
        totalValue: string;
        totalAccountBalance: string;
        lockedValue: string;
        targetCurrency: string;
        fiatTotal: string;
        fiatAccountBalance: string;
        fiatLockedValue: string;
        cryptoTotal: string;
        cryptoAccountBalance: string;
        cryptoLockedValue: string;
        totalInDefaultCurrency: string;
        lockedInDefaultCurrency: string;
        breakdown: {
            fiat: Array<{
                walletId: string;
                currency: string;
                availableBalance: string;
                accountBalance: string;
                lockedBalance: string;
                valueInTarget: string;
                rate: string;
            }>;
            crypto: Array<{
                walletId: string;
                currency: string;
                availableBalance: string;
                accountBalance: string;
                lockedBalance: string;
                valueInTarget: string;
                rate: string;
                isStablecoin: boolean;
            }>;
        };
    }> {
        try {
            // Aggregate both fiat and crypto wallets in parallel
            const [fiatResult, cryptoResult, defaultRate] = await Promise.all([
                this.aggregateFiatWallets(userId, targetCurrency),
                this.aggregateCryptoWallets(userId, targetCurrency),
                this.getRate(targetCurrency, 'USD') // Fetch default rate for logging;
            ]);

            const defaultRateDecimal = new Decimal(defaultRate.value);

            const totalValue = new Decimal(fiatResult.totalValue)
                .add(new Decimal(cryptoResult.totalValue));
            
            const totalAccountBalance = new Decimal(fiatResult.totalAccountBalance)
                .add(new Decimal(cryptoResult.totalAccountBalance));
            
            const totalLockedValue = new Decimal(fiatResult.lockedValue)
                .add(new Decimal(cryptoResult.lockedValue));

            const totalInDefaultCurrency = totalAccountBalance.mul(defaultRateDecimal);
            const lockedInDefaultCurrency = totalAccountBalance.mul(defaultRateDecimal);

            logger.info('All wallets aggregated', {
                userId,
                targetCurrency,
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                fiatTotal: fiatResult.totalValue,
                cryptoTotal: cryptoResult.totalValue
            });

            return {
                totalValue: totalValue.toFixed(2),
                totalAccountBalance: totalAccountBalance.toFixed(2),
                lockedValue: totalLockedValue.toFixed(2),
                targetCurrency,
                fiatTotal: fiatResult.totalValue,
                fiatAccountBalance: fiatResult.totalAccountBalance,
                fiatLockedValue: fiatResult.lockedValue,
                cryptoTotal: cryptoResult.totalValue,
                cryptoAccountBalance: cryptoResult.totalAccountBalance,
                cryptoLockedValue: cryptoResult.lockedValue,
                totalInDefaultCurrency: totalInDefaultCurrency.toFixed(2),
                lockedInDefaultCurrency: lockedInDefaultCurrency.toFixed(2),
                breakdown: {
                    fiat: fiatResult.wallets,
                    crypto: cryptoResult.wallets
                }
            };

        } catch (error: any) {
            logger.error('Failed to aggregate all wallets', {
                userId,
                targetCurrency,
                error: error.message
            });
            throw error;
        }
    }



    private complete_Withdrawal = async(
        withdrawal_Id: string,
        txId: string
    )=>{

        await tatumAxios.put(`/offchain/withdrawal/${withdrawal_Id}/${txId}`)

        const updatedTransaction = await prisma.transaction.update({
            where:{id: withdrawal_Id },
            data:{
              status:'SUCCESSFUL',
            }
        })

        return updatedTransaction

    }


    private Withdraw_USDC_ETH = async(
        userId: string, 
        account_ID: string,
        address: string,
        amount: number,
    )=>{
        const data = {
            senderAccountId: account_ID,
            mnemonic: config.USDT.ETH_MNEMONIC,
            index: 1,
            address,
            amount
        };

        let transaction;

        const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', data)
        console.log(response)
        const result = response.data

        transaction = await prisma.transaction.create({
            data:{
                id: result.id,
                userId: userId,
                currency: 'USDC',
                amount,
                status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                walletId: account_ID,
                type:'DEBIT_PAYMENT',
                description:'USD COIN transfer'
            }
        })

        if(!result.completed){
            transaction = await this.complete_Withdrawal(result.id, result.txId)
        }

        return transaction

        
    }

    
    async subscribe_address(payload:{
        address: string,
        chain: string
    }){

        const data = {
            type:"ADDRESS_EVENT",
            attr:{
               address: payload.address,
               chain: payload.chain,
               url:"https://api-dev.vyre.africa/api/v1/webhook/tatum" //The URL of the webhook listener you are using
               }
            }

        const subscribed = await tatumAxiosV4.post('/subscription', data)

        // const subcribed = await prisma.transaction.update({
        //     where:{id: withdrawal_Id },
        //     data:{
        //       status:'SUCCESSFUL',
        //     }
        // })

        return subscribed.data.id

    }


    async createWallet(payload:{userId:string, currencyId:string})
    {
        const {userId, currencyId} = payload

        const walletExists = await prisma.wallet.findFirst({
            where: { 
                userId,
                currencyId
            }
        })

        if(walletExists)return walletExists

        const currency = await prisma.currency.findUnique({
            where:{id:currencyId},
            select:{
              id: true,
              type: true,
              name: true,
              ISO: true,
              chain: true,
              isStablecoin: true
            }
              
        })

        if(!currency){
            const error = new Error('currency not found');
            error.name = 'CurrencyNotFoundError';
            throw error;
        }

        let result;

        if(currency.isStablecoin){

            switch (currency.ISO) {

                case 'USDC':
                 result = await stablecoinService.create_USDC_wallet(currency.chain!, userId, currency.id)
                return result
                break;

                case 'USDT':
                 result = await stablecoinService.create_Tether_wallet(currency.chain!, userId, currency.id)
                return result
                break;

                default:
                return
            }

        }else{

          result = await nativecoinService.createWallet(currency.ISO, userId, currency.id)
          return result
        }

        
    }

    async blockchain_Transfer(payload:{
        userId: string, 
        currencyId:string,
        amount: string,
        address: string,
        destination_Tag?: number
    })
    {
        const {userId,currencyId,amount,address,destination_Tag} = payload

        const currency = await prisma.currency.findUnique({
            where:{id:currencyId},
            select:{
              id: true,
              type: true,
              name: true,
              ISO: true,
              chain: true,
              isStablecoin: true
            }
              
        })


        if(!currency){
            const error = new Error('currency not found');
            error.name = 'CurrencyNotFoundError';
            throw error;
        }

        const wallet = await prisma.wallet.findFirst({
            where:{
                userId,
                currencyId
            }
        })

        if(!wallet)return
        let result;

        if(currency.isStablecoin){

            const isvalid = transferfeeService.isValidWithdrawal(currency?.chain as any,Number(amount))

            if(!isvalid){
                const error = new Error('Withdrawal amount below minimum');
                error.name = 'Amount Below Minimum';
                throw error;
            }



            switch (currency.ISO) {

                case 'USDC':

                    result = await stablecoinService.Transfer_USDC({
                        chain: currency?.chain as string, 
                        userId, 
                        walletId: wallet.id,
                        amount,
                        index: wallet?.derivationKey as number,
                        address
                    })

                return result
                break;

                case 'USDT':

                    result = await stablecoinService.Transfer_Tether({
                        chain: currency?.chain as string, 
                        userId, 
                        walletId: wallet.id,
                        amount,
                        index: wallet?.derivationKey as number,
                        address
                    })

                return result
                break;

                default:
                return
            }


        }else{

            result = await nativecoinService.blockchain_Transfer({
                ISO:currency.ISO, 
                userId, 
                walletId: wallet?.id,
                amount,
                index: wallet?.derivationKey as number,
                address,
                destination_Tag
            })

        }


    
    }

    async offchain_Transfer(payload: {
        userId: string;
        receipientId: string;
        currencyId: string;
        amount: string; // ✅ Changed to string
    }) {
        const { userId, receipientId, currencyId, amount } = payload;

        try {
            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new Decimal(amount);

            // Validate amount
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }

            logger.info('Offchain transfer initiated', {
                userId,
                receipientId,
                currencyId,
                amount: amountDecimal.toString()
            });

            // Fetch currency details
            const currency = await prisma.currency.findUnique({
                where: { id: currencyId },
                select: {
                    id: true,
                    type: true,
                    name: true,
                    ISO: true,
                    chain: true
                }
            });

            if (!currency) {
                const error = new Error('Currency not found');
                error.name = 'CurrencyNotFoundError';
                throw error;
            }

            let receipient_Wallet:any;

            // Fetch or create recipient wallet
            receipient_Wallet = await prisma.wallet.findFirst({
                where: {
                    userId: receipientId,
                    currencyId
                },
                select: {
                    id: true,
                    userId: true,
                    currencyId: true,
                    availableBalance: true,
                    accountBalance: true
                }
            });

            if (!receipient_Wallet) {
                logger.info('Creating recipient wallet', { receipientId, currencyId });
                receipient_Wallet = await this.createWallet({
                    userId: receipientId,
                    currencyId: currencyId as string
                });
            }

            // Fetch user wallet
            const user_Wallet = await prisma.wallet.findFirst({
                where: {
                    userId,
                    currencyId
                },
                select: {
                    id: true,
                    userId: true,
                    currencyId: true,
                    availableBalance: true,
                    accountBalance: true
                }
            });

            if (!user_Wallet) {
                throw new Error('User wallet not found');
            }

            // ✅ Check balance with Decimal comparison
            const availableBalance = new Decimal(user_Wallet.availableBalance);

            logger.info('Balance check for offchain transfer', {
                userId,
                availableBalance: availableBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                currency: currency.ISO
            });

            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(
                    `Insufficient balance for offchain transfer. Available: ${availableBalance.toFixed(8)} ${currency.ISO}, Required: ${amountDecimal.toFixed(8)} ${currency.ISO}`
                );
            }

            // Prepare transfer data
            const data = {
                senderAccountId: user_Wallet.id,
                recipientAccountId: receipient_Wallet.id,
                amount: DecimalUtil.roundForDisplay(amountDecimal,currency.ISO), // ✅ String for API
                anonymous: false,
                compliant: false
            };

            logger.info('Executing offchain transfer', {
                from: user_Wallet.id,
                to: receipient_Wallet.id,
                amount: amountDecimal.toString(),
                currency: currency.ISO
            });

            // Execute transfer
            const response = await tatumAxios.post('/ledger/transaction', data);
            const paymentData = response.data;

            logger.info('Offchain transfer response', {
                reference: paymentData.reference,
                status: paymentData.status
            });

            // Sync both wallets in parallel
            await Promise.all([
                this.getAccount(user_Wallet.id),
                this.getAccount(receipient_Wallet.id)
            ]);

            logger.info('Wallets synced after transfer');

            // ✅ Create transaction records for both parties
            const transactions = await prisma.transaction.createMany({
                data: [
                    // Debit transaction for sender
                    {
                        userId: userId,
                        currency: currency.ISO,
                        amount: amountDecimal.negated(), // ✅ Negative for debit (Prisma accepts Decimal)
                        reference: paymentData.reference,
                        status: 'SUCCESSFUL',
                        walletId: user_Wallet.id,
                        type: 'DEBIT_PAYMENT',
                        description: `${currency.name} transfer to ${receipientId.slice(0, 8)}`,
                        metadata: {
                            recipientId: receipientId,
                            recipientWalletId: receipient_Wallet.id,
                            currency: currency.ISO,
                            transferType: 'offchain'
                        }
                    },
                    // Credit transaction for recipient
                    {
                        userId: receipientId, // ✅ Fixed: was using sender's userId
                        currency: currency.ISO,
                        amount: amountDecimal, // ✅ Positive for credit (Prisma accepts Decimal)
                        reference: paymentData.reference,
                        status: 'SUCCESSFUL',
                        walletId: receipient_Wallet.id, // ✅ Fixed: was using sender's wallet
                        type: 'CREDIT_PAYMENT',
                        description: `${currency.name} transfer from ${userId.slice(0, 8)}`,
                        metadata: {
                            senderId: userId,
                            senderWalletId: user_Wallet.id,
                            currency: currency.ISO,
                            transferType: 'offchain'
                        }
                    }
                ]
            });

            logger.info('Offchain transfer completed successfully', {
                transactionCount: transactions.count,
                reference: paymentData.reference,
                amount: amountDecimal.toString(),
                currency: currency.ISO
            });

            return {
                success: true,
                reference: paymentData.reference,
                amount: amountDecimal.toString(),
                currency: currency.ISO,
                transactionCount: transactions.count,
                senderWallet: user_Wallet.id,
                recipientWallet: receipient_Wallet.id
            };

        } catch (error: any) {
            logger.error('Offchain transfer failed', {
                error: error.message,
                userId,
                receipientId,
                currencyId,
                amount,
                stack: error.stack
            });
            throw error;
        }
    }

    async bank_Transfer(payload:{
        account_number: string,
        bank_code: string, 
        recipient_name: string,
        endpoint: string
    })
    {
        const {account_number,bank_code,recipient_name,endpoint} = payload

        const data = {
            account_number,
            bank_code,
            recipient_name
        }

        const response = await axios.post(endpoint, data)
        console.log('qorepay transfer response',response.data)
        const result = response.data

        return result
    }

    private async processMomoPayment(payload: any) {
        // Implement MOMO payment
        throw new Error('MOMO payment not implemented');
    }

    /**
     * Initiate bank withdrawal notifying the user
    */
    async direct_bank_Transfer(payload:{
        userId:string,
        currencyId:string,

        amount:string,
        email:string, 
        phone:string,
     
        account_number: string,
        bank_code: string, 
        recipient_name: string
     
    })
    {
        const {amount,currencyId, userId} = payload

        const wallet = await prisma.wallet.findFirst({
            where:{
             userId:userId,
             currencyId
            },
            include:{
              currency: true
            }
        })

        if(!wallet){

        }

        const result = await qorepayService.bank_Transfer({...payload, currency: wallet?.currency?.ISO as string})

        console.log('---------Wallet to bank withdrawal initiated--------')

        // deduct amount from wallet
        // // debit user wallet
        await this.debit_Wallet(amount as any, wallet?.id as string)

        // record transaction
        await prisma.transaction.create({
            data:{
              userId,
              currency: wallet?.currency?.ISO,
              amount,
              reference: result.id,
              status: 'PENDING',
              walletId: wallet?.id,
              type:'FIAT_WITHDRAWAL',
              description:`${currency} bank withdrawal transfer`
            }
        })

        return result
    }

    async depositFiat(payload:{
        currency: string,
        amount: number, 
        email: string,
        userId: string,
        walletId: string,
        method?: string
    })
    {
        const { currency, amount, email, userId, walletId, method } = payload
        
        // const details = await qorepayService.deposit_via_Url({
        //     currency,
        //     amount, 
        //     email,
        //     userId,
        //     walletId
        // })

        const details = await qorepayService.deposit_via_Bank({
            currency,
            amount, 
            email,
            userId,
            walletId
        })
    
        return details
    }

    /**
     * process and returns preferred method details for payment for anonymous order
    */
    async getPaymentMethod(payload: {
        currency: string;
        amount: number;
        email: string;
        userId: string;
        walletId: string;
        method?: string;
    }) {
        const { method = 'BANK_TRANSFER' } = payload;

        // Add timeout to prevent hanging
        const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Payment method timeout')), 8000)
        );

        try {
        switch (method) {
            case 'BANK_TRANSFER':
            return await Promise.race([
                qorepayService.deposit_via_Bank(payload),
                timeoutPromise
            ]);

            case 'MOMO':
            return await Promise.race([
                this.processMomoPayment(payload),
                timeoutPromise
            ]);

            default:
            return await Promise.race([
                qorepayService.deposit_via_Bank(payload),
                timeoutPromise
            ]);
        }
        } catch (error) {
        logger.error('Payment method failed:', { method, error });
          throw error;
        }
    }


    async getRate(currency: string, basePair: string) {
        const response = await tatumAxios.get(`/tatum/rate/${currency}?basePair=${basePair}`);
        const result = response.data;
        console.log('fetched rate',result)
        try {
            // ✅ Use Decimal for financial calculations
            const value = new Decimal(result.value);
            
            return {
                ...result,
                value: value.toFixed(2), // Decimal's toFixed works correctly
                rawValue: value.toString() // Keep full precision
            };
        } catch (error) {
            throw new Error(`Invalid rate value received: ${result.value}`);
        }
    }

    /**
     * Sync and returns wallet data including balances
    */
    async getAccount(id: string) {
        try {
            // ✅ Single query - fetch Tatum data with wallet info in one transaction
            const [tatumResponse, wallet] = await Promise.all([
                tatumAxios.get(`/ledger/account/${id}`),
                prisma.wallet.findUnique({
                    where: { id },
                    select: {
                        id: true,
                        currency: {
                            select: {
                                ISO: true,
                                isStablecoin: true
                            }
                        }
                    }
                })
            ]);

            if (!wallet) throw new Error(`Wallet ${id} not found`);

            const result = tatumResponse.data;
            const currencyISO = wallet.currency?.ISO || 'BTC';

            // ✅ Round balances (in-memory, fast)
            const accountBalance = DecimalUtil.roundForDisplay(
                result.balance?.accountBalance || 0,
                currencyISO
            );

            const availableBalance = DecimalUtil.roundForDisplay(
                result.balance?.availableBalance || 0,
                currencyISO
            );

            // ✅ Single update with all data
            return await prisma.wallet.update({
                where: { id },
                data: {
                    frozen: result.frozen,
                    accountBalance,
                    availableBalance,
                    updatedAt: new Date()
                },
                include: {
                    currency: {
                        select: {
                            id: true,
                            name: true,
                            ISO: true,
                            type: true,
                            imgUrl: true,
                            chain: true,
                            chainImgUrl: true,
                            flagEmoji: true,
                            isStablecoin: true
                        }
                    }
                }
            });

        } catch (error: any) {
            logger.error('Wallet sync failed', {
                walletId: id,
                error: error.message
            });
            throw error;
        }
    }

    async authorize_Withdrawal(currency: string,amount:number, email:string, phone:string)
    {
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

        const response = await qorepayAxios.post(`/payouts/`, data)
        console.log('first response',response.data)
        const result = response.data

        const registered = await axios.get(result?.execution_url)
        const payment = registered.data

        // const paymentDetails ={
        //     banks: payment?.detail.data,
        //     url: payment?.payout_url,
        // }

        if(payment?.status === 'error'){
            return null
        }

        return payment?.payout_url
    }

    async debit_Wallet(amount: number, accountId: string){

        const data = {
            accountId,
            amount
        };

        const response = await tatumAxios.put('/ledger/virtualCurrency/revoke', data)
        const responseData = response.data
        console.log(responseData.reference)

        return responseData.reference
        
    }

    async credit_Wallet(amount: number, accountId: string){

        const data = {
            accountId,
            amount:String(amount)
        };

        console.log('crediting wallet', accountId)

        const response = await tatumAxios.put('/ledger/virtualCurrency/mint', data)
        const responseData = response.data
        console.log(responseData.reference)
        // sync wallet
        const wallet = await this.getAccount(accountId)

        return wallet
    }

    // async handleFiatCredit(payload:{amount:number,accountId: string}){
    //     const {amount, accountId} = payload

    //     await this.credit_Wallet(amount,accountId)

        
    // }

    async block_Amount(amount: number, accountId: string){

        const data = {
            amount: String(amount),
            type:'ORDER_BLOCK',
            description:'order amount blocked',
            ensureSufficientBalance: true
        };

        const response = await tatumAxios.post(`https://api.tatum.io/v3/ledger/account/block/${accountId}`, data)
        const responseData = response.data
        console.log(responseData.id)

        const record = await prisma.block.create({
            data:{
                id: responseData.id,
                walletId: accountId,
                amount,
                description:'order amount blocked'
            }
        })

        console.log('amount blocked')

        return responseData.id
        
    }

    async unblock_Transfer(amount:number | string, blockId:string, recipientAccountId:string){

        const data = {
            recipientAccountId,
            amount: String(amount),
            anonymous: true,
            compliant: false
        };

        const response = await tatumAxios.put(`https://api.tatum.io/v3/ledger/account/block/${blockId}`, data)
        const responseData = response.data
        console.log(responseData.reference)

        // sync wallet 
        const wallet = await this.getAccount(recipientAccountId)

        // const record = await prisma.block.create({
        //     data:{
        //         id: responseData.id,
        //         walletId: accountId,
        //         amount,
        //         description:'order amount blocked'
        //     }
        // })

        console.log('amount transferred')

        return wallet
        
    }

    async unblock_Amount(blockId:string){

        const response = await tatumAxios.delete(`https://api.tatum.io/v3/ledger/account/block/${blockId}`)
        const responseData = response.data
        console.log(responseData)

        await prisma.block.update({
            where:{id: blockId},
            data:{
              active: false
            }
        })

        return responseData.reference
        
    }

    async deletePaymentAccountById(accountId: string): Promise<boolean> {
        try {
          // First try to delete from fiat accounts
          const deletedFiatAccount = await prisma.fiatAccount.deleteMany({
            where: {
              id: accountId
            }
          })
      
          // If a fiat account was deleted, return true
          if (deletedFiatAccount.count > 0) {
            return true
          }
      
          // If no fiat account was found, try crypto accounts
          const deletedCryptoAccount = await prisma.cryptoAccount.deleteMany({
            where: {
              id: accountId
            }
          })
      
          // Return true if a crypto account was deleted
          return deletedCryptoAccount.count > 0
        } catch (error) {
          console.error('Error deleting account:', error)
          return false
        }
    }

    async queue(payload:{
        amount: number,
        address?: string,
        destination_Tag?: number

        userId?: string,
        receipientId?: string,
        currencyId?: string,


        currency?: string,
        email?:string, 
        phone?:string,
     
        account_number?: string,
        bank_code?: string, 
        recipient_name?: string


        type: 'OFFCHAIN' | 'BLOCKCHAIN' | 'BANK'
    }){

        const {
            amount,
            address,
            destination_Tag,

            userId,
            receipientId,
            currencyId,


            currency,
            email, 
            phone,
        
            account_number,
            bank_code, 
            recipient_name, 
            type
        } = payload

        if(type === 'OFFCHAIN'){
            return await this.generalQueue.add('offchain-transfer', {
                userId,
                receipientId,
                currencyId, 
                amount
            });
        }

        if(type === 'BLOCKCHAIN'){

            return await this.generalQueue.add('blockchain-transfer', {
                userId, 
                currencyId,
                amount,
                address,
                destination_Tag
            });
        }

        if(type === 'BANK'){

            return await this.generalQueue.add('bank-transfer', {
                userId,
                currencyId,
                amount,
                email, 
                phone,
            
                account_number,
                bank_code, 
                recipient_name
            });
        }

    }

   

    
}

export default new WalletService()