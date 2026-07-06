// src/scripts/sync-buy-orders.ts
// Run with: ts-node --transpile-only -r dotenv/config src/scripts/sync-buy-orders.ts

import prisma from '../config/prisma.client'
import liquidityRampService from '../services/liquidityRamp.service'
import logger from '../config/logger'

const RAMP_PAIRS = [
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'BASE' },
    // add more as needed, e.g.:
    // { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'TRON' },
]

// BUY orders (offramp): vendor offers to pay out this much NGN in exchange
// for crypto the user sends. order.amount for a BUY order is QUOTE currency
// (NGN), confirmed by createOrder()'s balance check:
//   orderType === 'BUY' && quoteBalance.lessThan(amountDecimal)
const NGN_AMOUNTS = ['5000', '10000', '20000', '500000', '1000000']

const LIQUIDITY_USER_EMAIL = 'vyreafrica@gmail.com'

async function run() {
    try {
        logger.info('Starting BUY order sync script...')

        // ── 1. Find liquidity user ─────────────────────────────────────────
        const liquidityUser = await prisma.user.findFirst({
            where: {
                isVendor: true,
                email:    LIQUIDITY_USER_EMAIL
            },
            select: { id: true, email: true, isVendor: true }
        })

        if (!liquidityUser) {
            logger.error(`Liquidity user not found: ${LIQUIDITY_USER_EMAIL}`)
            logger.error('Make sure the user exists and has isVendor = true')
            process.exit(1)
        }

        logger.info(`Liquidity user found: ${liquidityUser.email} (id: ${liquidityUser.id})`)

        // ── 2. Sync BUY orders for each pair ────────────────────────────────
        for (const pair of RAMP_PAIRS) {
            logger.info(`Syncing BUY orders for ${pair.toCurrency}/${pair.fromFiat}...`)

            // Get live rate from Quidax
            const liveRate = await liquidityRampService.getRate(pair.toCurrency, pair.fromFiat, pair.chain)
            logger.info(`Live rate from Quidax: ${liveRate} ${pair.fromFiat} per ${pair.toCurrency}`)

            // No spread — using Quidax's live rate directly
            const vyrePrice = liveRate.toFixed(8)
            logger.info(`Using live rate directly: ${vyrePrice}`)

            // Find the pair record
            const pairRecord = await prisma.pair.findFirst({
                where: {
                    baseCurrency:  { ISO: pair.toCurrency },
                    quoteCurrency: { ISO: pair.fromFiat }
                },
                select: { id: true, name: true }
            })

            if (!pairRecord) {
                logger.error(`Pair not found in DB: ${pair.toCurrency}/${pair.fromFiat}`)
                logger.error(`Make sure the pair exists with baseCurrency.ISO = ${pair.toCurrency} and quoteCurrency.ISO = ${pair.fromFiat}`)
                process.exit(1)
            }

            logger.info(`Pair found: ${pairRecord.name} (id: ${pairRecord.id})`)

            // ── 3. Upsert one BUY order per NGN tier ────────────────────────
            for (const fiatAmount of NGN_AMOUNTS) {
                const liquidityKey = `RAMP_BUY_${pair.toCurrency}_${pair.fromFiat}_${fiatAmount}`

                const order = await prisma.order.upsert({
                    where:  { liquidityKey },
                    update: {
                        price:               vyrePrice,
                        amount:              fiatAmount,   // quote currency, no conversion
                        amountProcessed:     0,
                        amountReserved:      0,
                        percentageProcessed: 0,
                        status:              'OPEN',
                        updatedAt:           new Date()
                    },
                    create: {
                        userId:              liquidityUser.id,
                        pairId:              pairRecord.id,
                        type:                'BUY',
                        price:               vyrePrice,
                        amount:              fiatAmount,   // quote currency, no conversion
                        amountProcessed:     0,
                        amountReserved:      0,
                        percentageProcessed: 0,
                        status:              'OPEN',
                        isSynthetic:         true,
                        liquiditySource:     'QUIDAX',
                        liquidityKey,
                        metadata: {
                            fiatAmount,
                            fromCurrency: pair.toCurrency,
                            toFiat:       pair.fromFiat
                        }
                    },
                    select: {
                        id:           true,
                        type:         true,
                        price:        true,
                        amount:       true,
                        status:       true,
                        liquidityKey: true,
                        isSynthetic:  true,
                    }
                })

                const cryptoEquivalent = (parseFloat(fiatAmount) / parseFloat(vyrePrice)).toFixed(8)

                logger.info(`✅ BUY order upserted:`, {
                    liquidityKey,
                    orderId:          order.id,
                    fiatAmount:       `${fiatAmount} ${pair.fromFiat}`,
                    cryptoEquivalent: `≈ ${cryptoEquivalent} ${pair.toCurrency}`,
                    price:            `${vyrePrice} ${pair.fromFiat}/${pair.toCurrency}`,
                })
            }
        }

        logger.info('✅ BUY order sync completed successfully')
        logger.info('You should now see 5 RAMP_BUY_USDC_NGN_* orders in your Order table')

    } catch (error: any) {
        logger.error('Script failed:', error.message)
        logger.error(error.stack)
        process.exit(1)
    } finally {
        await prisma.$disconnect()
    }
}

run()