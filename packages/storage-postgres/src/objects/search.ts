/**
 * Full-text search query builder for PostgreSQL.
 *
 * Uses ILIKE for case-insensitive matching across string-type columns.
 * Scores each row by summing matches across searchable fields.
 */

import type { Pool } from 'pg';
import type {
  RequestContext,
  SearchQuery,
  SearchResult,
  SearchHit,
  OntologyObject,
} from '@openfoundry/spi';
import { OpenFoundryError } from '@openfoundry/spi';
import { snakeCase, pgIdent, pgIdentName, fieldCol, fieldColName, physicalName } from '../schema/type-mapping.js';
import { filterToSql } from './filter-to-sql.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';

/** Build a qualified table name. */
function tableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
}

/**
 * Map a snake_case database row to an OntologyObject with camelCase fields.
 * System fields (_id, _type, etc.) are mapped explicitly to preserve their
 * underscore-prefixed names — generic camelCase conversion would produce
 * wrong keys (e.g., _id → Id).
 */
function rowToObject(row: Record<string, unknown>): OntologyObject {
  const obj: OntologyObject = {
    _tenantId: row['_tenant_id'] as string,
    _type: row['_type'] as string,
    _id: row['_id'] as string,
    _version: row['_version'] as number,
    _createdAt: row['_created_at'] instanceof Date
      ? row['_created_at'].toISOString()
      : String(row['_created_at'] ?? ''),
    _updatedAt: row['_updated_at'] instanceof Date
      ? row['_updated_at'].toISOString()
      : String(row['_updated_at'] ?? ''),
  };

  if (row['_deleted_at'] != null) {
    obj._deletedAt = row['_deleted_at'] instanceof Date
      ? row['_deleted_at'].toISOString()
      : String(row['_deleted_at']);
  }

  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_version',
    '_created_at', '_updated_at', '_deleted_at',
    '_search_score', '_total_count',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[camelKey] = value;
    }
  }

  return obj;
}

interface ColumnInfo {
  /** pg_type.typcategory of the column's type (of the base type, for a domain). */
  category: string;
  /** Whether that type converts to text implicitly (pg_cast). */
  toText: boolean;
}

/**
 * Whether ILIKE can match the column: a string-category type (text, varchar,
 * char(n), name, citext, a domain over one) or one that converts to text
 * implicitly ("char"). Numbers, dates, JSONB, arrays and enums do not.
 */
function isIlikeColumn(c: ColumnInfo): boolean {
  return c.category === 'S' || c.toText;
}

/** Quote a catalog column name. */
function quoteCol(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The identifier a named field has always been looked up as (fieldCol). */
const legacyName = (field: string): string => fieldColName(field);
/** The identifier the DDL writes for a declared property (pgIdent(snakeCase)). */
const ownName = (field: string): string => pgIdentName(snakeCase(field));

/**
 * The column a named search field is. First the mapping searches have always
 * used (fieldColName): `_id`, `_type`, `_tenantId`, `family_name`, a column
 * the schema no longer declares. Only when that names no column, a declared
 * property's own column as the DDL made it (pgIdent(snakeCase(name)); a
 * declared `_label` is column "label"). In that order a name never reaches a
 * different column than it did before: a declared `_id` is still the system
 * column, as the redaction check (which treats `_id` as the primary field)
 * assumes. Undefined when the declared column is ambiguous (reported as no
 * such field).
 *
 * `stored` maps each identifier to the name PostgreSQL stores for it, as the
 * server cut it (to 63 bytes in the database's encoding, which a client-side
 * UTF-8 cut gets wrong on a LATIN1 database).
 */
function columnOf(
  field: string,
  declared: ReadonlySet<string>,
  columns: ReadonlyMap<string, ColumnInfo>,
  stored: ReadonlyMap<string, string>,
): string | undefined {
  const legacy = stored.get(legacyName(field))!;
  if (columns.has(legacy) || !declared.has(field)) return legacy;
  const own = stored.get(ownName(field))!;
  // Not a column another declared property also maps to (`label` and
  // `_label` both make "label"): the visibility check of one name would
  // then cover a column holding the other's values.
  for (const other of declared) {
    if (other !== field && stored.get(ownName(other)) === own) return undefined;
  }
  return own;
}

/**
 * Execute a search query against the object table.
 *
 * Named fields (query.fields) are resolved to the table's columns as the
 * catalog has them. A name with no column, or whose column is not a text
 * column ILIKE can match (an INTEGER, a DATE, JSONB, ...), is
 * VALIDATION_ERROR naming the fields: it failed the whole query with a
 * database error before. With no fields named, the table's text columns are
 * searched, as before.
 *
 * @param declared the declared property names of the type, when a schema is
 *   applied (used to find a declared property's column).
 */
export async function searchObjects(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  query: SearchQuery,
  schema = 'public',
  tx?: PgTransaction,
  declared: readonly string[] = [],
): Promise<SearchResult> {
  const q = resolveQueryable(pool, tx);
  const table = tableName(type, schema);

  const params: unknown[] = [ctx.tenantId];
  const whereClauses = [`"_tenant_id" = $1`, `"_deleted_at" IS NULL`];

  // Guard against empty search queries (ILIKE '%%' matches all rows)
  if (!query.query || query.query.trim().length === 0) {
    return { hits: [], totalCount: 0, hasNextPage: false };
  }

  // Build ILIKE matching for search fields.
  // Escape LIKE wildcards (% and _) in the user query so they match literally.
  const escapedQuery = query.query.replace(/[%_\\]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;
  params.push(searchPattern);
  const patternIdx = params.length;

  // SQL column expressions to match.
  let searchCols: string[];
  if (query.fields !== undefined && query.fields !== null) {
    // An explicit list, even an empty one (a caller allowed to search no
    // field): only those fields, as on the memory provider. Resolved against
    // the table's columns as the catalog has them (see physicalName).
    // Each column's type followed through domains (a domain over a domain
    // over "char" converts to text as "char" does), to its base type.
    const colResult = await q.query(
      `WITH RECURSIVE base(column_name, typid, depth) AS (
         SELECT a.attname, a.atttypid, 0
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         UNION ALL
         SELECT b.column_name, t.typbasetype, b.depth + 1
           FROM base b JOIN pg_type t ON t.oid = b.typid
          WHERE t.typtype = 'd'
       )
       SELECT DISTINCT ON (b.column_name) b.column_name, t.typcategory AS category,
              EXISTS (SELECT 1 FROM pg_cast pc
                       WHERE pc.castsource = b.typid
                         AND pc.casttarget = 'text'::regtype AND pc.castcontext = 'i') AS to_text
         FROM base b JOIN pg_type t ON t.oid = b.typid
        ORDER BY b.column_name, b.depth DESC`,
      [physicalName(schema), physicalName(snakeCase(type))],
    );
    const columns = new Map<string, ColumnInfo>(
      (colResult.rows as Array<{ column_name: string; category: string; to_text: boolean }>).map((r) => [
        r.column_name,
        { category: r.category, toText: r.to_text },
      ]),
    );
    const declaredSet = new Set(declared);
    // Each identifier as PostgreSQL stores it: casting text to name cuts it
    // as the server cuts an identifier, in the database's encoding.
    const identifiers = [...new Set([...query.fields.map(legacyName), ...query.fields.map(ownName), ...declared.map(ownName)])];
    const storedResult = await q.query(
      `SELECT u.ident AS ident, u.ident::name::text AS stored FROM unnest($1::text[]) AS u(ident)`,
      [identifiers],
    );
    const stored = new Map<string, string>(
      (storedResult.rows as Array<{ ident: string; stored: string }>).map((r) => [r.ident, r.stored]),
    );
    const unknown: string[] = [];
    const notText: string[] = [];
    const resolved: string[] = [];
    for (const field of query.fields) {
      const col = columnOf(field, declaredSet, columns, stored);
      const info = col === undefined ? undefined : columns.get(col);
      if (!info || col === undefined) unknown.push(field);
      else if (!isIlikeColumn(info)) notText.push(field);
      else resolved.push(col);
    }
    if (columns.size === 0) {
      // No such table: let the query report it, as before.
      searchCols = query.fields.map((f) => fieldCol(f));
    } else if (unknown.length > 0 || notText.length > 0) {
      const parts = [
        ...unknown.map((f) => `${f} (no such field)`),
        ...notText.map((f) => `${f} (not a text field)`),
      ];
      throw new OpenFoundryError({
        code: 'VALIDATION_ERROR',
        category: 'validation',
        message: `Cannot search ${type} on: ${parts.join(', ')}`,
        details: { unknownFields: unknown, nonTextFields: notText },
      });
    } else {
      searchCols = resolved.map(quoteCol);
    }
  } else {
    // No list: the table's non-system text columns, found and named as they
    // always have been (each catalog name camelCased, then mapped back).
    const colResult = await q.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       AND data_type IN ('text', 'character varying')
       AND column_name NOT LIKE '\\_%' ESCAPE '\\'`,
      [physicalName(schema), physicalName(snakeCase(type))],
    );
    searchCols = (colResult.rows as Array<{ column_name: string }>)
      .map((r) => r.column_name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
      .map((field) => fieldCol(field));
  }

  if (searchCols.length === 0) {
    return { hits: [], totalCount: 0, hasNextPage: false };
  }

  // Build ILIKE OR clause and score expression
  const ilikeParts: string[] = [];
  const scoreParts: string[] = [];
  for (const col of searchCols) {
    ilikeParts.push(`${col} ILIKE $${patternIdx} ESCAPE '\\'`);
    scoreParts.push(`CASE WHEN ${col} ILIKE $${patternIdx} ESCAPE '\\' THEN 1 ELSE 0 END`);
  }

  whereClauses.push(`(${ilikeParts.join(' OR ')})`);

  // Apply additional filter
  if (query.filter) {
    const filterFragment = filterToSql(query.filter, params.length + 1);
    if (filterFragment.text !== 'TRUE') {
      whereClauses.push(filterFragment.text);
    }
    params.push(...filterFragment.params);
  }

  const whereClause = whereClauses.join(' AND ');
  const scoreExpr = scoreParts.join(' + ');

  // Save params for a potential count-only fallback query (before LIMIT/OFFSET are pushed)
  const countParams = [...params];

  // Build pagination
  let paginationClause = '';
  if (query.limit !== undefined) {
    params.push(query.limit);
    paginationClause += ` LIMIT $${params.length}`;
  }
  if (query.offset !== undefined) {
    params.push(query.offset);
    paginationClause += ` OFFSET $${params.length}`;
  }

  const sql = `SELECT *, (${scoreExpr}) AS _search_score, COUNT(*) OVER() AS _total_count
    FROM ${table}
    WHERE ${whereClause}
    ORDER BY _search_score DESC${paginationClause}`;

  const result = await q.query(sql, params);
  const rows = result.rows as Record<string, unknown>[];

  // COUNT(*) OVER() is only present in returned rows. When offset is past
  // all results, rows is empty and we lose the count. Fall back to a
  // separate count query in that case.
  let totalCount: number;
  if (rows.length > 0) {
    totalCount = Number((rows[0] as Record<string, unknown>)['_total_count']);
  } else if ((query.offset ?? 0) > 0 || query.limit === 0) {
    // No rows to carry COUNT(*) OVER(): past the end, or a page of none.
    const countSql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${whereClause}`;
    const countResult = await q.query(countSql, countParams);
    totalCount = Number((countResult.rows[0] as Record<string, unknown>)['cnt']);
  } else {
    totalCount = 0;
  }
  const offset = query.offset ?? 0;
  const limit = query.limit ?? totalCount;

  const hits: SearchHit[] = rows.map((row) => {
    const score = Number(row['_search_score']);
    const obj = rowToObject(row);
    return { object: obj, score };
  });

  return {
    hits,
    totalCount,
    hasNextPage: offset + limit < totalCount,
  };
}
