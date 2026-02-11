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
  connectTimeout: 15000,
//   username: "default",
  tls: {
    servername: config.redisServerName, // IMPORTANT: SNI for TLS
  },
//   tls: {}, // Required for Upstash
  maxRetriesPerRequest: null,
  family: 4
});



export default connection;