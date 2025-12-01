import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../config/logger';
import eventService from '../services/event.service';
import config from '../config/env.config';




const connection = new IORedis({
    host: config.redisHost || 'localhost',
    port: parseInt(config.redisPort),
    // username: "default",
    // password: config.redisPassWord,
    connectTimeout: 30000,  // 30 seconds - IMPORTANT!
    commandTimeout: 30000,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,  // Changed from true to false
    // For Memorystore performance
    keepAlive: 10000,
    enableOfflineQueue: false

     
});

// Handle connection errors
connection.on('error', (err) => {
    console.error('Redis connection error:', err);
});

connection.on('connect', () => {
    console.log('Redis connected successfully');
});

export default connection;