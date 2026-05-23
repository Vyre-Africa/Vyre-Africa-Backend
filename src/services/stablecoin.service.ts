import { Request, Response } from 'express';
import prisma from '../config/prisma.client';
import config from '../config/env.config';
import { Wallet } from '@prisma/client';
import axios, { AxiosInstance } from "axios";
import Decimal from 'decimal.js';
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
import { hasSufficientBalance } from '../utils';
import walletService from './wallet.service';
import TransferfeeService from './transferfee.service';
import transferfeeService from './transferfee.service';
import notificationService from './notification.service';
import { NotificationType } from '@prisma/client';
import logger from '../config/logger';
import chainService from './chain.service';
import { DecimalUtil } from './decimal.util';
import gaspumpService from './gaspump.service';
import virtualAccountService from './virtualAccount.service';
import { CHAIN_CONFIG, getChainConfigByCurrency, getChainKey} from '../config/blockchain.config';



    interface ChainConfig {
    tatumCurrency: string;
    tatumEndpoint: string;
    webhookChain: string;
    displayName: string;
    mnemonic: string;
    xpub: string;
    }

    interface TransferPayload {
    userId: string;
    walletId: string;
    address: string;
    amount: string;
    index?: number;
    }

    interface WalletCreationResult {
        id: string;
        depositAddress: string;
        subscriptionId: string;
        derivationKey: number;
    }

    type AllSupportedChains = 'ETHEREUM' | 'TRON' | 'BASE' | 'BSC' | 'ARBITRUM' | 'OPTIMISM' | 'POLYGON' | 'SOLANA';
    type StablecoinType = 'USDC' | 'USDT';
    const BLOCKCHAIN_DECIMALS = 8;

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

class stableCoinService
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
    // CORE WALLET OPERATIONS
    // ============================================

    private roundForBlockchain(amount: Decimal | string | number): string {
            const amountDecimal = new Decimal(amount);
            return amountDecimal.toDecimalPlaces(BLOCKCHAIN_DECIMALS, Decimal.ROUND_DOWN).toString();
        }

    private async generateAddress(accountId: string) {
        try {
            const response = await this.tatumAxios.post(`/offchain/account/${accountId}/address`);
            const result = response.data;
            return result

        } catch (error) {
        logger.error('Failed to generate address:', error);
          throw new Error('Failed to generate deposit address');
        }
    }

    private async subscribeAddress(payload: { 
        address: string; 
        chain: string; 
        contractAddress?: string 
    }) {
        try {
            const attr: any = {
                address: payload.address,
                chain:   payload.chain,
                url:     `https://api-dev.vyre.africa/api/v1/webhook/tatum`
            };

            // Only add conditions for token transfers with a known contract
            if (payload.contractAddress) {
                attr.conditions = [
                    {
                        field:    'contractAddress',
                        operator: '==',
                        value:    payload.contractAddress  // e.g. USDC contract on Base
                    },
                    {
                        field:    'value',
                        operator: '>=',
                        value:    '1000000'  // minimum 1 USDC (6 decimals)
                    }
                ];
            }

            const data = {
                type: 'ADDRESS_EVENT',
                attr
            };

            const response = await this.tatumAxiosV4.post('/subscription', data);
            return response.data;

        } catch (error) {
            logger.error('Failed to subscribe address:', error);
            throw new Error('Failed to subscribe to address events');
        }
    }


    // ============================================
    // UNIFIED WALLET CREATION
    // ============================================

    async createWallet(
        stablecoin: StablecoinType,
        chain: AllSupportedChains,
        userId: string,
        currencyId: string
    ): Promise<Wallet> {

        let wallet: any = null;

        try {
            // ── 1. Validate chain support ────────────────────────────
            const chainConfig = getChainConfigByCurrency(chain, stablecoin);
            if (!chainConfig) throw new Error(`Unsupported chain: ${chain} for ${stablecoin}`);

            const chainKey = getChainKey(chainConfig.blockchain, chainConfig.currency);
            if (!chainKey) throw new Error(`No chain key found for ${chainConfig.blockchain}/${chainConfig.currency}`);

            logger.info(`Creating ${stablecoin} wallet on ${chain}`, { userId, currencyId });

            // ── 2. Create virtual account (ledger) ───────────────────
            const account = await virtualAccountService.createAccount({
                userId,
                currency: chainConfig.currency,
                type: 'STANDARD',
                label: chainConfig.tokenSymbol,
                blockchain: chainConfig.blockchain
            });

            // ── 3. Create wallet record in DB ────────────────────────
            wallet = await prisma.wallet.create({
                data: {
                    id:                 account.id,
                    Tatum_customerId:   userId,
                    currencyId,
                    userId,
                    accountingCurrency: 'USD',
                    frozen: false
                }
            });

            // ── 4. Generate deposit address ──────────────────────────
            let gasPumpAddress: string | undefined;

            // Gas pump chains get their address from Tatum gas pump
            if (gaspumpService.isGasPumpChain(chain)) {
                const result = await gaspumpService.generateAddress(
                    wallet.id,
                    chain,
                    currencyId
                );
                gasPumpAddress = result?.address;
            }

            // Connect address to virtual account
            // If gas pump address exists pass it directly, otherwise generate from Tatum
            const { address: depositAddress } = await virtualAccountService.generateAndConnectAddress(
                account.id,
                chainKey,
                gasPumpAddress  // undefined for non-gas-pump chains — generates from Tatum
            );

            // ── 5. Subscribe to deposit events ───────────────────────
            const subscription = await this.subscribeAddress({
                address: depositAddress,
                chain:   chainConfig.webhookChain!,
                contractAddress: chainConfig.tokenMint  // Only add contract condition for ERC20 tokens
            });

            // ── 6. Update wallet with address + subscription ─────────
            const updatedWallet = await prisma.wallet.update({
                where: { id: wallet.id },
                data: {
                    depositAddress,
                    subscriptionId: subscription.id,
                    derivationKey:  null  // index tracked in VirtualAccountAddress / GasPumpAddress
                }
            });

            logger.info(`Wallet created successfully`, {
                walletId: updatedWallet.id,
                address:  updatedWallet.depositAddress,
                chain,
                stablecoin
            });

            return updatedWallet;

        } catch (error) {

            logger.error(`Failed to create ${stablecoin} wallet on ${chain}`, {
                userId,
                currencyId,
                error
            });

            // Clean up orphaned wallet if it was created before the error
            if (wallet?.id) {
                logger.warn(`Cleaning up orphaned wallet ${wallet.id}`);
                await prisma.wallet.delete({
                    where: { id: wallet.id }
                }).catch((e) => logger.error(`Failed to clean up wallet ${wallet.id}`, e));
            }

            throw error;
        }
    }


    // ============================================
    // UNIFIED TRANSFER OPERATION
    // ============================================

    private async executeTransfer(
        stablecoin: StablecoinType,
        chain: AllSupportedChains,
        payload: TransferPayload
    ) {
        try {
            const { userId, walletId, address, amount, index = 1 } = payload;

            // ✅ Convert amount to Decimal immediately
            const amountDecimal = new Decimal(amount);

            // Validate inputs
            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }

            const chainConfig = getChainConfigByCurrency(chain, stablecoin)

            if (!chainConfig) {
                throw new Error(`No chainConfig found for ${chain}/${stablecoin}`);
            }
            const chainKey = getChainKey(chainConfig.blockchain, chainConfig.currency);
            if (!chainKey) {
                throw new Error(`No chainKey found for ${chainConfig.blockchain}/${chainConfig.currency}`);
            }
            
            const withdrawalFeeDecimal = new Decimal(transferfeeService.calculateFee(chain));
            const netAmountDecimal = amountDecimal.minus(withdrawalFeeDecimal);

            if (netAmountDecimal.lessThanOrEqualTo(0)) {
                throw new Error(`Amount too small to cover network fee of $${withdrawalFeeDecimal.toString()}`);
            }

            logger.info(`Initiating ${stablecoin} transfer on ${chain}`, {
                userId,
                grossAmount: amountDecimal.toString(),
                fee: withdrawalFeeDecimal.toString(),
                netAmount: netAmountDecimal.toString(),
                address
            });

            // Get user wallet and check balance
            const userWallet = await prisma.wallet.findUnique({
                where: { id: walletId },
                select: { currencyId: true, availableBalance: true, accountBalance: true }
            });

            if (!userWallet) {
                throw new Error('Wallet not found');
            }

            // ✅ Convert wallet balance to Decimal
            const availableBalance = new Decimal(userWallet.availableBalance);
            const accountBalance = new Decimal(userWallet.accountBalance);

            logger.info('Balance verification', {
                availableBalance: availableBalance.toString(),
                accountBalance: accountBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
            });

            // ✅ Use Decimal comparison
            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(
                    `Insufficient balance. Available: ${availableBalance.toFixed(8)}, Required: ${amountDecimal.toFixed(8)}`
                );
            }

            let transferData;

            // Handle admin vs user transfers
            if (config.Admin_Id !== userId) {
                // Transfer to admin first
                const adminWallet = await prisma.wallet.findFirst({
                    where: {
                        userId: config.Admin_Id,
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
                    receipientId: config.Admin_Id,
                    currencyId: userWallet.currencyId as string,
                    amount:  amountDecimal.toString() // Convert for service
                });

                transferData = await virtualAccountService.transferCryptoToExternal({
                    virtualAccountId: adminWallet.id,
                    toAddress: address,
                    amount: DecimalUtil.roundForDisplay(netAmountDecimal,stablecoin),
                    chainKey,
                    metadata: {
                        availableBalance: availableBalance.toString(),
                        accountBalance: accountBalance.toString(),
                        requestedAmount: amountDecimal.toString(),
                        hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
                    }
                
                })

            } else {

                transferData = await virtualAccountService.transferCryptoToExternal({
                    virtualAccountId: walletId,
                    toAddress: address,
                    amount: DecimalUtil.roundForDisplay(netAmountDecimal,stablecoin),
                    chainKey,
                    metadata: {
                        availableBalance: availableBalance.toString(),
                        accountBalance: accountBalance.toString(),
                        requestedAmount: amountDecimal.toString(),
                        hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
                    }
                
                })

            }

            const result = transferData;

            // Create transaction record
            let transaction = await prisma.transaction.create({
                data: {
                    id: result.reference,
                    userId,
                    currency: `${stablecoin} ${chain}`,
                    amount: DecimalUtil.roundForDisplay(netAmountDecimal,stablecoin), // Prisma accepts Decimal
                    status: 'SUCCESSFUL',
                    reference: result.txHash,
                    walletId,
                    type: 'CRYPTO_WITHDRAWAL',
                    description: `${stablecoin} ${chain} transfer`,
                    metadata: {
                        grossAmount: amountDecimal.toString(),
                        fee: withdrawalFeeDecimal.toString(),
                        netAmount: netAmountDecimal.toString(),
                        recipientAddress: address,
                        chain: chainConfig.blockchain
                    }
                }
            });

            // Send notification
            await this.sendTransferNotification({
                userId,
                stablecoin,
                chain: chainConfig.blockchain,
                grossAmount: DecimalUtil.roundForDisplay(amountDecimal,stablecoin),
                fee: DecimalUtil.roundForDisplay(withdrawalFeeDecimal,stablecoin),
                netAmount: DecimalUtil.roundForDisplay(netAmountDecimal,stablecoin),
                address,
                status:'Completed'
            });

            logger.info(`Transfer completed successfully`, { 
                transactionId: transaction.id,
                txId: result.txHash,
                grossAmount: amountDecimal.toString(),
                netAmount: netAmountDecimal.toString()
            });

            return transaction;

        } catch (error: any) {
            logger.error(`Transfer failed:`, {
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

    private async offchainTransfer(payload: {
        userId: string;
        receipientId: string;
        currencyId: string;
        amount: string; // ✅ Keep as string
    }) {
        const { userId, receipientId, currencyId, amount } = payload;

        try {
            // ✅ Convert to Decimal immediately
            const amountDecimal = new Decimal(amount);

            if (amountDecimal.lessThanOrEqualTo(0)) {
                throw new Error('Transfer amount must be greater than 0');
            }

            const [recipientWallet, userWallet, currency] = await Promise.all([
                prisma.wallet.findFirst({
                    where: { userId: receipientId, currencyId },
                    select: {
                        id: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                }),
                prisma.wallet.findFirst({
                    where: { userId, currencyId },
                    select: {
                        id: true,
                        availableBalance: true,
                        accountBalance: true
                    }
                }),
                prisma.currency.findUnique({
                    where:{id: currencyId}
                })
            ]);

            if (!recipientWallet || !userWallet) {
                throw new Error('Wallet not found for offchain transfer');
            }

            // ✅ Convert wallet balance to Decimal and compare
            const availableBalance = new Decimal(userWallet.availableBalance);

            logger.info('Offchain transfer balance check', {
                userId,
                availableBalance: availableBalance.toString(),
                requestedAmount: amountDecimal.toString(),
                hasSufficient: availableBalance.greaterThanOrEqualTo(amountDecimal)
            });

            if (availableBalance.lessThan(amountDecimal)) {
                throw new Error(
                    `Insufficient balance for offchain transfer. Available: ${availableBalance.toFixed(8)}, Required: ${amountDecimal.toFixed(8)}`
                );
            }

            logger.info('Executing offchain transfer', {
                fromUserId: userId,
                toUserId: receipientId,
                amount: amountDecimal.toString()
            });

            const response =  await virtualAccountService.p2pTransfer({
                fromUserId: userId,
                toUserId: receipientId,
                amount,
                currency: currency?.ISO!,
                blockchain: currency?.chain ?? undefined,
                description: `Offchain transfer of ${currency?.ISO!}`,
            })
            
            logger.info('Offchain transfer successful', {
                fromUserId: userId,
                toUserId: receipientId,
                amount: amountDecimal.toString()
            });

            return response;

        } catch (error: any) {
            logger.error('Offchain transfer failed:', {
                error: error.message,
                userId,
                receipientId,
                amount,
                stack: error.stack
            });
            throw error;
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

    private async sendTransferNotification(params: {
        userId: string;
        stablecoin: StablecoinType;
        chain: string;
        grossAmount: string;
        fee: string;
        netAmount: string;
        address: string;
        status: string;
    }) {
        const { userId, stablecoin, chain, grossAmount, fee, netAmount, address, status } = params;

        await notificationService.queue({
        userId,
        type: 'GENERAL' as NotificationType,
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

    async createUSDCWallet(chain: AllSupportedChains, userId: string, currencyId: string) {
        return this.createWallet('USDC', chain, userId, currencyId);
    }

    async createUSDTWallet(chain: AllSupportedChains, userId: string, currencyId: string) {
        return this.createWallet('USDT', chain, userId, currencyId);
    }

    async transferUSDC(chain: AllSupportedChains, payload: TransferPayload) {
        return this.executeTransfer('USDC', chain, payload);
    }

    async transferUSDT(chain: AllSupportedChains, payload: TransferPayload) {
        return this.executeTransfer('USDT', chain, payload);
    }

    // Legacy method compatibility
    async create_USDC_wallet(chain: string, userId: string, currencyId: string) {
        return this.createUSDCWallet(chain as AllSupportedChains, userId, currencyId);
    }

    async create_Tether_wallet(chain: string, userId: string, currencyId: string) {
        return this.createUSDTWallet(chain as AllSupportedChains, userId, currencyId);
    }

    async Transfer_USDC(payload: {
        chain: string;
        userId: string;
        walletId: string;
        amount: string;
        index: number;
        address: string;
    }) {
        const { chain, ...rest } = payload;
        return this.transferUSDC(chain as AllSupportedChains, rest);
    }

    async Transfer_Tether(payload: {
        chain: string;
        userId: string;
        walletId: string;
        amount: string;
        index: number;
        address: string;
    }) {
        const { chain, ...rest } = payload;
        return this.transferUSDT(chain as AllSupportedChains, rest);
    }

}





export default new stableCoinService()