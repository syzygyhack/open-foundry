/**
 * Graph traversal over the link and object tables (SQL). The AGE graph is a
 * best-effort mirror and is not read here.
 *
 * Every traversal:
 * - Enforces tenant isolation
 * - Filters out soft-deleted links and nodes by default, the start node included
 * - Applies each step's filter to that step's targets
 * - Respects depth and node limits
 */

import type { Pool } from 'pg';
import type {
  RequestContext,
  TraversalPath,
  TraversalOptions,
  TraversalResult,
  OntologyObject,
  OntologyLink,
  DateTime,
  FilterExpression,
} from '@openfoundry/spi';
import { snakeCase, pgIdent } from '../schema/type-mapping.js';
import { PgTransaction, resolveQueryable } from '../transactions/index.js';
import type { Queryable } from '../transactions/index.js';
import { filterToSql } from '../objects/filter-to-sql.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  const systemCols = new Set([
    '_tenant_id', '_id', '_type', '_version',
    '_created_at', '_updated_at', '_deleted_at',
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (!systemCols.has(key)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      obj[camelKey] = value;
    }
  }

  return obj;
}

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

// ---------------------------------------------------------------------------
// SQL-based traversal
// ---------------------------------------------------------------------------

const MAX_TRAVERSAL_DEPTH = 10;
const MAX_TRAVERSAL_NODES = 10_000;

function objectTable(schema: string, type: string): string {
  return `${pgIdent(schema)}.${pgIdent(snakeCase(type))}`;
}

/**
 * Walk the path from startId with SQL over the link and object tables, one
 * step per hop, as the memory provider does:
 * - each step follows links of its type in its direction from the frontier
 *   (keyed by type and ID), keeps the targets that are visible and pass the
 *   step's filter, and records an edge only for a target it keeps;
 * - by default soft-deleted links and objects are not traversed, the start
 *   object included (spec §3.3 rule 3);
 * - at most MAX_TRAVERSAL_NODES nodes are taken in total, checked within each
 *   hop;
 * - returns the last step's nodes, in the order first reached, paginated
 *   (default 100), and every recorded edge.
 */
export async function traverse(
  pool: Pool,
  ctx: RequestContext,
  startId: string,
  path: TraversalPath,
  options?: TraversalOptions,
  schema = 'public',
  tx?: PgTransaction,
): Promise<TraversalResult> {
  const q = resolveQueryable(pool, tx);
  const includeDeleted = options?.includeDeleted ?? false;

  // PERF-03: Enforce maximum traversal depth to prevent resource exhaustion
  if (path.steps.length > MAX_TRAVERSAL_DEPTH) {
    throw new Error(`Traversal depth ${path.steps.length} exceeds maximum of ${MAX_TRAVERSAL_DEPTH}`);
  }

  const edges = new Map<string, OntologyLink>();
  let stepNodes = new Map<string, OntologyObject>();
  // The start object's type is not known yet: its links give it.
  let frontier: Array<{ type: string | undefined; id: string }> = [{ type: undefined, id: startId }];
  let totalNodesSeen = 0;

  for (const [stepIndex, step] of path.steps.entries()) {
    if (frontier.length === 0) break;
    const outbound = step.direction === 'outbound';
    const srcIdCol = outbound ? '_from_id' : '_to_id';
    const srcTypeCol = outbound ? '_from_type' : '_to_type';
    const tgtIdCol = outbound ? '_to_id' : '_from_id';
    const tgtTypeCol = outbound ? '_to_type' : '_from_type';

    // 1. Links of this step's type from the frontier.
    const ids = frontier.map((f) => f.id);
    const params: unknown[] = [ctx.tenantId, ids];
    let where = `"_tenant_id" = $1 AND "${srcIdCol}" = ANY($2::text[])`;
    if (!includeDeleted) where += ` AND "_deleted_at" IS NULL`;
    const linkRows = (
      await q.query(
        `SELECT * FROM ${pgIdent(schema)}.${pgIdent(snakeCase(step.linkType))} WHERE ${where}
          ORDER BY "_created_at" ASC, "_id" ASC`,
        params,
      )
    ).rows as Record<string, unknown>[];
    const frontierKeys = new Set(frontier.filter((f) => f.type !== undefined).map((f) => `${f.type}:${f.id}`));
    let candidates = linkRows.filter(
      (r) => stepIndex === 0 || frontierKeys.has(`${r[srcTypeCol] as string}:${r[srcIdCol] as string}`),
    );

    // 2. The start object must itself be visible (later frontiers are targets
    //    already checked).
    if (stepIndex === 0) {
      const visible = await visibleKeys(
        q, ctx, schema,
        candidates.map((r) => ({ type: r[srcTypeCol] as string, id: r[srcIdCol] as string })),
        includeDeleted, undefined,
      );
      candidates = candidates.filter((r) => visible.has(`${r[srcTypeCol] as string}:${r[srcIdCol] as string}`));
    }

    // 3. Targets that are visible and pass the step filter.
    const targets = await visibleObjects(
      q, ctx, schema,
      candidates.map((r) => ({ type: r[tgtTypeCol] as string, id: r[tgtIdCol] as string })),
      includeDeleted, step.filter, MAX_TRAVERSAL_NODES - totalNodesSeen,
    );

    // 4. Edges and nodes, in link order.
    const nextNodes = new Map<string, OntologyObject>();
    for (const r of candidates) {
      const key = `${r[tgtTypeCol] as string}:${r[tgtIdCol] as string}`;
      const target = targets.get(key);
      if (!target) continue;
      edges.set(`${r['_type'] as string}:${r['_id'] as string}`, rowToLink(r));
      if (!nextNodes.has(key)) nextNodes.set(key, target);
    }
    totalNodesSeen += nextNodes.size;
    stepNodes = nextNodes;
    frontier = Array.from(nextNodes.values()).map((n) => ({ type: n._type, id: n._id }));
  }

  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;
  const nodes = Array.from(stepNodes.values());
  return {
    nodes: nodes.slice(offset, offset + limit),
    edges: Array.from(edges.values()),
    totalCount: nodes.length,
  };
}

async function visibleKeys(
  q: Queryable,
  ctx: RequestContext,
  schema: string,
  refs: Array<{ type: string; id: string }>,
  includeDeleted: boolean,
  filter: FilterExpression | undefined,
): Promise<Set<string>> {
  return new Set((await visibleObjects(q, ctx, schema, refs, includeDeleted, filter, Infinity)).keys());
}

/**
 * The referenced objects that exist in this tenant, are not soft-deleted
 * (unless includeDeleted) and pass filter, keyed type:id, at most budget of
 * them.
 */
async function visibleObjects(
  q: Queryable,
  ctx: RequestContext,
  schema: string,
  refs: Array<{ type: string; id: string }>,
  includeDeleted: boolean,
  filter: FilterExpression | undefined,
  budget: number,
): Promise<Map<string, OntologyObject>> {
  const byType = new Map<string, Set<string>>();
  for (const { type, id } of refs) {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type)!.add(id);
  }
  const found = new Map<string, OntologyObject>();
  for (const [type, idSet] of byType) {
    if (found.size >= budget) break;
    const params: unknown[] = [ctx.tenantId, Array.from(idSet)];
    let where = `"_tenant_id" = $1 AND "_id" = ANY($2::text[])`;
    if (!includeDeleted) where += ` AND "_deleted_at" IS NULL`;
    if (filter) {
      const fragment = filterToSql(filter, params.length + 1);
      if (fragment.text !== 'TRUE') {
        where += ` AND (${fragment.text})`;
        params.push(...fragment.params);
      }
    }
    let sql = `SELECT * FROM ${objectTable(schema, type)} WHERE ${where}`;
    if (Number.isFinite(budget)) {
      params.push(budget - found.size);
      sql += ` LIMIT $${params.length}`;
    }
    const rows = (await q.query(sql, params)).rows as Record<string, unknown>[];
    for (const row of rows) {
      const obj = rowToObject(row);
      found.set(`${type}:${obj._id}`, obj);
    }
  }
  return found;
}
