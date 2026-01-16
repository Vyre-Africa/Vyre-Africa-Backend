"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MINIMUM_ORDER_USD = exports.MINIMUM_ORDER_AMOUNTS = void 0;
exports.getMinimumOrderAmount = getMinimumOrderAmount;
exports.getMinimumOrderDescription = getMinimumOrderDescription;
const logger_1 = __importDefault(require("../config/logger"));
const decimal_js_1 = __importDefault(require("decimal.js"));
/**
 * Minimum order amounts by currency ISO code
 * These are enforced to prevent dust orders and ensure economic viability
 */
exports.MINIMUM_ORDER_AMOUNTS = {
    // Stablecoins
    'USDT': {
        amount: new decimal_js_1.default('10'),
        usdEquivalent: 10,
        description: 'Tether USD'
    },
    'USDC': {
        amount: new decimal_js_1.default('10'),
        usdEquivalent: 10,
        description: 'USD Coin'
    },
    'BUSD': {
        amount: new decimal_js_1.default('10'),
        usdEquivalent: 10,
        description: 'Binance USD'
    },
    'DAI': {
        amount: new decimal_js_1.default('10'),
        usdEquivalent: 10,
        description: 'Dai Stablecoin'
    },
    // Major Cryptocurrencies
    'BTC': {
        amount: new decimal_js_1.default('0.0001'),
        usdEquivalent: 10,
        description: 'Bitcoin'
    },
    'ETH': {
        amount: new decimal_js_1.default('0.005'),
        usdEquivalent: 10,
        description: 'Ethereum'
    },
    'BNB': {
        amount: new decimal_js_1.default('0.02'),
        usdEquivalent: 10,
        description: 'Binance Coin'
    },
    'SOL': {
        amount: new decimal_js_1.default('0.1'),
        usdEquivalent: 10,
        description: 'Solana'
    },
    'XRP': {
        amount: new decimal_js_1.default('20'),
        usdEquivalent: 10,
        description: 'Ripple'
    },
    'ADA': {
        amount: new decimal_js_1.default('25'),
        usdEquivalent: 10,
        description: 'Cardano'
    },
    'DOGE': {
        amount: new decimal_js_1.default('100'),
        usdEquivalent: 10,
        description: 'Dogecoin'
    },
    'MATIC': {
        amount: new decimal_js_1.default('15'),
        usdEquivalent: 10,
        description: 'Polygon'
    },
    'DOT': {
        amount: new decimal_js_1.default('2'),
        usdEquivalent: 10,
        description: 'Polkadot'
    },
    'AVAX': {
        amount: new decimal_js_1.default('0.5'),
        usdEquivalent: 10,
        description: 'Avalanche'
    },
    'LINK': {
        amount: new decimal_js_1.default('1'),
        usdEquivalent: 10,
        description: 'Chainlink'
    },
    'UNI': {
        amount: new decimal_js_1.default('2'),
        usdEquivalent: 10,
        description: 'Uniswap'
    },
    'LTC': {
        amount: new decimal_js_1.default('0.2'),
        usdEquivalent: 10,
        description: 'Litecoin'
    },
    'ATOM': {
        amount: new decimal_js_1.default('2'),
        usdEquivalent: 10,
        description: 'Cosmos'
    },
    'TRX': {
        amount: new decimal_js_1.default('150'),
        usdEquivalent: 10,
        description: 'Tron'
    }
};
/**
 * Default minimum order amount if currency not found
 * Equivalent to $10 USD
 */
exports.DEFAULT_MINIMUM_ORDER_USD = new decimal_js_1.default('10');
/**
 * Get minimum order amount for a currency
 */
function getMinimumOrderAmount(currencyISO) {
    const config = exports.MINIMUM_ORDER_AMOUNTS[currencyISO.toUpperCase()];
    if (config) {
        return config.amount;
    }
    // For unknown currencies, return default USD equivalent
    logger_1.default.warn(`No minimum order amount configured for ${currencyISO}, using default`);
    return exports.DEFAULT_MINIMUM_ORDER_USD;
}
/**
 * Get human-readable minimum order description
 */
function getMinimumOrderDescription(currencyISO) {
    const config = exports.MINIMUM_ORDER_AMOUNTS[currencyISO.toUpperCase()];
    if (config) {
        return `${config.amount.toString()} ${currencyISO.toUpperCase()} (~$${config.usdEquivalent} USD)`;
    }
    return `$${exports.DEFAULT_MINIMUM_ORDER_USD.toString()} USD equivalent`;
}
