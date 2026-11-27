/**
 * Keyset cursors for getLinks (QueryOptions.after / LinkPage.cursor): the
 * position of a link in creation-time-then-ID order. The time is the
 * provider's own exact representation (Postgres: microseconds since the
 * epoch; memory: the ISO timestamp), so a cursor is only valid with the
 * provider that issued it.
 */

import { SchemaGuardError } from './schema-guards.js';

export interface LinkCursor {
  /** Creation time, in the issuing provider's representation. */
  t: string;
  id: string;
}

export function encodeLinkCursor(c: LinkCursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, id: c.id }), 'utf8').toString('base64url');
}

/** Decodes a cursor; a malformed one is VALIDATION_ERROR. */
export function decodeLinkCursor(cursor: string): LinkCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const c = parsed as Partial<LinkCursor> | undefined;
  if (!c || typeof c.t !== 'string' || typeof c.id !== 'string' || c.t === '' || c.id === '') {
    throw new SchemaGuardError('VALIDATION_ERROR', 'Malformed link cursor');
  }
  const out = { t: c.t, id: c.id };
  // Only the exact encoding this module produces (base64url decoding ignores
  // some trailing junk, and JSON allows other spellings of the same object).
  if (encodeLinkCursor(out) !== cursor) throw new SchemaGuardError('VALIDATION_ERROR', 'Malformed link cursor');
  return out;
}

/**
 * Throws VALIDATION_ERROR when a cursor and a non-zero offset are both given,
 * or the limit or offset is not a non-negative safe integer.
 */
export function assertCursorOrOffset(options: { after?: string; offset?: number; limit?: number } | undefined): void {
  for (const key of ['limit', 'offset'] as const) {
    const v = options?.[key];
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) {
      throw new SchemaGuardError('VALIDATION_ERROR', `getLinks ${key} must be a non-negative safe integer`);
    }
  }
  if (options?.after !== undefined && (options.offset ?? 0) !== 0) {
    throw new SchemaGuardError('VALIDATION_ERROR', 'getLinks takes a cursor (after) or a non-zero offset, not both');
  }
}
