import axios from "axios";
import config from "../config/env.config";
import prisma from '../config/prisma.config';
import logger from "../config/logger";
import { Queue } from 'bullmq'
import connection from '../config/redis.config';
import { tatumGet, tatumPost } from "../utils";
import chainService from "./chain.service";


// Chains that use gas pump
const GAS_PUMP_CHAINS = ['ETHEREUM', 'POLYGON', 'BSC', 'TRON']

// Maps internal chain → Tatum chain param for gas pump API calls
const CHAIN_PARAM_MAP: Record<string, string> = {
  ETHEREUM: 'ETH',    // Tatum expects 'ETH' in the API body
  POLYGON:  'MATIC',  // Tatum expects 'MATIC'
  BSC:      'BSC',
  TRON:     'TRON'
}

// Maps internal chain → webhook chain format → used to find admin wallet
const CHAIN_TO_WEBHOOK: Record<string, string> = {
  ETH:   'ethereum-mainnet',
  MATIC: 'polygon-mainnet',
  BSC:   'bsc-mainnet',
  TRON:  'tron-mainnet'
}

class GasPumpService{

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Get or create the GasPumpLog for a chain
    // Auto-creates if it doesn't exist using admin wallet as owner
    // ─────────────────────────────────────────────────────────────────────────
    private async getOrCreateLog(chain: string, currencyId: string): Promise<{
        id: string
        chain: string
        ownerAddress: string
        nextIndex: number
    }> {
        // Get admin wallet for this chain to use as owner address
        const adminWallet = await prisma.wallet.findFirst({
        where: {
            userId:     config.Admin_Id,
            currencyId
        },
        select: {
            depositAddress: true
        }
        })

        if (!adminWallet?.depositAddress) {
        throw new Error(`No admin wallet found for chain: ${chain}`)
        }

        const ownerAddress = adminWallet.depositAddress

        // Upsert — create if not exists, return if exists
        const log = await prisma.gasPumpLog.upsert({
        where: {
            chain_ownerAddress: {
            chain,
            ownerAddress
            }
        },
        create: {
            chain,
            ownerAddress,
            nextIndex: 0
        },
        update: {}  // don't update anything if it exists
        })

        console.log(`[GasPump] Log for ${chain} — ownerAddress: ${ownerAddress}, nextIndex: ${log.nextIndex}`)
        return log
    }


    // ─────────────────────────────────────────────────────────────────────────
    // createGasPump
    // Seeds the GasPumpLog for a specific chain
    // Called once per chain but auto-creates so safe to call multiple times
    // ─────────────────────────────────────────────────────────────────────────
    async createGasPump(chain: string, currencyId: string) {
        if (!GAS_PUMP_CHAINS.includes(chain)) {
        throw new Error(`Chain ${chain} does not support gas pump`)
        }

        const log = await this.getOrCreateLog(chain, currencyId)

        console.log(`[GasPump] Initialized for chain: ${chain}`)
        return log
    }


    // ─────────────────────────────────────────────────────────────────────────
    // generateAddress
    // Precalculates a single gas pump address for a wallet
    // Atomically claims the next index, calls Tatum, saves to DB
    // ─────────────────────────────────────────────────────────────────────────
    async generateAddress(walletId: string, chain: string, currencyId: string): Promise<{ address: string; derivationKey: null }> {

        if (!GAS_PUMP_CHAINS.includes(chain)) {
          throw new Error(`Chain ${chain} does not support gas pump`)
        }

        const [existing, adminWallet] = await Promise.all([

            prisma.gasPumpAddress.findUnique({
              where: { walletId }
            }),

            prisma.wallet.findFirst({
                where: { userId: config.Admin_Id, currencyId },
                select: { depositAddress: true }
            })

        ])

        if (existing) {
            console.log(`[GasPump] Wallet ${walletId} already has address: ${existing.depositAddress}`)
            return { 
                address: existing.depositAddress, 
                derivationKey: null 
            }
        }

        if (!adminWallet?.depositAddress) {
            throw new Error(`No admin wallet for chain: ${chain}`)
        }

        const ownerAddress = adminWallet.depositAddress

        // ── Atomically claim next index ────────────────────────────────────────
        // FOR UPDATE locks the row so concurrent registrations never get same index
        const assignedIndex = await prisma.$transaction(async (tx) => {

            // Lock and read current index
            const [log] = await tx.$queryRaw<{ nextIndex: number }[]>`
                SELECT "nextIndex" FROM "GasPumpLog"
                WHERE chain = ${chain} AND "ownerAddress" = ${ownerAddress}
                FOR UPDATE
            `

            if (!log) {
                // Auto-create if somehow not yet seeded
                await tx.gasPumpLog.create({
                    data: {
                        chain,
                        ownerAddress: ownerAddress,
                        nextIndex: 1  // starts at 1 since we're claiming 0
                    }
                })
                return 0
            }

            const index = log.nextIndex

            // Increment counter
            await tx.$executeRaw`
                UPDATE "GasPumpLog"
                SET "nextIndex" = "nextIndex" + 1,
                    "updatedAt" = NOW()
                WHERE chain = ${chain} AND "ownerAddress" = ${ownerAddress}
            `

            return index

        })

        let depositAddress: string

        try {
            const res = await tatumPost('/gas-pump', {
                chain:  CHAIN_PARAM_MAP[chain],
                owner:  adminWallet.depositAddress,
                from:   assignedIndex,
                to:     assignedIndex   // single address
            })

            // Tatum returns array — we asked for one address
            depositAddress = res[0]

            if (!depositAddress) {
                throw new Error(`Tatum returned no address for index ${assignedIndex}`)
            }

        } catch (err) {
            // Log the failed index so it can be investigated/retried
            await prisma.gasPumpAddress.create({
                data: {
                chain,
                ownerAddress:   adminWallet.depositAddress,
                depositAddress: `FAILED_${chain}_${assignedIndex}`,  // placeholder
                index:          assignedIndex,
                walletId:       null,
                activated:      false
                }
            }).catch(console.error)

            throw new Error(`Failed to generate gas pump address for index ${assignedIndex}: ${(err as Error).message}`)

        }

        // ── Save to DB and link to wallet ──────────────────────────────────────
        await prisma.gasPumpAddress.create({
            data: {
                chain,
                ownerAddress:   adminWallet.depositAddress,
                depositAddress,
                index:          assignedIndex,
                walletId,
                activated:      false
            }
        })

        console.log(`[GasPump] Generated address ${depositAddress} at index ${assignedIndex} for wallet ${walletId} on ${chain}`)

        return { 
            address: depositAddress, 
            derivationKey: null  // gas pump index lives in GasPumpAddress, not wallet
        }


    }

    // ─────────────────────────────────────────────────────────────────────────
    // activateAddress
    // Activates a gas pump address so it can send funds
    // Called from handleCreditTransaction when a deposit is detected
    // Only activates if not already activated
    // ─────────────────────────────────────────────────────────────────────────
    async activateAddress(depositAddress: string, chain: string, currencyId: string): Promise<string | null> {

        if (!GAS_PUMP_CHAINS.includes(chain)) {
            console.log(`[GasPump] Chain ${chain} does not use gas pump — skipping activation`)
            return null
        }

        const [gasPumpAddress, adminWallet] = await Promise.all([
            // Find the gas pump address record
            prisma.gasPumpAddress.findUnique({
              where: { depositAddress }
            }),

            prisma.wallet.findFirst({
                where: { userId: config.Admin_Id, currencyId },
                select: {
                    depositAddress: true
                }
            })
        ])

        if (!gasPumpAddress) {
            console.warn(`[GasPump] No gas pump address found for: ${depositAddress}`)
            return null
        }

        // Already activated — nothing to do
        if (gasPumpAddress.activated) {
            console.log(`[GasPump] Address ${depositAddress} already activated`)
            return null
        }

        // // Get admin wallet for private key derivation
        // const adminWallet = await 

        if (!adminWallet?.depositAddress) {
          throw new Error(`No admin wallet for chain: ${chain}`)
        }


        // ── Call Tatum to activate ─────────────────────────────────────────────
        try {
        const res = await tatumPost('/gas-pump/activate', {
            chain: CHAIN_PARAM_MAP[chain],
            owner: adminWallet.depositAddress,
            from: gasPumpAddress.index,
            to: gasPumpAddress.index,  // single address
            feesCovered: true
        })

        const activationTxId = res.txId

        if (!activationTxId) {
            throw new Error(`Tatum returned no txId — check your plan supports feesCovered`)
        }

        // Update DB — mark as activated
        await prisma.gasPumpAddress.update({
            where: { depositAddress },
            data: {
                activated:     true,
                activatedTxId: activationTxId
            }
        })

        console.log(`[GasPump] Activated ${depositAddress} — txId: ${activationTxId}`)
        return activationTxId

        } catch (err) {
            console.error(`[GasPump] Activation failed for ${depositAddress}:`, err)
            throw new Error(`Gas pump activation failed: ${(err as Error).message}`)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // isGasPumpChain
    // Helper to check if a chain uses gas pump
    // ─────────────────────────────────────────────────────────────────────────
    isGasPumpChain(chain: string): boolean {
        return GAS_PUMP_CHAINS.includes(chain)
    }

 

   


}

export default new GasPumpService()