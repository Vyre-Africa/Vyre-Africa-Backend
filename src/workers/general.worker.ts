import { Worker } from 'bullmq';
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
import prisma from '../config/prisma.config';
import sweepService from '../services/sweep.service';

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

const worker = new Worker('general-process',
  async (job) => {
    try {
      console.info(`Processing job ${job.id} of type ${job.name}`);
      let transferRequest;
      
      switch (job.name) {

        // GENERAL CASES

        case 'user-notification':
          return await notificationService.UserNotify(job.data)

        case 'blockchain-transfer':
          return await walletService.handle_Blockchain_Transfer(job.data.transferId);

        case 'offchain-transfer':
            return await walletService.handle_Vyre_Transfer(job.data.transferId)

        case 'bank-transfer':
          return await walletService.handle_Bank_Transfer(job.data.transferId);


        // ORDER CASES

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



        // EVENT CASES

        case 'Qorepay_Event':
          return await eventService.handleQorepayEvent(job.data);
        case 'Tatum_Event':
          return await eventService.handleTatumEvent(job.data);
        
        

        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      console.error(`Job ${job.id} failed:`, error);
      throw error; // Will trigger BullMQ's retry mechanism
    }
  },
  {
    connection,
    concurrency: 5, // Process 5 jobs concurrently
    removeOnComplete: { count: 100 }, // Keep last 100 completed jobs
    removeOnFail: { count: 100 } // Keep last 100 failed jobs
  }
);

worker.on('completed', (job) => {
  console.info(`Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed with error:`, err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
});

export default worker;