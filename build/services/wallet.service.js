"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const env_config_1 = __importDefault(require("../config/env.config"));
const axios_1 = __importDefault(require("axios"));
const stablecoin_service_1 = __importDefault(require("./stablecoin.service"));
const nativecoin_service_1 = __importDefault(require("./nativecoin.service"));
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
const qorepay_service_1 = __importDefault(require("./qorepay.service"));
const transferfee_service_1 = __importDefault(require("./transferfee.service"));
const bullmq_1 = require("bullmq");
const redis_config_1 = __importDefault(require("../config/redis.config"));
const globals_1 = require("../globals");
const decimal_js_1 = __importDefault(require("decimal.js"));
const logger_1 = __importDefault(require("../config/logger"));
const decimal_util_1 = require("./decimal.util");
// import connection from '../config/redis.config';
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
const qorepayAxios = axios_1.default.create({
    baseURL: 'https://gate.qorepay.com/api/v1',
    headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${env_config_1.default.QOREPAY_BEARER_TOKEN}`,
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
class WalletService {
    constructor() {
        this.complete_Withdrawal = async (withdrawal_Id, txId) => {
            await tatumAxios.put(`/offchain/withdrawal/${withdrawal_Id}/${txId}`);
            const updatedTransaction = await prisma_config_1.default.transaction.update({
                where: { id: withdrawal_Id },
                data: {
                    status: 'SUCCESSFUL',
                }
            });
            return updatedTransaction;
        };
        this.Withdraw_USDC_ETH = async (userId, account_ID, address, amount) => {
            const data = {
                senderAccountId: account_ID,
                mnemonic: env_config_1.default.USDT.ETH_MNEMONIC,
                index: 1,
                address,
                amount
            };
            let transaction;
            const response = await tatumAxios.post('/offchain/ethereum/erc20/transfer', data);
            console.log(response);
            const result = response.data;
            transaction = await prisma_config_1.default.transaction.create({
                data: {
                    id: result.id,
                    userId: userId,
                    currency: 'USDC',
                    amount,
                    status: result.completed ? 'SUCCESSFUL' : 'PENDING',
                    walletId: account_ID,
                    type: 'DEBIT_PAYMENT',
                    description: 'USD COIN transfer'
                }
            });
            if (!result.completed) {
                transaction = await this.complete_Withdrawal(result.id, result.txId);
            }
            return transaction;
        };
        // Initialize the processing queue
        this.generalQueue = new bullmq_1.Queue('general-process', {
            connection: redis_config_1.default, // Type assertion if necessary
        });
    }
    // Add these methods to the WalletService class
    /**
     * Aggregate total value of all fiat wallets for a user in a specified fiat currency
     * @param userId - User ID
     * @param targetCurrency - Target fiat currency ISO code (e.g., 'NGN', 'USD')
     * @returns Total value in target currency with locked balances
     */
    async aggregateFiatWallets(userId, targetCurrency = 'USD') {
        try {
            // Fetch all fiat wallets for the user
            const wallets = await prisma_config_1.default.wallet.findMany({
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
            let totalValue = new decimal_js_1.default(0);
            let totalAccountBalance = new decimal_js_1.default(0);
            let totalLockedValue = new decimal_js_1.default(0);
            const walletDetails = [];
            // Process each wallet
            for (const wallet of wallets) {
                const availableBalance = new decimal_js_1.default(wallet.availableBalance || 0);
                const accountBalance = new decimal_js_1.default(wallet.accountBalance || 0);
                const lockedBalance = accountBalance.minus(availableBalance);
                let rate;
                // If wallet currency is same as target, no conversion needed
                if (wallet.currency?.ISO === targetCurrency) {
                    rate = '1.00';
                }
                else {
                    // Fetch exchange rate
                    try {
                        const rateData = await this.getRate(wallet.currency?.ISO, targetCurrency);
                        const exchangeRate = new decimal_js_1.default(rateData.value);
                        rate = exchangeRate.toFixed(2);
                    }
                    catch (error) {
                        logger_1.default.error('Failed to fetch rate for fiat wallet', {
                            walletId: wallet.id,
                            from: wallet.currency?.ISO,
                            to: targetCurrency,
                            error
                        });
                        // Skip this wallet if rate fetch fails
                        continue;
                    }
                }
                const exchangeRate = new decimal_js_1.default(rate);
                const availableValueInTarget = availableBalance.mul(exchangeRate);
                const accountValueInTarget = accountBalance.mul(exchangeRate);
                const lockedValueInTarget = lockedBalance.mul(exchangeRate);
                totalValue = totalValue.add(availableValueInTarget);
                totalAccountBalance = totalAccountBalance.add(accountValueInTarget);
                totalLockedValue = totalLockedValue.add(lockedValueInTarget);
                walletDetails.push({
                    walletId: wallet.id,
                    currency: wallet.currency?.ISO,
                    availableBalance: availableBalance.toFixed(2),
                    accountBalance: accountBalance.toFixed(2),
                    lockedBalance: lockedBalance.toFixed(2),
                    valueInTarget: availableValueInTarget.toFixed(2),
                    rate
                });
            }
            logger_1.default.info('Fiat wallets aggregated', {
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
        }
        catch (error) {
            logger_1.default.error('Failed to aggregate fiat wallets', {
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
    async aggregateCryptoWallets(userId, targetCurrency = 'USD') {
        try {
            // Fetch all crypto wallets for the user (including stablecoins)
            const wallets = await prisma_config_1.default.wallet.findMany({
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
            let totalValue = new decimal_js_1.default(0);
            let totalAccountBalance = new decimal_js_1.default(0);
            let totalLockedValue = new decimal_js_1.default(0);
            const walletDetails = [];
            // Process each wallet
            for (const wallet of wallets) {
                const availableBalance = new decimal_js_1.default(wallet.availableBalance || 0);
                const accountBalance = new decimal_js_1.default(wallet.accountBalance || 0);
                const lockedBalance = accountBalance.minus(availableBalance);
                let rate;
                // Fetch exchange rate from crypto to target fiat
                try {
                    const rateData = await this.getRate(wallet?.currency?.ISO, targetCurrency);
                    const exchangeRate = new decimal_js_1.default(rateData.value);
                    rate = exchangeRate.toFixed(2);
                }
                catch (error) {
                    logger_1.default.error('Failed to fetch rate for crypto wallet', {
                        walletId: wallet.id,
                        from: wallet?.currency?.ISO,
                        to: targetCurrency,
                        error
                    });
                    // Skip this wallet if rate fetch fails
                    continue;
                }
                const exchangeRate = new decimal_js_1.default(rate);
                const availableValueInTarget = availableBalance.mul(exchangeRate);
                const accountValueInTarget = accountBalance.mul(exchangeRate);
                const lockedValueInTarget = lockedBalance.mul(exchangeRate);
                totalValue = totalValue.add(availableValueInTarget);
                totalAccountBalance = totalAccountBalance.add(accountValueInTarget);
                totalLockedValue = totalLockedValue.add(lockedValueInTarget);
                walletDetails.push({
                    walletId: wallet.id,
                    currency: wallet.currency?.ISO,
                    availableBalance: decimal_util_1.DecimalUtil.roundForDisplay(availableBalance, wallet.currency?.ISO),
                    accountBalance: decimal_util_1.DecimalUtil.roundForDisplay(accountBalance, wallet.currency?.ISO),
                    lockedBalance: decimal_util_1.DecimalUtil.roundForDisplay(lockedBalance, wallet.currency?.ISO),
                    valueInTarget: availableValueInTarget.toFixed(2),
                    rate,
                    isStablecoin: wallet?.currency?.isStablecoin
                });
            }
            logger_1.default.info('Crypto wallets aggregated', {
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
        }
        catch (error) {
            logger_1.default.error('Failed to aggregate crypto wallets', {
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
    async aggregateAllWallets(userId, targetCurrency = 'USD') {
        try {
            // Aggregate both fiat and crypto wallets in parallel
            const [fiatResult, cryptoResult, defaultRate] = await Promise.all([
                this.aggregateFiatWallets(userId, targetCurrency),
                this.aggregateCryptoWallets(userId, targetCurrency),
                this.getRate(targetCurrency, 'USD') // Fetch default rate for logging;
            ]);
            const defaultRateDecimal = new decimal_js_1.default(defaultRate.value);
            const totalValue = new decimal_js_1.default(fiatResult.totalValue)
                .add(new decimal_js_1.default(cryptoResult.totalValue));
            const totalAccountBalance = new decimal_js_1.default(fiatResult.totalAccountBalance)
                .add(new decimal_js_1.default(cryptoResult.totalAccountBalance));
            const totalLockedValue = new decimal_js_1.default(fiatResult.lockedValue)
                .add(new decimal_js_1.default(cryptoResult.lockedValue));
            const totalInDefaultCurrency = totalAccountBalance.mul(defaultRateDecimal);
            const lockedInDefaultCurrency = totalAccountBalance.mul(defaultRateDecimal);
            logger_1.default.info('All wallets aggregated', {
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
        }
        catch (error) {
            logger_1.default.error('Failed to aggregate all wallets', {
                userId,
                targetCurrency,
                error: error.message
            });
            throw error;
        }
    }
    async subscribe_address(payload) {
        const data = {
            type: "ADDRESS_EVENT",
            attr: {
                address: payload.address,
                chain: payload.chain,
                url: "https://api-dev.vyre.africa/api/v1/webhook/tatum" //The URL of the webhook listener you are using
            }
        };
        const subscribed = await tatumAxiosV4.post('/subscription', data);
        // const subcribed = await prisma.transaction.update({
        //     where:{id: withdrawal_Id },
        //     data:{
        //       status:'SUCCESSFUL',
        //     }
        // })
        return subscribed.data.id;
    }
    async createWallet(payload) {
        const { userId, currencyId } = payload;
        const walletExists = await prisma_config_1.default.wallet.findFirst({
            where: {
                userId,
                currencyId
            }
        });
        if (walletExists)
            return walletExists;
        const currency = await prisma_config_1.default.currency.findUnique({
            where: { id: currencyId },
            select: {
                id: true,
                type: true,
                name: true,
                ISO: true,
                chain: true,
                isStablecoin: true
            }
        });
        if (!currency) {
            const error = new Error('currency not found');
            error.name = 'CurrencyNotFoundError';
            throw error;
        }
        let result;
        if (currency.isStablecoin) {
            switch (currency.ISO) {
                case 'USDC':
                    result = await stablecoin_service_1.default.create_USDC_wallet(currency.chain, userId, currency.id);
                    return result;
                    break;
                case 'USDT':
                    result = await stablecoin_service_1.default.create_Tether_wallet(currency.chain, userId, currency.id);
                    return result;
                    break;
                default:
                    return;
            }
        }
        else {
            result = await nativecoin_service_1.default.createWallet(currency.ISO, userId, currency.id);
            return result;
        }
    }
    async blockchain_Transfer(payload) {
        const { userId, currencyId, amount, address, destination_Tag } = payload;
        const currency = await prisma_config_1.default.currency.findUnique({
            where: { id: currencyId },
            select: {
                id: true,
                type: true,
                name: true,
                ISO: true,
                chain: true,
                isStablecoin: true
            }
        });
        if (!currency) {
            const error = new Error('currency not found');
            error.name = 'CurrencyNotFoundError';
            throw error;
        }
        const wallet = await prisma_config_1.default.wallet.findFirst({
            where: {
                userId,
                currencyId
            }
        });
        if (!wallet)
            return;
        let result;
        if (currency.isStablecoin) {
            const isvalid = transferfee_service_1.default.isValidWithdrawal(currency?.chain, Number(amount));
            if (!isvalid) {
                const error = new Error('Withdrawal amount below minimum');
                error.name = 'Amount Below Minimum';
                throw error;
            }
            switch (currency.ISO) {
                case 'USDC':
                    result = await stablecoin_service_1.default.Transfer_USDC({
                        chain: currency?.chain,
                        userId,
                        walletId: wallet.id,
                        amount,
                        index: wallet?.derivationKey,
                        address
                    });
                    return result;
                    break;
                case 'USDT':
                    result = await stablecoin_service_1.default.Transfer_Tether({
                        chain: currency?.chain,
                        userId,
                        walletId: wallet.id,
                        amount,
                        index: wallet?.derivationKey,
                        address
                    });
                    return result;
                    break;
                default:
                    return;
            }
        }
        else {
            result = await nativecoin_service_1.default.blockchain_Transfer({
                ISO: currency.ISO,
                userId,
                walletId: wallet?.id,
                amount,
                index: wallet?.derivationKey,
                address,
                destination_Tag
            });
        }
    }
    async offchain_Transfer(payload) {
        const { userId, receipientId, currencyId, amount } = payload;
        const startTime = Date.now();
        try {
            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new decimal_js_1.default(amount);
            // Validate amount
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }
            logger_1.default.info('Offchain transfer initiated', {
                userId,
                receipientId,
                currencyId,
                amount: amountDecimal.toString()
            });
            // ============================================
            // STEP 1: FETCH DATA IN PARALLEL (OPTIMIZED)
            // ============================================
            const fetchStartTime = Date.now();
            const [currency, user_Wallet, receipient_Wallet_Temp] = await Promise.all([
                prisma_config_1.default.currency.findUnique({
                    where: { id: currencyId },
                    select: {
                        id: true,
                        type: true,
                        name: true,
                        ISO: true,
                        chain: true
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: { userId, currencyId },
                    select: {
                        id: true,
                        userId: true,
                        currencyId: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: { userId: receipientId, currencyId },
                    select: {
                        id: true,
                        userId: true,
                        currencyId: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                })
            ]);
            const fetchDuration = Date.now() - fetchStartTime;
            logger_1.default.info('⏱️ Data fetch complete', { duration: `${fetchDuration}ms` });
            if (!currency) {
                throw new Error('Currency not found');
            }
            if (!user_Wallet) {
                throw new Error('User wallet not found');
            }
            // ============================================
            // STEP 2: CREATE RECIPIENT WALLET IF NEEDED
            // ============================================
            let receipient_Wallet = receipient_Wallet_Temp;
            if (!receipient_Wallet) {
                const walletCreateStart = Date.now();
                logger_1.default.info('Creating recipient wallet', { receipientId, currencyId });
                receipient_Wallet = await this.createWallet({
                    userId: receipientId,
                    currencyId: currencyId
                });
                const walletCreateDuration = Date.now() - walletCreateStart;
                logger_1.default.info('⏱️ Wallet created', { duration: `${walletCreateDuration}ms` });
            }
            // ============================================
            // STEP 3: VALIDATE BALANCE
            // ============================================
            const availableBalance = new decimal_js_1.default(user_Wallet.availableBalance);
            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(`Insufficient balance. Available: ${availableBalance.toFixed(8)} ${currency.ISO}, Required: ${amountDecimal.toFixed(8)} ${currency.ISO}`);
            }
            // ============================================
            // STEP 4: EXECUTE TATUM TRANSFER
            // ============================================
            // Prepare transfer data
            const data = {
                senderAccountId: user_Wallet.id,
                recipientAccountId: receipient_Wallet.id,
                amount: decimal_util_1.DecimalUtil.roundForDisplay(amountDecimal, currency.ISO), // ✅ String for API
                anonymous: false,
                compliant: false
            };
            logger_1.default.info('📡 Executing Tatum API call', {
                from: user_Wallet.id,
                to: receipient_Wallet.id,
                amount: amountDecimal.toString(),
                currency: currency.ISO
            });
            const apiStartTime = Date.now();
            // Execute transfer
            const response = await tatumAxios.post('/ledger/transaction', data);
            const paymentData = response.data;
            const apiDuration = Date.now() - apiStartTime;
            logger_1.default.info('🟢 Tatum API complete', {
                reference: paymentData.reference,
                status: paymentData.status,
                duration: `${apiDuration}ms`
            });
            // ============================================
            // STEP 5: BACKGROUND POST-PROCESSING
            // ============================================
            // ✅ Move slow operations to background
            setImmediate(async () => {
                const postProcessStart = Date.now();
                try {
                    // Sync wallets in parallel
                    await Promise.all([
                        this.getAccount(user_Wallet.id),
                        this.getAccount(receipient_Wallet.id)
                    ]);
                    // Create transaction records
                    await prisma_config_1.default.transaction.createMany({
                        data: [
                            {
                                userId: userId,
                                currency: currency.ISO,
                                amount: amountDecimal.negated(),
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
                            {
                                userId: receipientId,
                                currency: currency.ISO,
                                amount: amountDecimal,
                                reference: paymentData.reference,
                                status: 'SUCCESSFUL',
                                walletId: receipient_Wallet.id,
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
                    const postProcessDuration = Date.now() - postProcessStart;
                    logger_1.default.info('🔄 Background post-processing complete', {
                        reference: paymentData.reference,
                        duration: `${postProcessDuration}ms`
                    });
                }
                catch (postError) {
                    logger_1.default.error('⚠️ Background post-processing failed (non-critical)', {
                        reference: paymentData.reference,
                        error: postError.message
                    });
                    // Don't throw - transfer already succeeded
                }
            });
            const totalDuration = Date.now() - startTime;
            logger_1.default.info('✅ Offchain transfer COMPLETE', {
                reference: paymentData.reference,
                totalDuration: `${totalDuration}ms`
            });
            // ✅ Return immediately after Tatum API succeeds
            return {
                success: true,
                reference: paymentData.reference,
                amount: amountDecimal.toString(),
                currency: currency.ISO,
                senderWallet: user_Wallet.id,
                recipientWallet: receipient_Wallet.id
            };
        }
        catch (error) {
            const totalDuration = Date.now() - startTime;
            logger_1.default.error('🔴 Offchain transfer FAILED', {
                error: error.message,
                userId,
                receipientId,
                currencyId,
                amount,
                totalDuration: `${totalDuration}ms`,
                stack: error.stack
            });
            throw error;
        }
    }
    async direct_offchain_Transfer(payload) {
        const { userId, receipientId, currencyId, amount } = payload;
        const startTime = Date.now();
        try {
            const amountDecimal = new decimal_js_1.default(amount);
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }
            logger_1.default.info('🔵 Direct offchain transfer START', {
                userId,
                receipientId,
                currencyId,
                amount: amountDecimal.toString()
            });
            // ============================================
            // STEP 1: FETCH DATA IN PARALLEL
            // ============================================
            const fetchStartTime = Date.now();
            const [currency, user_Wallet, receipient_Wallet] = await Promise.all([
                prisma_config_1.default.currency.findUnique({
                    where: { id: currencyId },
                    select: {
                        id: true,
                        type: true,
                        name: true,
                        ISO: true,
                        chain: true
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: { userId, currencyId },
                    select: {
                        id: true,
                        userId: true,
                        currencyId: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                }),
                prisma_config_1.default.wallet.findFirst({
                    where: { userId: receipientId, currencyId },
                    select: {
                        id: true,
                        userId: true,
                        currencyId: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                })
            ]);
            const fetchDuration = Date.now() - fetchStartTime;
            logger_1.default.info('⏱️ Data fetch complete', { duration: `${fetchDuration}ms` });
            if (!currency) {
                throw new Error('Currency not found');
            }
            if (!user_Wallet) {
                throw new Error('User wallet not found');
            }
            if (!receipient_Wallet) {
                throw new Error(`Recipient wallet not found for user ${receipientId} and currency ${currency.ISO}`);
            }
            // ============================================
            // STEP 2: VALIDATE BALANCE
            // ============================================
            const availableBalance = new decimal_js_1.default(user_Wallet.availableBalance);
            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(`Insufficient balance. Available: ${availableBalance.toFixed(8)} ${currency.ISO}, Required: ${amountDecimal.toFixed(8)} ${currency.ISO}`);
            }
            // ============================================
            // STEP 3: EXECUTE TATUM TRANSFER
            // ============================================
            const transferData = {
                senderAccountId: user_Wallet.id,
                recipientAccountId: receipient_Wallet.id, // ✅ Removed optional chaining
                amount: decimal_util_1.DecimalUtil.roundForDisplay(amountDecimal, currency.ISO),
                anonymous: false,
                compliant: false
            };
            logger_1.default.info('📡 Executing Tatum API call', {
                from: user_Wallet.id,
                to: receipient_Wallet.id, // ✅ Removed optional chaining
                amount: amountDecimal.toString(),
                currency: currency.ISO
            });
            const apiStartTime = Date.now();
            // ✅ Add timeout to prevent hanging
            const response = await tatumAxios.post('/ledger/transaction', transferData);
            const paymentData = response.data;
            const apiDuration = Date.now() - apiStartTime;
            logger_1.default.info('🟢 Tatum API complete', {
                reference: paymentData.reference,
                status: paymentData.status,
                duration: `${apiDuration}ms`
            });
            // ============================================
            // STEP 4: BACKGROUND POST-PROCESSING
            // ============================================
            setImmediate(async () => {
                const postProcessStart = Date.now();
                try {
                    // Sync wallets in parallel
                    await Promise.all([
                        this.getAccount(user_Wallet.id),
                        this.getAccount(receipient_Wallet.id) // ✅ Removed optional chaining & type assertion
                    ]);
                    // Create transaction records
                    await prisma_config_1.default.transaction.createMany({
                        data: [
                            {
                                userId: userId,
                                currency: currency.ISO,
                                amount: amountDecimal.negated(),
                                reference: paymentData.reference,
                                status: 'SUCCESSFUL',
                                walletId: user_Wallet.id,
                                type: 'DEBIT_PAYMENT',
                                description: `${currency.name} transfer to ${receipientId.slice(0, 8)}`,
                                metadata: {
                                    recipientId: receipientId,
                                    recipientWalletId: receipient_Wallet.id, // ✅ Removed optional chaining
                                    currency: currency.ISO,
                                    transferType: 'direct_offchain'
                                }
                            },
                            {
                                userId: receipientId,
                                currency: currency.ISO,
                                amount: amountDecimal,
                                reference: paymentData.reference,
                                status: 'SUCCESSFUL',
                                walletId: receipient_Wallet.id, // ✅ Removed optional chaining
                                type: 'CREDIT_PAYMENT',
                                description: `${currency.name} transfer from ${userId.slice(0, 8)}`,
                                metadata: {
                                    senderId: userId,
                                    senderWalletId: user_Wallet.id,
                                    currency: currency.ISO,
                                    transferType: 'direct_offchain'
                                }
                            }
                        ]
                    });
                    const postProcessDuration = Date.now() - postProcessStart;
                    logger_1.default.info('🔄 Background post-processing complete', {
                        reference: paymentData.reference,
                        duration: `${postProcessDuration}ms`
                    });
                }
                catch (postError) {
                    logger_1.default.error('⚠️ Background post-processing failed (non-critical)', {
                        reference: paymentData.reference,
                        error: postError.message
                    });
                }
            });
            const totalDuration = Date.now() - startTime;
            logger_1.default.info('✅ Direct offchain transfer COMPLETE', {
                reference: paymentData.reference,
                totalDuration: `${totalDuration}ms`
            });
            return {
                success: true,
                reference: paymentData.reference,
                amount: amountDecimal.toString(),
                currency: currency.ISO,
                senderWallet: user_Wallet.id,
                recipientWallet: receipient_Wallet.id // ✅ Removed optional chaining
            };
        }
        catch (error) {
            const totalDuration = Date.now() - startTime;
            logger_1.default.error('🔴 Direct offchain transfer FAILED', {
                error: error.message,
                userId,
                receipientId,
                currencyId,
                amount,
                totalDuration: `${totalDuration}ms`,
                stack: error.stack
            });
            throw error;
        }
    }
    async bank_Transfer(payload) {
        const { account_number, bank_code, recipient_name, endpoint } = payload;
        const data = {
            account_number,
            bank_code,
            recipient_name
        };
        const response = await axios_1.default.post(endpoint, data);
        console.log('qorepay transfer response', response.data);
        const result = response.data;
        return result;
    }
    async processMomoPayment(payload) {
        // Implement MOMO payment
        throw new Error('MOMO payment not implemented');
    }
    /**
     * Initiate bank withdrawal notifying the user
    */
    async direct_bank_Transfer(payload) {
        const { amount, currencyId, userId } = payload;
        const wallet = await prisma_config_1.default.wallet.findFirst({
            where: {
                userId: userId,
                currencyId
            },
            include: {
                currency: true
            }
        });
        if (!wallet) {
        }
        const result = await qorepay_service_1.default.bank_Transfer({ ...payload, currency: wallet?.currency?.ISO });
        console.log('---------Wallet to bank withdrawal initiated--------');
        // deduct amount from wallet
        // // debit user wallet
        await this.debit_Wallet(amount, wallet?.id);
        // record transaction
        await prisma_config_1.default.transaction.create({
            data: {
                userId,
                currency: wallet?.currency?.ISO,
                amount,
                reference: result.id,
                status: 'PENDING',
                walletId: wallet?.id,
                type: 'FIAT_WITHDRAWAL',
                description: `${globals_1.currency} bank withdrawal transfer`
            }
        });
        return result;
    }
    async depositFiat(payload) {
        const { currency, amount, email, userId, walletId, method } = payload;
        // const details = await qorepayService.deposit_via_Url({
        //     currency,
        //     amount, 
        //     email,
        //     userId,
        //     walletId
        // })
        const details = await qorepay_service_1.default.deposit_via_Bank({
            currency,
            amount,
            email,
            userId,
            walletId
        });
        return details;
    }
    /**
     * process and returns preferred method details for payment for anonymous order
    */
    async getPaymentMethod(payload) {
        const { method = 'BANK_TRANSFER' } = payload;
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Payment method timeout')), 8000));
        try {
            switch (method) {
                case 'BANK_TRANSFER':
                    return await Promise.race([
                        qorepay_service_1.default.deposit_via_Bank(payload),
                        timeoutPromise
                    ]);
                case 'MOMO':
                    return await Promise.race([
                        this.processMomoPayment(payload),
                        timeoutPromise
                    ]);
                default:
                    return await Promise.race([
                        qorepay_service_1.default.deposit_via_Bank(payload),
                        timeoutPromise
                    ]);
            }
        }
        catch (error) {
            logger_1.default.error('Payment method failed:', { method, error });
            throw error;
        }
    }
    async getRate(currency, basePair) {
        const response = await tatumAxios.get(`/tatum/rate/${currency}?basePair=${basePair}`);
        const result = response.data;
        console.log('fetched rate', result);
        try {
            // ✅ Use Decimal for financial calculations
            const value = new decimal_js_1.default(result.value);
            return {
                ...result,
                value: value.toFixed(2), // Decimal's toFixed works correctly
                rawValue: value.toString() // Keep full precision
            };
        }
        catch (error) {
            throw new Error(`Invalid rate value received: ${result.value}`);
        }
    }
    /**
     * Sync and returns wallet data including balances
    */
    async getAccount(id) {
        try {
            // ✅ Single query - fetch Tatum data with wallet info in one transaction
            const [tatumResponse, wallet] = await Promise.all([
                tatumAxios.get(`/ledger/account/${id}`),
                prisma_config_1.default.wallet.findUnique({
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
            if (!wallet)
                throw new Error(`Wallet ${id} not found`);
            const result = tatumResponse.data;
            const currencyISO = wallet.currency?.ISO || 'BTC';
            // ✅ Round balances (in-memory, fast)
            const accountBalance = decimal_util_1.DecimalUtil.roundForDisplay(result.balance?.accountBalance || 0, currencyISO);
            const availableBalance = decimal_util_1.DecimalUtil.roundForDisplay(result.balance?.availableBalance || 0, currencyISO);
            // ✅ Single update with all data
            return await prisma_config_1.default.wallet.update({
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
        }
        catch (error) {
            logger_1.default.error('Wallet sync failed', {
                walletId: id,
                error: error.message
            });
            throw error;
        }
    }
    async authorize_Withdrawal(currency, amount, email, phone) {
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
            sender_name: 'Vyre Africa',
            brand_id: env_config_1.default.QOREPAY_BRAND_ID,
        };
        const response = await qorepayAxios.post(`/payouts/`, data);
        console.log('first response', response.data);
        const result = response.data;
        const registered = await axios_1.default.get(result?.execution_url);
        const payment = registered.data;
        // const paymentDetails ={
        //     banks: payment?.detail.data,
        //     url: payment?.payout_url,
        // }
        if (payment?.status === 'error') {
            return null;
        }
        return payment?.payout_url;
    }
    async debit_Wallet(amount, accountId) {
        const data = {
            accountId,
            amount
        };
        const response = await tatumAxios.put('/ledger/virtualCurrency/revoke', data);
        const responseData = response.data;
        console.log(responseData.reference);
        return responseData.reference;
    }
    async credit_Wallet(amount, accountId) {
        const data = {
            accountId,
            amount: String(amount)
        };
        console.log('crediting wallet', accountId);
        const response = await tatumAxios.put('/ledger/virtualCurrency/mint', data);
        const responseData = response.data;
        console.log(responseData.reference);
        // sync wallet
        const wallet = await this.getAccount(accountId);
        return wallet;
    }
    // async handleFiatCredit(payload:{amount:number,accountId: string}){
    //     const {amount, accountId} = payload
    //     await this.credit_Wallet(amount,accountId)
    // }
    async block_Amount(amount, accountId) {
        const data = {
            amount: String(amount),
            type: 'ORDER_BLOCK',
            description: 'order amount blocked',
            ensureSufficientBalance: true
        };
        const response = await tatumAxios.post(`https://api.tatum.io/v3/ledger/account/block/${accountId}`, data);
        const responseData = response.data;
        console.log(responseData.id);
        const record = await prisma_config_1.default.block.create({
            data: {
                id: responseData.id,
                walletId: accountId,
                amount,
                description: 'order amount blocked'
            }
        });
        console.log('amount blocked');
        return responseData.id;
    }
    async unblock_Transfer(amount, blockId, recipientAccountId) {
        const startTime = Date.now();
        try {
            const data = {
                recipientAccountId,
                amount: String(amount),
                anonymous: true,
                compliant: false
            };
            logger_1.default.info('🔵 Unblock transfer START', {
                blockId,
                recipientAccountId,
                amount: String(amount)
            });
            const response = await tatumAxios.put(`https://api.tatum.io/v3/ledger/account/block/${blockId}`, data);
            const responseData = response.data;
            console.log(responseData.reference);
            const duration = Date.now() - startTime;
            logger_1.default.info('🟢 Unblock transfer API complete', {
                blockId,
                reference: responseData.reference,
                duration: `${duration}ms`
            });
            // ✅ Skip wallet sync - not needed immediately
            // Wallet balance is already updated by Tatum
            // Sync in background if needed
            setImmediate(() => {
                this.getAccount(recipientAccountId).catch(err => logger_1.default.error('Background wallet sync failed (non-critical)', {
                    recipientAccountId,
                    error: err.message
                }));
            });
            const totalDuration = Date.now() - startTime;
            logger_1.default.info('✅ Unblock transfer COMPLETE', {
                blockId,
                totalDuration: `${totalDuration}ms`
            });
            return {
                success: true,
                reference: responseData.reference,
                blockId,
                recipientAccountId
            };
        }
        catch (error) {
            const duration = Date.now() - startTime;
            logger_1.default.error('🔴 Unblock transfer FAILED', {
                blockId,
                recipientAccountId,
                duration: `${duration}ms`,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    async unblock_Amount(blockId) {
        const response = await tatumAxios.delete(`https://api.tatum.io/v3/ledger/account/block/${blockId}`);
        const responseData = response.data;
        console.log(responseData);
        await prisma_config_1.default.block.update({
            where: { id: blockId },
            data: {
                active: false
            }
        });
        return responseData.reference;
    }
    async deletePaymentAccountById(accountId) {
        try {
            // First try to delete from fiat accounts
            const deletedFiatAccount = await prisma_config_1.default.fiatAccount.deleteMany({
                where: {
                    id: accountId
                }
            });
            // If a fiat account was deleted, return true
            if (deletedFiatAccount.count > 0) {
                return true;
            }
            // If no fiat account was found, try crypto accounts
            const deletedCryptoAccount = await prisma_config_1.default.cryptoAccount.deleteMany({
                where: {
                    id: accountId
                }
            });
            // Return true if a crypto account was deleted
            return deletedCryptoAccount.count > 0;
        }
        catch (error) {
            console.error('Error deleting account:', error);
            return false;
        }
    }
    async queue(payload) {
        const { amount, address, destination_Tag, userId, receipientId, currencyId, currency, email, phone, account_number, bank_code, recipient_name, type } = payload;
        if (type === 'OFFCHAIN') {
            return await this.generalQueue.add('offchain-transfer', {
                userId,
                receipientId,
                currencyId,
                amount
            });
        }
        if (type === 'BLOCKCHAIN') {
            return await this.generalQueue.add('blockchain-transfer', {
                userId,
                currencyId,
                amount,
                address,
                destination_Tag
            });
        }
        if (type === 'BANK') {
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
exports.default = new WalletService();
