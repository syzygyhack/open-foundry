/**
 * Aggregation query builder for PostgreSQL.
 *
 * Builds and executes aggregate SQL queries (COUNT, SUM, AVG, MIN, MAX)
 * with optional GROUP BY, filtering, ordering, and pagination.
 */

import type { Pool } from 'pg';
import type {
  RequestContext,
  AggregateQuery,
  AggregateResult,
  AggregateGroup,
} from '@openfoundry/spi';
import { SchemaGuardError } from '@openfoundry/spi';
import { snakeCase, pgIdent, fieldCol } from '../schema/type-mapping.js';
import { filterToSql } from './filter-to-sql.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';

/** Build a qualified table name. */
function tableName(type: string, schema = 'public'): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
}

/** The name an aggregate's value is returned under (and sorted by). */
function aggregateOutputName(f: { field: string; fn: string; alias?: string }): string {
  return f.alias ?? `${f.fn}_${f.field}`;
}

/**
 * Execute an aggregation query against the object table.
 */
export async function aggregateObjects(
  pool: Pool,
  ctx: RequestContext,
  type: string,
  query: AggregateQuery,
  schema = 'public',
  tx?: PgTransaction,
): Promise<AggregateResult> {
  const q = resolveQueryable(pool, tx);
  const table = tableName(type, schema);

  if (!query.fields || query.fields.length === 0) {
    throw new Error('Aggregate query must specify at least one field');
  }

  // Output names must be distinct: rows are returned keyed by them, and an
  // orderBy names one.
  const seenOutputs = new Set<string>();
  for (const f of query.fields) {
    const name = aggregateOutputName(f);
    if (seenOutputs.has(name)) {
      throw new SchemaGuardError('VALIDATION_ERROR', `Aggregate output "${name}" is named twice`);
    }
    // Values are returned in a plain object, where this key sets the prototype.
    if (name === '__proto__') throw new SchemaGuardError('VALIDATION_ERROR', 'Aggregate output may not be named __proto__');
    seenOutputs.add(name);
  }

  // --- SELECT clause ---
  const selectParts: string[] = [];

  // Every output gets a positional name ("g0", "a0", ...): rows are read back
  // by it, and an orderBy naming an output resolves to it. Output names as
  // given (an alias like _total or totalCount) are not valid or stable SQL
  // identifiers, and a bare ORDER BY name that is not an output column is
  // resolved by PostgreSQL against the table's columns instead.
  const groupByFields = query.groupBy ?? [];
  groupByFields.forEach((field, i) => selectParts.push(`${fieldCol(field)} AS "g${i}"`));

  // Aggregate functions — allowlist to prevent SQL injection
  const ALLOWED_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);

  query.fields.forEach((aggField, i) => {
    const fnLower = aggField.fn.toLowerCase();
    if (!ALLOWED_FNS.has(fnLower)) {
      throw new Error(`Invalid aggregate function: ${aggField.fn}`);
    }

    const aliasIdent = `"a${i}"`;

    if (fnLower === 'count') {
      if (aggField.field === '*') {
        selectParts.push(`COUNT(*) AS ${aliasIdent}`);
      } else {
        selectParts.push(`COUNT(${fieldCol(aggField.field)}) AS ${aliasIdent}`);
      }
    } else {
      const col = fieldCol(aggField.field);
      const fnUpper = fnLower.toUpperCase();
      selectParts.push(`${fnUpper}(${col}) AS ${aliasIdent}`);
    }
  });

  // --- WHERE clause ---
  const baseParams: unknown[] = [ctx.tenantId];
  const whereClauses = [`"_tenant_id" = $1`, `"_deleted_at" IS NULL`];

  if (query.filter) {
    const filterFragment = filterToSql(query.filter, baseParams.length + 1);
    if (filterFragment.text !== 'TRUE') {
      whereClauses.push(filterFragment.text);
    }
    baseParams.push(...filterFragment.params);
  }

  const whereClause = whereClauses.join(' AND ');

  // --- GROUP BY clause ---
  let groupByClause = '';
  if (query.groupBy && query.groupBy.length > 0) {
    const groupCols = query.groupBy.map((f) => fieldCol(f));
    groupByClause = ` GROUP BY ${groupCols.join(', ')}`;
  }

  // --- ORDER BY clause ---
  // An orderBy names a grouping key or an aggregate's output (its alias, or
  // <fn>_<field>), a key first, as on the memory provider. Anything else is
  // refused: it is not part of the result, and as a bare name PostgreSQL
  // would look it up among the table's columns.
  let orderClause = '';
  if (query.orderBy && query.orderBy.length > 0) {
    const orderParts = query.orderBy.map((o) => {
      const g = groupByFields.indexOf(o.field);
      const a = query.fields.findIndex((f) => aggregateOutputName(f) === o.field);
      if (g < 0 && a < 0) {
        throw new SchemaGuardError(
          'VALIDATION_ERROR',
          `Aggregate orderBy "${o.field}" is neither a groupBy field nor an aggregate output`,
        );
      }
      // Nulls last either way, as on the memory provider (PostgreSQL puts
      // them first in a descending sort by default).
      return `${g >= 0 ? `"g${g}"` : `"a${a}"`} ${o.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
    });
    orderClause = ` ORDER BY ${orderParts.join(', ')}`;
  }

  // Total group count (before LIMIT/OFFSET).
  // When no GROUP BY is used, there is always exactly one aggregate group.
  let totalGroups: number;
  if (query.groupBy && query.groupBy.length > 0) {
    const countSql = `SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM ${table} WHERE ${whereClause}${groupByClause}) AS _sub`;
    const countResult = await q.query(countSql, baseParams);
    totalGroups = parseInt(String((countResult.rows[0] as Record<string, unknown>)['cnt']), 10);
  } else {
    totalGroups = 1;
  }

  // --- LIMIT / OFFSET ---
  let paginationClause = '';
  const allParams = [...baseParams];
  if (query.limit !== undefined) {
    allParams.push(query.limit);
    paginationClause += ` LIMIT $${allParams.length}`;
  }
  if (query.offset !== undefined) {
    allParams.push(query.offset);
    paginationClause += ` OFFSET $${allParams.length}`;
  }

  // --- Execute ---
  const sql = `SELECT ${selectParts.join(', ')} FROM ${table} WHERE ${whereClause}${groupByClause}${orderClause}${paginationClause}`;
  const result = await q.query(sql, allParams);

  // --- Map rows to AggregateGroup[] ---
  const groups: AggregateGroup[] = (result.rows as Record<string, unknown>[]).map((row) => {
    const keys: Record<string, unknown> = {};
    groupByFields.forEach((field, i) => {
      keys[field] = row[`g${i}`] ?? null;
    });

    const values: Record<string, number | null> = {};
    query.fields.forEach((aggField, i) => {
      const rawVal = row[`a${i}`];
      values[aggregateOutputName(aggField)] = rawVal === null || rawVal === undefined ? null : Number(rawVal);
    });

    return { keys, values };
  });

  return { groups, totalGroups };
}
