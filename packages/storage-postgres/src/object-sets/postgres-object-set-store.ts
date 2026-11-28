/**
 * PostgreSQL-backed ObjectSetStore.
 *
 * Persistent implementation of the `ObjectSetStore` interface (from
 * `@openfoundry/spi`), storing saved named query definitions in the
 * `_object_sets` table. Behaviourally identical to `InMemoryObjectSetStore`
 * (same tenant isolation, public/private visibility, and creator-only mutation
 * semantics) but durable across restarts and shared across pods.
 *
 * Self-initialising: the table is created on first use (`CREATE TABLE IF NOT
 * EXISTS`), so the store can be constructed with a Pool and used directly,
 * independent of the SPI `applySchema` DDL path (mirrors PostgresSchemaRegistry).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  RequestContext,
  ObjectSetDefinition,
  ObjectSetStore,
} from '@openfoundry/spi';
import { OpenFoundryError } from '@openfoundry/spi';

/** Error shapes match InMemoryObjectSetStore for cross-implementation parity. */
function notFoundError(id: string): never {
  throw {
    code: 'OBJECT_SET_NOT_FOUND',
    category: 'not_found' as const,
    message: `Object set ${id} not found`,
    retryable: false,
  };
}

function forbiddenError(id: string, verb: 'update' | 'delete'): never {
  throw {
    code: 'FORBIDDEN',
    category: 'authorization' as const,
    message: `Only the creator can ${verb} object set ${id}`,
    retryable: false,
  };
}

export class PostgresObjectSetStore implements ObjectSetStore {
  private readonly pool: Pool;
  private initialized = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Create the object-set table on first use (idempotent). */
  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "_object_sets" (
        "id" TEXT PRIMARY KEY,
        "tenant_id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "object_type" TEXT NOT NULL,
        "filter" JSONB,
        "order_by" JSONB,
        "limit" INT,
        "aggregation" JSONB,
        "created_by" TEXT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "is_public" BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS "_object_sets_tenant_name_idx"
         ON "_object_sets" ("tenant_id", "name")`,
    );
    this.initialized = true;
  }

  async create(
    ctx: RequestContext,
    def: Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ObjectSetDefinition> {
    // Enforce createdBy from request context — fail closed if unauthenticated.
    if (!ctx.actorId) {
      throw new OpenFoundryError({
        code: 'UNAUTHENTICATED',
        category: 'authorization',
        message: 'Cannot create object set without authenticated user',
      });
    }
    await this.ensureSchema();

    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO "_object_sets"
        ("id", "tenant_id", "name", "description", "object_type",
         "filter", "order_by", "limit", "aggregation",
         "created_by", "is_public")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        ctx.tenantId,
        def.name,
        def.description ?? null,
        def.objectType,
        def.filter !== undefined ? JSON.stringify(def.filter) : null,
        def.orderBy !== undefined ? JSON.stringify(def.orderBy) : null,
        def.limit ?? null,
        def.aggregation !== undefined ? JSON.stringify(def.aggregation) : null,
        ctx.actorId,
        def.isPublic,
      ],
    );
    return rowToDefinition(result.rows[0]);
  }

  async get(ctx: RequestContext, id: string): Promise<ObjectSetDefinition | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT * FROM "_object_sets"
       WHERE "id" = $1 AND "tenant_id" = $2 AND ${visibilitySql(ctx, 3)}`,
      [id, ctx.tenantId, ...visibilityParams(ctx)],
    );
    if (result.rows.length === 0) return null;
    return rowToDefinition(result.rows[0]);
  }

  async getByName(ctx: RequestContext, name: string): Promise<ObjectSetDefinition | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT * FROM "_object_sets"
       WHERE "name" = $1 AND "tenant_id" = $2 AND ${visibilitySql(ctx, 3)}
       ORDER BY "created_at" ASC LIMIT 1`,
      [name, ctx.tenantId, ...visibilityParams(ctx)],
    );
    if (result.rows.length === 0) return null;
    return rowToDefinition(result.rows[0]);
  }

  async list(ctx: RequestContext, objectType?: string): Promise<ObjectSetDefinition[]> {
    await this.ensureSchema();
    const conditions = ['"tenant_id" = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;
    if (objectType !== undefined) {
      conditions.push(`"object_type" = $${idx++}`);
      params.push(objectType);
    }
    conditions.push(visibilitySql(ctx, idx));
    params.push(...visibilityParams(ctx));

    const result = await this.pool.query(
      `SELECT * FROM "_object_sets"
       WHERE ${conditions.join(' AND ')}
       ORDER BY "created_at" ASC`,
      params,
    );
    return result.rows.map(rowToDefinition);
  }

  async update(
    ctx: RequestContext,
    id: string,
    updates: Partial<
      Pick<
        ObjectSetDefinition,
        'name' | 'description' | 'filter' | 'orderBy' | 'limit' | 'aggregation' | 'isPublic'
      >
    >,
  ): Promise<ObjectSetDefinition> {
    await this.ensureSchema();
    // Enforces tenant scope (NOT_FOUND) + creator-only access (FORBIDDEN).
    await this.loadForMutation(ctx, id, 'update');

    // Build the SET clause from provided fields only (mirrors in-memory merge).
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    const addSet = (col: string, value: unknown): void => {
      sets.push(`"${col}" = $${idx++}`);
      params.push(value);
    };
    if (updates.name !== undefined) addSet('name', updates.name);
    if (updates.description !== undefined) addSet('description', updates.description);
    if (updates.filter !== undefined) addSet('filter', JSON.stringify(updates.filter));
    if (updates.orderBy !== undefined) addSet('order_by', JSON.stringify(updates.orderBy));
    if (updates.limit !== undefined) addSet('limit', updates.limit);
    if (updates.aggregation !== undefined) addSet('aggregation', JSON.stringify(updates.aggregation));
    if (updates.isPublic !== undefined) addSet('is_public', updates.isPublic);
    // Always advance updated_at, even for an empty update payload — matches
    // InMemoryObjectSetStore so behaviour is backend-independent.
    sets.push(`"updated_at" = NOW()`);

    params.push(id);
    const result = await this.pool.query(
      `UPDATE "_object_sets" SET ${sets.join(', ')} WHERE "id" = $${idx} RETURNING *`,
      params,
    );
    return rowToDefinition(result.rows[0]);
  }

  async delete(ctx: RequestContext, id: string): Promise<void> {
    await this.ensureSchema();
    await this.loadForMutation(ctx, id, 'delete');
    await this.pool.query(`DELETE FROM "_object_sets" WHERE "id" = $1`, [id]);
  }

  /**
   * Load a row for mutation, enforcing tenant scope (NOT_FOUND) and
   * creator-only access (FORBIDDEN, fail closed when actorId absent).
   */
  private async loadForMutation(
    ctx: RequestContext,
    id: string,
    verb: 'update' | 'delete',
  ): Promise<ObjectSetDefinition> {
    const result = await this.pool.query(
      `SELECT * FROM "_object_sets" WHERE "id" = $1 AND "tenant_id" = $2`,
      [id, ctx.tenantId],
    );
    if (result.rows.length === 0) notFoundError(id);
    const def = rowToDefinition(result.rows[0]);
    if (!ctx.actorId || def.createdBy !== ctx.actorId) forbiddenError(id, verb);
    return def;
  }
}

// ---------------------------------------------------------------------------
// Visibility helpers — public sets are visible to all; private sets only to
// their creator. When actorId is absent, only public sets are visible.
// ---------------------------------------------------------------------------

function visibilitySql(ctx: RequestContext, startIdx: number): string {
  if (!ctx.actorId) return `"is_public" = TRUE`;
  return `("is_public" = TRUE OR "created_by" = $${startIdx})`;
}

function visibilityParams(ctx: RequestContext): unknown[] {
  return ctx.actorId ? [ctx.actorId] : [];
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToDefinition(row: Record<string, unknown>): ObjectSetDefinition {
  const def: ObjectSetDefinition = {
    id: row['id'] as string,
    name: row['name'] as string,
    objectType: row['object_type'] as string,
    createdBy: row['created_by'] as string,
    createdAt: (row['created_at'] as Date).toISOString(),
    updatedAt: (row['updated_at'] as Date).toISOString(),
    isPublic: row['is_public'] as boolean,
    tenantId: row['tenant_id'] as string,
  };
  if (row['description'] != null) def.description = row['description'] as string;
  if (row['filter'] != null) def.filter = row['filter'] as ObjectSetDefinition['filter'];
  if (row['order_by'] != null) def.orderBy = row['order_by'] as ObjectSetDefinition['orderBy'];
  if (row['limit'] != null) def.limit = row['limit'] as number;
  if (row['aggregation'] != null) {
    def.aggregation = row['aggregation'] as ObjectSetDefinition['aggregation'];
  }
  return def;
}
