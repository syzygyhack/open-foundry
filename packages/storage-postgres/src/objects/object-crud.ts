/**
 * Object CRUD operations for PostgreSQL + Apache AGE.
 *
 * Every operation:
 * - Enforces tenant isolation via _tenant_id
 * - Maintains version history in the *_history table
 * - Maintains an AGE graph vertex for graph traversal
 * - Accepts an optional PgTransaction for transactional batching
 */

import type { Pool } from 'pg';
import type {
  OntologyObject,
  RequestContext,
  FilterExpression,
  QueryOptions,
  ObjectPage,
  DateTime,
} from '@openfoundry/spi';
import { snakeCase, pgIdent, fieldCol } from '../schema/type-mapping.js';

import { filterToSql } from './filter-to-sql.js';
import { PgTransaction, resolveQueryable, withTransaction } from '../transactions/index.js';
import { ageQuery } from '../graph/age-query.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Sanitize a value for inclusion in an AGE Cypher string literal.
 * Apache AGE does not support parameterized Cypher queries, so we must
 * validate and escape values before interpolation.
 *
 * Rejects any value containing characters that could break out of a
 * Cypher string literal or label context.
 */
function sanitizeCypherValue(value: string, context: string): string {
  // Reject values with characters that could enable injection:
  // single/double quotes, backslashes, backticks, dollar signs, braces
  if (/['"`\\${}]/.test(value)) {
    throw new Error(`Invalid ${context}: contains disallowed characters`);
  }
  // Labels must be valid identifiers (alphanumeric + underscore)
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
  return `pg_${Date.now().toString(36)}_${(++_counter).toString(36)}`;
}

function now(): DateTime {
  return new Date().toISOString() as DateTime;
}

/**
 * Map a snake_case database row to an OntologyObject with camelCase
 * system fields. Non-system columns are mapped back to camelCase property
 * names.
 */
function rowToObject(row: Record<string, unknown>): OntologyObject {
  const obj: OntologyObject = {
    _tenantId: row['_tenant_id'] as string,
    _type: row['_type'] as string,
    _id: row['_id'] as string,
    _version: row['_version'] as number,
    _createdAt: (row['_created_at'] as Date).toISOString() as DateTime,
    _updatedAt: (row['_updated_at'] as Date).toISOString() as DateTime,
  };

  if (row['_deleted_at'] != null) {
    obj._deletedAt = (row['_deleted_at'] as Date).toISOString() as DateTime;
  }

  // Map remaining columns (user-defined properties)
  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_version',
    '_created_at', '_updated_at', '_deleted_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      // Convert snake_case column back to camelCase property name
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[camelKey] = value;
    }
  }

  return obj;
}

/** Build a qualified table name. */
function tableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
}

/** Build the history table name. */
function historyTableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type) + '_history')}`;
}

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

/**
 * Create a new ontology object.
 *
 * 1. INSERT into type table
 * 2. INSERT snapshot into history table
 * 3. CREATE vertex in AGE graph
 */
export async function createObject(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  properties: Record<string, unknown>,
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyObject> {
  // The row, its history snapshot and its graph mirror in one transaction
  // (the caller's, or its own): a hard delete waiting on the row lock then
  // sees the history row, instead of one landing after it.
  return withTransaction(pool, tx, async (q) => {
    const id = genId();
    const timestamp = now();

    // Build column names and values for user properties
    const propEntries = Object.entries(properties);
    const systemCols = ['"_tenant_id"', '"_id"', '"_type"', '"_version"', '"_created_at"', '"_updated_at"'];
    const systemVals = [ctx.tenantId, id, type, 1, timestamp, timestamp];

    const propCols = propEntries.map(([k]) => pgIdent(snakeCase(k)));
    // Serialize objects/arrays as JSON strings for JSONB columns —
    // the pg driver does not auto-serialize non-primitive values.
    // Dates must pass through for TIMESTAMPTZ columns.
    const propVals = propEntries.map(([, v]) =>
      v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
    );

    const allCols = [...systemCols, ...propCols];
    const allVals = [...systemVals, ...propVals];
    const placeholders = allVals.map((_, i) => `$${i + 1}`);

    const table = tableName(type, schema);
    const insertSql = `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;

    const result = await q.query(insertSql, allVals);
    const row = result.rows[0] as Record<string, unknown>;
    const obj = rowToObject(row);

    // Insert history snapshot
    await insertHistory(q, type, row, schema);

    // Create AGE vertex
    await createAgeVertex(q, type, ctx.tenantId, id);

    return obj;
  });
}

/**
 * Get an object by type and id. Returns null if not found.
 * Includes _deletedAt if soft-deleted (caller decides visibility).
 */
export async function getObject(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  schema = 'public',
  tx?: PgTransaction,
): Promise<OntologyObject | null> {
  const q = resolveQueryable(pool, tx);
  const table = tableName(type, schema);
  const sql = `SELECT * FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2`;
  const result = await q.query(sql, [ctx.tenantId, id]);

  if (result.rows.length === 0) return null;
  return rowToObject(result.rows[0] as Record<string, unknown>);
}

/**
 * Update an existing object's properties.
 *
 * 1. UPDATE type table, increment _version
 * 2. INSERT new snapshot into history table
 * 3. Update AGE vertex properties
 */
export async function updateObject(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  properties: Record<string, unknown>,
  schema = 'public',
  tx?: PgTransaction,
  expectedVersion?: number,
): Promise<OntologyObject> {
  // The row, its history snapshot and its graph mirror in one transaction
  // (the caller's, or its own): a hard delete waiting on the row lock then
  // sees the history row, instead of one landing after it.
  return withTransaction(pool, tx, async (q) => {
    const table = tableName(type, schema);
    const timestamp = now();

    // Build SET clause for user properties
    const propEntries = Object.entries(properties);
    const setClauses: string[] = [
      `"_version" = "_version" + 1`,
      `"_updated_at" = $1`,
    ];
    const params: unknown[] = [timestamp];
    let paramIdx = 2;

    for (const [key, value] of propEntries) {
      setClauses.push(`${pgIdent(snakeCase(key))} = $${paramIdx}`);
      // Serialize objects/arrays as JSON strings for JSONB columns
      params.push(value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value);
      paramIdx++;
    }

    // WHERE clause params
    params.push(ctx.tenantId); // $paramIdx
    const tenantParam = paramIdx++;
    params.push(id); // $paramIdx
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
          [ctx.tenantId, id],
        );
        if (check.rows.length === 0) {
          const err = new Error(`Object ${type}:${id} not found or deleted`) as Error & { code: string };
          err.code = 'VERSION_CONFLICT';
          throw err;
        }
        const currentVersion = (check.rows[0] as Record<string, unknown>)['_version'];
        const err = new Error(`Object ${type}:${id} version mismatch (expected ${expectedVersion}, current ${currentVersion})`) as Error & { code: string };
        err.code = 'VERSION_CONFLICT';
        throw err;
      }
      throw new Error(`Object ${type}:${id} not found or is deleted`);
    }

    const row = result.rows[0] as Record<string, unknown>;
    const obj = rowToObject(row);

    // Insert history snapshot
    await insertHistory(q, type, row, schema);

    // Update AGE vertex
    await updateAgeVertex(q, type, ctx.tenantId, id);

    return obj;
  });
}

/**
 * Soft-delete: SET _deleted_at = now(). Keeps AGE vertex (marks as deleted).
 */
export async function softDeleteObject(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  schema = 'public',
  tx?: PgTransaction,
): Promise<void> {
  // The row, its history snapshot and its graph mirror in one transaction
  // (the caller's, or its own): a hard delete waiting on the row lock then
  // sees the history row, instead of one landing after it.
  return withTransaction(pool, tx, async (q) => {
    const table = tableName(type, schema);
    const timestamp = now();

    const sql = `UPDATE ${table} SET "_deleted_at" = $1, "_version" = "_version" + 1, "_updated_at" = $1 WHERE "_tenant_id" = $2 AND "_id" = $3 AND "_deleted_at" IS NULL RETURNING *`;

    const result = await q.query(sql, [timestamp, ctx.tenantId, id]);
    if (result.rows.length === 0) {
      throw new Error(`Object ${type}:${id} not found or already deleted`);
    }

    // Insert history snapshot for the soft-delete event
    await insertHistory(q, type, result.rows[0] as Record<string, unknown>, schema);
  });
}

/**
 * Hard delete (spec §3.3 rule 6): the object, its history, every link from or
 * to it (live or soft-deleted, in every link table of the data schema), and its
 * AGE vertex with its edges, in one transaction (the caller's, or its own).
 *
 * The object row is locked first. createLink takes a share lock on both
 * endpoints for its whole transaction, so a link being created to this object
 * either commits before the delete proceeds (and is then removed with the
 * others: each statement here takes a fresh snapshot, at READ COMMITTED) or
 * waits and then finds the endpoint gone. In a caller's transaction above
 * READ COMMITTED the snapshot is older than the lock, so that is refused. Links are matched on
 * tenant, endpoint type and ID, in tables found by their system columns rather
 * than from the current schema, so links of link types an older schema
 * version declared, and links an earlier delete left behind, go too.
 */
export async function hardDeleteObject(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  id: string,
  schema = 'public',
  tx?: PgTransaction,
): Promise<void> {
  const table = tableName(type, schema);
  const historyTable = historyTableName(type, schema);

  if (tx) {
    // Above READ COMMITTED, the caller's snapshot can predate a link committed
    // while this waited for the object's row lock (createLink holds a share
    // lock on it until it commits), and the link would survive its endpoint.
    // Its own transaction (no tx) is always READ COMMITTED.
    const level = await tx.client.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
    const isolation = level.rows[0]?.transaction_isolation;
    if (isolation !== 'read committed') {
      throw Object.assign(
        new Error(
          `Hard delete of ${type}:${id} needs a READ COMMITTED transaction (this one is ${isolation}); ` +
            'run it outside the transaction or at READ COMMITTED',
        ),
        { code: 'VALIDATION_ERROR' },
      );
    }
  }

  await withTransaction(pool, tx, async (q) => {
    await q.query(`SELECT 1 FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2 FOR UPDATE`, [
      ctx.tenantId,
      id,
    ]);

    const linkTables = await q.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.relnamespace = to_regnamespace($1)
          AND c.relkind IN ('r', 'p')
          AND (SELECT count(*) FROM pg_attribute a
                WHERE a.attrelid = c.oid AND NOT a.attisdropped
                  AND a.attname IN ('_tenant_id', '_from_type', '_from_id', '_to_type', '_to_id')) = 5
        ORDER BY c.relname`,
      [pgIdent(schema)],
    );
    for (const { name } of linkTables.rows) {
      await q.query(
        `DELETE FROM ${pgIdent(schema)}."${name.replace(/"/g, '""')}"
          WHERE "_tenant_id" = $1
            AND (("_from_type" = $2 AND "_from_id" = $3) OR ("_to_type" = $2 AND "_to_id" = $3))`,
        [ctx.tenantId, type, id],
      );
    }

    // Delete from history table first (no FK, but logical ordering)
    await q.query(`DELETE FROM ${historyTable} WHERE "_tenant_id" = $1 AND "_id" = $2`, [ctx.tenantId, id]);

    // Delete from main table — idempotent (no-throw if missing, per SPI contract)
    const result = await q.query(`DELETE FROM ${table} WHERE "_tenant_id" = $1 AND "_id" = $2`, [ctx.tenantId, id]);

    // If object existed, also clean up AGE vertex (and all connected edges)
    if (result.rowCount && result.rowCount > 0) {
      await deleteAgeVertex(q, type, ctx.tenantId, id);
    }
  });
}

/**
 * Query objects with filter expression, pagination, and sorting.
 * Excludes soft-deleted objects by default.
 */
export async function queryObjects(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  filter: FilterExpression,
  options?: QueryOptions,
  schema = 'public',
  tx?: PgTransaction,
): Promise<ObjectPage> {
  const q = resolveQueryable(pool, tx);
  const table = tableName(type, schema);

  // Base params: tenant isolation
  const baseParams: unknown[] = [ctx.tenantId];
  const whereClauses = [`"_tenant_id" = $1`];

  // Soft-delete exclusion (default: exclude)
  if (!options?.includeDeleted) {
    whereClauses.push(`"_deleted_at" IS NULL`);
  }

  // User filter translation (offset by existing params)
  const filterFragment = filterToSql(filter, baseParams.length + 1);
  if (filterFragment.text !== 'TRUE') {
    whereClauses.push(filterFragment.text);
  }
  const allParams = [...baseParams, ...filterFragment.params];

  const whereClause = whereClauses.join(' AND ');

  // Count query for totalCount
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${whereClause}`;
  const countResult = await q.query(countSql, allParams);
  const totalCount = parseInt(String((countResult.rows[0] as Record<string, unknown>)['cnt']), 10);

  // Order by
  let orderClause = '';
  if (options?.orderBy && options.orderBy.length > 0) {
    const orderParts = options.orderBy.map(
      (o) => `${fieldCol(o.field)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`,
    );
    orderClause = ` ORDER BY ${orderParts.join(', ')}`;
  }

  // Pagination — PERF-01: enforce maximum limit to prevent DoS
  const MAX_QUERY_LIMIT = 1000;
  const limit = Math.min(options?.limit ?? 100, MAX_QUERY_LIMIT);
  const offset = options?.offset ?? 0;
  const paginationParams = [...allParams, limit, offset];
  const limitParam = `$${allParams.length + 1}`;
  const offsetParam = `$${allParams.length + 2}`;

  const dataSql = `SELECT * FROM ${table} WHERE ${whereClause}${orderClause} LIMIT ${limitParam} OFFSET ${offsetParam}`;
  const dataResult = await q.query(dataSql, paginationParams);

  const items = (dataResult.rows as Record<string, unknown>[]).map(
    (row) => rowToObject(row),
  );

  return {
    items,
    totalCount,
    hasNextPage: offset + limit < totalCount,
  };
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

async function insertHistory(
  q: Pool | import('pg').PoolClient,
  type: string,
  row: Record<string, unknown>,
  schema: string,
): Promise<void> {
  const table = historyTableName(type, schema);

  // Copy all columns except _history_id (auto-generated)
  const entries = Object.entries(row);
  const cols = entries.map(([k]) => `"${k}"`);
  // Serialize objects/arrays for JSONB columns (pg driver returns JSONB as JS objects)
  const vals = entries.map(([, v]) =>
    v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
  );
  const placeholders = vals.map((_, i) => `$${i + 1}`);

  await q.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
    vals,
  );
}

// ---------------------------------------------------------------------------
// Apache AGE graph helpers
// ---------------------------------------------------------------------------


async function createAgeVertex(
  q: Pool | import('pg').PoolClient,
  type: string,
  tenantId: string,
  id: string,
): Promise<void> {
  const safeType = sanitizeCypherLabel(type);
  const safeTenant = sanitizeCypherValue(tenantId, 'tenantId');
  const safeId = sanitizeCypherValue(id, 'id');
  await ageQuery(
    q,
    `CREATE (:${safeType} {tenant_id: '${safeTenant}', id: '${safeId}'})`,
  );
}

async function updateAgeVertex(
  q: Pool | import('pg').PoolClient,
  type: string,
  tenantId: string,
  id: string,
): Promise<void> {
  const safeType = sanitizeCypherLabel(type);
  const safeTenant = sanitizeCypherValue(tenantId, 'tenantId');
  const safeId = sanitizeCypherValue(id, 'id');
  await ageQuery(
    q,
    `MATCH (v:${safeType} {tenant_id: '${safeTenant}', id: '${safeId}'}) SET v.updated = true RETURN v`,
  );
}

async function deleteAgeVertex(
  q: Pool | import('pg').PoolClient,
  type: string,
  tenantId: string,
  id: string,
): Promise<void> {
  const safeType = sanitizeCypherLabel(type);
  const safeTenant = sanitizeCypherValue(tenantId, 'tenantId');
  const safeId = sanitizeCypherValue(id, 'id');
  await ageQuery(
    q,
    `MATCH (v:${safeType} {tenant_id: '${safeTenant}', id: '${safeId}'}) DETACH DELETE v`,
  );
}
