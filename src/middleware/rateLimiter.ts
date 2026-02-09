import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../config/redis.config';
import { Request } from 'express';

// General API rate limiter
export const apiLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        client: redis,
        prefix: 'rl:api:',
    }),
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests, please try again later'
    }
});

// Auth routes (strict)
export const authLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        client: redis,
        prefix: 'rl:auth:',
    }),
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many login attempts, please try again later'
    }
});

// Transfer routes (moderate)
export const transferLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        client: redis,
        prefix: 'rl:transfer:',
    }),
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req: Request & { user?: any }) => {
        // ✅ Fixed: Type req properly
        return req.user?.id || req.ip;
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            message: 'Transfer limit exceeded. Please wait before trying again.',
            retryAfter: res.getHeader('Retry-After')
        });
    }
});

// Read operations (generous)
export const readLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        client: redis,
        prefix: 'rl:read:',
    }),
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

// OTP/SMS routes (very strict)
export const otpLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        client: redis,
        prefix: 'rl:otp:',
    }),
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyGenerator: (req: Request & { user?: any }) => {
        // ✅ Fixed: Type req properly
        return req.user?.id || req.ip;
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            message: 'Too many OTP requests. Please try again later.',
            retryAfter: res.getHeader('Retry-After')
        });
    }
});