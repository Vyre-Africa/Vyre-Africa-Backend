"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ioredis_1 = __importDefault(require("ioredis"));
class RedisService {
    constructor() {
        this.client = null;
        // Private constructor for singleton
    }
    static getInstance() {
        if (!RedisService.instance) {
            RedisService.instance = new RedisService();
        }
        return RedisService.instance;
    }
    async getClient() {
        if (!this.client || this.client.status !== 'ready') {
            await this.initialize();
        }
        return this.client;
    }
    async initialize() {
        console.log('🔧 Initializing Redis connection...');
        // Use IP address to avoid DNS issues
        this.client = new ioredis_1.default({
            host: "13.244.198.250",
            port: 6379,
            password: "ATXcAAIncDI1Y2MzYTJhODc3ZjA0MzVkYmM2NjBlMDRmMmRiNGQ3ZHAyMTM3ODg",
            connectTimeout: 15000,
            tls: {
                servername: 'ideal-hedgehog-13788.upstash.io',
            },
            maxRetriesPerRequest: 3,
            retryStrategy: function (times) {
                const delay = Math.min(times * 100, 3000);
                return delay;
            },
        });
        // Event listeners
        this.client.on('connect', () => {
            console.log('✅ Redis connected to IP: 13.244.198.250:6379');
        });
        this.client.on('error', (err) => {
            if (!err.message.includes('rediss://default:')) {
                console.error('Redis error:', err.message);
            }
        });
        // Wait for connection
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Redis connection timeout'));
            }, 10000);
            this.client.on('ready', () => {
                clearTimeout(timeout);
                resolve(true);
            });
            this.client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        console.log('✅ Redis initialized successfully');
    }
    async quit() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
        }
    }
}
// Export singleton instance
const redisService = RedisService.getInstance();
exports.default = redisService;
