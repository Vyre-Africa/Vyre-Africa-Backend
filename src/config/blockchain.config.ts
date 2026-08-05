// src/config/blockchain.config.ts
import config from '../config/env.config';
export type ChainConfig = {
    blockchain: string;
    walletType: 'HD' | 'KEYPAIR';
    tatumEndpoint?: string;
    tatumWalletEndpoint?: string;
    tatumTransferEndpoint?: string;
    mnemonic?: string;
    xpub?: string;
    xpubEnvKey?: string;
    currency: string;
    decimals?: number;
    isToken?: boolean;
    tokenMint?: string;
    tokenSymbol?: string;
    tokenStandard?: string;
    webhookChain?: string;
    tatumChainParam?: string;

    // Explicit, declared per entry — true ONLY for token configs whose
    // tatumTransferEndpoint points at Tatum's generic multi-chain endpoint
    // (/blockchain/token/transaction), which requires a `chain` field in
    // the request body (confirmed via Tatum's own validator). Chains still
    // on their own dedicated endpoint (e.g. /base/transaction) must leave
    // this unset/false — that endpoint doesn't take a `chain` field at all,
    // since the URL itself identifies the chain.
    //
    // Deliberately explicit rather than inferred from the endpoint URL at
    // call time — a URL substring check is fragile and silent; a missing
    // or wrong boolean here is a one-line, obvious thing to check when
    // adding or migrating a chain.
    usesGenericTokenEndpoint?: boolean;
};

export const CHAIN_CONFIG: Record<string, ChainConfig> = {

    // ── Native HD Chains ─────────────────────────────────────────

    ETH: {
        blockchain: 'ETHEREUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/ethereum/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/ethereum/transaction',
        mnemonic: config.USDC.ETH_MNEMONIC || '',
        xpub: config.USDC.ETH_XPUB || '',
        xpubEnvKey: 'ETH_XPUB',
        currency: 'ETH',
        decimals: 18,
        webhookChain: 'ethereum-mainnet',
        tatumChainParam: 'ETH',
    },

    BTC: {
        blockchain: 'BTC',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/bitcoin/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/bitcoin/transaction',
        xpubEnvKey: 'BTC_XPUB',
        currency: 'BTC',
        decimals: 8,
        webhookChain: 'bitcoin-mainnet',
    },

    TRON: {
        blockchain: 'TRON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/tron/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/tron/transaction',
        mnemonic: config.USDT.TRON_MNEMONIC || '',
        xpub: config.USDT.TRON_XPUB || '',
        xpubEnvKey: 'TRON_XPUB',
        currency: 'TRX',
        decimals: 6,
        webhookChain: 'tron-mainnet',
        tatumChainParam: 'TRON',
    },

    LTC: {
        blockchain: 'LTC',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/litecoin/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/litecoin/transaction',
        xpubEnvKey: 'LTC_XPUB',
        currency: 'LTC',
        decimals: 8,
        webhookChain: 'litecoin-mainnet',
    },

    POLYGON: {
        blockchain: 'POLYGON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/polygon/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/polygon/transaction',
        mnemonic: config.USDC.POLYGON_MNEMONIC || '',
        xpub: config.USDC.POLYGON_XPUB || '',
        xpubEnvKey: 'MATIC_XPUB',
        currency: 'MATIC',
        decimals: 18,
        webhookChain: 'polygon-mainnet',
        tatumChainParam: 'MATIC',
    },

    BSC: {
        blockchain: 'BSC',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/bsc/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/bsc/transaction',
        mnemonic: config.USDC.BSC_MNEMONIC || '',
        xpub: config.USDC.BSC_XPUB || '',
        xpubEnvKey: 'BSC_XPUB',
        currency: 'BSC',
        decimals: 18,
        webhookChain: 'bsc-mainnet',
        tatumChainParam: 'BSC',
    },

    BASE: {
        blockchain: 'BASE',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/base/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/base/transaction',
        mnemonic: config.USDC.BASE_MNEMONIC || '',
        xpub: config.USDC.BASE_XPUB || '',
        xpubEnvKey: 'BASE_XPUB',
        currency: 'ETH_BASE',
        decimals: 18,
        webhookChain: 'base-mainnet',
    },

    ARBITRUM: {
        blockchain: 'ARBITRUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/arb/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/arb/transaction',
        mnemonic: config.USDC.ARBITRUM_MNEMONIC || '',
        xpub: config.USDC.ARBITRUM_XPUB || '',
        xpubEnvKey: 'ARB_XPUB',
        currency: 'ETH_ARB',
        decimals: 18,
        webhookChain: 'arb-one-mainnet',
    },

    OPTIMISM: {
        blockchain: 'OPTIMISM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/optimism/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/optimism/transaction',
        mnemonic: config.USDC.OPTIMISM_MNEMONIC || '',
        xpub: config.USDC.OPTIMISM_XPUB || '',
        xpubEnvKey: 'OP_XPUB',
        currency: 'ETH_OP',
        decimals: 18,
        webhookChain: 'optimism-mainnet',
    },

    // ── Native Keypair Chains ────────────────────────────────────

    SOLANA: {
        blockchain: 'SOLANA',
        walletType: 'KEYPAIR',
        tatumWalletEndpoint: 'https://api.tatum.io/v3/solana/wallet',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/solana/transaction',
        currency: 'SOL',
        decimals: 9,
        webhookChain: 'solana-mainnet',
        tatumChainParam: 'SOL',
    },

    XRP: {
        blockchain: 'XRP',
        walletType: 'KEYPAIR',
        tatumWalletEndpoint: 'https://api.tatum.io/v3/xrp/account',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/xrp/transaction',
        currency: 'XRP',
        decimals: 6,
        webhookChain: 'xrp-mainnet',
    },

    // ── ERC20 Tokens (ETH chain) — on the GENERIC endpoint ──────────
    // usesGenericTokenEndpoint: true — confirmed via live Tatum testing.

    USDT_ETH: {
        blockchain: 'ETHEREUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/ethereum/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.ETH_MNEMONIC || '',
        xpub: config.USDC.ETH_XPUB || '',
        xpubEnvKey: 'ETH_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        tokenSymbol: 'USDT',
        tokenStandard: 'ERC20',
        webhookChain: 'ethereum-mainnet',
        tatumChainParam: 'ETH',
        usesGenericTokenEndpoint: true,
    },

    USDC_ETH: {
        blockchain: 'ETHEREUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/ethereum/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.ETH_MNEMONIC || '',
        xpub: config.USDC.ETH_XPUB || '',
        xpubEnvKey: 'ETH_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        tokenSymbol: 'USDC',
        tokenStandard: 'ERC20',
        webhookChain: 'ethereum-mainnet',
        tatumChainParam: 'ETH',
        usesGenericTokenEndpoint: true,
    },

    // ── TRC20 Tokens (TRON chain) — own dedicated endpoint, no flag needed
    // (TRC20 has its own case in broadcastTokenToTatum, unaffected by this flag)

    USDT_TRON: {
        blockchain: 'TRON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/tron/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/tron/trc20/transaction',
        mnemonic: config.USDT.TRON_MNEMONIC || '',
        xpub: config.USDT.TRON_XPUB || '',
        xpubEnvKey: 'TRON_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        tokenSymbol: 'USDT_TRON',
        tokenStandard: 'TRC20',
        webhookChain: 'tron-mainnet',
        tatumChainParam: 'TRON',
    },

    USDC_TRON: {
        blockchain: 'TRON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/tron/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/tron/trc20/transaction',
        mnemonic: config.USDT.TRON_MNEMONIC || '',
        xpub: config.USDT.TRON_XPUB || '',
        xpubEnvKey: 'TRON_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
        tokenSymbol: 'USDC_TRON',
        tokenStandard: 'TRC20',
        webhookChain: 'tron-mainnet',
        tatumChainParam: 'TRON',
    },

    // ── BEP20 Tokens (BSC chain) — on the GENERIC endpoint ──────────

    USDT_BSC: {
        blockchain: 'BSC',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/bsc/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.BSC_MNEMONIC || '',
        xpub: config.USDC.BSC_XPUB || '',
        xpubEnvKey: 'BSC_XPUB',
        currency: 'USDT',
        decimals: 18,
        isToken: true,
        tokenMint: '0x55d398326f99059fF775485246999027B3197955',
        tokenSymbol: 'USDT_BSC',
        tokenStandard: 'BEP20',
        webhookChain: 'bsc-mainnet',
        tatumChainParam: 'BSC',
        usesGenericTokenEndpoint: true,
    },

    USDC_BSC: {
        blockchain: 'BSC',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/bsc/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.BSC_MNEMONIC || '',
        xpub: config.USDC.BSC_XPUB || '',
        xpubEnvKey: 'BSC_XPUB',
        currency: 'USDC',
        decimals: 18,
        isToken: true,
        tokenMint: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        tokenSymbol: 'USDC_BSC',
        tokenStandard: 'BEP20',
        webhookChain: 'bsc-mainnet',
        tatumChainParam: 'BSC',
        usesGenericTokenEndpoint: true,
    },

    // ── SPL Tokens (Solana chain) — own case in broadcastTokenToTatum,
    // flag not applicable

    USDC_SOL: {
        blockchain: 'SOLANA',
        walletType: 'KEYPAIR',
        tatumWalletEndpoint: 'https://api.tatum.io/v3/solana/wallet',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        tokenSymbol: 'USDC_SOL',
        tokenStandard: 'SPL',
        webhookChain: 'solana-mainnet',
        tatumChainParam: 'SOL',
    },

    USDT_SOL: {
        blockchain: 'SOLANA',
        walletType: 'KEYPAIR',
        tatumWalletEndpoint: 'https://api.tatum.io/v3/solana/wallet',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        tokenSymbol: 'USDT_SOL',
        tokenStandard: 'SPL',
        webhookChain: 'solana-mainnet',
        tatumChainParam: 'SOL',
    },

    // ── Polygon Tokens — on the GENERIC endpoint ──────────

    USDT_MATIC: {
        blockchain: 'POLYGON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/polygon/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.POLYGON_MNEMONIC || '',
        xpub: config.USDC.POLYGON_XPUB || '',
        xpubEnvKey: 'MATIC_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        tokenSymbol: 'USDT_MATIC',
        tokenStandard: 'ERC20',
        webhookChain: 'polygon-mainnet',
        tatumChainParam: 'MATIC',
        usesGenericTokenEndpoint: true,
    },

    USDC_MATIC: {
        blockchain: 'POLYGON',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/polygon/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/blockchain/token/transaction',
        mnemonic: config.USDC.POLYGON_MNEMONIC || '',
        xpub: config.USDC.POLYGON_XPUB || '',
        xpubEnvKey: 'MATIC_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        tokenSymbol: 'USDC_MATIC',
        tokenStandard: 'ERC20',
        webhookChain: 'polygon-mainnet',
        tatumChainParam: 'MATIC',
        usesGenericTokenEndpoint: true,
    },

    // ── Arbitrum Tokens — DEDICATED endpoint, not migrated ──────────
    // usesGenericTokenEndpoint intentionally omitted (= false).

    USDT_ARB: {
        blockchain: 'ARBITRUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/arb/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/arb/transaction',
        mnemonic: config.USDC.ARBITRUM_MNEMONIC || '',
        xpub: config.USDC.ARBITRUM_XPUB || '',
        xpubEnvKey: 'ARB_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        tokenSymbol: 'USDT_ARB',
        tokenStandard: 'ERC20',
        webhookChain: 'arb-one-mainnet',
    },

    USDC_ARB: {
        blockchain: 'ARBITRUM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/arb/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/arb/transaction',
        mnemonic: config.USDC.ARBITRUM_MNEMONIC || '',
        xpub: config.USDC.ARBITRUM_XPUB || '',
        xpubEnvKey: 'ARB_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        tokenSymbol: 'USDC_ARB',
        tokenStandard: 'ERC20',
        webhookChain: 'arb-one-mainnet',
    },

    // ── Optimism Tokens — DEDICATED endpoint, not migrated ──────────

    USDT_OP: {
        blockchain: 'OPTIMISM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/optimism/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/optimism/transaction',
        mnemonic: config.USDC.OPTIMISM_MNEMONIC || '',
        xpub: config.USDC.OPTIMISM_XPUB || '',
        xpubEnvKey: 'OP_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        tokenSymbol: 'USDT_OP',
        tokenStandard: 'ERC20',
        webhookChain: 'optimism-mainnet',
    },

    USDC_OP: {
        blockchain: 'OPTIMISM',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/optimism/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/optimism/transaction',
        mnemonic: config.USDC.OPTIMISM_MNEMONIC || '',
        xpub: config.USDC.OPTIMISM_XPUB || '',
        xpubEnvKey: 'OP_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        tokenSymbol: 'USDC_OP',
        tokenStandard: 'ERC20',
        webhookChain: 'optimism-mainnet',
    },

    // ── Base Tokens — DEDICATED endpoint, not migrated ──────────

    USDC_BASE: {
        blockchain: 'BASE',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/base/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/base/transaction',
        mnemonic: config.USDC.BASE_MNEMONIC || '',
        xpub: config.USDC.BASE_XPUB || '',
        xpubEnvKey: 'BASE_XPUB',
        currency: 'USDC',
        decimals: 6,
        isToken: true,
        tokenMint: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenSymbol: 'USDC_BASE',
        tokenStandard: 'ERC20',
        webhookChain: 'base-mainnet',
    },

    USDT_BASE: {
        blockchain: 'BASE',
        walletType: 'HD',
        tatumEndpoint: 'https://api.tatum.io/v3/base/address',
        tatumTransferEndpoint: 'https://api.tatum.io/v3/base/transaction',
        mnemonic: config.USDC.BASE_MNEMONIC || '',
        xpub: config.USDC.BASE_XPUB || '',
        xpubEnvKey: 'BASE_XPUB',
        currency: 'USDT',
        decimals: 6,
        isToken: true,
        tokenMint: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        tokenSymbol: 'USDT_BASE',
        tokenStandard: 'ERC20',
        webhookChain: 'base-mainnet',
    },
};

// Helper to get config by blockchain address and token mint
export function getChainConfigByMint(
    blockchain: string,
    tokenMint?: string
): ChainConfig | undefined {
    return Object.values(CHAIN_CONFIG).find(config =>
        config.blockchain === blockchain &&
        (tokenMint ? config.tokenMint === tokenMint : !config.isToken)
    );
}

// Helper to get all configs for a blockchain
export function getChainsByBlockchain(blockchain: string): ChainConfig[] {
    return Object.values(CHAIN_CONFIG).filter(
        config => config.blockchain === blockchain
    );
}

// Helper to check if a chain is HD or KEYPAIR
export function isHDChain(blockchain: string): boolean {
    const config = CHAIN_CONFIG[blockchain.toUpperCase()];
    return config?.walletType === 'HD';
}

// Helper to get all supported chain keys
export function getSupportedChains(): string[] {
    return Object.keys(CHAIN_CONFIG);
}

// Helper to get config by blockchain and currency
export function getChainConfigByCurrency(
    blockchain: string,
    currency: string
): ChainConfig | undefined {
    return Object.values(CHAIN_CONFIG).find(config =>
        config.blockchain.toUpperCase() === blockchain.toUpperCase() &&
        config.currency.toUpperCase() === currency.toUpperCase()
    );
}

// Helper to get the chain key (e.g 'USDT_TRON', 'USDC_BASE', 'ETH') by blockchain and currency
export function getChainKey(
    blockchain: string,
    currency: string
): string | undefined {
    return Object.entries(CHAIN_CONFIG).find(([_, config]) =>
        config.blockchain.toUpperCase() === blockchain.toUpperCase() &&
        config.currency.toUpperCase() === currency.toUpperCase()
    )?.[0];
}

// Returns Tatum's required `chain` enum value for a blockchain/currency pair
export function getTatumChainParam(blockchain: string, currency: string): string {
    const config = getChainConfigByCurrency(blockchain, currency);
    return config?.tatumChainParam ?? blockchain;
}

// Reverse lookup: CHAIN_CONFIG is keyed by short chain codes but
// config.blockchain holds the full name. Always resolve via this when you
// only have a `blockchain` string.
export function getChainConfigKeyByBlockchain(blockchain: string): string | undefined {
    const upper = blockchain.toUpperCase();
    return Object.entries(CHAIN_CONFIG).find(
        ([key, config]) => config.blockchain.toUpperCase() === upper && !config.isToken
    )?.[0];
}

export function getBaseChainConfig(blockchain: string): ChainConfig | undefined {
    const key = getChainConfigKeyByBlockchain(blockchain);
    return key ? CHAIN_CONFIG[key] : undefined;
}