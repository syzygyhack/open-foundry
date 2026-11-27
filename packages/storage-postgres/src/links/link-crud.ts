/**
 * Link CRUD operations for PostgreSQL + Apache AGE.
 *
 * Every operation:
 * - Enforces tenant isolation via _tenant_id
 * - Enforces cardinality constraints (counting active links of same type)
 * - Enforces referential integrity (from/to objects must exist and not be soft-deleted)
 * - Maintains an AGE graph edge for graph traversal
 * - Accepts an optional PgTransaction for transactional batching
 */

import type { Pool } from 'pg';
import type {
  OntologyLink,
  RequestContext,
  QueryOptions,
  LinkPage,
  DateTime,
  LinkTypeDefinition,
} from '@openfoundry/spi';

import { snakeCase, pgIdent } from '../schema/type-mapping.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';
import { ageQuery } from '../graph/age-query.js';
import type { Queryable } from '../transactions/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Sanitize a value for inclusion in an AGE Cypher string literal.
 * Apache AGE does not support parameterized Cypher queries.
 */
function sanitizeCypherValue(value: string, context: string): string {
  if (/['"`\\${}]/.test(value)) {
    throw new Error(`Invalid ${context}: contains disallowed characters`);
  }
  return value;
}

function sanitizeCypherLabel(label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
    throw new Error(`Invalid Cypher label: ${label}`);
  }
  return label;
}

let _counter = 0;
function genId(): string {
  return `lk_${Date.now().toString(36)}_${(++_counter).toString(36)}`;
}

function now(): DateTime {
  return new Date().toISOString() as DateTime;
}

/**
 * Map a snake_case database row to an OntologyLink with camelCase
 * system fields. Non-system columns are mapped back to camelCase property
 * names.
 */
function rowToLink(row: Record<string, unknown>): OntologyLink {
  const link: OntologyLink = {
    _tenantId: row['_tenant_id'] as string,
    _type: row['_type'] as string,
    _id: row['_id'] as string,
    _fromType: row['_from_type'] as string,
    _fromId: row['_from_id'] as string,
    _toType: row['_to_type'] as string,
    _toId: row['_to_id'] as string,
    _version: row['_version'] as number,
    _createdAt: (row['_created_at'] as Date).toISOString() as DateTime,
    _updatedAt: (row['_updated_at'] as Date).toISOString() as DateTime,
  };

  if (row['_deleted_at'] != null) {
    link._deletedAt = (row['_deleted_at'] as Date).toISOString() as DateTime;
  }

  // Map remaining columns (user-defined link properties)
  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_from_type', '_from_id',
    '_to_type', '_to_id', '_version', '_created_at', '_updated_at', '_deleted_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      link[camelKey] = value;
    }
  }

  return link;
}

/** Build a qualified link table name. */
function linkTableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
}


// ---------------------------------------------------------------------------
// Cardinality enforcement
// ---------------------------------------------------------------------------

/**
 * Check cardinality constraints for a link type.
 *
 * - ONE_TO_ONE: max 1 active link from source, max 1 active link to target
 * - ONE_TO_MANY: max 1 active link to target (many from source OK)
 * - MANY_TO_ONE: max 1 active link from source (many to target OK)
 * - MANY_TO_MANY: no constraints
 *
 * Only active (non-deleted) links count toward cardinality.
 */
async function enforceCardinality(
  q: Queryable,
  tenantId: string,
  linkType: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  cardinality: LinkTypeDefinition['cardinality'],
  schema: string,
): Promise<void> {
  const table = linkTableName(linkType, schema);

  if (cardinality === 'ONE_TO_ONE') {
    // Check: no active link from this source of this type
    const fromCount = await q.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE "_tenant_id" = $1 AND "_from_type" = $2 AND "_from_id" = $3 AND "_deleted_at" IS NULL`,
      [tenantId, fromType, fromId],
    );
    if (parseInt(String((fromCount.rows[0] as Record<string, unknown>)['cnt']), 10) > 0) {
      throw new Error(`Cardinality violation: ONE_TO_ONE link ${linkType} already exists from ${fromType}:${fromId}`);
    }

    // Check: no active link to this target of this type
    const toCount = await q.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE "_tenant_id" = $1 AND "_to_type" = $2 AND "_to_id" = $3 AND "_deleted_at" IS NULL`,
      [tenantId, toType, toId],
    );
    if (parseInt(String((toCount.rows[0] as Record<string, unknown>)['cnt']), 10) > 0) {
      throw new Error(`Cardinality violation: ONE_TO_ONE link ${linkType} already exists to ${toType}:${toId}`);
    }
  } else if (cardinality === 'ONE_TO_MANY') {
    // Check: no active link to this target of this type (each target has at most one inbound)
    const toCount = await q.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE "_tenant_id" = $1 AND "_to_type" = $2 AND "_to_id" = $3 AND "_deleted_at" IS NULL`,
      [tenantId, toType, toId],
    );
    if (parseInt(String((toCount.rows[0] as Record<string, unknown>)['cnt']), 10) > 0) {
      throw new Error(`Cardinality violation: ONE_TO_MANY link ${linkType} already exists to ${toType}:${toId}`);
    }
  } else if (cardinality === 'MANY_TO_ONE') {
    // Check: no active link from this source of this type (each source has at most one outbound)
    const fromCount = await q.query(
      `SELECT COUNT(*) AS cnt FROM ${table} WHERE "_tenant_id" = $1 AND "_from_type" = $2 AND "_from_id" = $3 AND "_deleted_at" IS NULL`,
      [tenantId, fromType, fromId],
    );
    if (parseInt(String((fromCount.rows[0] as Record<string, unknown>)['cnt']), 10) > 0) {
      throw new Error(`Cardinality violation: MANY_TO_ONE link ${linkType} already exists from ${fromType}:${fromId}`);
    }
  }
  // MANY_TO_MANY: no cardinality check needed
}

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

/**
 * Verify that both endpoints of a link exist and are not soft-deleted.
 */
async function enforceReferentialIntegrity(
  q: Queryable,
  tenantId: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  schema: string,
): Promise<void> {
  const fromTable = `${pgIdent(schema)}.${pgIdent(snakeCase(fromType))}`;
  const toTable = `${pgIdent(schema)}.${pgIdent(snakeCase(toType))}`;

  const fromResult = await q.query(
    `SELECT "_id", "_deleted_at" FROM ${fromTable} WHERE "_tenant_id" = $1 AND "_id" = $2`,
    [tenantId, fromId],
  );
  if (fromResult.rows.length === 0) {
    throw new Error(`Referential integrity: source object ${fromType}:${fromId} does not exist`);
  }
  if ((fromResult.rows[0] as Record<string, unknown>)['_deleted_at'] != null) {
    throw new Error(`Referential integrity: source object ${fromType}:${fromId} is soft-deleted`);
  }

  const toResult = await q.query(
    `SELECT "_id", "_deleted_at" FROM ${toTable} WHERE "_tenant_id" = $1 AND "_id" = $2`,
    [tenantId, toId],
  );
  if (toResult.rows.length === 0) {
    throw new Error(`Referential integrity: target object ${toType}:${toId} does not exist`);
  }
  if ((toResult.rows[0] as Record<string, unknown>)['_deleted_at'] != null) {
    throw new Error(`Referential integrity: target object ${toType}:${toId} is soft-deleted`);
  }
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Create a new link between two ontology objects.
 *
 * 1. Enforce referential integrity (from/to must exist, not soft-deleted)
 * 2. Enforce cardinality constraints
 * 3. INSERT into link table
 * 4. CREATE edge in AGE graph
 */
export async function createLink(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  properties?: Record<string, unknown>,
  cardinality: LinkTypeDefinition['cardinality'] = 'MANY_TO_MANY',
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyLink> {
  const q = resolveQueryable(pool, tx);
  // Honour engine-provided ID (UUIDv7) per SPI contract, fall back to genId
  const engineId = properties?._engineLinkId;
  const id = typeof engineId === 'string' ? engineId : genId();
  const timestamp = now();

  // Referential integrity
  await enforceReferentialIntegrity(q, ctx.tenantId, fromType, fromId, toType, toId, schema);

  // Cardinality enforcement
  await enforceCardinality(q, ctx.tenantId, type, fromType, fromId, toType, toId, cardinality, schema);

  // Build column names and values
  const systemCols = [
    '"_tenant_id"', '"_id"', '"_type"', '"_from_type"', '"_from_id"',
    '"_to_type"', '"_to_id"', '"_version"', '"_created_at"', '"_updated_at"',
  ];
  const systemVals: unknown[] = [
    ctx.tenantId, id, type, fromType, fromId, toType, toId, 1, timestamp, timestamp,
  ];

  // Strip _engineLinkId from user-facing properties before persisting.
  // Auto-populate 'id' property (ODL @primary on link types) if not provided.
  const { _engineLinkId: _, ...userProps } = properties ?? {};
  if (!('id' in userProps)) {
    userProps['id'] = id;
  }
  const propEntries = Object.entries(userProps);
  const propCols = propEntries.map(([k]) => pgIdent(snakeCase(k)));
  const propVals = propEntries.map(([, v]) => v);

  const allCols = [...systemCols, ...propCols];
  const allVals = [...systemVals, ...propVals];
  const placeholders = allVals.map((_, i) => `$${i + 1}`);

  const table = linkTableName(type, schema);
  const insertSql = `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;

  const result = await q.query(insertSql, allVals);
  const row = result.rows[0] as Record<string, unknown>;
  const link = rowToLink(row);

  // Create AGE edge (sanitize all interpolated values)
  const safeFromType = sanitizeCypherLabel(fromType);
  const safeToType = sanitizeCypherLabel(toType);
  const safeLinkType = sanitizeCypherLabel(type);
  const safeTenant = sanitizeCypherValue(ctx.tenantId, 'tenantId');
  const safeFromId = sanitizeCypherValue(fromId, 'fromId');
  const safeToId = sanitizeCypherValue(toId, 'toId');
  const safeLinkId = sanitizeCypherValue(id, 'linkId');
  await ageQuery(
    q,
    `MATCH (a:${safeFromType} {tenant_id: '${safeTenant}', id: '${safeFromId}'}), (b:${safeToType} {tenant_id: '${safeTenant}', id: '${safeToId}'}) CREATE (a)-[:${safeLinkType} {tenant_id: '${safeTenant}', id: '${safeLinkId}'}]->(b)`,
  );

  return link;
}

/**
 * Get a link by type and id. Returns null if not found.
 */
export async function getLink(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  linkId: string,
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyLink | null> {
  const q = resolveQueryable(pool, tx);
  const table = linkTableName(type, schema);
  const sql = `SELECT * FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2`;
  const result = await q.query(sql, [ctx.tenantId, linkId]);

  if (result.rows.length === 0) return null;
  return rowToLink(result.rows[0] as Record<string, unknown>);
}

/**
 * Update a link's properties. Increments _version.
 */
export async function updateLink(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  linkId: string,
  properties: Record<string, unknown>,
  schema = 'public',
  tx?: PgTransaction,
  expectedVersion?: number,
): Promise<OntologyLink> {
  const q = resolveQueryable(pool, tx);
  const table = linkTableName(type, schema);
  const timestamp = now();

  const propEntries = Object.entries(properties);
  const setClauses: string[] = [
    `"_version" = "_version" + 1`,
    `"_updated_at" = $1`,
  ];
  const params: unknown[] = [timestamp];
  let paramIdx = 2;

  for (const [key, value] of propEntries) {
    setClauses.push(`${pgIdent(snakeCase(key))} = $${paramIdx}`);
    params.push(value);
    paramIdx++;
  }

  params.push(ctx.tenantId);
  const tenantParam = paramIdx++;
  params.push(linkId);
  const idParam = paramIdx++;

  let whereClause = `"_tenant_id" = $${tenantParam} AND "_id" = $${idParam} AND "_deleted_at" IS NULL`;
  if (expectedVersion !== undefined) {
    params.push(expectedVersion);
    whereClause += ` AND "_version" = $${paramIdx}`;
  }

  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClause} RETURNING *`;

  const result = await q.query(sql, params);
  if (result.rows.length === 0) {
    if (expectedVersion !== undefined) {
      // Follow-up SELECT to distinguish not-found vs version-mismatch
      const check = await q.query(
        `SELECT "_version" FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2 AND "_deleted_at" IS NULL`,
        [ctx.tenantId, linkId],
      );
      if (check.rows.length === 0) {
        const err = new Error(`Link ${type}:${linkId} not found or deleted`) as Error & { code: string };
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      const currentVersion = (check.rows[0] as Record<string, unknown>)['_version'];
      const err = new Error(`Link ${type}:${linkId} version mismatch (expected ${expectedVersion}, current ${currentVersion})`) as Error & { code: string };
      err.code = 'VERSION_CONFLICT';
      throw err;
    }
    throw new Error(`Link ${type}:${linkId} not found or is deleted`);
  }

  return rowToLink(result.rows[0] as Record<string, unknown>);
}

/**
 * Soft-delete a link. Sets _deleted_at, removes AGE edge.
 */
export async function deleteLink(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  linkId: string,
  schema = 'public',
  tx?: PgTransaction,
): Promise<void> {
  const q = resolveQueryable(pool, tx);
  const table = linkTableName(type, schema);
  const timestamp = now();

  const sql = `UPDATE ${table} SET "_deleted_at" = $1, "_updated_at" = $1, "_version" = "_version" + 1 WHERE "_tenant_id" = $2 AND "_id" = $3 AND "_deleted_at" IS NULL RETURNING *`;

  const result = await q.query(sql, [timestamp, ctx.tenantId, linkId]);
  if (result.rows.length === 0) {
    throw new Error(`Link ${type}:${linkId} not found or already deleted`);
  }

  // Remove AGE edge (sanitize all interpolated values)
  const safeDelType = sanitizeCypherLabel(type);
  const safeDelTenant = sanitizeCypherValue(ctx.tenantId, 'tenantId');
  const safeDelId = sanitizeCypherValue(linkId, 'linkId');
  await ageQuery(
    q,
    `MATCH ()-[e:${safeDelType} {tenant_id: '${safeDelTenant}', id: '${safeDelId}'}]->() DELETE e`,
  );
}

/**
 * Get links by objectId, linkType, and direction.
 * Excludes soft-deleted links by default.
 */
export async function getLinks(
  pool: Pool,
  ctx: RequestContext,
  objectId: string,
  linkType: string,
  direction: 'inbound' | 'outbound',
  options?: QueryOptions,
  schema = 'public',
  tx?: PgTransaction,
): Promise<LinkPage> {
  const q = resolveQueryable(pool, tx);
  const table = linkTableName(linkType, schema);

  const params: unknown[] = [ctx.tenantId, objectId];
  const whereClauses = [`"_tenant_id" = $1`];

  if (direction === 'outbound') {
    whereClauses.push(`"_from_id" = $2`);
  } else {
    whereClauses.push(`"_to_id" = $2`);
  }

  if (!options?.includeDeleted) {
    whereClauses.push(`"_deleted_at" IS NULL`);
  }

  const whereClause = whereClauses.join(' AND ');

  // Count
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${whereClause}`;
  const countResult = await q.query(countSql, params);
  const totalCount = parseInt(String((countResult.rows[0] as Record<string, unknown>)['cnt']), 10);

  // Pagination — PERF-02: enforce maximum limit to prevent DoS
  const MAX_LINK_QUERY_LIMIT = 1000;
  const limit = Math.min(options?.limit ?? 100, MAX_LINK_QUERY_LIMIT);
  const offset = options?.offset ?? 0;
  const paginationParams = [...params, limit, offset];
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const dataSql = `SELECT * FROM ${table} WHERE ${whereClause} ORDER BY "_created_at" ASC, "_id" ASC LIMIT ${limitParam} OFFSET ${offsetParam}`;
  const dataResult = await q.query(dataSql, paginationParams);

  const items = (dataResult.rows as Record<string, unknown>[]).map(
    (row) => rowToLink(row),
  );

  return {
    items,
    totalCount,
    hasNextPage: offset + limit < totalCount,
  };
}
