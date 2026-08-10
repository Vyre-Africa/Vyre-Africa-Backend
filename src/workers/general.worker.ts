import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
// import logger from '../config/logger';
import notificationService from '../services/notification.service';
import config from '../config/env.config';
import walletService from '../services/wallet.service';
// import connection from '../config/redis.config';
import eventService from '../services/event.service';
import orderService from '../services/order.service';
import connection from '../config/redis.config';
import anonService from '../services/anon.service';
import prisma from '../config/prisma.client';
import sweepService from '../services/sweep.service';
import walletpoolService from '../services/walletpool.service';
import { syncRampOrders } from '../services/rampOrderSync.service';
import logger from '../config/logger';

// const SWEEP_CHAINS = ['ETH', 'MATIC', 'BSC', 'BASE', 'ARB', 'OPTIMISM', 'TRON']
const SWEEP_CHAINS = [
  'ETHEREUM', 'POLYGON', 'BSC', 'TRON',   // gas pump
  'BASE', 'ARBITRUM', 'OPTIMISM'  // nonce chain
]
export function startSweepWorkers() {
  return SWEEP_CHAINS.map((chain) => {
    const sweepWorker = new Worker(
      `sweep-${chain}`,
      (job) => sweepService.processSweepJob(job),
      {
        connection,
        concurrency: 1
      }
    )

    sweepWorker.on('completed', (job) => {
      console.log(`[SweepWorker:${chain}] Job ${job.id} completed`)
    })

    sweepWorker.on('failed', async (job, err) => {
      console.error(`[SweepWorker:${chain}] Job ${job?.id} failed:`, err.message)

      // Only mark FAILED after all retries exhausted
      if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
        await prisma.sweepLog.update({
          where: { id: job.data.sweepLogId },
          data: { status: 'FAILED', error: err.message }
        }).catch(console.error)
      }
    })

    console.log(`[SweepWorker:${chain}] Started`)
    return sweepWorker
  })
}

export function startGeneralWorker() {
    const worker = new Worker('general-process',
        async (job) => {
            try {
                console.info(`Processing job ${job.id} of type ${job.name}`);

                switch (job.name) {
                    case 'user-notification':
                        return await notificationService.UserNotify(job.data);
                    case 'blockchain-transfer':
                        return await walletService.handle_Blockchain_Transfer(job.data.transferId);
                    case 'offchain-transfer':
                        return await walletService.handle_Vyre_Transfer(job.data.transferId);
                    case 'bank-transfer':
                        return await walletService.handle_Bank_Transfer(job.data.transferId);
                    case 'create-order':
                        return await orderService.createOrder(job.data);
                    case 'process-order':
                        return await orderService.processOrderJob(job.data);
                    case 'process-post-action':
                        return await eventService.process_Post_Action_Job(job.data);
                    case 'initiate-refund':
                        return await eventService.processRefundJob(job.data);
                    case 'expire-awaiting':
                        return await anonService.cancelAwaitingJob(job.data);
                    case 'Qorepay_Event':
                        return await eventService.handleQorepayEvent(job.data);
                    case 'Tatum_Event':
                        return await eventService.handleTatumEvent(job.data);

                    case 'cleanup-trade-wallets':
                        return await walletpoolService.cleanupTradeWallets(job.data.awaitingId);

                    // Scheduled ramp order pricing sync. Always runs live
                    // (confirm: true) — dry-run is a CLI-only debugging
                    // concept, never appropriate for an automated
                    // recurring job.
                    case 'ramp-sync':
                        return await syncRampOrders({ confirm: true });

                    default:
                        throw new Error(`Unknown job type: ${job.name}`);
                }
            } catch (error) {
                console.error(`Job ${job.id} failed:`, error);
                throw error;
            }
        },
        {
            connection,
            concurrency:      5,
            removeOnComplete: { count: 100 },
            removeOnFail:     { count: 100 }
        }
    );

    worker.on('completed', (job) => {
        console.info(`Job ${job.id} completed successfully`);
    });

    worker.on('failed', (job, err) => {
        console.error(`Job ${job?.id} failed with error:`, err);
    });

    process.on('SIGTERM', async () => {
        await worker.close();
    });

    console.log('[GeneralWorker] Started');
    return worker;
}

// ── Recurring job scheduling ────────────────────────────────────────────
// Registers onto the SAME 'general-process' queue the worker above
// consumes — this Queue instance was previously missing entirely, which
// is why scheduleRecurringJobs() referenced an undefined `generalQueue`.
const generalQueue = new Queue('general-process', { connection });

// Judgment call, not a measured requirement — the synced price is a
// listing estimate, not an execution price (real fills always re-quote
// against Quidax fresh), so this only needs to stay "reasonably fresh."
// Adjust freely.

const RAMP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function scheduleRecurringJobs() {
    await generalQueue.add(
        'ramp-sync',
        {},
        {
            repeat:  { every: RAMP_SYNC_INTERVAL_MS },
            jobId:   'ramp-sync-recurring', // stable id — BullMQ won't duplicate the schedule on every server restart as long as this stays the same
            removeOnComplete: { count: 20 },
            removeOnFail:     { count: 50 },
        }
    );
    logger.info(`[Schedule] ramp-sync registered — every ${RAMP_SYNC_INTERVAL_MS / 60000} minutes`);
}