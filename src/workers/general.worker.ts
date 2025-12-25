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

const worker = new Worker('general-process',
  async (job) => {
    try {
      console.info(`Processing job ${job.id} of type ${job.name}`);
      
      switch (job.name) {

        // GENERAL CASES

        case 'user-notification':
          return await notificationService.UserNotify(job.data)
        case 'blockchain-transfer':
          return await walletService.blockchain_Transfer(job.data);

        case 'offchain-transfer':
          return await walletService.offchain_Transfer(job.data);

        case 'bank-transfer':
          return await walletService.direct_bank_Transfer(job.data);


        // ORDER CASES

        case 'create-order':
          return await orderService.createOrder(job.data);
        case 'process-order':
          return await eventService.processOrderJob(job.data);
        case 'process-post-action':
          return await eventService.process_Post_Action_Job(job.data);
        case 'initiate-refund':
          return await eventService.processRefundJob(job.data);

          

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