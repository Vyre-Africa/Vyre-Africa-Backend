// scripts/sync-ramp-orders.ts
// Run with: npx ts-node scripts/sync-ramp-orders.ts
// Or if using tsx: npx tsx scripts/sync-ramp-orders.ts

import prisma from '../../src/config/prisma.client'
import liquidityRampService from '../../src/services/liquidityRamp.service'
import logger from '../../src/config/logger'

// const RAMP_PAIRS = [
//     { toCurrency: 'USDC', fromFiat: 'NGN' },
// ]

const RAMP_PAIRS = [
    { toCurrency: 'USDC', fromFiat: 'NGN', chain: 'BASE' },
    // add more as needed, e.g.:
    // { toCurrency: 'USDT', fromFiat: 'NGN', chain: 'TRON' },
]

const NGN_AMOUNTS = ['5000', '10000', '20000', '50000', '100000']

const LIQUIDITY_USER_EMAIL = 'vyreafrica@gmail.com'

async function run() {
    try {
        logger.info('Starting ramp order sync script...')

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

        // ── 2. Sync USDC/NGN pair ──────────────────────────────────────────
        for (const pair of RAMP_PAIRS) {
            logger.info(`Syncing pair ${pair.toCurrency}/${pair.fromFiat}...`)

            // Get live rate from Quidax
            const liveRate = await liquidityRampService.getRate(pair.toCurrency, pair.fromFiat, pair.chain)
            logger.info(`Live rate from Quidax: ${liveRate} ${pair.fromFiat} per ${pair.toCurrency}`)

            // Add 0.5% Vyre spread
            const vyrePrice = (liveRate * 1.005).toFixed(8)
            logger.info(`Vyre price (+ 0.5% spread): ${vyrePrice}`)

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
                logger.error('Make sure the pair exists with baseCurrency.ISO = USDC and quoteCurrency.ISO = NGN')
                process.exit(1)
            }

            logger.info(`Pair found: ${pairRecord.name} (id: ${pairRecord.id})`)

            // ── 3. Upsert one order per NGN amount ─────────────────────────
            for (const fiatAmount of NGN_AMOUNTS) {
                const cryptoAmount = (parseFloat(fiatAmount) / parseFloat(vyrePrice)).toFixed(8)
                const liquidityKey = `RAMP_${pair.toCurrency}_${pair.fromFiat}_${fiatAmount}`

                const order = await prisma.order.upsert({
                    where:  { liquidityKey },
                    update: {
                        price:               vyrePrice,
                        amount:              cryptoAmount,
                        amountProcessed:     0,
                        amountReserved:      0,
                        percentageProcessed: 0,
                        status:              'OPEN',
                        updatedAt:           new Date()
                    },
                    create: {
                        userId:              liquidityUser.id,
                        pairId:              pairRecord.id,
                        type:                'SELL',
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

                logger.info(`✅ Order upserted:`, {
                    liquidityKey,
                    orderId:     order.id,
                    fiatAmount:  `${fiatAmount} NGN`,
                    cryptoAmount: `${cryptoAmount} USDC`,
                    price:       `${vyrePrice} NGN/USDC`,
                })
            }
        }

        logger.info('✅ Ramp order sync script completed successfully')
        logger.info('You should now see 5 RAMP_USDC_NGN_* orders in your Order table')

    } catch (error: any) {
        logger.error('Script failed:', error.message)
        logger.error(error.stack)
        process.exit(1)
    } finally {
        await prisma.$disconnect()
    }
}

run()