import axios from "axios";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import logger from "../config/logger";
import { Queue } from 'bullmq'
import connection from '../config/redis.config';
import { tatumGet, tatumPost } from "../utils";
import chainService from "./chain.service";


export interface SweepJobData {
  currencyId: string
  userId: string
  depositAddress: string
  derivationKey: number   // Wallet.derivationKey
  amount: string
  chain: string           // ETHEREUM, BASE, ARB etc (internal format)
  contractAddress?: string
  depositTxId: string
  sweepLogId: string
}

const SWEEP_CHAINS = [
  'ETHEREUM', 'POLYGON', 'BSC', 'TRON',   // gas pump
  'BASE', 'ARBITRUM', 'OPTIMISM'  // nonce chain
]


class SweepService{

    // One queue per chain — this is what gives us sequential nonces
    sweepQueues: Record<string, Queue<SweepJobData>> =
        Object.fromEntries(
            SWEEP_CHAINS.map((chain) => [
                chain,
                new Queue<SweepJobData>(`sweep-${chain}`, {
                    connection,
                    defaultJobOptions: {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                    removeOnComplete: { count: 100 },
                    removeOnFail: { count: 200 }
                    }
                })
            ])
    )

    getSweepQueue(chain: string): Queue<SweepJobData> {
        const queue = this.sweepQueues[chain]
        if (!queue) throw new Error(`No sweep queue for chain: ${chain}`)
        return queue
    }

    // Maps your internal chain key → Tatum's transfer endpoint prefix
    public CHAIN_ENDPOINT_MAP: Record<string, string> = {
        ETHEREUM: 'ethereum',
        BASE:     'base',
        BSC:      'bsc',
        POLYGON:  'polygon',
        ARBITRUM: 'arb',
        OPTIMISM: 'optimism',
        TRON:     'tron'
    }


    async processSweepJob(job: any) {
        const {
            currencyId,
            depositAddress,
            derivationKey,
            amount,
            chain,
            contractAddress,
            sweepLogId
        }: SweepJobData = job.data

        console.log(`[SweepWorker:${chain}] Processing — ${amount} from ${depositAddress}`)

        const currency = await prisma.currency.findUnique({
            where: {id: currencyId}
        })

        if (!currency) throw new Error(`Currency not found: ${currencyId}`)


        // Get chain config — this gives us mnemonic, endpoint, masterAddress etc
        const chainConfig = chainService.getChainConfig(
            currency.ISO as 'USDC' | 'USDT',
            currency.chain as any
        )

        // Update log to PROCESSING
        await prisma.sweepLog.update({
            where: { id: sweepLogId },
            data: { status: 'PROCESSING' }
        })

        let sweepTxId: string

        if (chainService.GAS_PUMP_CHAINS.has(chain)) {
            // ── ETH / POLYGON / BSC — gas pump, master pays atomically ──────────────
            sweepTxId = await this.gasPumpSweep({
                chain,
                currencyId,
                chainConfig,
                depositAddress,
                amount,
                contractAddress
            })
        } else {
            // ── BASE / ARBITRUM / OPTIMISM — nonce chain ─────────────────────────────
            sweepTxId = await this.nonceChainSweep({
                chain,
                currencyId,
                ISO: currency.ISO,
                chainConfig,
                depositAddress,
                derivationKey,
                amount
            })
        }

        // Mark success
        await prisma.sweepLog.update({
            where: { id: sweepLogId },
            data: { status: 'SUCCESS', sweepTxId }
        })

        console.log(`[SweepWorker:${chain}] Sweep complete — txId: ${sweepTxId}`)
        return { sweepTxId }

    }


    async gasPumpSweep({
            chain,
            currencyId,
            chainConfig,
            depositAddress,
            amount,
            contractAddress
        }: {
            chain: string
            currencyId: string
            chainConfig: any
            depositAddress: string
            amount: string
            contractAddress?: string
        }) {

        const adminWallet = await prisma.wallet.findFirst({
            where: { userId: config.Admin_Id, currencyId },
            select: { id: true, derivationKey: true, depositAddress: true }
        })
        console.log('adminWallet',adminWallet)

        if (!adminWallet) throw new Error(`No admin wallet for chain: ${chain}`)
        const masterAddress = adminWallet.depositAddress
        if (!masterAddress) throw new Error(`No master address for chain: ${chain}`)

        const endpoint = this.CHAIN_ENDPOINT_MAP[chain]

        // Derive master private key
        const masterPrivRes = await tatumPost(`/${endpoint}/wallet/priv`, {
            mnemonic: chainConfig.mnemonic,
            index: adminWallet.derivationKey
        })
        console.log('masterPrivRes',masterPrivRes)
        const masterPrivateKey = masterPrivRes.key
        if (!masterPrivateKey) throw new Error(`Failed to derive master private key on ${chain}`)

        // Map chain to Tatum's chain param
        const chainParam: Record<string, string> = {
            ETHEREUM: 'ETH',
            POLYGON:  'MATIC',
            BSC:      'BSC',
            TRON:     'TRON'   // ← back in, correctly
        }

        const body: Record<string, any> = {
            chain:           chainParam[chain],
            custodialAddress: depositAddress,
            recipient:       masterAddress,
            contractType:    contractAddress ? 0 : 3,  // 0 = fungible token, 3 = native
            amount,
            fromPrivateKey:  masterPrivateKey
        }

        // Only include tokenAddress when transferring a token
        if (contractAddress) {
            body.tokenAddress = contractAddress
        }

        // TRON requires feeLimit — it's the max TRX willing to spend on energy
        // 100 TRX is the standard safe value for TRC-20 transfers
        if (chain === 'TRON') {
            body.feeLimit = 100
        }

        const res = await tatumPost('/blockchain/sc/custodial/transfer', body)
        return res.txId
    }



    async nonceChainSweep({
        chain,
        ISO,
        currencyId,
        chainConfig,
        depositAddress,
        derivationKey,
        amount,
    }: {
        chain: string
        ISO: string
        currencyId: string
        chainConfig: any
        depositAddress: string
        derivationKey: number
        amount: string
    }) {

        const adminWallet = await prisma.wallet.findFirst({
            where: { userId: config.Admin_Id, currencyId },
            select: {
                id: true,
                derivationKey: true,
                depositAddress: true,
                currency: { select: { ISO: true } }
            }
        })

        console.log('adminWallet', adminWallet)

        if (!adminWallet) throw new Error(`No admin wallet for admin: ${config.Admin_Id}`)

        const endpoint = this.CHAIN_ENDPOINT_MAP[chain]
        const masterAddress = adminWallet.depositAddress
        if (!masterAddress) throw new Error(`No master address for chain: ${chain}`)

        // ── Step A: derive private keys in parallel ──────────────────────────────
        const [userPrivRes, masterPrivRes] = await Promise.all([
            tatumPost(`/${endpoint}/wallet/priv`, {
                mnemonic: chainConfig.mnemonic,
                index: derivationKey
            }),
            tatumPost(`/${endpoint}/wallet/priv`, {
                mnemonic: chainConfig.mnemonic,
                index: adminWallet.derivationKey
            })
        ])

        console.log('privatekeys fetch', userPrivRes, masterPrivRes)

        const userPrivateKey   = userPrivRes.key
        const masterPrivateKey = masterPrivRes.key

        if (!userPrivateKey)   throw new Error(`Failed to derive user private key for index ${derivationKey} on ${chain}`)
        if (!masterPrivateKey) throw new Error(`Failed to derive master private key on ${chain}`)

        // ── Step B: get nonces in parallel ───────────────────────────────────────
        const [userNonceRaw, masterNonceRaw] = await Promise.all([
            tatumGet(`/${endpoint}/transaction/count/${depositAddress}`),
            tatumGet(`/${endpoint}/transaction/count/${masterAddress}`)
        ])

        console.log('nonces', userNonceRaw, masterNonceRaw )

        // Safely extract — Tatum may return { nonce: N } or just N
        const userNonce   = typeof userNonceRaw   === 'number' ? userNonceRaw   : userNonceRaw?.nonce   ?? 0
        const masterNonce = typeof masterNonceRaw === 'number' ? masterNonceRaw : masterNonceRaw?.nonce ?? 0

        console.log(`[NonceChain:${chain}] userNonce: ${userNonce}, masterNonce: ${masterNonce}`)

        // ── Step C: check gas balance ────────────────────────────────────────────
        const gasPreloadAmount = process.env[`GAS_PRELOAD_${chain}`] || '0.0001'

        const balanceData = await tatumGet(`/${endpoint}/account/balance/${depositAddress}`)
        console.log('balanceData', balanceData )

        // Guard against unexpected response shapes
        const currentGas = parseFloat(
            balanceData?.balance ??
            balanceData?.ethereum?.balance ??
            '0'
        )
        const requiredGas = parseFloat(gasPreloadAmount)
        const needsTopUp  = currentGas < requiredGas * 0.3

        // ── Step D: Tx 1 — top up gas if needed ─────────────────────────────────
        if (needsTopUp) {
            console.log(`[NonceChain:${chain}] Gas low (${currentGas} ETH) — topping up`)

            const topUpRes = await tatumPost(`/${endpoint}/transaction`, {
                to:             depositAddress,
                amount:         gasPreloadAmount,
                currency:       chainService.getTatumCurrency(chain, 'ETH'),
                fromPrivateKey: masterPrivateKey,
                nonce:          masterNonce
            })

            console.log(`[NonceChain:${chain}] Gas top-up broadcast`)

            console.log(`[NonceChain:${chain}] Gas top-up broadcast — txId: ${topUpRes.txId}`)

            // Wait for top-up to confirm before sweeping
            await this.waitForConfirmation(topUpRes.txId, chain)

            console.log(`[NonceChain:${chain}] Gas top-up confirmed — proceeding to sweep`)

        }

        // ── Step E: Tx 2 — sweep tokens to master ───────────────────────────────
        const tatumCurrency = chainService.getTatumCurrency(chain, ISO)

        const res = await tatumPost(`/${endpoint}/transaction`, {
            to:             masterAddress,
            amount,
            currency:       tatumCurrency,
            fromPrivateKey: userPrivateKey,
            nonce:          userNonce
        })

        console.log(`[NonceChain:${chain}] Sweep broadcast — txId: ${res.txId}`)
        return res.txId
    }

    private async waitForConfirmation(
        txId: string,
        chain: string,
        maxAttempts: number = 20,
        intervalMs: number = 3000
    ): Promise<void> {

        const endpoint = this.CHAIN_ENDPOINT_MAP[chain]

        console.log(`[NonceChain:${chain}] Waiting for tx ${txId} to confirm...`)

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {

            try {
                const tx = await tatumGet(`/${endpoint}/transaction/${txId}`)

                // Transaction is confirmed when blockNumber is set
                if (tx?.blockNumber || tx?.blockHash) {
                    console.log(`[NonceChain:${chain}] Tx confirmed at block ${tx.blockNumber} (attempt ${attempt})`)
                    return
                }

            } catch (err) {
                // Transaction not found yet — still pending
                console.log(`[NonceChain:${chain}] Tx not yet confirmed (attempt ${attempt}/${maxAttempts})`)
            }

            // Wait before next check
            await new Promise(resolve => setTimeout(resolve, intervalMs))
        }

        throw new Error(
            `[NonceChain:${chain}] Top-up tx ${txId} did not confirm after ${maxAttempts} attempts. ` +
            `Check ${txId} on the explorer.`
        )
    }

    // Simple tx status check
    async isTxDropped(endpoint: string, txId: string): Promise<boolean> {
        try {
            const tx = await tatumGet(`/${endpoint}/transaction/${txId}`)
            return !tx || !tx.blockNumber
        } catch {
            return true  // not found = dropped
        }
    }

   


}

export default new SweepService()