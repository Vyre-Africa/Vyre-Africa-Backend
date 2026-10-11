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
// handleTreasuryReplenishment still comes from nuvionpayout.service: the real
// implementation moved to treasuryReplenishment.service.ts and is re-exported
// from there, so this import needs no change.
import { processNuvionPayoutJob, handleTreasuryReplenishment } from '../services/nuvionpayout.service';
// NEW — steps 5 and 6 of the replenishment, plus the sweeper that covers all of it.
import { handleTreasuryConversion, sweepTreasury } from '../services/treasuryConversion.service';
// NEW — checked once at boot so a wrong treasury map entry is caught on deploy
// rather than halfway through a payout.
import { validateTreasuryMap } from '../config/nuvionTreasury.config';
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

                    case 'Nuvion_Event':
                        return await eventService.handleNuvionEvent(job.data);

                    case 'Nuvion_Payout_Process':
                        return await processNuvionPayoutJob(job.data);

                    // ── Treasury replenishment, steps 4 to 6 ──
                    // A thrown error must reach BullMQ: that is how a genuinely
                    // retryable failure gets retried. All three use
                    // `return await` for exactly that reason.
                    //
                    // concurrency is 5 below, so two of these can run at once.
                    // handleTreasuryReplenishment claims its row with a single
                    // atomic update before sending, so only one can ever send
                    // the same crypto.

                    // Step 4: send the stablecoin on-chain to Nuvion.
                    case 'Nuvion_Treasury_Replenish':
                        return await handleTreasuryReplenishment(job.data);

                    // NEW — step 6: convert the arrived stablecoin into the USD
                    // treasury. Queued by handleDepositConfirmed once the
                    // inflows.completed webhook matches a deposit.
                    case 'Nuvion_Treasury_Convert':
                        return await handleTreasuryConversion(job.data);

                    // NEW — re-queues anything whose job was lost (a Redis
                    // outage, a dead worker) and escalates anything stuck
                    // mid-send or waiting too long for a deposit. Registered in
                    // scheduleRecurringJobs below.
                    case 'Nuvion_Treasury_Sweep':
                        return await sweepTreasury();

                    case 'Didit_Event':
                        return await eventService.handleDiditEvent(job.data);

                    case 'Ramp_Event':
                        console.log('🔍 TRACE [8] worker picked up Ramp_Event job', {
                            jobId: job.id,
                            attemptsMade: job.attemptsMade,
                        });
                        try {
                            await eventService.processRampWebhook(job.data.body);
                            console.log('🔍 TRACE [8a] processRampWebhook returned without throwing');
                        } catch (err: any) {
                            console.log('🔍 TRACE [8b] ❌ processRampWebhook THREW inside worker', {
                                error: err?.message,
                                stack: err?.stack,
                            });
                            throw err; // let BullMQ's retry/failure handling see this
                        }
                        break;


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
export const generalQueue = new Queue('general-process', { connection });

// Judgment call, not a measured requirement — the synced price is a
// listing estimate, not an execution price (real fills always re-quote
// against Quidax fresh), so this only needs to stay "reasonably fresh."
// Adjust freely.

const RAMP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Every 5 minutes. Frequent enough that nothing sits unnoticed for long, cheap
// enough to ignore: most runs find nothing and do four indexed queries.
const TREASURY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

    // NEW — the treasury sweeper. Picks up replenishments whose job was lost,
    // and escalates anything stuck mid-send or waiting too long for a deposit.
    // Same stable-jobId pattern as ramp-sync, so restarts do not duplicate it.
    await generalQueue.add(
        'Nuvion_Treasury_Sweep',
        {},
        {
            repeat:  { every: TREASURY_SWEEP_INTERVAL_MS },
            jobId:   'nuvion-treasury-sweep',
            removeOnComplete: { count: 20 },
            removeOnFail:     { count: 50 },
        }
    );
    logger.info(`[Schedule] Nuvion_Treasury_Sweep registered — every ${TREASURY_SWEEP_INTERVAL_MS / 60000} minutes`);

    // NEW — checks every STABLECOIN_TREASURY entry resolves to a real, active
    // row on the right chain, and that no two keys point at the same account.
    // Reports rather than throws: one bad pair must not stop the service, it
    // just means that pair cannot be replenished automatically.
    const treasuryProblems = await validateTreasuryMap();
    if (treasuryProblems.length > 0) {
        logger.warn(`[Schedule] Treasury map has ${treasuryProblems.length} problem(s) — those pairs cannot be replenished automatically`);
    }
}