import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import logger from '../config/logger';
import eventService from '../services/event.service';
import config from '../config/env.config';
// import { Redis } from '@upstash/redis';


const redisUrl = config.redisHost; // "rediss://default:token@organic-worm-35699.upstash.io:6379"

// Method 1: Parse with URL class
// let host, port, username, password, tlsEnabled;

// try {
//   const url = new URL(redisUrl);
//   host = url.hostname; // "organic-worm-35699.upstash.io"
//   port = parseInt(config.redisPort)
//   username = url.username || 'default';
//   password = url.password;
//   tlsEnabled = url.protocol === 'rediss:';
  
//   console.log('✅ Parsed Redis URL:');
//   console.log('  Host:', host);
//   console.log('  Port:', port);
//   console.log('  Username:', username);
//   console.log('  Password length:', password?.length);
//   console.log('  TLS required:', tlsEnabled);
// } catch (error) {
//   console.error('❌ Failed to parse Redis URL:', error);
//   // Fallback to basic values
//   host = config.redisHost;
//   port = config.redisPort ? parseInt(config.redisPort) : 6379;
//   password = config.redisPassWord;
//   tlsEnabled = redisUrl.includes('rediss://');
// }

// // Create connection with proper configuration
// const connection = new IORedis({
//   // Core connection settings (EXTRACTED from the URL)
//   host: host, // Just the hostname, not the full URL!
//   port: port,
//   username: username,
//   password: password,
//   tls: tlsEnabled ? {} : undefined, // Required for Upstash
  
//   // Your options
//   maxRetriesPerRequest: null,
//   enableReadyCheck: false,
//   connectTimeout: 15000, // Added: prevent timeout errors
// //   retryStrategy: function(times) {
// //     const delay = Math.min(times * 100, 3000);
// //     console.log(`Redis reconnecting attempt ${times}, delay: ${delay}ms`);
// //     return delay;
// //   },
// });

const connection = new IORedis({
  host: 'organic-worm-35699.upstash.io',
  port: 6379,
  password: 'AYtzAAIncDFjMmU2NjFlNjEzZWY0MmU1OTc3ZWE0NzVmOTU1OTgwOXAxMzU2OTk',
  tls: {}, // Required for Upstash
  maxRetriesPerRequest: null,
});

// Event listeners for debugging
// connection.on('error', (err) => {
//   console.error('Redis connection error:', {
//     message: err.message,
//     host: config.redisHost,
//     port: config.redisPort
//   });
// });

connection.on('connect', () => {
  console.log('✅ Redis connected successfully to:', 
    `${config.redisHost}:${config.redisPort || 6379}`);
});

connection.on('close', () => {
  console.log('Redis connection closed');
});

connection.on('ready', () => {
  console.log('Redis client is ready to accept commands');
});

connection.on('reconnecting', () => {
  console.log(`Redis reconnecting `);
});

// Test connection immediately
// (async () => {
//   try {
//     // Wait a moment for connection to establish
//     setTimeout(async () => {
//       try {
//         const pong = await connection.ping();
//         console.log('Connection test:', pong);
//       } catch (pingErr) {
//         console.error('Ping failed:', pingErr);
//       }
//     }, 1000);
//   } catch (error) {
//     console.error('Initial connection setup error:', error);
//   }
// })();

export default connection;