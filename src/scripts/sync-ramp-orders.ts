// scripts/sync-ramp-orders.ts
// Run with: npx ts-node scripts/sync-ramp-orders.ts
//
//   npx ts-node scripts/sync-ramp-orders.ts              # dry run
//   npx ts-node scripts/sync-ramp-orders.ts --confirm     # live
//
// This is now a thin wrapper — the real logic lives in
// services/rampOrderSync.service.ts, shared with the scheduled worker.

import prisma from '../config/prisma.client'
import logger from '../config/logger'
import { syncRampOrders } from '../services/rampOrderSync.service'

const CONFIRMED = process.argv.includes('--confirm')

async function main() {
    if (!CONFIRMED) {
        logger.info('🛑 Dry run — nothing will be written. Re-run with --confirm to apply.')
    }

    const result = await syncRampOrders({ confirm: CONFIRMED })

    logger.info('─────────────────────────────────────────')
    logger.info(`${CONFIRMED ? 'RESULT' : 'DRY RUN PREVIEW'}`)
    logger.info(`  Created: ${result.created}`)
    logger.info(`  Updated: ${result.updated}`)
    logger.info(`  Closed:  ${result.closed}`)
    if (result.errors.length > 0) {
        logger.error(`  Errors:  ${result.errors.length}`)
        result.errors.forEach(e => logger.error(`    - ${e}`))
    }
    if (!CONFIRMED) {
        logger.info('Re-run with --confirm to apply these changes.')
    }
}

main()
    .catch((error) => {
        logger.error('Script failed:', error.message)
        logger.error(error.stack)
        process.exitCode = 1
    })
    .finally(async () => {
        await prisma.$disconnect() // safe here — this process only ever runs once and exits
    })