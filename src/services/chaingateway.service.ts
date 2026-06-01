// src/services/chaingateway.service.ts
import axios from 'axios';
import logger from '../config/logger';
import prisma from '../config/prisma.client';

// Chain endpoint map
const CHAIN_ENDPOINT_MAP: Record<string, string> = {
    ETHEREUM: 'ethereum',
    POLYGON:  'polygon',
    BSC:      'bsc',
    TRON:     'tron',
    BASE:     'base',
    ARBITRUM: 'arbitrum',
    OPTIMISM: 'optimism',
};

// Chaingateway chain → Tatum chain format
const CHAIN_TO_TATUM: Record<string, string> = {
    ethereum: 'ethereum-mainnet',
    polygon:  'polygon-mainnet',
    bsc:      'bsc-mainnet',
    tron:     'tron-mainnet',
    base:     'base-mainnet',
    arbitrum: 'arb-one-mainnet',
    optimism: 'optimism-mainnet',
};

class ChainggatewayService {

    private readonly BASE_URL = 'https://api.chaingateway.io/api/v2';
    private readonly API_KEY  = process.env.CHAINGATEWAY_API_KEY!;
    // private readonly WEBHOOK_URL = process.env.CHAINGATEWAY_WEBHOOK_URL!;

    private headers() {
        return {
            'Authorization': this.API_KEY,
            'Content-Type':  'application/json'
        };
    }

    // ── Subscribe address to incoming ERC20 deposits ──────────
    async subscribeAddress(payload: {
        address:         string;
        blockchain:      string;  // 'ETH', 'BASE', 'TRON' etc.
        contractAddress?: string; // token contract
    }) {
        const { address, blockchain, contractAddress } = payload;
        const endpoint = CHAIN_ENDPOINT_MAP[blockchain.toUpperCase()];

        if (!endpoint) {
            logger.warn(`Chaingateway: unsupported chain ${blockchain}`);
            return null;
        }

        try {
            const response = await axios.post(
                `${this.BASE_URL}/${endpoint}/webhooks`,
                {
                    to: address,
                    type: contractAddress ? 'ERC20' : 'ETH',
                    contractaddress: contractAddress ?? undefined,
                    url: `https://api-dev.vyre.africa/api/v1/webhook/chaingateway`
                },
                { headers: this.headers() }
            );

            logger.info('Chaingateway address subscribed', {
                address,
                blockchain,
                contractAddress,
                webhookId: response.data?.data?.id
            });

            return response.data;

        } catch (error: any) {
            // Non-fatal — Tatum is primary
            logger.warn('Chaingateway subscription failed', {
                address,
                blockchain,
                error: error.response?.data || error.message
            });
            return null;
        }
    }

    // ── Delete subscription ───────────────────────────────────
    async deleteSubscription(blockchain: string, webhookId: string) {
        const endpoint = CHAIN_ENDPOINT_MAP[blockchain.toUpperCase()];
        if (!endpoint) return;

        try {
            await axios.delete(
                `${this.BASE_URL}/${endpoint}/webhooks/${webhookId}`,
                { headers: this.headers() }
            );
            logger.info('Chaingateway subscription deleted', { webhookId });
        } catch (error: any) {
            logger.warn('Failed to delete Chaingateway subscription', { error: error.message });
        }
    }

    // ── Convert Chaingateway chain to Tatum chain format ──────
    tatumChain(chainggatewayChain: string): string {
        return CHAIN_TO_TATUM[chainggatewayChain.toLowerCase()] ?? chainggatewayChain;
    }
}

export default new ChainggatewayService();