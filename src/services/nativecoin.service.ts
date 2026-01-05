import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import axios, { AxiosInstance } from "axios";
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
import { hasSufficientBalance } from '../utils';
import Decimal from 'decimal.js';
import logger from '../config/logger';

  type SupportedCoin = 'BTC' | 'ETH' | 'LTC' | 'TRON' | 'BNB' | 'XRP' | 'NGN' | 'USD';

  interface CoinConfig {
    tatumCurrency: string;
    transferEndpoint: string;
    webhookChain?: string; // Optional for fiat
    displayName: string;
    accountingCurrency: string;
    requiresIndex?: boolean;
    requiresDestinationTag?: boolean;
    authType: 'mnemonic' | 'privateKey' | 'secret' | 'none';
  }

   interface TransferPayload {
    userId: string;
    walletId: string;
    address: string;
    amount: string;
    index?: number;
    destinationTag?: number;
   }

    interface WalletCreationResult {
    id: string;
    depositAddress?: string;
    subscriptionId?: string;
    derivationKey?: number;
    destinationTag?: number;
   }

   // ============================================
    // COIN CONFIGURATIONS
    // ============================================

    class CoinConfigurations {

        private static CONFIGS: Record<SupportedCoin, CoinConfig> = {
            BTC: {
                tatumCurrency: 'BTC',
                transferEndpoint: '/offchain/bitcoin/transfer',
                webhookChain: 'bitcoin-mainnet',
                displayName: 'Bitcoin',
                accountingCurrency: 'USD',
                authType: 'mnemonic'
            },
            ETH: {
                tatumCurrency: 'ETH',
                transferEndpoint: '/offchain/ethereum/transfer',
                webhookChain: 'ethereum-mainnet',
                displayName: 'Ethereum',
                accountingCurrency: 'USD',
                requiresIndex: true,
                authType: 'mnemonic'
            },
            LTC: {
                tatumCurrency: 'LTC',
                transferEndpoint: '/offchain/litecoin/transfer',
                webhookChain: 'litecoin-mainnet',
                displayName: 'Litecoin',
                accountingCurrency: 'USD',
                authType: 'mnemonic'
            },
            TRON: {
                tatumCurrency: 'TRON',
                transferEndpoint: '/offchain/tron/transfer',
                webhookChain: 'tron-mainnet',
                displayName: 'Tron',
                accountingCurrency: 'USD',
                requiresIndex: true,
                authType: 'mnemonic'
            },
            BNB: {
                tatumCurrency: 'BNB',
                transferEndpoint: '/offchain/bnb/transfer',
                webhookChain: 'bsc-mainnet',
                displayName: 'BNB',
                accountingCurrency: 'USD',
                authType: 'privateKey'
            },
            XRP: {
                tatumCurrency: 'XRP',
                transferEndpoint: '/offchain/xrp/transfer',
                webhookChain: 'ripple-mainnet',
                displayName: 'Ripple',
                accountingCurrency: 'USD',
                requiresDestinationTag: true,
                authType: 'secret'
            },
            NGN: {
                tatumCurrency: 'VC_NGN',
                transferEndpoint: '', // No blockchain transfer for fiat
                displayName: 'Nigerian Naira',
                accountingCurrency: 'NGN',
                authType: 'none'
            },
            USD: {
                tatumCurrency: 'VC_USD',
                transferEndpoint: '', // No blockchain transfer for fiat
                displayName: 'US Dollar',
                accountingCurrency: 'USD',
                authType: 'none'
            }
        };


        static getConfig(coin: SupportedCoin): CoinConfig {
            const config = this.CONFIGS[coin];
            
            if (!config) {
            throw new Error(`Coin ${coin} not supported`);
            }
            
            return config;
        }

        static isSupported(coin: string): boolean {
            return coin in this.CONFIGS;
        }

        static isCrypto(coin: SupportedCoin): boolean {
            return !!this.CONFIGS[coin]?.webhookChain;
        }

    }


    // ============================================
    // AUTHENTICATION HELPER
    // ============================================

    class AuthenticationHelper {

        static getAuthConfig(coin: SupportedCoin, index?: number) {
            const coinConfig = CoinConfigurations.getConfig(coin);

            switch (coinConfig.authType) {
                case 'mnemonic':
                    return this.getMnemonicAuth(coin, index);
                
                case 'privateKey':
                    return this.getPrivateKeyAuth(coin);
                
                case 'secret':
                    return this.getSecretAuth(coin);
                
                case 'none':
                    return {};
                
                default:
                  throw new Error(`Unknown auth type for ${coin}`);
            }
        }

        private static getMnemonicAuth(coin: SupportedCoin, index?: number) {
            const mnemonicMap: Record<string, string> = {
            BTC: config.BTC_MNEMONIC || '',
            ETH: config.ETH_MNEMONIC || '',
            LTC: config.LTC_MNEMONIC || '',
            TRON: config.TRON_MNEMONIC || ''
            };

            const xpubMap: Record<string, string> = {
            BTC: config.BTC_XPUB || '',
            LTC: config.LTC_XPUB || ''
            };

            const auth: any = {
            mnemonic: mnemonicMap[coin]
            };

            if (xpubMap[coin]) {
            auth.xpub = xpubMap[coin];
            }

            if (index !== undefined && CoinConfigurations.getConfig(coin).requiresIndex) {
            auth.index = index;
            }

            return auth;
        }

        private static getPrivateKeyAuth(coin: SupportedCoin) {
            if (coin === 'BNB') {
            return { fromPrivateKey: config.BNB_KEY };
            }
            throw new Error(`Private key auth not configured for ${coin}`);
        }

        private static getSecretAuth(coin: SupportedCoin) {
            if (coin === 'XRP') {
            return {
                account: config.XRP_ADDRESS,
                secret: config.XRP_SECRET
            };
            }
            throw new Error(`Secret auth not configured for ${coin}`);
        }
    }


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

class nativeCoinService
{    

    private tatumAxios: AxiosInstance;
    private tatumAxiosV4: AxiosInstance;

    constructor() {
        this.tatumAxios = axios.create({
        baseURL: 'https://api.tatum.io/v3',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
        });

        this.tatumAxiosV4 = axios.create({
        baseURL: 'https://api.tatum.io/v4',
        headers: {
            'x-api-key': config.TATUM_LIVE_KEY,
            'Content-Type': 'application/json'
        }
        });
    }

    // ============================================
    // HELPER METHODS
    // ============================================

    private async generateAddress(accountId: string) {
        try {
        const response = await this.tatumAxios.post(`/offchain/account/${accountId}/address`);
        return response.data;
        } catch (error) {
        logger.error('Failed to generate address:', error);
        throw new Error('Failed to generate deposit address');
        }
    }

    private async subscribeAddress(payload: { address: string; chain: string }) {
        try {
        const data = {
            type: "ADDRESS_EVENT",
            attr: {
            address: payload.address,
            chain: payload.chain,
            url: `https://api-dev.vyre.africa/api/v1/webhook/tatum`
            }
        };

        const response = await this.tatumAxiosV4.post('/subscription', data);
        return response.data;
        } catch (error) {
        logger.error('Failed to subscribe address:', error);
        throw new Error('Failed to subscribe to address events');
        }
    }

    private async completeWithdrawal(withdrawalId: string, txId: string) {
        try {
            await this.tatumAxios.put(`/offchain/withdrawal/${withdrawalId}/${txId}`);

            return await prisma.transaction.update({
                where: { id: withdrawalId },
                data: { status: 'SUCCESSFUL' }
            });
        } catch (error) {
            logger.error('Failed to complete withdrawal:', error);
            throw error;
        }
    }


    // ============================================
    // UNIFIED WALLET CREATION
    // ============================================

    async createWallet(
        coin: SupportedCoin | any,
        userId: string,
        currencyId: string
    ): Promise<WalletCreationResult> {
        try {

            if (!CoinConfigurations.isSupported(coin)) {
                throw new Error(`Coin ${coin} not supported`);
            }

            const coinConfig = CoinConfigurations.getConfig(coin);
            const isCrypto = CoinConfigurations.isCrypto(coin);

            logger.info(`Creating ${coin} wallet`, { userId, currencyId });

            // Create Tatum ledger account
            const accountData: any = {
                currency: coinConfig.tatumCurrency,
                customer: {
                    accountingCurrency: coinConfig.accountingCurrency,
                    externalId: userId
                }
            };

            // Add xpub for coins that need it
            if (coin === 'BTC') accountData.xpub = config.BTC_XPUB;
            if (coin === 'ETH') accountData.xpub = config.ETH_XPUB;
            if (coin === 'LTC') accountData.xpub = config.LTC_XPUB;
            if (coin === 'TRON') accountData.xpub = config.TRON_XPUB;
            if (coin === 'BNB') accountData.xpub = config.BNB_ADDRESS;
            if (coin === 'XRP') accountData.xpub = config.XRP_ADDRESS;

            const accountResponse = await this.tatumAxios.post('/ledger/account', accountData);
            const account = accountResponse.data;

            // For crypto wallets, generate deposit address and subscribe
            let depositAddress, subscription, derivationKey, destinationTag;

            if (isCrypto) {
                depositAddress = await this.generateAddress(account.id);
                
                subscription = await this.subscribeAddress({
                    address: depositAddress.address,
                    chain: coinConfig.webhookChain!
                });

                derivationKey = depositAddress.derivationKey;
                destinationTag = depositAddress.destinationTag; // For XRP
            }

            // Create wallet in database
            const walletData: any = {
                id: account.id,
                currencyId,
                userId,
                Tatum_customerId: account.customerId,
                accountingCurrency: account.accountingCurrency,
                frozen: account.frozen
            };

            if (isCrypto) {
                walletData.depositAddress = depositAddress.address;
                walletData.subscriptionId = subscription.id;
                walletData.derivationKey = derivationKey;
                if (destinationTag) walletData.destinationTag = destinationTag;
            }

            const wallet = await prisma.wallet.create({ data: walletData });

            logger.info(`${coin} wallet created successfully`, { 
                walletId: wallet.id,
                address: wallet.depositAddress
            });

            return {
                id: wallet.id,
                depositAddress: wallet.depositAddress || undefined,
                subscriptionId: wallet.subscriptionId || undefined,
                derivationKey: wallet.derivationKey || undefined,
                destinationTag: Number(wallet?.destinationTag) || undefined
            };

        } catch (error) {
            logger.error(`Failed to create ${coin} wallet:`, error);
            throw error;
        }
    }

    // ============================================
    // UNIFIED BLOCKCHAIN TRANSFER
    // ============================================

    async blockchainTransfer(
        coin: SupportedCoin,
        payload: TransferPayload
    ) {
        try {
            const { userId, walletId, address, amount, index = 1, destinationTag } = payload;

            // Validate coin support
            if (!CoinConfigurations.isSupported(coin)) {
                throw new Error(`Coin ${coin} not supported`);
            }

            if (!CoinConfigurations.isCrypto(coin)) {
                throw new Error(`${coin} is not a cryptocurrency - use fiat transfer methods`);
            }

            // ✅ Convert amount to Decimal
            const amountDecimal = new Decimal(amount);

            // Validate amount
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }

            const coinConfig = CoinConfigurations.getConfig(coin);

            logger.info(`Initiating ${coin} transfer`, {
                userId,
                walletId,
                amount: amountDecimal.toString(),
                address
            });

            // Check wallet balance
            const wallet = await prisma.wallet.findUnique({
                where: { id: walletId },
                select: { 
                    availableBalance: true,
                    accountBalance: true,
                    currencyId: true
                }
            });

            if (!wallet) {
                throw new Error('Wallet not found');
            }

            // ✅ Convert wallet balance to Decimal and compare
            const availableBalance = new Decimal(wallet.availableBalance);

            logger.info('Balance verification', {
                coin,
                availableBalance: availableBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
            });

            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(
                    `Insufficient balance. Available: ${availableBalance.toFixed(8)} ${coin}, Required: ${amountDecimal.toFixed(8)} ${coin}`
                );
            }

            // Build transfer data
            const transferData: any = {
                senderAccountId: walletId,
                address,
                amount: amountDecimal.toString(), // ✅ Use string for API
                ...AuthenticationHelper.getAuthConfig(coin, index)
            };

            // Add destination tag for XRP
            if (coin === 'XRP' && destinationTag) {
                transferData.attr = destinationTag;
            }

            logger.info('Executing blockchain transfer', {
                coin,
                endpoint: coinConfig.transferEndpoint,
                amount: amountDecimal.toString(),
                address
            });

            // Execute transfer
            const response = await this.tatumAxios.post(coinConfig.transferEndpoint, transferData);
            const result = response.data;

            // Create transaction record
            let transaction = await prisma.transaction.create({
                data: {
                    id: result.id,
                    userId,
                    currency: coin,
                    amount: amountDecimal, // ✅ Prisma accepts Decimal
                    status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                    reference: result.txId,
                    walletId,
                    type: 'DEBIT_PAYMENT',
                    description: `${coinConfig.displayName} transfer`,
                    metadata: {
                        recipientAddress: address,
                        destinationTag: destinationTag || null,
                        txId: result.txId,
                        amount: amountDecimal.toString(), // ✅ Store string in metadata for precision
                        coin: coinConfig.displayName
                    }
                }
            });

            // Complete withdrawal if pending
            if (!result.completed) {
                logger.info('Completing pending withdrawal', {
                    withdrawalId: result.id,
                    txId: result.txId
                });
                transaction = await this.completeWithdrawal(result.id, result.txId);
            }

            logger.info(`${coin} transfer completed successfully`, {
                transactionId: transaction.id,
                txId: result.txId,
                amount: amountDecimal.toString(),
                status: transaction.status
            });

            return transaction;

        } catch (error: any) {
            logger.error(`${coin} transfer failed:`, {
                error: error.message,
                coin,
                userId: payload.userId,
                amount: payload.amount,
                stack: error.stack
            });
            throw error;
        }
    }


        // ============================================
        // PUBLIC API METHODS (Legacy Compatibility)
        // ============================================

        // Single entry point for wallet creation
        async createWalletByISO(ISO: string, userId: string, currencyId: string) {
            if (!CoinConfigurations.isSupported(ISO)) {
            throw new Error(`Currency ${ISO} not supported`);
            }
            return this.createWallet(ISO as SupportedCoin, userId, currencyId);
        }

        // Single entry point for transfers
        async blockchain_Transfer(payload: {
            ISO: string;
            userId: string;
            walletId: string;
            amount: string;
            address: string;
            index?: number;
            destination_Tag?: number;
        }) {
            const { ISO, userId, walletId, amount, address, index, destination_Tag } = payload;

            if (!CoinConfigurations.isSupported(ISO)) {
            throw new Error(`Currency ${ISO} not supported`);
            }

            return this.blockchainTransfer(ISO as SupportedCoin, {
            userId,
            walletId,
            address,
            amount,
            index,
            destinationTag: destination_Tag
            });
        }

    }








//     private generate_Address = async(Account_ID:string)=>{
    
//         const response = await tatumAxios.post(`/offchain/account/${Account_ID}/address`)
//         const result = response.data
//         console.log(result)

//         return result
//     }

//     async subscribe_address(payload:{
//         address: string,
//         chain: string
//     }){

//         const data = {
//             type:"ADDRESS_EVENT",
//             attr:{
//                address: payload.address,
//                chain: payload.chain,
//                url:"https://api-dev.vyre.africa/api/v1/webhook/tatum" //The URL of the webhook listener you are using
//                }
//             }

//         const result = await tatumAxiosV4.post('/subscription', data)

//         return result.data

//     }

//     private complete_Withdrawal = async(
//         withdrawal_Id: string,
//         txId: string
//     )=>{

//         await tatumAxios.put(`/offchain/withdrawal/${withdrawal_Id}/${txId}`)

//         const updatedTransaction = await prisma.transaction.update({
//             where:{id: withdrawal_Id },
//             data:{
//               status:'SUCCESSFUL',
//             }
//         })

//         return updatedTransaction

//     }



//     private Withdraw_Bitcoin = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         amount: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             mnemonic: config.BTC_MNEMONIC,
//             xpub: config.BTC_XPUB,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/bitcoin/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'BTC',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'Bitcoin transfer'
//             }
//         })

//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }

//         return transaction

//     }

//     private Withdraw_Ethereum = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             mnemonic: config.ETH_MNEMONIC,
//             index: index || 1,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/ethereum/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'ETH',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'Ethereum transfer'
//             }
//         })

//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }

//         return transaction

        
//     }

//     private Withdraw_Litecoin = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         amount: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             mnemonic: config.LTC_MNEMONIC,
//             xpub: config.LTC_XPUB,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/litecoin/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'LTC',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'Litecoin transfer'
//             }
//         })

//         if(!result.completed){
//            transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         return transaction
        
//     }
    
//     private Withdraw_Tron = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             mnemonic: config.TRON_MNEMONIC,
//             index: index || 1,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/tron/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'TRON',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'Tron transfer'
//             }
//         })

//         if(!result.completed){
//            transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }

//         return transaction

        
//     }

//     private Withdraw_BNB = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         amount: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             fromPrivateKey: config.BNB_KEY,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/bnb/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'BNB',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'BNB transfer'
//             }
//         })

//         if(!result.completed){
//            transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }

//         return transaction

//     }

//     private Withdraw_XRP = async(
//         userId: string, 
//         account_ID: string,
//         address: string,
//         amount: number,
//         destination_Tag: number,
//     )=>{
//         const data = {
//             senderAccountId: account_ID,
//             account: config.XRP_ADDRESS,
//             secret: config.XRP_SECRET,
//             attr: destination_Tag,
//             address,
//             amount
//         };

//         let transaction;

//         const response = await tatumAxios.post('/offchain/xrp/transfer', data)
//         console.log(response)
//         const result = response.data

//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'XRP',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'Ripple transfer'
//             }
//         })

//         if(!result.completed){
//            transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }

//         return transaction

//     }


//     private create_Naira_wallet = async(userId:string,currencyId:string)=>{

//         console.log('Creating Naira wallet')
//         const data = {
//             currency: "VC_NGN",
//             customer:{
//                accountingCurrency: "NGN",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         console.log('new Naira wallet', newWallet)

//         return newWallet
//     }

//     private create_Dollar_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "VC_USD",
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Bitcoin_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "BTC",
//             xpub: config.BTC_XPUB,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data

//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'bitcoin-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Ethereum_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "ETH",
//             xpub: config.ETH_XPUB,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data

//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'ethereum-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Litecoin_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "LTC",
//             xpub: config.LTC_XPUB,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data
//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'litecoin-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Tron_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "TRON",
//             xpub: config.TRON_XPUB,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data
//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'tron-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Bnb_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "BNB",
//             xpub: config.BNB_ADDRESS,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data
//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'bsc-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }

//     private create_Ripple_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "XRP",
//             xpub: config.XRP_ADDRESS,
//             customer:{
//                accountingCurrency: "USD",
//                externalId: userId
//             }
//         };
//         const response = await tatumAxios.post('/ledger/account', data)
//         console.log(response)
//         const result = response.data
//         const deposit = await this.generate_Address(result.id)

//         const subscribed = await this.subscribe_address({
//             address: deposit.address,
//             chain:'ripple-mainnet'
//         })

//         const newWallet = await prisma.wallet.create({
//             data:{
//                 id: result.id,
//                 currencyId,
//                 userId,
//                 depositAddress: deposit.address,
//                 subscriptionId: subscribed.id,
//                 derivationKey: deposit.derivationKey,
//                 destinationTag: deposit.destinationTag,

//                 Tatum_customerId: result.customerId,
//                 accountingCurrency: result.accountingCurrency,
//                 frozen: result.frozen
//             }
//         })

//         return newWallet
//     }


    

//     async createWallet(ISO:string, userId:string, currencyId:string){
//         let result;
//         switch (ISO) {

//             case 'NGN':
//                 result = await this.create_Naira_wallet(userId, currencyId)
//                 return result
//                 break;

//                 case 'USD':
//                 result = await this.create_Dollar_wallet(userId, currencyId)
//                 return result
//                 break;
                
//                 case 'BTC':
//                 result = await this.create_Bitcoin_wallet(userId, currencyId)
//                 return result
//                 break;
                
//                 case 'ETH':
//                 result = await this.create_Ethereum_wallet(userId, currencyId)
//                 return result
//                 break;

//                 case 'LTC':
//                 result = await this.create_Litecoin_wallet(userId, currencyId)
//                 return result
//                 break;
                
//                 case 'TRON':
//                 result = await this.create_Tron_wallet(userId, currencyId)
//                 return result
//                 break;

//                 case 'BNB':
//                 result = await this.create_Bnb_wallet(userId, currencyId)
//                 return result
//                 break;

//                 case 'XRP':
//                 result = await this.create_Ripple_wallet(userId, currencyId)
//                 return result
//                 break;

//                 default:
//                  return
//         }

//     }

//     async blockchain_Transfer(payload:{
//         ISO:string, 
//         userId:string, 
//         walletId:string,
//         amount: number,
//         address: string,
//         index: number,
//         destination_Tag?: number
//     }){
//         const {ISO, userId, walletId, amount, address, index, destination_Tag } = payload

//         let result;

//         switch (ISO) {
            
//             case 'BTC':
//               result = await this.Withdraw_Bitcoin(
//                 userId, 
//                 walletId,
//                 address,
//                 amount
//               )
//               return result
//               break;
            
//             case 'ETH':
//                 result = await this.Withdraw_Ethereum(
//                     userId, 
//                     walletId,
//                     address,
//                     index,
//                     amount
//                 )
//                 return result
//               break;

//             case 'LTC':
//                 result = await this.Withdraw_Litecoin(
//                     userId, 
//                     walletId,
//                     address,
//                     amount
//                 )
//                 return result
//               break;
            
//             case 'TRON':
//                 result = await this.Withdraw_Tron(
//                     userId, 
//                     walletId,
//                     address,
//                     index,
//                     amount
//                 )
//                 return result
//               break;

//             case 'BNB':
//                 result = await this.Withdraw_BNB(
//                     userId, 
//                     walletId,
//                     address,
//                     amount
//                 )
//                 return result
//               break;

//             case 'XRP':
//                 result = await this.Withdraw_XRP(
//                     userId, 
//                     walletId,
//                     address,
//                     amount,
//                     destination_Tag!
//                 )
//                 return result
//               break;

//             // case 'USDC':
//             //     result = await this.Withdraw_USDC_ETH(
//             //         userId, 
//             //         walletId,
//             //         address,
//             //         amount
//             //     )
//             //     return result
//             //   break;

//             default:
//              return
//         } 

//     }
    
// }

export default new nativeCoinService()