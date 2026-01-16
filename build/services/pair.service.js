"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const prisma_config_1 = __importDefault(require("../config/prisma.config"));
const stablecoinPairs = [
    // USDC Pairs with NGN
    {
        name: 'USDC-BASE/NGN',
        base: { ISO: 'USDC', chain: 'BASE', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDC-SOL/NGN',
        base: { ISO: 'USDC', chain: 'SOLANA', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDC-ARB/NGN',
        base: { ISO: 'USDC', chain: 'ARBITRUM', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDC/NGN',
        base: { ISO: 'USDC', chain: 'ETHEREUM', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDC-POLY/NGN',
        base: { ISO: 'USDC', chain: 'POLYGON', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDC-TRON/NGN',
        base: { ISO: 'USDC', chain: 'TRON', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    // USDT Pairs with NGN
    {
        name: 'USDT-BASE/NGN',
        base: { ISO: 'USDT', chain: 'BASE', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDT-SOL/NGN',
        base: { ISO: 'USDT', chain: 'SOLANA', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDT-ARB/NGN',
        base: { ISO: 'USDT', chain: 'ARBITRUM', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDT/NGN',
        base: { ISO: 'USDT', chain: 'ETHEREUM', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDT-POLY/NGN',
        base: { ISO: 'USDT', chain: 'POLYGON', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    {
        name: 'USDT-TRON/NGN',
        base: { ISO: 'USDT', chain: 'TRON', type: 'STABLECOIN' },
        quote: { ISO: 'NGN', chain: null, type: 'FIAT' }
    },
    // Add USD pairs for completeness
    // ...['BASE', 'SOLANA', 'ARBITRUM', 'ETHEREUM', 'POLYGON', 'TRON'].flatMap(chain => [
    //   {
    //     name: `USDC-${chain}/USD`,
    //     base: { ISO: 'USDC', chain, type: 'STABLECOIN' },
    //     quote: { ISO: 'USD', chain: null, type: 'FIAT' }
    //   },
    //   {
    //     name: `USDT-${chain}/USD`,
    //     base: { ISO: 'USDT', chain, type: 'STABLECOIN' },
    //     quote: { ISO: 'USD', chain: null, type: 'FIAT' }
    //   }
    // ])
];
class PairService {
    async syncStablecoinPairs() {
        for (const pair of stablecoinPairs) {
            try {
                // Find base currency with chain specification
                const baseCurrency = await prisma_config_1.default.currency.findFirst({
                    where: {
                        ISO: pair.base.ISO,
                        ...(pair.base.chain && { chain: pair.base.chain })
                    }
                });
                // Find quote currency (fiat typically has no chain)
                const quoteCurrency = await prisma_config_1.default.currency.findFirst({
                    where: {
                        ISO: pair.quote.ISO,
                        ...(pair?.quote?.chain ? { chain: pair?.quote?.chain } : { chain: null })
                    }
                });
                if (!baseCurrency || !quoteCurrency) {
                    console.warn(`Skipping pair ${pair.name}: currencies not found`);
                    continue;
                }
                const pairExist = await prisma_config_1.default.pair.findFirst({
                    where: { name: pair.name }
                });
                if (pairExist) {
                    await prisma_config_1.default.pair.update({
                        where: { id: pairExist?.id },
                        data: {
                            baseCurrency: { connect: { id: baseCurrency.id } },
                            quoteCurrency: { connect: { id: quoteCurrency.id } },
                        }
                    });
                }
                else {
                    await prisma_config_1.default.pair.create({
                        data: {
                            name: pair.name,
                            baseCurrency: { connect: { id: baseCurrency.id } },
                            quoteCurrency: { connect: { id: quoteCurrency.id } },
                        }
                    });
                }
                // Create or update pair
                // await prisma.pair.upsert({
                //   where: { name: pair.name },
                //   update: {
                //     baseCurrency: { connect: { id: baseCurrency.id } },
                //     quoteCurrency: { connect: { id: quoteCurrency.id } },
                //     // status: 'ACTIVE'
                //   },
                //   create: {
                //     name: pair.name,
                //     baseCurrency: { connect: { id: baseCurrency.id } },
                //     quoteCurrency: { connect: { id: quoteCurrency.id } },
                //     // status: 'ACTIVE'
                //   }
                // });
                console.log(`Processed pair: ${pair.name}`);
            }
            catch (error) {
                console.error(`Error processing stablecoin pair ${pair.name}:`, error);
            }
        }
    }
}
exports.default = new PairService();
