"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const env_config_1 = __importDefault(require("../config/env.config"));
// ============================================
// CHAIN CONFIGURATIONS
// ============================================
class chainService {
    constructor() {
        this.USDC_CHAINS = {
            ETHEREUM: {
                tatumCurrency: 'USDC',
                tatumEndpoint: '/offchain/ethereum/erc20/transfer',
                webhookChain: 'ethereum-mainnet',
                displayName: 'Ethereum',
                mnemonic: env_config_1.default.USDC.ETH_MNEMONIC || '',
                xpub: env_config_1.default.USDC.ETH_XPUB || ''
            },
            BASE: {
                tatumCurrency: 'USDC_BASE',
                tatumEndpoint: '/offchain/base/transfer',
                webhookChain: 'base-mainnet',
                displayName: 'Base',
                mnemonic: env_config_1.default.USDC.BASE_MNEMONIC || '',
                xpub: env_config_1.default.USDC.BASE_XPUB || ''
            },
            BSC: {
                tatumCurrency: 'USDC_BSC',
                tatumEndpoint: '/offchain/bsc/transfer',
                webhookChain: 'bsc-mainnet',
                displayName: 'Binance Smart Chain',
                mnemonic: env_config_1.default.USDC.BSC_MNEMONIC || '',
                xpub: env_config_1.default.USDC.BSC_XPUB || ''
            },
            POLYGON: {
                tatumCurrency: 'USDC_MATIC',
                tatumEndpoint: '/offchain/polygon/transfer',
                webhookChain: 'polygon-mainnet',
                displayName: 'Polygon',
                mnemonic: env_config_1.default.USDC.POLYGON_MNEMONIC || '',
                xpub: env_config_1.default.USDC.POLYGON_XPUB || ''
            },
            ARBITRUM: {
                tatumCurrency: 'USDC_ARB',
                tatumEndpoint: '/offchain/arb/transfer',
                webhookChain: 'arb-one-mainnet',
                displayName: 'Arbitrum',
                mnemonic: env_config_1.default.USDC.ARBITRUM_MNEMONIC || '',
                xpub: env_config_1.default.USDC.ARBITRUM_XPUB || ''
            },
            OPTIMISM: {
                tatumCurrency: 'USDC_OP',
                tatumEndpoint: '/offchain/optimism/transfer',
                webhookChain: 'optimism-mainnet',
                displayName: 'Optimism',
                mnemonic: env_config_1.default.USDC.OPTIMISM_MNEMONIC || '',
                xpub: env_config_1.default.USDC.OPTIMISM_XPUB || ''
            },
            // TRON: {
            //   tatumCurrency: 'USDC_TRON',
            //   tatumEndpoint: '/offchain/tron/transfer',
            //   webhookChain: 'tron-mainnet',
            //   displayName: 'Tron',
            //   mnemonic: config.USDC.TRON_MNEMONIC || '',
            //   xpub: config.USDC.TRON_XPUB || ''
            // }
        };
        this.USDT_CHAINS = {
            ETHEREUM: {
                tatumCurrency: 'USDT',
                tatumEndpoint: '/offchain/ethereum/erc20/transfer',
                webhookChain: 'ethereum-mainnet',
                displayName: 'Ethereum',
                mnemonic: env_config_1.default.USDT.ETH_MNEMONIC || '',
                xpub: env_config_1.default.USDT.ETH_XPUB || ''
            },
            TRON: {
                tatumCurrency: 'USDT_TRON',
                tatumEndpoint: '/offchain/tron/transfer',
                webhookChain: 'tron-mainnet',
                displayName: 'Tron',
                mnemonic: env_config_1.default.USDT.TRON_MNEMONIC || '',
                xpub: env_config_1.default.USDT.TRON_XPUB || ''
            },
            BASE: {
                tatumCurrency: 'USDT_BASE',
                tatumEndpoint: '/offchain/base/transfer',
                webhookChain: 'base-mainnet',
                displayName: 'Base',
                mnemonic: env_config_1.default.USDT.BASE_MNEMONIC || '',
                xpub: env_config_1.default.USDT.BASE_XPUB || ''
            },
            BSC: {
                tatumCurrency: 'USDT_BSC',
                tatumEndpoint: '/offchain/bsc/transfer',
                webhookChain: 'bsc-mainnet',
                displayName: 'BSC',
                mnemonic: env_config_1.default.USDT.BSC_MNEMONIC || '',
                xpub: env_config_1.default.USDT.BSC_XPUB || ''
            },
            ARBITRUM: {
                tatumCurrency: 'USDT_ARB',
                tatumEndpoint: '/offchain/arb/transfer',
                webhookChain: 'arb-one-mainnet',
                displayName: 'Arbitrum',
                mnemonic: env_config_1.default.USDT.ARBITRUM_MNEMONIC || '',
                xpub: env_config_1.default.USDT.ARBITRUM_XPUB || ''
            },
            OPTIMISM: {
                tatumCurrency: 'USDT_OP',
                tatumEndpoint: '/offchain/optimism/transfer',
                webhookChain: 'optimism-mainnet',
                displayName: 'Optimism',
                mnemonic: env_config_1.default.USDT.OPTIMISM_MNEMONIC || '',
                xpub: env_config_1.default.USDT.OPTIMISM_XPUB || ''
            },
            // POLYGON: {
            //   tatumCurrency: 'USDT_MATIC',
            //   tatumEndpoint: '/offchain/polygon/transfer',
            //   webhookChain: 'polygon-mainnet',
            //   displayName: 'Polygon',
            //   mnemonic: config.USDT.POLYGON_MNEMONIC || '',
            //   xpub: config.USDT.POLYGON_XPUB || ''
            // }
        };
    }
    getChainConfig(stablecoin, chain) {
        if (stablecoin === 'USDC') {
            const config = this.USDC_CHAINS[chain];
            if (!config) {
                throw new Error(`Chain ${chain} not supported for ${stablecoin}`);
            }
            return config;
        }
        else {
            const config = this.USDT_CHAINS[chain];
            if (!config) {
                throw new Error(`Chain ${chain} not supported for ${stablecoin}`);
            }
            return config;
        }
    }
    isChainSupported(stablecoin, chain) {
        if (stablecoin === 'USDC') {
            return Boolean(this.USDC_CHAINS[chain]);
        }
        else {
            return Boolean(this.USDT_CHAINS[chain]);
        }
    }
}
exports.default = new chainService();
