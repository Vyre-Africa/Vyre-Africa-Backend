// scripts/createAdminWallets.ts

import prisma from '../../src/config/prisma.client';
import virtualAccountService from '../services/virtualAccount.service';
import { CHAIN_CONFIG, getChainKey } from '../../src/config/blockchain.config';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// ── Admin user IDs ───────────────────────────────────────────
const ADMIN_USER_IDS = [
    "user_38OI3Y47pS0u4gKiRoee5GySGiV",
    // process.env.Admin_Id!,
    
    // add more admin IDs here if needed
];

// ── Chains that support gas pump (admin wallet = master address) ──
const GAS_PUMP_CHAINS = new Set(['ETHEREUM', 'POLYGON', 'BSC', 'TRON']);

// ── All wallets to create for admin ─────────────────────────
const ADMIN_WALLET_CONFIGS = [
    // Fiat
    // { currency: 'NGN',  blockchain: null,       chainKey: null },
    // { currency: 'USD',  blockchain: null,       chainKey: null },

    // Native crypto
    // { currency: 'ETH',  blockchain: 'ETHEREUM', chainKey: 'ETH' },
    // { currency: 'BTC',  blockchain: 'BTC',      chainKey: 'BTC' },
    // { currency: 'TRX',  blockchain: 'TRON',     chainKey: 'TRON' },
    // { currency: 'LTC',  blockchain: 'LTC',      chainKey: 'LTC' },
    // { currency: 'SOL',  blockchain: 'SOL',      chainKey: 'SOL' },
    // { currency: 'XRP',  blockchain: 'XRP',      chainKey: 'XRP' },

    // Stablecoins
    // { currency: 'USDT', blockchain: 'TRON',     chainKey: 'USDT_TRON' },
    // { currency: 'USDT', blockchain: 'ETHEREUM', chainKey: 'USDT_ETH' },
    // { currency: 'USDT', blockchain: 'BSC',      chainKey: 'USDT_BSC' },
    // { currency: 'USDT', blockchain: 'BASE',     chainKey: 'USDT_BASE' },
    // { currency: 'USDT', blockchain: 'ARBITRUM', chainKey: 'USDT_ARB' },
    // { currency: 'USDT', blockchain: 'OPTIMISM', chainKey: 'USDT_OP' },
    { currency: 'USDC', blockchain: 'ETHEREUM',    chainKey: 'USDC_ETH' },
    // { currency: 'USDC', blockchain: 'BSC',      chainKey: 'USDC_BSC' },
    // { currency: 'USDC', blockchain: 'BASE',     chainKey: 'USDC_BASE' },
    // { currency: 'USDC', blockchain: 'ARBITRUM', chainKey: 'USDC_ARB' },
    // { currency: 'USDC', blockchain: 'OPTIMISM', chainKey: 'USDC_OP' },
    // { currency: 'USDC', blockchain: 'POLYGON',  chainKey: 'USDC_MATIC' },
    // { currency: 'USDT', blockchain: 'POLYGON',  chainKey: 'USDT_MATIC' },
    // { currency: 'USDC', blockchain: 'SOL',      chainKey: 'USDC_SOL' },
    // { currency: 'USDT', blockchain: 'SOL',      chainKey: 'USDT_SOL' },
];

// ── Generate direct address from Tatum (no gas pump) ────────
async function generateDirectAddress(
    blockchain: string,
    xpub: string,
    index: number
): Promise<string> {
    const config = CHAIN_CONFIG[blockchain.toUpperCase()];
    if (!config?.tatumEndpoint) throw new Error(`No endpoint for ${blockchain}`);

    try {
        const response = await axios.get(
            `${config.tatumEndpoint}/${xpub}/${index}`,
            { headers: { 'x-api-key': process.env.TATUM_LIVE_KEY! } }
        );

        const address = response.data?.address;
        if (!address) throw new Error(`Failed to generate address for ${blockchain}`);
        return address;

    } catch (error: any) {
        // Log full Tatum error response
        console.error(`Tatum error for ${blockchain}:`, {
            status: error.response?.status,
            data:   error.response?.data,
            url:    `${config.tatumEndpoint}/${xpub}/${index}`
        });
        throw error;
    }
}

// ── Generate keypair wallet (SOL, XRP) ───────────────────────
async function generateKeypairWallet(blockchain: string): Promise<{
    address: string;
    privateKey: string;
    mnemonic?: string;
}> {
    const config = CHAIN_CONFIG[blockchain.toUpperCase()];
    if (!config?.tatumWalletEndpoint) throw new Error(`No wallet endpoint for ${blockchain}`);

    const response = await axios.get(
        config.tatumWalletEndpoint,
        { headers: { 'x-api-key': process.env.TATUM_LIVE_KEY! } }
    );

    const data = response.data;
    const address    = data?.address || data?.account;
    const privateKey = data?.privateKey || data?.secret;
    const mnemonic   = data?.mnemonic;

    if (!address || !privateKey) throw new Error(`Failed to generate keypair for ${blockchain}`);
    return { address, privateKey, mnemonic };
}

// ── Subscribe address to webhook ─────────────────────────────
async function subscribeAddress(address: string, webhookChain: string): Promise<string> {
    const response = await axios.post(
        'https://api.tatum.io/v4/subscription',
        {
            type: 'ADDRESS_EVENT',
            attr: {
                address,
                chain: webhookChain,
                url: "https://api-dev.vyre.africa/api/v1/webhook/tatum"
            }
        },
        { headers: { 'x-api-key': process.env.TATUM_LIVE_KEY! } }
    );
    return response.data.id;
}

// ── Create single admin wallet ────────────────────────────────
async function createAdminWallet(
    userId: string,
    walletConfig: typeof ADMIN_WALLET_CONFIGS[0],
    currencyId: string
) {
    const { currency, blockchain, chainKey } = walletConfig;

    console.log(`\n  Creating ${currency} wallet${blockchain ? ` on ${blockchain}` : ''}...`);

    try {
        // Check if wallet already exists
        const existingWallet = await prisma.wallet.findFirst({
            where: { userId, currencyId }
        });

        if (existingWallet) {
            console.log(`  ⚠️  Wallet already exists — skipping (${existingWallet.id})`);
            return existingWallet;
        }

        // Create virtual account
        const chainConfig = chainKey ? CHAIN_CONFIG[chainKey.toUpperCase()] : null;

        const account = await virtualAccountService.createAccount({
            userId,
            currency,
            type: 'STANDARD',
            label: chainConfig?.tokenSymbol ?? currency,
            xpub: chainConfig?.xpub ?? undefined,
            blockchain: blockchain ?? undefined,
        });

        console.log('virtualAccountService.createAccount response', account);

        // Create wallet record
        const wallet = await prisma.wallet.create({
            data: {
                id:                 account.id,
                Tatum_customerId:   userId,
                currencyId,
                userId,
                accountingCurrency: 'USD',
                frozen:             false
            }
        });

        // Fiat wallets — no address needed
        if (!blockchain || !chainKey || !chainConfig) {
            console.log(`  ✅ Fiat wallet created: ${wallet.id}`);
            return wallet;
        }

        // ── Generate address ─────────────────────────────────────
        let depositAddress: string;
        let derivationKey: number | null = null;

        if (chainConfig.walletType === 'HD') {
            // Admin wallet always uses index from xpubIndex
            // but gets a DIRECT address — never gas pump
            const xpubIndexRecord = await prisma.xpubIndex.upsert({
                where: { xpub_blockchain: { xpub: chainConfig.xpub!, blockchain } },
                update: { lastIndex: { increment: 1 } },
                create: { xpub: chainConfig.xpub!, blockchain, lastIndex: 0 }
            });

            const index = xpubIndexRecord.lastIndex;
            derivationKey = index;

            // Generate direct address — no gas pump for admin
            depositAddress = await generateDirectAddress(
                blockchain,
                chainConfig.xpub!,
                index
            );

            // Connect address to virtual account directly
            await virtualAccountService.connectHDAddress(
                account.id,
                blockchain,
                depositAddress,
                chainConfig.xpub!,
                index,
                chainConfig
            );

        } else {
            // KEYPAIR chain (SOL, XRP)
            const { address, privateKey, mnemonic } = await generateKeypairWallet(blockchain);
            depositAddress = address;

            // Connect keypair address
            await virtualAccountService.connectKeypairAddress(
                account.id,
                blockchain,
                address,
                privateKey,
                mnemonic,
                chainConfig
            );
        }

        // Subscribe to deposit events
        let subscriptionId: string | null = null;
        if (chainConfig.webhookChain) {
            subscriptionId = await subscribeAddress(depositAddress, chainConfig.webhookChain);
        }

        // Update wallet with address + subscription
        const updatedWallet = await prisma.wallet.update({
            where: { id: wallet.id },
            data: {
                depositAddress,
                subscriptionId,
                derivationKey
            }
        });

        console.log(`  ✅ Wallet created: ${depositAddress}`);
        return updatedWallet;

    } catch (error: any) {
        console.error(`  ❌ Failed: ${error.message}`);
        throw error;
    }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log('🚀 Starting admin wallet creation...\n');

    for (const userId of ADMIN_USER_IDS) {
        console.log(`\n👤 Creating wallets for admin: ${userId}`);
        console.log('─'.repeat(50));

        for (const walletConfig of ADMIN_WALLET_CONFIGS) {

            // Find currency in DB
            const currency = await prisma.currency.findFirst({
                where: {
                    ISO: walletConfig.currency,
                    ...(walletConfig.blockchain ? { chain: walletConfig.blockchain } : {})
                }
            });

            if (!currency) {
                console.log(`  ⚠️  Currency not found: ${walletConfig.currency} ${walletConfig.blockchain ?? ''} — skipping`);
                continue;
            }

            try {
                await createAdminWallet(userId, walletConfig, currency.id);
            } catch (error: any) {
                console.error(`  ❌ Error creating ${walletConfig.currency} wallet:`, error.message);
                // Continue with next wallet — don't stop entire script
            }
        }
    }

    console.log('\n\n✅ Admin wallet creation complete!');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());