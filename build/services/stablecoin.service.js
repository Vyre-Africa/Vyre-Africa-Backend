"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const env_config_1 = __importDefault(require("../config/env.config"));
const axios_1 = __importDefault(require("axios"));
const decimal_js_1 = __importDefault(require("decimal.js"));
const transferfee_service_1 = __importDefault(require("./transferfee.service"));
const notification_service_1 = __importDefault(require("./notification.service"));
const logger_1 = __importDefault(require("../config/logger"));
const chain_service_1 = __importDefault(require("./chain.service"));
const decimal_util_1 = require("./decimal.util");
const BLOCKCHAIN_DECIMALS = 8;
const tatumAxios = axios_1.default.create({
    baseURL: 'https://api.tatum.io/v3',
    headers: {
        'x-api-key': env_config_1.default.TATUM_LIVE_KEY,
        'Content-Type': 'application/json'
    }
});
const tatumAxiosV4 = axios_1.default.create({
    baseURL: 'https://api.tatum.io/v4',
    headers: {
        'x-api-key': env_config_1.default.TATUM_LIVE_KEY,
        'Content-Type': 'application/json'
    }
});
class stableCoinService {
    constructor() {
        this.tatumAxios = axios_1.default.create({
            baseURL: 'https://api.tatum.io/v3',
            headers: {
                'x-api-key': env_config_1.default.TATUM_LIVE_KEY,
                'Content-Type': 'application/json'
            }
        });
        this.tatumAxiosV4 = axios_1.default.create({
            baseURL: 'https://api.tatum.io/v4',
            headers: {
                'x-api-key': env_config_1.default.TATUM_LIVE_KEY,
                'Content-Type': 'application/json'
            }
        });
    }
    // ============================================
    // CORE WALLET OPERATIONS
    // ============================================
    roundForBlockchain(amount) {
        const amountDecimal = new decimal_js_1.default(amount);
        return amountDecimal.toDecimalPlaces(BLOCKCHAIN_DECIMALS, decimal_js_1.default.ROUND_DOWN).toString();
    }
    async generateAddress(accountId) {
        try {
            const response = await this.tatumAxios.post(`/offchain/account/${accountId}/address`);
            return response.data;
        }
        catch (error) {
            logger_1.default.error('Failed to generate address:', error);
            throw new Error('Failed to generate deposit address');
        }
    }
    async subscribeAddress(payload) {
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
        }
        catch (error) {
            logger_1.default.error('Failed to subscribe address:', error);
            throw new Error('Failed to subscribe to address events');
        }
    }
    // ============================================
    // UNIFIED WALLET CREATION
    // ============================================
    async createWallet(stablecoin, chain, userId, currencyId) {
        try {
            // Validate chain support
            if (!chain_service_1.default.isChainSupported(stablecoin, chain)) {
                throw new Error(`Chain ${chain} not supported for ${stablecoin}`);
            }
            const chainConfig = chain_service_1.default.getChainConfig(stablecoin, chain);
            logger_1.default.info(`Creating ${stablecoin} wallet on ${chain}`, { userId, currencyId });
            // Create Tatum ledger account
            const accountData = {
                currency: chainConfig.tatumCurrency,
                xpub: chainConfig.xpub,
                customer: {
                    accountingCurrency: "USD",
                    externalId: userId
                }
            };
            const accountResponse = await this.tatumAxios.post('/ledger/account', accountData);
            const account = accountResponse.data;
            // Generate deposit address
            const depositAddress = await this.generateAddress(account.id);
            // Subscribe to address events
            const subscription = await this.subscribeAddress({
                address: depositAddress.address,
                chain: chainConfig.webhookChain
            });
            // Create wallet in database
            const wallet = await prisma_config_1.default.wallet.create({
                data: {
                    id: account.id,
                    currencyId,
                    userId,
                    depositAddress: depositAddress.address,
                    subscriptionId: subscription.id,
                    derivationKey: depositAddress.derivationKey,
                    Tatum_customerId: account.customerId,
                    accountingCurrency: account.accountingCurrency,
                    frozen: account.frozen
                }
            });
            logger_1.default.info(`Wallet created successfully`, {
                walletId: wallet.id,
                address: wallet.depositAddress
            });
            return wallet;
        }
        catch (error) {
            logger_1.default.error(`Failed to create ${stablecoin} wallet on ${chain}:`, error);
            throw error;
        }
    }
    // ============================================
    // UNIFIED TRANSFER OPERATION
    // ============================================
    async executeTransfer(stablecoin, chain, payload) {
        try {
            const { userId, walletId, address, amount, index = 1 } = payload;
            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new decimal_js_1.default(amount);
            // Validate inputs
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }
            const chainConfig = chain_service_1.default.getChainConfig(stablecoin, chain);
            const withdrawalFeeDecimal = new decimal_js_1.default(transferfee_service_1.default.calculateFee(chain));
            const netAmountDecimal = amountDecimal.minus(withdrawalFeeDecimal);
            if (netAmountDecimal.lessThanOrEqualTo(0)) {
                throw new Error(`Amount too small to cover network fee of $${withdrawalFeeDecimal.toString()}`);
            }
            logger_1.default.info(`Initiating ${stablecoin} transfer on ${chain}`, {
                userId,
                grossAmount: amountDecimal.toString(),
                fee: withdrawalFeeDecimal.toString(),
                netAmount: netAmountDecimal.toString(),
                address
            });
            // Get user wallet and check balance
            const userWallet = await prisma_config_1.default.wallet.findUnique({
                where: { id: walletId },
                select: { currencyId: true, availableBalance: true, accountBalance: true }
            });
            if (!userWallet) {
                throw new Error('Wallet not found');
            }
            // ✅ Convert wallet balance to Decimal
            const availableBalance = new decimal_js_1.default(userWallet.availableBalance);
            const accountBalance = new decimal_js_1.default(userWallet.accountBalance);
            logger_1.default.info('Balance verification', {
                availableBalance: availableBalance.toString(),
                accountBalance: accountBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
            });
            // ✅ Use Decimal comparison
            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(`Insufficient balance. Available: ${availableBalance.toFixed(8)}, Required: ${amountDecimal.toFixed(8)}`);
            }
            let transferData;
            // Handle admin vs user transfers
            if (env_config_1.default.Admin_Id !== userId) {
                // Transfer to admin first
                const adminWallet = await prisma_config_1.default.wallet.findFirst({
                    where: {
                        userId: env_config_1.default.Admin_Id,
                        currencyId: userWallet.currencyId
                    },
                    select: {
                        id: true,
                        derivationKey: true
                    }
                });
                if (!adminWallet) {
                    throw new Error('Admin wallet not found');
                }
                // Internal transfer to admin (convert to number if service requires it)
                await this.offchainTransfer({
                    userId,
                    receipientId: env_config_1.default.Admin_Id,
                    currencyId: userWallet.currencyId,
                    amount: amountDecimal.toString() // Convert for service
                });
                transferData = {
                    senderAccountId: adminWallet.id,
                    mnemonic: chainConfig.mnemonic,
                    index: adminWallet.derivationKey || 1,
                    address,
                    amount: decimal_util_1.DecimalUtil.roundForDisplay(netAmountDecimal, stablecoin) // rounded amount in string
                };
            }
            else {
                transferData = {
                    senderAccountId: walletId,
                    mnemonic: chainConfig.mnemonic,
                    index,
                    address,
                    amount: decimal_util_1.DecimalUtil.roundForDisplay(netAmountDecimal, stablecoin) // rounded amount in string
                };
            }
            // Execute blockchain transfer
            const response = await this.tatumAxios.post(chainConfig.tatumEndpoint, transferData);
            const result = response.data;
            // Create transaction record
            let transaction = await prisma_config_1.default.transaction.create({
                data: {
                    id: result.id,
                    userId,
                    currency: `${stablecoin} ${chain}`,
                    amount: decimal_util_1.DecimalUtil.roundForDisplay(netAmountDecimal, stablecoin), // Prisma accepts Decimal
                    status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                    reference: result.txId,
                    walletId,
                    type: 'DEBIT_PAYMENT',
                    description: `${stablecoin} ${chain} transfer`,
                    metadata: {
                        grossAmount: amountDecimal.toString(),
                        fee: withdrawalFeeDecimal.toString(),
                        netAmount: netAmountDecimal.toString(),
                        recipientAddress: address,
                        chain: chainConfig.displayName
                    }
                }
            });
            // Complete withdrawal if pending
            if (!result.completed) {
                transaction = await this.completeWithdrawal(result.id, result.txId);
            }
            // Send notification
            await this.sendTransferNotification({
                userId,
                stablecoin,
                chain: chainConfig.displayName,
                grossAmount: decimal_util_1.DecimalUtil.roundForDisplay(amountDecimal, stablecoin),
                fee: decimal_util_1.DecimalUtil.roundForDisplay(withdrawalFeeDecimal, stablecoin),
                netAmount: decimal_util_1.DecimalUtil.roundForDisplay(netAmountDecimal, stablecoin),
                address,
                status: result.completed ? 'Completed' : 'Processing'
            });
            logger_1.default.info(`Transfer completed successfully`, {
                transactionId: transaction.id,
                txId: result.txId,
                grossAmount: amountDecimal.toString(),
                netAmount: netAmountDecimal.toString()
            });
            return transaction;
        }
        catch (error) {
            logger_1.default.error(`Transfer failed:`, {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    // private async executeTransfer(
    //     stablecoin: StablecoinType,
    //     chain: AllSupportedChains,
    //     payload: TransferPayload
    // ) {
    //     try {
    //     const { userId, walletId, address, amount, index = 1 } = payload;
    //     // Validate inputs
    //     if (amount <= 0) {
    //         throw new Error('Transfer amount must be greater than 0');
    //     }
    //     const chainConfig = chainService.getChainConfig(stablecoin, chain);
    //     const withdrawalFee = transferfeeService.calculateFee(chain);
    //     const netAmount = amount - withdrawalFee;
    //     if (netAmount <= 0) {
    //         throw new Error(`Amount too small to cover network fee of $${withdrawalFee}`);
    //     }
    //     logger.info(`Initiating ${stablecoin} transfer on ${chain}`, {
    //         userId,
    //         grossAmount: amount,
    //         fee: withdrawalFee,
    //         netAmount,
    //         address
    //     });
    //     // Get user wallet and check balance
    //     const userWallet = await prisma.wallet.findUnique({
    //         where: { id: walletId },
    //         select: { currencyId: true, availableBalance: true, accountBalance: true }
    //     });
    //     if (!userWallet) {
    //         throw new Error('Wallet not found');
    //     }
    //     console.log('balance check', userWallet.availableBalance)
    //     console.log('wallet total balance check', userWallet.accountBalance)
    //     console.log('intending amount to transfer', amount)
    //     if (!hasSufficientBalance(userWallet.availableBalance, amount)) {
    //         throw new Error('Insufficient balance');
    //     }
    //     let transferData;
    //     // Handle admin vs user transfers
    //     if (config.Admin_Id !== userId) {
    //         // Transfer to admin first
    //         const adminWallet = await prisma.wallet.findFirst({
    //         where: {
    //             userId: config.Admin_Id,
    //             currencyId: userWallet.currencyId
    //         },
    //         select: {
    //             id: true,
    //             derivationKey: true
    //         }
    //         });
    //         if (!adminWallet) {
    //         throw new Error('Admin wallet not found');
    //         }
    //         // Internal transfer to admin
    //         await this.offchainTransfer({
    //             userId,
    //             receipientId: config.Admin_Id,
    //             currencyId: userWallet.currencyId as string,
    //             amount
    //         });
    //         transferData = {
    //             senderAccountId: adminWallet.id,
    //             mnemonic: chainConfig.mnemonic,
    //             index: adminWallet.derivationKey || 1,
    //             address,
    //             amount: String(netAmount)
    //         };
    //     } else {
    //         transferData = {
    //             senderAccountId: walletId,
    //             mnemonic: chainConfig.mnemonic,
    //             index,
    //             address,
    //             amount: String(netAmount)
    //         };
    //     }
    //     // Execute blockchain transfer
    //     const response = await this.tatumAxios.post(chainConfig.tatumEndpoint, transferData);
    //     const result = response.data;
    //     // Create transaction record
    //     let transaction = await prisma.transaction.create({
    //         data: {
    //             id: result.id,
    //             userId,
    //             currency: `${stablecoin} ${chain}`,
    //             amount,
    //             status: result.completed ? 'SUCCESSFUL' : 'PENDING',
    //             reference: result.txId,
    //             walletId,
    //             type: 'DEBIT_PAYMENT',
    //             description: `${stablecoin} ${chain} transfer`,
    //             metadata: {
    //                 grossAmount: amount,
    //                 fee: withdrawalFee,
    //                 netAmount,
    //                 recipientAddress: address,
    //                 chain: chainConfig.displayName
    //             }
    //         }
    //     });
    //     // Complete withdrawal if pending
    //     if (!result.completed) {
    //         transaction = await this.completeWithdrawal(result.id, result.txId);
    //     }
    //     // Send notification
    //     await this.sendTransferNotification({
    //         userId,
    //         stablecoin,
    //         chain: chainConfig.displayName,
    //         grossAmount: amount,
    //         fee: withdrawalFee,
    //         netAmount,
    //         address,
    //         status: result.completed ? 'Completed' : 'Processing'
    //     });
    //     logger.info(`Transfer completed successfully`, { 
    //         transactionId: transaction.id,
    //         txId: result.txId 
    //     });
    //     return transaction;
    //     } catch (error) {
    //      logger.error(`Transfer failed:`, error);
    //      throw error;
    //     }
    // }
    // ============================================
    // HELPER METHODS
    // ============================================
    async offchainTransfer(payload) {
        const { userId, receipientId, currencyId, amount } = payload;
        try {
            // ✅ Convert to Decimal immediately
            const amountDecimal = new decimal_js_1.default(amount);
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }
            const [recipientWallet, userWallet] = await Promise.all([
                prisma_config_1.default.wallet.findFirst({
                    where: { userId: receipientId, currencyId },
                    select: {
                        id: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: { userId, currencyId },
                    select: {
                        id: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                })
            ]);
            if (!recipientWallet || !userWallet) {
                throw new Error('Wallet not found for offchain transfer');
            }
            // ✅ Convert wallet balance to Decimal and compare
            const availableBalance = new decimal_js_1.default(userWallet.availableBalance);
            logger_1.default.info('Offchain transfer balance check', {
                userId,
                availableBalance: availableBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
            });
            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(`Insufficient balance for offchain transfer. Available: ${availableBalance.toFixed(8)}, Required: ${amountDecimal.toFixed(8)}`);
            }
            const data = {
                senderAccountId: userWallet.id,
                recipientAccountId: recipientWallet.id,
                amount: amount, // ✅ Keep as string for API - Tatum accepts strings
                anonymous: false,
                compliant: false
            };
            logger_1.default.info('Executing offchain transfer', {
                from: userWallet.id,
                to: recipientWallet.id,
                amount: amountDecimal.toString()
            });
            const response = await this.tatumAxios.post('/ledger/transaction', data);
            logger_1.default.info('Offchain transfer successful', {
                transactionId: response.data.id,
                reference: response.data.reference
            });
            return response.data;
        }
        catch (error) {
            logger_1.default.error('Offchain transfer failed:', {
                error: error.message,
                userId,
                receipientId,
                amount,
                stack: error.stack
            });
            throw error;
        }
    }
    async completeWithdrawal(withdrawalId, txId) {
        try {
            await this.tatumAxios.put(`/offchain/withdrawal/${withdrawalId}/${txId}`);
            return await prisma_config_1.default.transaction.update({
                where: { id: withdrawalId },
                data: { status: 'SUCCESSFUL' }
            });
        }
        catch (error) {
            logger_1.default.error('Failed to complete withdrawal:', error);
            throw error;
        }
    }
    async sendTransferNotification(params) {
        const { userId, stablecoin, chain, grossAmount, fee, netAmount, address, status } = params;
        await notification_service_1.default.queue({
            userId,
            type: 'GENERAL',
            title: 'Transaction Notification',
            content: `💰 **${stablecoin} Transfer Successful**

            We've successfully processed your ${stablecoin} transfer on ${chain} network.

            **Transaction Details:**
            • **Amount Sent:** ${grossAmount} ${stablecoin}
            • **Network Fee:** ${fee} ${stablecoin}
            • **Recipient Received:** ${netAmount} ${stablecoin}
            • **Recipient Address:** ${address}
            • **Network:** ${chain}
            • **Status:** ${status}

            Your funds are on the way! ${chain} network transactions are typically fast and cost-effective.

            Need help? Contact our support team anytime.`
        });
    }
    // ============================================
    // PUBLIC API METHODS
    // ============================================
    async createUSDCWallet(chain, userId, currencyId) {
        return this.createWallet('USDC', chain, userId, currencyId);
    }
    async createUSDTWallet(chain, userId, currencyId) {
        return this.createWallet('USDT', chain, userId, currencyId);
    }
    async transferUSDC(chain, payload) {
        return this.executeTransfer('USDC', chain, payload);
    }
    async transferUSDT(chain, payload) {
        return this.executeTransfer('USDT', chain, payload);
    }
    // Legacy method compatibility
    async create_USDC_wallet(chain, userId, currencyId) {
        return this.createUSDCWallet(chain, userId, currencyId);
    }
    async create_Tether_wallet(chain, userId, currencyId) {
        return this.createUSDTWallet(chain, userId, currencyId);
    }
    async Transfer_USDC(payload) {
        const { chain, ...rest } = payload;
        return this.transferUSDC(chain, rest);
    }
    async Transfer_Tether(payload) {
        const { chain, ...rest } = payload;
        return this.transferUSDT(chain, rest);
    }
}
//     private generate_Address = async(Account_ID:string)=>{
//         const response = await tatumAxios.post(`/offchain/account/${Account_ID}/address`)
//         const result = response.data
//         console.log(result)
//         return result
//     }
//     async offchain_Transfer(payload:{
//             userId: string,
//             receipientId: string,
//             currencyId: string, 
//             amount: number
//         })
//         {
//             const {userId,receipientId,currencyId,amount} = payload
//             let receipient_Wallet: any;
//             let user_Wallet: any;
//             const currency = await prisma.currency.findUnique({
//                 where:{id:currencyId},
//                 select:{
//                   id: true,
//                   type: true,
//                   name: true,
//                   ISO: true,
//                   chain: true 
//                 }
//             })
//             if(!currency){
//                 const error = new Error('currency not found');
//                 error.name = 'CurrencyNotFoundError';
//                 throw error;
//             }
//             console.log('transfer data passed',
//                 userId,
//                 receipientId,
//                 currencyId, 
//                 amount
//             )
//             receipient_Wallet = await prisma.wallet.findFirst({
//                 where:{
//                     userId: receipientId,
//                     currencyId
//                 }
//             })
//             //check if receipient has currency wallet created else we create it
//             if(!receipient_Wallet){
//                 receipient_Wallet = await walletService.createWallet({userId:receipientId, currencyId: currencyId as string})
//             }
//             user_Wallet = await prisma.wallet.findFirst({
//                 where:{
//                     userId,
//                     currencyId
//                 }
//             })
//             // check if user balance is sufficient enough
//             if(!hasSufficientBalance(user_Wallet?.availableBalance,amount))return
//             const data = {
//                 senderAccountId: user_Wallet?.id!,
//                 recipientAccountId: receipient_Wallet?.id!,
//                 amount: `${amount}`,
//                 anonymous: false,
//                 compliant: false
//             };
//             console.log('transfer Data',data)
//             const response = await tatumAxios.post('/ledger/transaction', data)
//             const paymentData = response.data
//             console.log(paymentData)
//             // create transactions for both parties
//             const transactions = await prisma.transaction.createMany({
//                 data:[
//                     {
//                     userId: userId,
//                     currency: currency.ISO,
//                     amount: -amount,
//                     reference: paymentData.reference,
//                     status: 'SUCCESSFUL',
//                     walletId: user_Wallet?.id!,
//                     type:'DEBIT_PAYMENT',
//                     description:`${currency} transfer`
//                    },
//                    {
//                     userId: userId,
//                     currency: currency.ISO,
//                     amount: amount,
//                     reference: paymentData.reference,
//                     status: 'SUCCESSFUL',
//                     walletId: user_Wallet?.id!,
//                     type:'CREDIT_PAYMENT',
//                     description:`${currency} transfer`
//                    }
//                 ]
//             })
//             return  transactions
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
//         // const subcribed = await prisma.transaction.update({
//         //     where:{id: withdrawal_Id },
//         //     data:{
//         //       status:'SUCCESSFUL',
//         //     }
//         // })
//         return result.data
//     }
//     private subscribe_events = async(
//         accountId: string
//     )=>{
//         const data = {
//             type:"ACCOUNT_INCOMING_BLOCKCHAIN_TRANSACTION",
//             attr:{
//                id: accountId, // The Virtual_Account_ID
//                url:"https://vyre-a33d9c003be3.herokuapp.com/api/v1/tatum/events" //The URL of the webhook listener you are using
//                }
//             }
//         const subscribed = await tatumAxios.post('/subscription', data)
//         // const subcribed = await prisma.transaction.update({
//         //     where:{id: withdrawal_Id },
//         //     data:{
//         //       status:'SUCCESSFUL',
//         //     }
//         // })
//         return subscribed.data.id
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
//     // USDC TRANSFERS
//     private Transfer_USDC_BASE = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('BASE');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.BASE_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.BASE_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/base/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC BASE',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC BASE transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Base network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** Base
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Base network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDC_ARB = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('ARBITRUM');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.ARBITRUM_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.ARBITRUM_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/arb/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC ARBITRUM',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC ARBITRUM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Arbitrum network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** Arbitrum
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Arbitrum network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDC_OP = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('OPTIMISM');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.OPTIMISM_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.OPTIMISM_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/optimism/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC OPTIMISM',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC OPTIMISM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Optimism network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** OPTIMISM
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! OPTIMISM network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDC_BSC = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('BSC');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.BSC_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.BSC_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/bsc/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC BSC',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC BSC transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Binance smart chain.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** Binance smart chain
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! BSC network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDC_MATIC = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('POLYGON');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.POLYGON_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.POLYGON_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/polygon/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC MATIC',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC MATIC transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Polygon network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** POLYGON
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Base network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDC_ETH = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const {userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('ETHEREUM');
//             // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDC.ETH_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDC.ETH_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDC ETH',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDC ETHEREUM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDC Transfer Successful**
//                 We've successfully processed your USDC transfer on Ethereum network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDC
//                 • **Network Fee:** $${withdrawalFee} USDC  
//                 • **Recipient Received:** $${netAmount} USDC
//                 • **Recipient Address:** ${address}
//                 • **Network:** Ethereum
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 💡 Ethereum transactions require blockchain confirmations for security. Your transaction is being processed and will be confirmed shortly.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     // USDT TRANSFERS
//     private Transfer_USDT_ETH = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID,address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('ETHEREUM');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.ETH_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.ETH_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT ETH',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT ETHEREUM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Ethereum network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** Ethereum
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 💡 Ethereum transactions require blockchain confirmations for security. Your transaction is being processed and will be confirmed shortly.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDT_BASE = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('BASE');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.BASE_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.BASE_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/base/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT BASE',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT BASE transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Base network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** Base
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Base network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDT_BSC = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number,
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('BSC');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.BSC_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.BSC_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/bsc/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT BSC',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT BSC transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Binance smart chain.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** BSC
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! BSC network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDT_OP = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('OPTIMISM');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//          if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.OPTIMISM_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.OPTIMISM_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/optimism/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT OP',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT OPTIMISM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Optimism network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** OPTIMISM
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Optimism network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDT_ARB = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//         // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('ARBITRUM');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.ARBITRUM_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.ARBITRUM_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/arb/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT ARB',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT ARBITRUM transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Arbitrum network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** ARBITRUM
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Arbitrum network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
//     private Transfer_USDT_TRON = async(payload:{
//         userId: string, 
//         account_ID: string,
//         address: string,
//         index: number,
//         amount: number
//     })=>{
//         const { userId, account_ID, address, index, amount } = payload
//          // First of all we transfer the asset to the Admin Account, which is the master account, 
//         // then from there we transfer to the desired address
//         let userWallet;
//         let adminWallet;
//         let TransferData;
//         const withdrawalFee = transferfeeService.calculateFee('TRON');
//         // Calculate net amount (amount after fee deduction)
//         const netAmount = amount - withdrawalFee;
//         console.log(`Transfer details: Gross: $${amount}, Fee: $${withdrawalFee}, Net: $${netAmount}`);
//         if(config.Admin_Id !== userId){
//             userWallet = await prisma.wallet.findUnique({
//                 where:{id: account_ID },
//                 select:{ currencyId: true }
//             })
//             adminWallet = await prisma.wallet.findFirst({
//                 where:{ 
//                     userId: config.Admin_Id, 
//                     currencyId: userWallet?.currencyId as string 
//                 },
//                 select:{ 
//                     id: true,
//                     derivationKey: true
//                 }
//             })
//             const AdminTransfer = await this.offchain_Transfer({
//                 userId,
//                 receipientId: config.Admin_Id,
//                 currencyId: userWallet?.currencyId as string, 
//                 amount
//             })
//             console.log('Admin Transfer', AdminTransfer)
//             TransferData = {
//                 senderAccountId: adminWallet?.id as string,
//                 mnemonic: config.USDT.TRON_MNEMONIC,
//                 index: adminWallet?.derivationKey as number || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }else{
//            TransferData = {
//                 senderAccountId: account_ID,
//                 mnemonic: config.USDT.TRON_MNEMONIC,
//                 index: index || 1,
//                 address,
//                 amount: String(netAmount)
//             }; 
//         }
//         let transaction;
//         const response = await tatumAxios.post('/offchain/tron/transfer', TransferData)
//         console.log(response)
//         const result = response.data
//         transaction = await prisma.transaction.create({
//             data:{
//                 id: result.id,
//                 userId: userId,
//                 currency: 'USDT TRON',
//                 amount,
//                 status: result.completed ? 'SUCCESSFUL' : 'PENDING',
//                 walletId: account_ID,
//                 type:'DEBIT_PAYMENT',
//                 description:'USDT TRON transfer'
//             }
//         })
//         if(!result.completed){
//             transaction = await this.complete_Withdrawal(result.id, result.txId)
//         }
//         notificationService.queue({
//               userId,
//               type:'GENERAL' as NotificationType,
//               title:`Transaction Notification`,
//               content:`💰 **USDT Transfer Successful**
//                 We've successfully processed your USDT transfer on Tron network.
//                 **Transaction Details:**
//                 • **Amount Sent:** $${amount} USDT
//                 • **Network Fee:** $${withdrawalFee} USDT  
//                 • **Recipient Received:** $${netAmount} USDT
//                 • **Recipient Address:** ${address}
//                 • **Network:** TRON
//                 • **Status:** ${result.completed ? 'Completed' : 'Processing'}
//                 Your funds are on the way! Tron network transactions are typically fast and cost-effective.
//                 Need help? Contact our support team anytime.
//                     `,
//         })
//         return transaction
//     }
// // USDC
//     private create_USDC_Eth_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDC",
//             xpub: config.USDC.ETH_XPUB,
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
//     private create_USDC_Base_wallet = async(userId:string, currencyId:string)=>{
//         console.log('Creating USDC BASE wallet')
//         const data = {
//             currency: "USDC_BASE",
//             xpub: config.USDC.BASE_XPUB,
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
//             chain:'base-mainnet'
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
//     private create_USDC_BSC_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDC_BSC",
//             xpub: config.USDC.BSC_XPUB,
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
//     private create_USDC_Matic_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDC_MATIC",
//             xpub: config.USDC.POLYGON_XPUB,
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
//             chain:'polygon-mainnet'
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
//     private create_USDC_Arb_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDC_ARB",
//             xpub: config.USDC.ARBITRUM_XPUB,
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
//             chain:'arb-one-mainnet'
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
//     private create_USDC_OP_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDC_OP",
//             xpub: config.USDC.OPTIMISM_XPUB,
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
//             chain:'optimism-mainnet'
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
// // USDT
//     private create_TetherErc_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT",
//             xpub: config.USDT.ETH_XPUB,
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
//     private create_TetherTrc_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT_TRON",
//             xpub: config.USDT.TRON_XPUB,
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
//     private create_TetherBase_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT_BASE",
//             xpub: config.USDT.BASE_XPUB,
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
//             chain:'base-mainnet'
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
//     private create_TetherBSC_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT_BSC",
//             xpub: config.USDT.BSC_XPUB,
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
//     private create_TetherARB_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT_ARB",
//             xpub: config.USDT.ARBITRUM_XPUB,
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
//             chain:'arb-one-mainnet'
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
//     private create_TetherOP_wallet = async(userId:string, currencyId:string)=>{
//         const data = {
//             currency: "USDT_OP",
//             xpub: config.USDT.OPTIMISM_XPUB,
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
//             chain:'optimism-mainnet'
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
//     async create_Tether_wallet(chain:string, userId:string, currencyId:string){
//         let result;
//         switch (chain) {
//             case 'ETHEREUM':
//              result = await this.create_TetherErc_wallet(userId, currencyId)
//             return result
//             break;
//             case 'TRON':
//              result = await this.create_TetherTrc_wallet(userId, currencyId)
//             return result
//             break;
//             case 'BASE':
//             result = await this.create_TetherBase_wallet(userId, currencyId)
//             return result
//             break;
//             case 'BSC':
//             result = await this.create_TetherBSC_wallet(userId, currencyId)
//             return result
//             break;
//             case 'ARBITRUM':
//             result = await this.create_TetherARB_wallet(userId, currencyId)
//             return result
//             break;
//             case 'OPTIMISM':
//             result = await this.create_TetherOP_wallet(userId, currencyId)
//             return result
//             break;
//             default:
//             return
//         }
//     }
//     async create_USDC_wallet(chain:string, userId:string, currencyId:string){
//         let result;
//         switch (chain) {
//             case 'ETHEREUM':
//              result = await this.create_USDC_Eth_wallet(userId, currencyId)
//             return result
//             break;
//             case 'POLYGON':
//              result = await this.create_USDC_Matic_wallet(userId, currencyId)
//             return result
//             break;
//             case 'BASE':
//             result = await this.create_USDC_Base_wallet(userId, currencyId)
//             return result
//             break;
//             case 'BSC':
//             result = await this.create_USDC_BSC_wallet(userId, currencyId)
//             return result
//             break;
//             case 'ARBITRUM':
//             result = await this.create_USDC_Arb_wallet(userId, currencyId)
//             return result
//             break;
//             case 'OPTIMISM':
//             result = await this.create_USDC_OP_wallet(userId, currencyId)
//             return result
//             break;
//             default:
//             return
//         }
//     }
//     async Transfer_Tether(payload:{
//         chain:string, 
//         userId:string, 
//         walletId:string,
//         amount: number,
//         index: number,
//         address: string
//     }){
//         const {chain, userId, walletId, amount, address, index } = payload
//         let result;
//         const transferPayload = {
//             userId, 
//             account_ID: walletId,
//             address,
//             index,
//             amount,
//         }
//         switch (chain) {
//             case 'ETHEREUM':
//                 result = await this.Transfer_USDT_ETH(transferPayload)
//                return result
//                break;
//                case 'TRON':
//                 result = await this.Transfer_USDT_TRON(transferPayload)
//                return result
//                break;
//                case 'BASE':
//                result = await this.Transfer_USDT_BASE(transferPayload)
//                return result
//                break;
//                case 'BSC':
//                result = await this.Transfer_USDT_BSC(transferPayload)
//                return result
//                break;
//                case 'ARBITRUM':
//                result = await this.Transfer_USDT_ARB(transferPayload)
//                return result
//                break;
//                case 'OPTIMISM':
//                result = await this.Transfer_USDT_OP(transferPayload)
//                return result
//                break;
//             default:
//              return
//         } 
//     }
//     async Transfer_USDC(payload:{
//         chain:string, 
//         userId:string, 
//         walletId:string,
//         amount: number,
//         index: number,
//         address: string
//     }){
//         const {chain, userId, walletId, amount, address, index } = payload
//         let result;
//         const transferPayload = {
//             userId, 
//             account_ID: walletId,
//             address,
//             index,
//             amount,
//         }
//         switch (chain) {
//             case 'ETHEREUM':
//                 result = await this.Transfer_USDC_ETH(transferPayload)
//                return result
//                break;
//                case 'POLYGON':
//                 result = await this.Transfer_USDC_MATIC(transferPayload)
//                return result
//                break;
//                case 'BASE':
//                result = await this.Transfer_USDC_BASE(transferPayload)
//                return result
//                break;
//                case 'BSC':
//                result = await this.Transfer_USDC_BSC(transferPayload)
//                return result
//                break;
//                case 'ARBITRUM':
//                result = await this.Transfer_USDC_ARB(transferPayload)
//                return result
//                break;
//                case 'OPTIMISM':
//                result = await this.Transfer_USDC_OP(transferPayload)
//                return result
//                break;
//             default:
//              return
//         } 
//     }
exports.default = new stableCoinService();
