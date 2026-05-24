import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../config/logger';
import eventService from '../services/event.service';
import config from '../config/env.config';
// import { Redis } from '@upstash/redis';

const connection = new IORedis({
  host: config.redisHost,
  port: 6379,
  password: config.redisPassWord,
  lazyConnect: true,
  connectTimeout: 30000,
  keepAlive: 10000,
//   username: "default",
  tls: {
    servername: config.redisServerName, // IMPORTANT: SNI for TLS
  },
  retryStrategy: (times: number) => {
        if (times > 5) return null;  // ← stop after 5 retries
        return Math.min(times * 500, 3000);
  },
//   tls: {}, // Required for Upstash
  reconnectOnError: (err) => {
        const targetErrors = [
            'ETIMEDOUT',
            'ECONNRESET', 
            'ECONNREFUSED',
            'Connection is closed',  // ← add this
            'Stream isn\'t writeable'
        ];
        return targetErrors.some(e => err.message.includes(e));
  },
  // maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  maxRetriesPerRequest: null,
  family: 4
});

connection.on('error', (err) => {
    console.error('Redis connection error:', err.message);
});

connection.on('close', () => {
    console.warn('Redis connection closed — reconnecting...');
});

connection.on('reconnecting', () => {
    console.log('Redis reconnecting...');
});

connection.on('ready', () => {
    console.log('Redis connection ready');
});



export default connection;