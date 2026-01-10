import axios from "axios";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import logger from "../config/logger";
import { createClerkClient } from '@clerk/backend'
import Decimal from "decimal.js";

export interface MinimumOrderConfig {
  amount: Decimal;
  usdEquivalent: number; // For reference
  description: string;
}


/**
 * Minimum order amounts by currency ISO code
 * These are enforced to prevent dust orders and ensure economic viability
 */
export const MINIMUM_ORDER_AMOUNTS: Record<string, MinimumOrderConfig> = {
  // Stablecoins
  'USDT': {
    amount: new Decimal('10'),
    usdEquivalent: 10,
    description: 'Tether USD'
  },
  'USDC': {
    amount: new Decimal('10'),
    usdEquivalent: 10,
    description: 'USD Coin'
  },
  'BUSD': {
    amount: new Decimal('10'),
    usdEquivalent: 10,
    description: 'Binance USD'
  },
  'DAI': {
    amount: new Decimal('10'),
    usdEquivalent: 10,
    description: 'Dai Stablecoin'
  },
  
  // Major Cryptocurrencies
  'BTC': {
    amount: new Decimal('0.0001'),
    usdEquivalent: 10,
    description: 'Bitcoin'
  },
  'ETH': {
    amount: new Decimal('0.005'),
    usdEquivalent: 10,
    description: 'Ethereum'
  },
  'BNB': {
    amount: new Decimal('0.02'),
    usdEquivalent: 10,
    description: 'Binance Coin'
  },
  'SOL': {
    amount: new Decimal('0.1'),
    usdEquivalent: 10,
    description: 'Solana'
  },
  'XRP': {
    amount: new Decimal('20'),
    usdEquivalent: 10,
    description: 'Ripple'
  },
  'ADA': {
    amount: new Decimal('25'),
    usdEquivalent: 10,
    description: 'Cardano'
  },
  'DOGE': {
    amount: new Decimal('100'),
    usdEquivalent: 10,
    description: 'Dogecoin'
  },
  'MATIC': {
    amount: new Decimal('15'),
    usdEquivalent: 10,
    description: 'Polygon'
  },
  'DOT': {
    amount: new Decimal('2'),
    usdEquivalent: 10,
    description: 'Polkadot'
  },
  'AVAX': {
    amount: new Decimal('0.5'),
    usdEquivalent: 10,
    description: 'Avalanche'
  },
  'LINK': {
    amount: new Decimal('1'),
    usdEquivalent: 10,
    description: 'Chainlink'
  },
  'UNI': {
    amount: new Decimal('2'),
    usdEquivalent: 10,
    description: 'Uniswap'
  },
  'LTC': {
    amount: new Decimal('0.2'),
    usdEquivalent: 10,
    description: 'Litecoin'
  },
  'ATOM': {
    amount: new Decimal('2'),
    usdEquivalent: 10,
    description: 'Cosmos'
  },
  'TRX': {
    amount: new Decimal('150'),
    usdEquivalent: 10,
    description: 'Tron'
  }
};

/**
 * Default minimum order amount if currency not found
 * Equivalent to $10 USD
 */
export const DEFAULT_MINIMUM_ORDER_USD = new Decimal('10');

/**
 * Get minimum order amount for a currency
 */
export function getMinimumOrderAmount(currencyISO: string): Decimal {
  const config = MINIMUM_ORDER_AMOUNTS[currencyISO.toUpperCase()];
  
  if (config) {
    return config.amount;
  }
  
  // For unknown currencies, return default USD equivalent
  logger.warn(`No minimum order amount configured for ${currencyISO}, using default`);
  return DEFAULT_MINIMUM_ORDER_USD;
}

/**
 * Get human-readable minimum order description
 */
export function getMinimumOrderDescription(currencyISO: string): string {
  const config = MINIMUM_ORDER_AMOUNTS[currencyISO.toUpperCase()];
  
  if (config) {
    return `${config.amount.toString()} ${currencyISO.toUpperCase()} (~$${config.usdEquivalent} USD)`;
  }
  
  return `$${DEFAULT_MINIMUM_ORDER_USD.toString()} USD equivalent`;
}


