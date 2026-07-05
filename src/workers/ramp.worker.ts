// src/workers/ramp.worker.ts
import prisma from '../config/prisma.client'
import liquidityRampService from '../services/liquidityRamp.service'
import logger from '../config/logger'

// const RAMP_PAIRS = [
//     { toCurrency: 'USDT', fromFiat: 'NGN' },
//     { toCurrency: 'USDC', fromFiat: 'NGN' },
//     { toCurrency: 'USDT', fromFiat: 'GHS' },
//     { toCurrency: 'USDC', fromFiat: 'GHS' },
// ]

const RAMP_PAIRS = [
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'BASE' },
    // add more as needed, e.g.:
    // { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'TRON' },
]

const NGN_AMOUNTS = ['5000', '10000', '20000', '50000', '100000']
const GHS_AMOUNTS = ['100', '200', '500', '1000', '2000']

const LIQUIDITY_USER_EMAIL = 'vyreafrica@gmail.com'

export async function startRampOrderSync() {
    logger.info('Ramp order sync worker started')

    await syncRampOrders()
    setInterval(() => syncRampOrders(), 60_000)
}

async function syncRampOrders() {
    try {
        const liquidityUser = await prisma.user.findFirst({
            where: {
                isVendor: true,
                email:    LIQUIDITY_USER_EMAIL
            }
        })

        if (!liquidityUser) {
            logger.error('Liquidity user not found — run seed first')
            return
        }

        for (const pair of RAMP_PAIRS) {
            try {
                await syncPair(liquidityUser.id, pair)
            } catch (err: any) {
                logger.error(`Failed to sync pair ${pair.toCurrency}/${pair.fromFiat}:`, err.message)
            }
        }

        logger.info('Ramp order sync complete')

    } catch (error: any) {
        logger.error('Ramp order sync failed:', error.message)
    }
}

async function syncPair(
    liquidityUserId: string,
    pair: { toCurrency: string; fromFiat: string; chain: string }
) {
    // Get live rate from Quidax
    const liveRate = await liquidityRampService.getRate(pair.toCurrency, pair.fromFiat, pair.chain)

    // Add 0.5% Vyre spread
    const vyrePrice = (liveRate * 1.005).toFixed(8)

    const pairRecord = await prisma.pair.findFirst({
        where: {
            baseCurrency:  { ISO: pair.toCurrency },
            quoteCurrency: { ISO: pair.fromFiat }
        },
        select: { id: true }
    })

    if (!pairRecord) {
        logger.warn(`Pair not found in DB: ${pair.toCurrency}/${pair.fromFiat}`)
        return
    }

    const amounts = pair.fromFiat === 'NGN' ? NGN_AMOUNTS : GHS_AMOUNTS

    for (const fiatAmount of amounts) {
        // How much crypto user gets for this fiat amount
        const cryptoAmount = (parseFloat(fiatAmount) / parseFloat(vyrePrice)).toFixed(8)
        const liquidityKey = `RAMP_${pair.toCurrency}_${pair.fromFiat}_${fiatAmount}`

        await prisma.order.upsert({
            where:  { liquidityKey },
            update: {
                // Refresh price + reset capacity — order is always fully available
                price:               vyrePrice,
                amount:              cryptoAmount,
                amountProcessed:     0,
                amountReserved:      0,
                percentageProcessed: 0,
                status:              'OPEN',
                updatedAt:           new Date()
            },
            create: {
                userId:              liquidityUserId,
                pairId:              pairRecord.id,
                type:                'SELL',      // vendor selling crypto, user buying
                price:               vyrePrice,
                amount:              cryptoAmount,
                amountProcessed:     0,
                amountReserved:      0,
                percentageProcessed: 0,
                status:              'OPEN',
                isSynthetic:         true,
                liquiditySource:     'QUIDAX',
                liquidityKey,
                metadata: {
                    fiatAmount,
                    fromFiat:   pair.fromFiat,
                    toCurrency: pair.toCurrency
                }
            }
        })
    }

    logger.info(`Synced ${pair.toCurrency}/${pair.fromFiat} @ ${vyrePrice}`)
}