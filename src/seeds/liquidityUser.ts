// src/seeds/liquidityUser.ts
import prisma from '../config/prisma.client'
import logger from '../config/logger'

export async function seedLiquidityUser() {
    const user = await prisma.user.upsert({
        where:  { email: 'liquidity@vyre.internal' },
        update: {},
        create: {
            email:     'liquidity@vyre.internal',
            isVendor:  true,
            firstName: 'Vyre',
            lastName:  'Liquidity'
        }
    })

    logger.info('Liquidity user seeded', { userId: user.id })
    return user
}