import { Request, Response } from 'express';
import prisma from '../config/prisma.config';
import config from '../config/env.config';
import axios from "axios";
// import {Currency,walletType} from '@prisma/client';
// import { currency as baseCurrency } from '../globals';
import { hasSufficientBalance } from '../utils';
import walletService from './wallet.service';
import TransferfeeService from './transferfee.service';
import transferfeeService from './transferfee.service';
import notificationService from './notification.service';
import { NotificationType } from '@prisma/client';


// ============================================
// TYPES & INTERFACES
// ============================================

type Supported_USDC_Chain = 'ETHEREUM' | 'BASE' | 'BSC' | 'ARBITRUM' | 'OPTIMISM' | 'POLYGON';
type Supported_USDT_Chain = 'ETHEREUM' | 'TRON' | 'BASE' | 'BSC' | 'ARBITRUM' | 'OPTIMISM';
type AllChains = 'ETHEREUM' | 'TRON' | 'BASE' | 'BSC' | 'ARBITRUM' | 'OPTIMISM' | 'POLYGON';
type StablecoinType = 'USDC' | 'USDT';

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
  amount: number;
  index?: number;
}

interface WalletCreationResult {
  id: string;
  depositAddress: string;
  subscriptionId: string;
  derivationKey: number;
}

// ============================================
// CHAIN CONFIGURATIONS
// ============================================

class chainService {
  private USDC_CHAINS: Record<Supported_USDC_Chain, ChainConfig> = {
    ETHEREUM: {
      tatumCurrency: 'USDC',
      tatumEndpoint: '/offchain/ethereum/erc20/transfer',
      webhookChain: 'ethereum-mainnet',
      displayName: 'Ethereum',
      mnemonic: config.USDC.ETH_MNEMONIC || '',
      xpub: config.USDC.ETH_XPUB || ''
    },
    BASE: {
      tatumCurrency: 'USDC_BASE',
      tatumEndpoint: '/offchain/base/transfer',
      webhookChain: 'base-mainnet',
      displayName: 'Base',
      mnemonic: config.USDC.BASE_MNEMONIC || '',
      xpub: config.USDC.BASE_XPUB || ''
    },
    BSC: {
      tatumCurrency: 'USDC_BSC',
      tatumEndpoint: '/offchain/bsc/transfer',
      webhookChain: 'bsc-mainnet',
      displayName: 'Binance Smart Chain',
      mnemonic: config.USDC.BSC_MNEMONIC || '',
      xpub: config.USDC.BSC_XPUB || ''
    },
    POLYGON: {
      tatumCurrency: 'USDC_MATIC',
      tatumEndpoint: '/offchain/polygon/transfer',
      webhookChain: 'polygon-mainnet',
      displayName: 'Polygon',
      mnemonic: config.USDC.POLYGON_MNEMONIC || '',
      xpub: config.USDC.POLYGON_XPUB || ''
    },
    ARBITRUM: {
      tatumCurrency: 'USDC_ARB',
      tatumEndpoint: '/offchain/arb/transfer',
      webhookChain: 'arb-one-mainnet',
      displayName: 'Arbitrum',
      mnemonic: config.USDC.ARBITRUM_MNEMONIC || '',
      xpub: config.USDC.ARBITRUM_XPUB || ''
    },
    OPTIMISM: {
      tatumCurrency: 'USDC_OP',
      tatumEndpoint: '/offchain/optimism/transfer',
      webhookChain: 'optimism-mainnet',
      displayName: 'Optimism',
      mnemonic: config.USDC.OPTIMISM_MNEMONIC || '',
      xpub: config.USDC.OPTIMISM_XPUB || ''
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

  private USDT_CHAINS: Record<Supported_USDT_Chain, ChainConfig> = {
    ETHEREUM: {
      tatumCurrency: 'USDT',
      tatumEndpoint: '/offchain/ethereum/erc20/transfer',
      webhookChain: 'ethereum-mainnet',
      displayName: 'Ethereum',
      mnemonic: config.USDT.ETH_MNEMONIC || '',
      xpub: config.USDT.ETH_XPUB || ''
    },
    TRON: {
      tatumCurrency: 'USDT_TRON',
      tatumEndpoint: '/offchain/tron/transfer',
      webhookChain: 'tron-mainnet',
      displayName: 'Tron',
      mnemonic: config.USDT.TRON_MNEMONIC || '',
      xpub: config.USDT.TRON_XPUB || ''
    },
    BASE: {
      tatumCurrency: 'USDT_BASE',
      tatumEndpoint: '/offchain/base/transfer',
      webhookChain: 'base-mainnet',
      displayName: 'Base',
      mnemonic: config.USDT.BASE_MNEMONIC || '',
      xpub: config.USDT.BASE_XPUB || ''
    },
    BSC: {
      tatumCurrency: 'USDT_BSC',
      tatumEndpoint: '/offchain/bsc/transfer',
      webhookChain: 'bsc-mainnet',
      displayName: 'BSC',
      mnemonic: config.USDT.BSC_MNEMONIC || '',
      xpub: config.USDT.BSC_XPUB || ''
    },
    ARBITRUM: {
      tatumCurrency: 'USDT_ARB',
      tatumEndpoint: '/offchain/arb/transfer',
      webhookChain: 'arb-one-mainnet',
      displayName: 'Arbitrum',
      mnemonic: config.USDT.ARBITRUM_MNEMONIC || '',
      xpub: config.USDT.ARBITRUM_XPUB || ''
    },
    OPTIMISM: {
      tatumCurrency: 'USDT_OP',
      tatumEndpoint: '/offchain/optimism/transfer',
      webhookChain: 'optimism-mainnet',
      displayName: 'Optimism',
      mnemonic: config.USDT.OPTIMISM_MNEMONIC || '',
      xpub: config.USDT.OPTIMISM_XPUB || ''
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

  public getChainConfig(stablecoin: StablecoinType, chain: AllChains): ChainConfig {
    if (stablecoin === 'USDC') {
      const config = this.USDC_CHAINS[chain as Supported_USDC_Chain];
      if (!config) {
        throw new Error(`Chain ${chain} not supported for ${stablecoin}`);
      }
      return config;
    } else {
      const config = this.USDT_CHAINS[chain as Supported_USDT_Chain];
      if (!config) {
        throw new Error(`Chain ${chain} not supported for ${stablecoin}`);
      }
      return config;
    }
  }

  public isChainSupported(stablecoin: StablecoinType, chain: AllChains): boolean {
    if (stablecoin === 'USDC') {
      return Boolean(this.USDC_CHAINS[chain as Supported_USDC_Chain]);
    } else {
      return Boolean(this.USDT_CHAINS[chain as Supported_USDT_Chain]);
    }
  }
}

export default new chainService()