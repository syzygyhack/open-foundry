/**
 * What a client is told about a thrown error, for REST and GraphQL alike.
 *
 * Only a platform error passes its code, message and details on: a value
 * that is a PlatformError (isPlatformError: a code, one of the platform's
 * categories, a message and a retryable flag; OpenFoundryError,
 * SchemaGuardError and the engine's structured errors), or an Error whose
 * code is one of the platform's well-known codes (the ErrorCode list; kept
 * for first-party code that sets only `code`). Anything else -- a PostgreSQL
 * error with its SQLSTATE, a Node error (ERR_INVALID_URL, ECONNREFUSED), an
 * SDK or driver error -- is INTERNAL_ERROR with a generic message: its code
 * and text describe the server, not the request.
 *
 * System and timeout errors never carry their own message or details.
 */

import type { ErrorCategory, ErrorCode } from '@openfoundry/spi';
import { isPlatformError } from '@openfoundry/spi';

export interface ClientError {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export const INTERNAL_MESSAGE = 'An internal error occurred';

/** The well-known codes and their categories (spec section 8.8). */
const WELL_KNOWN: ReadonlyMap<string, ErrorCategory> = new Map<string, ErrorCategory>([
  ['VALIDATION_ERROR', 'validation'],
  ['INVALID_FILTER', 'validation'],
  ['SCHEMA_VIOLATION', 'validation'],
  ['UNAUTHORIZED', 'authorization'],
  ['FORBIDDEN', 'authorization'],
  ['CONSENT_DENIED', 'consent'],
  ['CONSENT_UNKNOWN', 'consent'],
  ['VERSION_CONFLICT', 'conflict'],
  ['OPTIMISTIC_LOCK_FAILED', 'conflict'],
  ['RATE_LIMITED', 'rate_limit'],
  ['QUOTA_EXCEEDED', 'quota'],
  ['OBJECT_NOT_FOUND', 'not_found'],
  ['LINK_NOT_FOUND', 'not_found'],
  ['TYPE_NOT_FOUND', 'not_found'],
  ['INTERNAL_ERROR', 'system'],
  ['PROVIDER_ERROR', 'system'],
  ['OPERATION_TIMEOUT', 'timeout'],
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function wellKnownCode(err: Error): string | undefined {
  const code: unknown = (err as unknown as { code?: unknown }).code;
  return typeof code === 'string' && WELL_KNOWN.has(code) ? code : undefined;
}

export function toClientError(err: unknown): ClientError {
  let out: ClientError;
  if (isPlatformError(err)) {
    out = {
      code: err.code,
      category: err.category,
      message: err.message,
      retryable: err.retryable,
      ...(isRecord(err.details) ? { details: err.details } : {}),
    };
  } else if (err instanceof Error && wellKnownCode(err) !== undefined) {
    const code = wellKnownCode(err)!;
    const category = WELL_KNOWN.get(code)!;
    out = { code, category, message: err.message, retryable: category === 'system' || category === 'timeout' };
  } else {
    return { code: 'INTERNAL_ERROR', category: 'system', message: INTERNAL_MESSAGE, retryable: true };
  }
  if (out.category === 'system' || out.category === 'timeout') {
    return { code: out.code, category: out.category, message: INTERNAL_MESSAGE, retryable: out.retryable };
  }
  return out;
}
