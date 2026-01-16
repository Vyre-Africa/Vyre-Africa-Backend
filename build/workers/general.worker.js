"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
// import logger from '../config/logger';
const notification_service_1 = __importDefault(require("../services/notification.service"));
const wallet_service_1 = __importDefault(require("../services/wallet.service"));
// import connection from '../config/redis.config';
const event_service_1 = __importDefault(require("../services/event.service"));
const order_service_1 = __importDefault(require("../services/order.service"));
const redis_config_1 = __importDefault(require("../config/redis.config"));
const anon_service_1 = __importDefault(require("../services/anon.service"));
const worker = new bullmq_1.Worker('general-process', async (job) => {
    try {
        console.info(`Processing job ${job.id} of type ${job.name}`);
        switch (job.name) {
            // GENERAL CASES
            case 'user-notification':
                return await notification_service_1.default.UserNotify(job.data);
            case 'blockchain-transfer':
                return await wallet_service_1.default.blockchain_Transfer(job.data);
            case 'offchain-transfer':
                return await wallet_service_1.default.offchain_Transfer(job.data);
            case 'bank-transfer':
                return await wallet_service_1.default.direct_bank_Transfer(job.data);
            // ORDER CASES
            case 'create-order':
                return await order_service_1.default.createOrder(job.data);
            case 'process-order':
                return await order_service_1.default.processOrderJob(job.data);
            case 'process-post-action':
                return await event_service_1.default.process_Post_Action_Job(job.data);
            case 'initiate-refund':
                return await event_service_1.default.processRefundJob(job.data);
            case 'expire-awaiting':
                return await anon_service_1.default.cancelAwaitingJob(job.data);
            // EVENT CASES
            case 'Qorepay_Event':
                return await event_service_1.default.handleQorepayEvent(job.data);
            case 'Tatum_Event':
                return await event_service_1.default.handleTatumEvent(job.data);
            default:
                throw new Error(`Unknown job type: ${job.name}`);
        }
    }
    catch (error) {
        console.error(`Job ${job.id} failed:`, error);
        throw error; // Will trigger BullMQ's retry mechanism
    }
}, {
    connection: redis_config_1.default,
    concurrency: 5, // Process 5 jobs concurrently
    removeOnComplete: { count: 100 }, // Keep last 100 completed jobs
    removeOnFail: { count: 100 } // Keep last 100 failed jobs
});
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
exports.default = worker;
