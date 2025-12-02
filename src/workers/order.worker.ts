import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../config/logger';
import eventService from '../services/event.service';
import config from '../config/env.config';
// import connection from '../config/redis.config';
import connection from '../config/redis.config';

const worker = new Worker('order-processing', 
  async (job) => {
    try {
      logger.info(`Processing job ${job.id} of type ${job.name}`);
      
      switch (job.name) {
        case 'process-order':
          return await eventService.processOrderJob(job.data);
        case 'process-post-action':
          return await eventService.process_Post_Action_Job(job.data);
        case 'initiate-refund':
          return await eventService.processRefundJob(job.data);
        default:
          throw new Error(`Unknown job type: ${job.name}`);
      }
    } catch (error) {
      logger.error(`Job ${job.id} failed:`, error);
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
  logger.info(`Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed with error:`, err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
});

export default worker;