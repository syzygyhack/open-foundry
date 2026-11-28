/**
 * REST error handling.
 *
 * Unified error model (Section 8.8) adapted for REST responses.
 * Maps error categories to HTTP status codes and produces the
 * standard error envelope described in the spec.
 */

import type { ErrorCategory, ErrorCode } from '@openfoundry/spi';
import type { RestResponse } from './types.js';
import { toClientError } from '../client-error.js';

interface RestErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}

/**
 * Map error category to HTTP status code.
 * Mirrors the GraphQL error categories but uses standard HTTP semantics.
 */
export function mapErrorToHttpStatus(category: ErrorCategory): number {
  const mapping: Record<string, number> = {
    validation: 400,
    authorization: 403,
    consent: 403,
    not_found: 404,
    conflict: 409,
    rate_limit: 429,
    quota: 429,
    timeout: 504,
    system: 500,
  };
  return mapping[category] ?? 500;
}

/**
 * Create a REST error response with the unified error envelope.
 *
 * Response body format matches Section 8.8:
 * {
 *   "error": {
 *     "code": "CONSENT_DENIED",
 *     "category": "consent",
 *     "message": "...",
 *     "retryable": false,
 *     "details": { ... },
 *     "traceId": "...",
 *     "timestamp": "..."
 *   }
 * }
 */
export function createRestErrorResponse(opts: RestErrorOptions): RestResponse {
  const status = mapErrorToHttpStatus(opts.category);

  return {
    status,
    body: {
      error: {
        code: opts.code,
        category: opts.category,
        message: opts.message,
        retryable: opts.retryable,
        details: opts.details ?? {},
        traceId: opts.traceId,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

/**
 * Convert an unknown error into a REST error response. Only a platform
 * error keeps its code and message (see toClientError); anything else is
 * INTERNAL_ERROR.
 */
export function wrapErrorToRest(err: unknown, traceId?: string): RestResponse {
  return createRestErrorResponse({ ...toClientError(err), traceId });
}
