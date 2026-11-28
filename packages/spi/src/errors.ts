/**
 * Unified error model (Section 8.8).
 */

import type { DateTime } from './scalars.js';

/** Error category determines HTTP status mapping and client handling. */
export type ErrorCategory =
  | 'validation'
  | 'authorization'
  | 'consent'
  | 'conflict'
  | 'rate_limit'
  | 'quota'
  | 'not_found'
  | 'system'
  | 'timeout';

/**
 * Well-known error codes used across the platform.
 * Not exhaustive -- providers may define additional codes within the
 * categories above.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_FILTER'
  | 'SCHEMA_VIOLATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONSENT_DENIED'
  | 'CONSENT_UNKNOWN'
  | 'VERSION_CONFLICT'
  | 'OPTIMISTIC_LOCK_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'OBJECT_NOT_FOUND'
  | 'LINK_NOT_FOUND'
  | 'TYPE_NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'PROVIDER_ERROR'
  | 'OPERATION_TIMEOUT'
  | (string & {}); // Allow extension codes while keeping autocomplete

/** Structured error returned by all platform operations. */
export interface PlatformError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
  timestamp?: DateTime;
}

/** Every ErrorCategory, for checking a value at run time. */
export const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  'validation', 'authorization', 'consent', 'conflict', 'rate_limit', 'quota', 'not_found', 'system', 'timeout',
];

const CATEGORY_SET: ReadonlySet<string> = new Set(ERROR_CATEGORIES);

/**
 * Whether a thrown value is a platform error: an object carrying the
 * PlatformError fields with valid types (a string code, one of the
 * ErrorCategory values, a string message, a boolean retryable). This is how
 * the API tells an error meant for the client from a database, runtime or
 * SDK error, whose code is not the client's business; a provider marks an
 * error, including one with its own extension code, by throwing a
 * PlatformError or an OpenFoundryError.
 */
export function isPlatformError(value: unknown): value is PlatformError {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['code'] === 'string' && v['code'] !== ''
    && typeof v['category'] === 'string' && CATEGORY_SET.has(v['category'])
    && typeof v['message'] === 'string'
    && typeof v['retryable'] === 'boolean';
}

/** An Error that is also a PlatformError, so it keeps a stack trace. */
export class OpenFoundryError extends Error implements PlatformError {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(opts: { code: ErrorCode; category: ErrorCategory; message: string; retryable?: boolean; details?: Record<string, unknown> }) {
    super(opts.message);
    this.name = 'OpenFoundryError';
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    if (opts.details) this.details = opts.details;
  }
}

