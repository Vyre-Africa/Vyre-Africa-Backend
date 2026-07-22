// src/config/blockchain.config.ts
import config from '../config/env.config';
export type ChainConfig = {
    blockchain: string;
    walletType: 'HD' | 'KEYPAIR';
    tatumEndpoint?: string;           // HD chains - address generation endpoint
    tatumWalletEndpoint?: string;     // KEYPAIR chains - wallet generation endpoint
    tatumTransferEndpoint?: string;   // token/native transfer endpoint
    mnemonic?: string;
    xpub?: string;
    xpubEnvKey?: string;              // env key for xpub
    currency: string;
    decimals?: number;                // token decimal places
    isToken?: boolean;
    tokenMint?: string;               // contract address / mint address
    tokenSymbol?: string;
    tokenStandard?: string;           // ERC20, TRC20, SPL, BEP20
    webhookChain?: string;
    tatumChainParam?: string;
    
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

    // ── ERC20 Tokens (ETH chain) ─────────────────────────────────
    // tatumTransferEndpoint switched to the generic multi-chain token
    // endpoint — the per-chain /ethereum/transaction endpoint resolves
    // balances off Tatum's internal currency ticker (e.g. 'USDT'), which
    // was confirmed to misresolve on Polygon (see USDC_MATIC below); Tatum's
    // docs list Ethereum as supported by the generic endpoint, so this
    // applies the same fix preemptively here. Verify with a real test
    // transfer before relying on it in production, same as Polygon was.

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
    },

    // ── TRC20 Tokens (TRON chain) ────────────────────────────────
    // Unchanged — TRC20 transfers already go through their own dedicated
    // /tron/trc20/transaction endpoint with tokenAddress specified
    // explicitly, so this doesn't have the ticker-resolution problem.

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

    // ── BEP20 Tokens (BSC chain) ─────────────────────────────────
    // Same endpoint fix as ETH tokens above — BSC is explicitly listed as
    // supported by Tatum's generic token-transfer endpoint.

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
    },

    // ── SPL Tokens (Solana chain) ────────────────────────────────

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

    // ── Polygon Tokens ───────────────────────────────────────────
    // FIXED — confirmed live: /v3/polygon/transaction with currency:
    // 'USDC_MATIC' resolved to a contract with 0 balance while the real
    // deposit address held 6.5 USDC on-chain (verified on Polygonscan).
    // Even sending contractAddress explicitly to that same endpoint didn't
    // help — the endpoint itself ignores it and resolves purely off the
    // ticker. Switched to the generic multi-chain endpoint, which the
    // manual sweep script already proved works correctly for this exact
    // token/address.

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
    },

    // ── Arbitrum Tokens ──────────────────────────────────────────
    // DELIBERATELY UNCHANGED — Tatum's documented list of chains supported
    // by the generic /blockchain/token/transaction endpoint does NOT
    // include Arbitrum (it lists Ethereum, BSC, Polygon, Base, Optimism,
    // Solana, Avalanche, Fantom, Celo, Algorand, and others — Arbitrum is
    // conspicuously absent). Switching this to the generic endpoint could
    // break it entirely rather than fix anything. Leave on the dedicated
    // /arb/transaction endpoint until specifically tested.

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

    // ── Optimism Tokens ──────────────────────────────────────────
    // NOT YET CHANGED — Optimism IS listed among Tatum's chains supported
    // by the generic token-transfer endpoint, so this is very likely
    // affected by the same bug as Polygon/ETH/BSC above. Left on the
    // dedicated endpoint for now since it hasn't been live-tested in this
    // pass — same treatment as Arbitrum's caution, just for a different
    // reason (untested vs. unsupported). Verify with a real transfer
    // before switching, the same way Polygon was confirmed.

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

    // ── Base Tokens ──────────────────────────────────────────────
    // NOT YET CHANGED — same situation as Optimism above: Base IS listed
    // as supported by the generic endpoint, likely affected by the same
    // bug, but not yet live-tested in this pass. Verify before switching.

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
// — only meaningful for the generic multi-chain endpoints (e.g.
// /blockchain/token/transaction, /blockchain/sc/custodial/transfer).
// Falls back to the raw blockchain string if no override is set, which is
// correct for chains that never needed one — the dedicated per-chain
// endpoints (/base/transaction, /arb/transaction etc.) don't take a `chain`
// field at all, so nothing reads this fallback value for them.
export function getTatumChainParam(blockchain: string, currency: string): string {
    const config = getChainConfigByCurrency(blockchain, currency);
    return config?.tatumChainParam ?? blockchain;
}