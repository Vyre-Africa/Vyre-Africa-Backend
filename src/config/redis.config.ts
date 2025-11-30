import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../config/logger';
import eventService from '../services/event.service';
import config from '../config/env.config';




const connection = new IORedis({
    host: config.redisHost,
    port: parseInt(config.redisPort),
    username: "default",
    password: config.redisPassWord,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // lazyConnect: true, // Don't connect immediately
     // Connection pooling settings
     // connectTimeout: 30000,
     // commandTimeout: 30000,
     // Limit concurrent connections
    // maxLoadingRetryTime: 10000,
    // retryDelayOnFailover: 1000,
    // connectTimeout: 45000,
    // commandTimeout: 45000,
    // retryDelayOnFailover: 2000
});

// Handle connection errors
connection.on('error', (err) => {
    console.error('Redis connection error:', err);
});

connection.on('connect', () => {
    console.log('Redis connected successfully');
});

export default connection;