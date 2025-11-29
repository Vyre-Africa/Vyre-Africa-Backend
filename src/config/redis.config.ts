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
    lazyConnect: true // Don't connect immediately
});

// Handle connection errors
connection.on('error', (err) => {
    console.error('Redis connection error:', err);
});

connection.on('connect', () => {
    console.log('Redis connected successfully');
});

export default connection;