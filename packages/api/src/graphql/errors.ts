import { GraphQLError } from 'graphql';
import type { ErrorCategory, ErrorCode } from '@openfoundry/spi';
import { toClientError } from '../client-error.js';

/**
 * Unified error model (Section 8.8).
 * Maps platform errors to GraphQL errors with extensions.openfoundry.
 */

interface OpenFoundryErrorOptions {
  code: ErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}

/** The errors createOpenFoundryError built: the only ones wrapError passes as they are. */
const built = new WeakSet<GraphQLError>();

/**
 * Create a GraphQL error with Open Foundry extensions.
 */
export function createOpenFoundryError(opts: OpenFoundryErrorOptions): GraphQLError {
  const err = new GraphQLError(opts.message, {
    extensions: {
      // Mirrors openfoundry.code where GraphQL clients look first; without it
      // Apollo Server fills in INTERNAL_SERVER_ERROR, whatever the error was.
      code: opts.code,
      openfoundry: {
        code: opts.code,
        category: opts.category,
        retryable: opts.retryable,
        details: opts.details ?? {},
        traceId: opts.traceId,
        timestamp: new Date().toISOString(),
      },
    },
  });
  built.add(err);
  return err;
}

/**
 * Wrap an unknown error into a GraphQL-safe Open Foundry error.
 */
export function wrapError(err: unknown, traceId?: string): GraphQLError {
  // One the API built (createOpenFoundryError) passes as it is; any other
  // GraphQLError, say from a provider's own GraphQL client, is classified
  // like other errors, so its code and message do not reach the client,
  // whatever extensions it carries.
  if (err instanceof GraphQLError && built.has(err)) {
    return err;
  }

  // Only a platform error keeps its code and message (see toClientError).
  return createOpenFoundryError({ ...toClientError(err), traceId });
}
