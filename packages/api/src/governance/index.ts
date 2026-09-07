/**
 * API governance module (Section 8.7).
 *
 * Provides rate limiting, query complexity analysis,
 * execution timeouts, and response size caps.
 */

export {
  SlidingWindowRateLimiter,
  type RateLimiter,
  type RateLimitConfig,
  type RateLimitWindow,
  type RateLimitIdentity,
  type RateLimitResult,
} from './rate-limiter.js';
export { RedisRateLimiter, monitorRedisRateLimiterConnection, type RedisRateLimiterConfig } from './redis-rate-limiter.js';

export {
  QueryComplexityAnalyzer,
  type ComplexityConfig,
  type ComplexityAnalysis,
} from './query-complexity.js';

export {
  withTimeout,
  checkResponseSize,
  createTimeoutError,
  createResponseTooLargeError,
  DEFAULT_EXECUTION_GUARD_CONFIG,
  type ExecutionGuardConfig,
} from './execution-guard.js';
