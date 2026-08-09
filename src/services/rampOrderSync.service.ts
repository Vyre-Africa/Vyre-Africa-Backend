// services/rampOrderSync.service.ts
//
// Core sync logic extracted from scripts/sync-ramp-orders.ts so it can be
// called both from the CLI script (manual/dry-run use) and from a BullMQ
// worker (scheduled, recurring use). The two callers need different
// behavior around process lifecycle:
//   - CLI script: safe to process.exit() and prisma.$disconnect() when done,
//     since the whole process exists only to run this once.
//   - Worker: must NEVER exit the process or disconnect Prisma — the
//     worker process stays alive across many jobs. Errors should be
//     thrown, not exit()'d, so BullMQ's retry/backoff can handle them.
// This file has neither — it's safe for both callers.

import prisma from '../config/prisma.client'
import liquidityRampService from './liquidityRamp.service'
import logger from '../config/logger'

const RAMP_PAIRS = [
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'BASE' },
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'SOLANA' },
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'POLYGON' },
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'ETHEREUM' },
    { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'SOLANA' },
    { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'POLYGON' },
    { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'TRON' },
    { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'ETHEREUM' },
]

const NGN_AMOUNTS = ['5000000', '10000000', '20000000', '50000000', '100000000']

const LIQUIDITY_USER_EMAIL = 'vyreafrica@gmail.com'

const SPREAD: Record<'SELL' | 'BUY', number> = {
    SELL: 1.005,
    BUY:  0.995,
}

const ORDER_TYPES: Array<'SELL' | 'BUY'> = ['SELL', 'BUY']

export interface RampSyncResult {
    created: number
    updated: number
    closed:  number
    errors:  string[]
}

export async function syncRampOrders(options: { confirm: boolean }): Promise<RampSyncResult> {
    const { confirm } = options

    logger.info(`[RampSync] Starting... [${confirm ? 'LIVE' : 'DRY RUN'}]`)

    const result: RampSyncResult = { created: 0, updated: 0, closed: 0, errors: [] }

    // ── 1. Find liquidity user ─────────────────────────────────────────
    const liquidityUser = await prisma.user.findFirst({
        where: { isVendor: true, email: LIQUIDITY_USER_EMAIL },
        select: { id: true, email: true, isVendor: true }
    })

    if (!liquidityUser) {
        const msg = `Liquidity user not found: ${LIQUIDITY_USER_EMAIL} (must exist with isVendor = true)`
        logger.error(`[RampSync] ${msg}`)
        throw new Error(msg) // let BullMQ mark the job failed and retry per its configured policy
    }

    const activeLiquidityKeys = new Set<string>()

    // ── 2. Sync each configured pair ─────────────────────────────────
    for (const pair of RAMP_PAIRS) {
        try {
            const liveRate = await liquidityRampService.getRate(pair.toCurrency, pair.fromFiat, pair.chain)

            const pairRecord = await prisma.pair.findFirst({
                where: {
                    baseCurrency:  { ISO: pair.toCurrency, chain: pair.chain },
                    quoteCurrency: { ISO: pair.fromFiat }
                },
                select: { id: true, name: true }
            })

            if (!pairRecord) {
                const msg = `Pair not found: ${pair.toCurrency} (${pair.chain})/${pair.fromFiat}`
                logger.error(`[RampSync] ${msg}`)
                result.errors.push(msg)
                continue // one missing pair shouldn't abort the rest
            }

            for (const orderType of ORDER_TYPES) {
                const vyrePrice = (liveRate * SPREAD[orderType]).toFixed(8)

                for (const fiatAmount of NGN_AMOUNTS) {
                    const cryptoAmount = (parseFloat(fiatAmount) / parseFloat(vyrePrice)).toFixed(8)
                    const liquidityKey = `RAMP_${orderType}_${pair.toCurrency}_${pair.chain}_${pair.fromFiat}_${fiatAmount}`
                    activeLiquidityKeys.add(liquidityKey)

                    const orderData = {
                        pairId:              pairRecord.id,
                        price:               vyrePrice,
                        amount:              orderType === 'BUY' ? fiatAmount : cryptoAmount,
                        amountProcessed:     0,
                        amountReserved:      0,
                        percentageProcessed: 0,
                        status:              'OPEN' as const,
                    }

                    if (!confirm) {
                        const existing = await prisma.order.findUnique({
                            where: { liquidityKey },
                            select: { id: true }
                        })
                        if (existing) result.updated++
                        else result.created++
                        continue
                    }

                    const existingBefore = await prisma.order.findUnique({
                        where: { liquidityKey },
                        select: { id: true }
                    })

                    await prisma.order.upsert({
                        where:  { liquidityKey },
                        update: { ...orderData, updatedAt: new Date() },
                        create: {
                            userId:          liquidityUser.id,
                            type:            orderType,
                            isSynthetic:     true,
                            liquiditySource: 'QUIDAX',
                            liquidityKey,
                            metadata: {
                                fiatAmount, fromFiat: pair.fromFiat,
                                toCurrency: pair.toCurrency, chain: pair.chain,
                            },
                            ...orderData,
                        }
                    })

                    if (existingBefore) result.updated++
                    else result.created++
                }
            }
        } catch (pairError: any) {
            // One pair's Quidax call failing (network blip, rate limit)
            // shouldn't take down the sync for every other pair.
            const msg = `Failed syncing ${pair.toCurrency}/${pair.chain}: ${pairError.message}`
            logger.error(`[RampSync] ${msg}`)
            result.errors.push(msg)
        }

        // Small delay between pairs — avoids bursting Quidax's rate limit
        // when syncing 8 pairs back-to-back.
        await new Promise(resolve => setTimeout(resolve, 750))
    }

    // ── 3. Close stale synthetic orders ──────────────────────────────
    const staleOrders = await prisma.order.findMany({
        where: {
            isSynthetic:     true,
            liquiditySource: 'QUIDAX',
            status:          'OPEN',
            liquidityKey:    { notIn: Array.from(activeLiquidityKeys) }
        },
        select: { id: true, liquidityKey: true }
    })

    if (staleOrders.length > 0) {
        if (confirm) {
            await prisma.order.updateMany({
                where: { id: { in: staleOrders.map(o => o.id) } },
                data:  { status: 'CLOSED', updatedAt: new Date() }
            })
        }
        result.closed = staleOrders.length
    }

    logger.info(`[RampSync] Done. created=${result.created} updated=${result.updated} closed=${result.closed} errors=${result.errors.length}`)

    // If EVERY pair failed, that's worth surfacing as a real job failure
    // (so BullMQ retries / alerts), rather than a silent 0-order sync.
    if (result.errors.length === RAMP_PAIRS.length) {
        throw new Error(`All ${RAMP_PAIRS.length} pairs failed to sync: ${result.errors.join('; ')}`)
    }

    return result
}