/**
 * Redis-backed distributed rate limiter (Section 8.7).
 *
 * Uses sorted sets for sliding-window counters. Each dimension
 * (tenant, principal, clientApp) maps to a sorted set keyed by
 * `{prefix}:{dimension}:{id}`. Timestamps are scores; ZCARD counts
 * requests in the current window.
 *
 * Atomic via Lua script to prevent TOCTOU races across pods.
 *
 * Fails open: if Redis is unreachable, requests are allowed with a
 * console warning (rate limiting is QoS, not a security boundary).
 */

import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RateLimiter, RateLimitIdentity, RateLimitResult, RateLimitConfig, RateLimitWindow } from './rate-limiter.js';
import { logger } from '../logger.js';
import { rateLimiterFailOpenTotal, rateLimiterRedisUp } from '../metrics.js';

export interface RedisRateLimiterConfig {
  keyPrefix?: string;
  config?: Partial<RateLimitConfig>;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  tenant: { windowMs: 60_000, maxRequests: 1000 },
  principal: { windowMs: 60_000, maxRequests: 200 },
  clientApp: { windowMs: 60_000, maxRequests: 500 },
};

/**
 * Lua script for atomic sliding-window rate check.
 *
 * KEYS[1] = sorted set key
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = windowMs
 * ARGV[3] = maxRequests
 * ARGV[4] = member (unique request ID)
 *
 * Returns: count BEFORE adding if under limit (and adds the member),
 *          or count if over limit (does NOT add — denied requests don't consume quota).
 *          Second return value: 1 if added, 0 if denied.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maxReqs = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= maxReqs then
  redis.call('PEXPIRE', key, window)
  return {count, 0}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {count + 1, 1}
`;

/** Per-process unique prefix for Redis sorted-set members to avoid cross-pod collisions. */
const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
const REDIS_WARNING_INTERVAL_MS = 60_000;
let requestCounter = 0;

/** Track connection health and surface Redis failures even when no requests arrive. */
export function monitorRedisRateLimiterConnection(redis: Redis): void {
  let lastErrorLogAt = Number.NEGATIVE_INFINITY;

  rateLimiterRedisUp.set(0);
  redis.on('ready', () => {
    rateLimiterRedisUp.set(1);
    logger.info('Redis rate limiter connection ready');
  });
  redis.on('close', () => rateLimiterRedisUp.set(0));
  redis.on('end', () => rateLimiterRedisUp.set(0));
  redis.on('error', (err: Error) => {
    rateLimiterRedisUp.set(0);
    const now = Date.now();
    if (now - lastErrorLogAt >= REDIS_WARNING_INTERVAL_MS) {
      lastErrorLogAt = now;
      logger.warn({ err: err.message }, 'Redis rate limiter connection error');
    }
  });
}

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly config: RateLimitConfig;
  private lastFailOpenLogAt = Number.NEGATIVE_INFINITY;

  constructor(redis: Redis, opts?: RedisRateLimiterConfig) {
    this.redis = redis;
    this.keyPrefix = opts?.keyPrefix ?? 'rl:';
    this.config = { ...DEFAULT_CONFIG, ...opts?.config };
  }

  async check(identity: RateLimitIdentity): Promise<RateLimitResult> {
    const now = Date.now();
    const member = `${INSTANCE_ID}:${now}:${++requestCounter}`;

    const dimensions: Array<{
      key: string;
      dimension: 'tenant' | 'principal' | 'clientApp';
      window: RateLimitWindow;
    }> = [];

    if (this.config.tenant) {
      dimensions.push({
        key: `${this.keyPrefix}tenant:${identity.tenantId}`,
        dimension: 'tenant',
        window: this.config.tenant,
      });
    }
    if (this.config.principal) {
      dimensions.push({
        key: `${this.keyPrefix}principal:${identity.principalId}`,
        dimension: 'principal',
        window: this.config.principal,
      });
    }
    if (this.config.clientApp && identity.clientAppId) {
      dimensions.push({
        key: `${this.keyPrefix}clientApp:${identity.clientAppId}`,
        dimension: 'clientApp',
        window: this.config.clientApp,
      });
    }

    try {
      let minRemaining = Infinity;
      let earliestReset = now;
      let exceededDimension: 'tenant' | 'principal' | 'clientApp' | undefined;

      for (const { key, dimension, window: win } of dimensions) {
        const result = await this.redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          key,
          String(now),
          String(win.windowMs),
          String(win.maxRequests),
          member,
        ) as [number, number];

        const [count, added] = result;
        const remaining = Math.max(0, win.maxRequests - count);
        const resetAt = now + win.windowMs;

        if (remaining < minRemaining) {
          minRemaining = remaining;
          earliestReset = resetAt;
        }

        if (!added) {
          exceededDimension = dimension;
          break;
        }
      }

      if (exceededDimension) {
        return { allowed: false, exceededBy: exceededDimension, remaining: 0, resetAt: earliestReset };
      }

      return {
        allowed: true,
        remaining: minRemaining === Infinity ? 0 : minRemaining,
        resetAt: earliestReset,
      };
    } catch (err) {
      // Fail open: allow requests when Redis is unavailable
      rateLimiterFailOpenTotal.inc();
      if (now - this.lastFailOpenLogAt >= REDIS_WARNING_INTERVAL_MS) {
        this.lastFailOpenLogAt = now;
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'RedisRateLimiter Redis error, failing open');
      }
      return { allowed: true, remaining: 0, resetAt: now + 60_000 };
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
