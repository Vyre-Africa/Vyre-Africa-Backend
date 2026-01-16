import { Request, Response } from "express";
import prisma from "../config/prisma.config";
import Decimal from 'decimal.js';


interface CryptoPrecisionConfig {
  displayDecimals: number;  // For UI display
  storageDecimals: number;  // For database storage
  blockchainDecimals: number; // For blockchain API calls
}

const PRECISION_MAP: Record<string, CryptoPrecisionConfig> = {
  // Stablecoins (2-6 decimals)
  'USDT': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 6 },
  'USDC': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 6 },
  'DAI': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 6 },
  'BUSD': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 6 },
  'TUSD': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 6 },
  
  // Major Cryptocurrencies (8 decimals)
  'BTC': { displayDecimals: 8, storageDecimals: 8, blockchainDecimals: 8 },
  'ETH': { displayDecimals: 8, storageDecimals: 8, blockchainDecimals: 8 },
  'BNB': { displayDecimals: 8, storageDecimals: 8, blockchainDecimals: 8 },
  'LTC': { displayDecimals: 8, storageDecimals: 8, blockchainDecimals: 8 },
  'BCH': { displayDecimals: 8, storageDecimals: 8, blockchainDecimals: 8 },
  
  // Other Tokens (6-8 decimals)
  'XRP': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 6 },
  'TRX': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 6 },
  'DOGE': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 8 },
  'ADA': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 6 },
  'SOL': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 8 },
  'MATIC': { displayDecimals: 2, storageDecimals: 6, blockchainDecimals: 8 },
  
  // Fiat Currencies (2 decimals)
  'NGN': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 2 },
  'USD': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 2 },
  'EUR': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 2 },
  'GBP': { displayDecimals: 2, storageDecimals: 2, blockchainDecimals: 2 },
};

// Default precision for unknown currencies
const DEFAULT_PRECISION: CryptoPrecisionConfig = {
  displayDecimals: 8,
  storageDecimals: 8,
  blockchainDecimals: 8
};


export class DecimalUtil {
  private static TOLERANCE = new Decimal('0.00000001');

  static isEqual(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.minus(decimalB).abs().lessThan(this.TOLERANCE);
  }

  static isGreaterThan(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.greaterThan(decimalB);
  }

  static isLessThan(a: number | string, b: number | string): boolean {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.lessThan(decimalB);
  }

  static add(a: number | string, b: number | string): string {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.plus(decimalB).toString();
  }

  static subtract(a: number | string, b: number | string): string {
    const decimalA = new Decimal(a.toString());
    const decimalB = new Decimal(b.toString());
    return decimalA.minus(decimalB).toString();
  }

  /**
   * Get precision config for a currency
   */
  static getPrecisionConfig(currencyISO: string): CryptoPrecisionConfig {
    const upperISO = currencyISO.toUpperCase();
    return PRECISION_MAP[upperISO] || DEFAULT_PRECISION;
  }

  /**
   * Check if currency is a stablecoin
   */
  static isStablecoin(currencyISO: string): boolean {
    const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD'];
    return stablecoins.includes(currencyISO.toUpperCase());
  }

  /**
   * Check if currency is fiat
   */
  static isFiat(currencyISO: string): boolean {
    const fiatCurrencies = ['NGN', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'];
    return fiatCurrencies.includes(currencyISO.toUpperCase());
  }

  /**
   * Round amount for display (UI)
   * Stablecoins: 2 decimals, Crypto: 8 decimals
   */
  static roundForDisplay(
    amount: Decimal | string | number,
    currencyISO: string
  ): string {
    const amountDecimal = new Decimal(amount);
    const config = this.getPrecisionConfig(currencyISO);
    
    return amountDecimal
      .toDecimalPlaces(config.displayDecimals, Decimal.ROUND_DOWN)
      .toFixed(config.displayDecimals);
  }

  /**
   * Round amount for storage (Database)
   * Maintains precision for internal calculations
   */
  static roundForStorage(
    amount: Decimal | string | number,
    currencyISO: string
  ): Decimal {
    const amountDecimal = new Decimal(amount);
    const config = this.getPrecisionConfig(currencyISO);
    
    return amountDecimal.toDecimalPlaces(
      config.storageDecimals, 
      Decimal.ROUND_DOWN
    );
  }

  /**
   * Round amount for blockchain API calls
   * Prevents parsing errors from excessive decimals
   */
  static roundForBlockchain(
    amount: Decimal | string | number,
    currencyISO: string
  ): string {
    const amountDecimal = new Decimal(amount);
    const config = this.getPrecisionConfig(currencyISO);
    
    return amountDecimal
      .toDecimalPlaces(config.blockchainDecimals, Decimal.ROUND_DOWN)
      .toString();
  }

  /**
   * Format amount with currency symbol for notifications
   */
  static formatWithCurrency(
    amount: Decimal | string | number,
    currencyISO: string
  ): string {
    const formatted = this.roundForDisplay(amount, currencyISO);
    return `${currencyISO} ${formatted}`;
  }

  /**
   * Get minimum amount for a currency (smallest unit)
   */
  static getMinimumAmount(currencyISO: string): Decimal {
    const config = this.getPrecisionConfig(currencyISO);
    // Minimum is 0.01 for 2 decimals, 0.00000001 for 8 decimals, etc.
    return new Decimal(10).pow(-config.storageDecimals);
  }

  /**
   * Validate amount has correct decimal places
   */
  static validateDecimalPlaces(
    amount: Decimal | string | number,
    currencyISO: string
  ): { valid: boolean; error?: string } {
    const amountDecimal = new Decimal(amount);
    const config = this.getPrecisionConfig(currencyISO);
    
    // Count decimal places
    const decimalPlaces = amountDecimal.decimalPlaces();
    
    if (decimalPlaces > config.storageDecimals) {
      return {
        valid: false,
        error: `${currencyISO} supports maximum ${config.storageDecimals} decimal places, but ${decimalPlaces} were provided`
      };
    }
    
    return { valid: true };
  }

  /**
   * Smart rounding based on amount size
   * Large amounts: fewer decimals, Small amounts: more decimals
   */
  static smartRound(
    amount: Decimal | string | number,
    currencyISO: string
  ): string {
    const amountDecimal = new Decimal(amount);
    const config = this.getPrecisionConfig(currencyISO);
    
    // For stablecoins and fiat, always use 2 decimals
    if (this.isStablecoin(currencyISO) || this.isFiat(currencyISO)) {
      return amountDecimal.toFixed(2);
    }
    
    // For crypto, adjust based on amount size
    if (amountDecimal.greaterThanOrEqualTo(1)) {
      return amountDecimal.toFixed(Math.min(4, config.displayDecimals));
    } else if (amountDecimal.greaterThanOrEqualTo(0.001)) {
      return amountDecimal.toFixed(Math.min(6, config.displayDecimals));
    } else {
      return amountDecimal.toFixed(config.displayDecimals);
    }
  }



  
}
