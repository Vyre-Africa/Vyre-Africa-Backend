// middleware/parseRateLimiter.ts
//
// Per-user limiter for POST /transfers/parse-recipient.
//
// WHAT IT IS ACTUALLY PROTECTING
// Every parse call is a paid OpenAI call made on behalf of a logged-in user.
// There is no transfer at the end of it and no fee attached to it, so the
// usual thing that makes abuse self-limiting — it costs the attacker money —
// does not apply here. A logged-in account running a loop against this
// endpoint is a direct charge on your OpenAI account at whatever rate their
// connection allows. MAX_TEXT in the controller caps the cost of one call;
// this caps how many of them.
//
// TWO LIMITS, because they stop different things:
//   PER_MINUTE  a burst — a retry loop, a stuck frontend, someone curling it
//   PER_DAY     the bill. This is the one that matters. A loop held at 20/min
//               is still ~29,000 calls a day; the daily cap turns that into
//               300.
//
// ── Wiring ────────────────────────────────────────────────────────────
//
//   import { parseRateLimiter, useRedisForRateLimit } from '../middleware/parseRateLimiter';
//
//   // once at boot, with the SAME ioredis client BullMQ already uses
//   useRedisForRateLimit(redisConnection);
//
//   router.post('/transfers/parse-recipient', authenticate, parseRateLimiter, recipientParseController.parse);
//
// ── Why Redis and not a Map ───────────────────────────────────────────
// You run under PM2. An in-memory counter is per PROCESS, so with 4 instances
// the real limit is 4× what the numbers below say, and which instance a
// request lands on is round-robin — so a client that gets a 429 just retries
// and gets served by the next one. You already run Redis for BullMQ, so the
// correct version costs two commands.
//
// The in-memory path below exists only so this never becomes the reason the
// endpoint is down. It logs loudly, once, that it is degraded.

import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

const PER_MINUTE = Number(process.env.PARSE_LIMIT_PER_MINUTE ?? 20);
const PER_DAY = Number(process.env.PARSE_LIMIT_PER_DAY ?? 300);

const MINUTE = 60;
const DAY = 24 * 60 * 60;

// ── Redis, when it has been handed to us ────────────────────────────
type RedisLike = {
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<any>;
};

let redis: RedisLike | null = null;

export function useRedisForRateLimit(client: RedisLike) {
    redis = client;
    logger.info('[ParseLimit] using Redis — limits are correct across all PM2 instances', {
        perMinute: PER_MINUTE, perDay: PER_DAY,
    });
}

// ── In-memory fallback ──────────────────────────────────────────────
const memory = new Map<string, { count: number; resetAt: number }>();
let warnedAboutMemory = false;

function warnMemoryOnce() {
    if (warnedAboutMemory) return;
    warnedAboutMemory = true;
    logger.warn(
        '[ParseLimit] NO REDIS — counting in process memory. Under PM2 the real limit is ' +
        '(instances × these numbers) and a 429 can be retried onto another instance. ' +
        'Call useRedisForRateLimit(redisConnection) at boot.',
        { perMinute: PER_MINUTE, perDay: PER_DAY },
    );
}

// Keeps the Map from growing without bound. Cheap: it only runs on a miss.
function sweepMemory(now: number) {
    if (memory.size < 5000) return;
    for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}

// Returns the count AFTER this request. One shape for both backends so the
// decision below reads the same either way.
async function bump(key: string, windowSeconds: number): Promise<number> {
    if (redis) {
        const count = await redis.incr(key);
        // Only the first request in a window sets the TTL. Setting it every
        // time would slide the window forward on each call and the limit
        // would never actually reset.
        if (count === 1) await redis.expire(key, windowSeconds);
        return count;
    }

    warnMemoryOnce();
    const now = Date.now();
    sweepMemory(now);
    const hit = memory.get(key);
    if (!hit || hit.resetAt <= now) {
        memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return 1;
    }
    hit.count += 1;
    return hit.count;
}

// Day boundary in UTC. Good enough: the point is a ceiling, not a calendar.
const dayStamp = () => new Date().toISOString().slice(0, 10);

export async function parseRateLimiter(req: Request & Record<string, any>, res: Response, next: NextFunction) {
    // Keyed on the user, never the IP. This route sits behind `authenticate`,
    // and IP-keying would put a whole office or a whole mobile carrier NAT
    // into one bucket.
    const subject = req.user?.id;
    if (!subject) {
        // No user means the middleware order is wrong — `authenticate` must
        // run first. Failing closed is right: an unauthenticated route to a
        // paid API is the exact thing being guarded against.
        logger.error('[ParseLimit] no req.user — is this route behind authenticate()?');
        return res.status(401).json({ success: false, msg: 'Please sign in again' });
    }

    const minuteWindow = Math.floor(Date.now() / 60000);

    try {
        const [perMinute, perDay] = await Promise.all([
            bump(`parselimit:m:${subject}:${minuteWindow}`, MINUTE),
            bump(`parselimit:d:${subject}:${dayStamp()}`, DAY),
        ]);

        if (perDay > PER_DAY) {
            logger.warn('[ParseLimit] daily cap hit', { userId: subject, perDay });
            return res.status(429).json({
                success: false,
                // The UI falls back to the manual fields on a 429, so this is
                // an explanation, not a dead end.
                msg: "You've used up today's automatic reading of pasted details. You can still enter the details yourself.",
                retryAfterSeconds: DAY,
            });
        }

        if (perMinute > PER_MINUTE) {
            logger.warn('[ParseLimit] burst cap hit', { userId: subject, perMinute });
            res.setHeader('Retry-After', '60');
            return res.status(429).json({
                success: false,
                msg: 'That was a lot of pastes at once — give it a minute, or enter the details yourself.',
                retryAfterSeconds: 60,
            });
        }

        return next();
    } catch (error: any) {
        // Redis being down must not stop people sending money, and it must
        // not silently remove the cost ceiling either. Fail OPEN but say so
        // at error level, because this is the window in which the bill is
        // unprotected.
        logger.error('[ParseLimit] limiter failed — ALLOWING the request, cost ceiling is off', {
            userId: subject,
            error: error?.message,
        });
        return next();
    }
}