import Moralis from 'moralis';
import logger from '../config/logger';
import prisma from '../config/prisma.client';

const ERC20_TRANSFER_ABI = [
    {
        anonymous: false,
        inputs: [
            { indexed: true,  name: 'from',  type: 'address' },
            { indexed: true,  name: 'to',    type: 'address' },
            { indexed: false, name: 'value', type: 'uint256' },
        ],
        name: 'Transfer',
        type: 'event',
    }
];

const CHAIN_CONFIG: Record<string, {
    chainId:   string;
    streamEnv: string;
    contracts: string[];
}> = {
    ETH: {
        chainId:   '0x1',
        streamEnv: 'MORALIS_STREAM_ETH',
        contracts: [
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
            '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
        ]
    },
    BASE: {
        chainId:   '0x2105',
        streamEnv: 'MORALIS_STREAM_BASE',
        contracts: [
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
            '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
        ]
    },
    POLYGON: {
        chainId:   '0x89',
        streamEnv: 'MORALIS_STREAM_POLYGON',
        contracts: [
            '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
            '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
        ]
    },
    BSC: {
        chainId:   '0x38',
        streamEnv: 'MORALIS_STREAM_BSC',
        contracts: [
            '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
            '0x55d398326f99059ff775485246999027b3197955', // USDT
        ]
    },
    ARBITRUM: {
        chainId:   '0xa4b1',
        streamEnv: 'MORALIS_STREAM_ARBITRUM',
        contracts: [
            '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
            '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
        ]
    },
    OPTIMISM: {
        chainId:   '0xa',
        streamEnv: 'MORALIS_STREAM_OPTIMISM',
        contracts: [
            '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
            '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
        ]
    }
};

function buildFilter(contracts: string[]) {
    return {
        and: [
            // Only USDC/USDT contracts
            {
                or: contracts.map(contract => ({
                    eq: ['moralis_streams_contract_address', contract.toLowerCase()]
                }))
            },
            // Minimum 1 USDC/USDT (6 decimals)
            { gte: ['value', '1000000'] },
            // Exclude mints (from zero address)
            { ne: ['from', '0x0000000000000000000000000000000000000000'] },
            // Exclude burns (to zero address)
            { ne: ['to',   '0x0000000000000000000000000000000000000000'] }
        ]
    };
}

class MoralisService {

    private initialized = false;

    async init() {
        if (this.initialized) return;
        await Moralis.start({ apiKey: process.env.MORALIS_API_KEY! });
        this.initialized = true;
        logger.info('Moralis SDK initialized');
    }

    // ── Add wallet address to stream ──────────────────────────
    // Called when a new wallet is created
    async addAddress(address: string, blockchain: string) {
        try {
            await this.init();

            const chainConfig = CHAIN_CONFIG[blockchain.toUpperCase()];
            if (!chainConfig) {
                logger.warn(`Moralis: unsupported chain ${blockchain}`);
                return null;
            }

            const streamId = process.env[chainConfig.streamEnv];
            if (!streamId) {
                logger.warn(`Moralis: no stream ID for ${blockchain} — run setup script`);
                return null;
            }

            await Moralis.Streams.addAddress({
                id:      streamId,
                address: address.toLowerCase()
            });

            logger.info('Moralis address added to stream', {
                address,
                blockchain,
                streamId
            });

            return { streamId, address };

        } catch (error: any) {
            // Non-fatal — Tatum is primary
            logger.warn('Moralis addAddress failed', {
                address,
                blockchain,
                error: error.message
            });
            return null;
        }
    }

    // ── Convert Moralis chainId to Tatum chain format ─────────
    tatumChain(chainId: string): string {
        const map: Record<string, string> = {
            '0x1':    'ethereum-mainnet',
            '0x2105': 'base-mainnet',
            '0x89':   'polygon-mainnet',
            '0x38':   'bsc-mainnet',
            '0xa4b1': 'arb-one-mainnet',
            '0xa':    'optimism-mainnet',
        };
        return map[chainId.toLowerCase()] ?? chainId;
    }

    // ── Expose CHAIN_CONFIG and buildFilter for setup script ──
    getChainConfigs() {
        return CHAIN_CONFIG;
    }

    buildFilterForChain(blockchain: string) {
        const chainConfig = CHAIN_CONFIG[blockchain.toUpperCase()];
        if (!chainConfig) return null;
        return buildFilter(chainConfig.contracts);
    }

    getERC20Abi() {
        return ERC20_TRANSFER_ABI;
    }
}

export default new MoralisService();