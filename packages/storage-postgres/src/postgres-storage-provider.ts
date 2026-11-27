/**
 * PostgresStorageProvider — full StorageProvider implementation.
 *
 * Composes the object, link, transaction, temporal, and schema modules
 * into a single class that implements the @openfoundry/spi StorageProvider
 * interface. Uses pg Pool for connection pooling.
 */

import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type {
  StorageProvider,
  Transaction,
  RequestContext,
  OntologySchema,
  OntologyObject,
  OntologyLink,
  FilterExpression,
  QueryOptions,
  TraversalPath,
  TraversalOptions,
  TraversalResult,
  BulkMutationRequest,
  BulkMutationResult,
  ObjectPage,
  LinkPage,
  MigrationResult,
  HealthStatus,
  StorageCapabilities,
  IndexDefinition,
  IndexType,
  DateTime,
  LinkTypeDefinition,
  AggregateQuery,
  AggregateResult,
  SearchQuery,
  SearchResult,
} from '@openfoundry/spi';

// ─── Module imports ───
import { createLogger } from '@openfoundry/observability';
import { generateDDL } from './schema/index.js';
import { pgIdent, snakeCase, pgIndexMethod } from './schema/type-mapping.js';
import {
  createObject as pgCreateObject,
  getObject as pgGetObject,
  updateObject as pgUpdateObject,
  softDeleteObject as pgSoftDeleteObject,
  hardDeleteObject as pgHardDeleteObject,
  queryObjects as pgQueryObjects,
  aggregateObjects as pgAggregateObjects,
  searchObjects as pgSearchObjects,
} from './objects/index.js';
import {
  createLink as pgCreateLink,
  getLink as pgGetLink,
  updateLink as pgUpdateLink,
  deleteLink as pgDeleteLink,
  getLinks as pgGetLinks,
} from './links/index.js';
import { traverse as pgTraverse } from './links/index.js';
import {
  getObjectAtVersion as pgGetObjectAtVersion,
  getObjectAtTime as pgGetObjectAtTime,
} from './temporal/index.js';
import { PgTransaction } from './transactions/index.js';
import { withRetry } from './retry.js';

const logger = createLogger('storage-postgres');
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PostgresStorageConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Maximum pool size. Default: 10. */
  maxPoolSize?: number;
  /** Schema name for data tables. Default: 'public'. */
  dataSchema?: string;
  /** SSL/TLS configuration for the connection. */
  ssl?: boolean | { rejectUnauthorized: boolean };
  /** Transaction isolation level. Default: 'READ COMMITTED'. */
  defaultIsolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

// ---------------------------------------------------------------------------
// PgSpiTransaction — adapts PgTransaction to SPI Transaction interface
// ---------------------------------------------------------------------------

/**
 * Wraps a PgTransaction and delegates mutation operations through the
 * provider's module functions, using the PgTransaction's client.
 */
class PgSpiTransaction implements Transaction {
  constructor(
    private _pool: Pool,
    private _ctx: RequestContext,
    private _tx: PgTransaction,
    private _schema: string,
    private _resolveLink: (linkType: string) => LinkTypeDefinition | undefined,
  ) {}

  async createObject(type: string, properties: Record<string, unknown>): Promise<OntologyObject> {
    return pgCreateObject(this._pool, this._ctx, type, properties, this._schema, this._tx);
  }

  async updateObject(type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject> {
    return pgUpdateObject(this._pool, this._ctx, type, id, properties, this._schema, this._tx, expectedVersion);
  }

  async deleteObject(type: string, id: string, mode: 'soft' | 'hard'): Promise<void> {
    if (mode === 'soft') {
      await pgSoftDeleteObject(this._pool, this._ctx, type, id, this._schema, this._tx);
    } else {
      await pgHardDeleteObject(this._pool, this._ctx, type, id, this._schema, this._tx);
    }
  }

  async createLink(type: string, fromId: string, toId: string, properties?: Record<string, unknown>): Promise<OntologyLink> {
    const def = this._resolveLink(type);
    const fromType = def?.fromType ?? 'unknown';
    const toType = def?.toType ?? 'unknown';
    const cardinality = def?.cardinality ?? 'MANY_TO_MANY';
    return pgCreateLink(
      this._pool, this._ctx, type,
      fromType, fromId,
      toType, toId,
      properties,
      cardinality,
      this._schema,
      this._tx,
    );
  }

  async updateLink(type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink> {
    return pgUpdateLink(this._pool, this._ctx, type, linkId, properties, this._schema, this._tx, expectedVersion);
  }

  async deleteLink(type: string, linkId: string): Promise<void> {
    await pgDeleteLink(this._pool, this._ctx, type, linkId, this._schema, this._tx);
  }

  async commit(): Promise<void> {
    await this._tx.commit();
  }

  async rollback(): Promise<void> {
    await this._tx.rollback();
  }
}

// ---------------------------------------------------------------------------
// PostgresStorageProvider
// ---------------------------------------------------------------------------

export class PostgresStorageProvider implements StorageProvider {
  private _pool: Pool;
  private _dataSchema: string;
  private _schemas = new Map<number, OntologySchema>();
  private _currentSchemaVersion = 0;
  private _idempotencyCache = new Map<string, { result: BulkMutationResult; expiresAt: number }>();
  private _idempotencyCacheTimer: ReturnType<typeof setInterval> | null = null;
  /** Idempotency cache TTL in milliseconds. Entries older than this are evicted. */
  private static readonly IDEMPOTENCY_TTL_MS = 5 * 60_000; // 5 minutes

  private _defaultIsolationLevel: string;

  constructor(config: PostgresStorageConfig) {
    this._pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.maxPoolSize ?? 10,
      ssl: config.ssl || undefined,
      // Production-safe timeouts: prevent hung connections and pool exhaustion.
      connectionTimeoutMillis: 5_000,    // fail fast if Postgres unreachable
      idleTimeoutMillis: 30_000,         // release idle connections after 30s
      statement_timeout: 30_000,         // kill queries running longer than 30s
    } satisfies PoolConfig);
    this._dataSchema = config.dataSchema ?? 'public';
    this._defaultIsolationLevel = config.defaultIsolationLevel ?? 'READ COMMITTED';

    // Periodically evict expired idempotency cache entries
    this._idempotencyCacheTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this._idempotencyCache) {
        if (entry.expiresAt <= now) this._idempotencyCache.delete(key);
      }
    }, 60_000);
    this._idempotencyCacheTimer.unref(); // Don't prevent process exit
  }

  /** Expose pool for testing / direct access. */
  get pool(): Pool {
    return this._pool;
  }

  /** Gracefully shut down the connection pool. */
  async close(): Promise<void> {
    if (this._idempotencyCacheTimer) clearInterval(this._idempotencyCacheTimer);
    await this._pool.end();
  }

  // ─── Schema ───

  async applySchema(_ctx: RequestContext, schema: OntologySchema): Promise<MigrationResult> {
    const fromVersion = this._currentSchemaVersion;
    const ddl = generateDDL(schema, { dataSchema: this._dataSchema });

    // The migration ledger lives in the data schema it describes, named
    // explicitly. Left unqualified it resolved through each connection's
    // search_path: two providers on different data schemas shared one ledger
    // (and failed each other's checksums), and a connection whose search_path
    // had been pointed at ag_catalog created and read a second, empty ledger
    // there. _ensureLedger carries the old ledger's history across.
    const ledger = `${pgIdent(this._dataSchema)}."_schema_migrations"`;
    await this._ensureLedger(ledger);

    // Compute DDL checksum from ontology-specific DDL only.
    // Platform DDL (consent) is excluded because it's applied idempotently
    // and wasn't part of earlier schema versions' checksums.
    const checksumParts = [
      ...ddl.audit, ...ddl.lineage,
      ...ddl.objectTables, ...ddl.linkTables, ...ddl.graph,
    ];
    const ddlText = checksumParts.join('\n');
    const checksum = createHash('sha256').update(ddlText).digest('hex').slice(0, 16);

    // Check if this version is already applied (cheap check before acquiring lock)
    const existing = await this._pool.query(
      `SELECT checksum FROM ${ledger} WHERE version = $1`,
      [schema.version],
    );
    if (existing.rows.length > 0) {
      const storedChecksum = existing.rows[0].checksum;
      if (storedChecksum && storedChecksum !== checksum) {
        throw new Error(
          `Schema migration: version ${schema.version} already applied but DDL checksum differs. ` +
          `Expected ${storedChecksum}, got ${checksum}. ` +
          `Increment schema version or resolve the drift before deploying.`,
        );
      }
      // Schema version already applied — still run platform DDL (consent)
      // for upgrades that add new platform tables/columns. These statements
      // are idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
      for (const stmt of ddl.consent) {
        await this._pool.query(stmt);
      }
      this._currentSchemaVersion = schema.version;
      this._schemas.set(schema.version, schema);
      const now = new Date().toISOString() as DateTime;
      return { success: true, fromVersion, toVersion: schema.version, appliedAt: now };
    }

    // Use a dedicated client for the entire migration to ensure advisory lock
    // is held on the same session. pg_advisory_xact_lock auto-releases on COMMIT.
    const client = await this._pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      // Transaction-scoped advisory lock — released automatically on COMMIT/ROLLBACK
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x4F46]);

      // Re-check after acquiring lock (another instance may have applied it)
      const recheck = await client.query(
        `SELECT checksum FROM ${ledger} WHERE version = $1`,
        [schema.version],
      );
      if (recheck.rows.length > 0) {
        const storedChecksum = recheck.rows[0].checksum;
        if (storedChecksum && storedChecksum !== checksum) {
          throw new Error(
            `Schema migration: version ${schema.version} already applied but DDL checksum differs. ` +
            `Expected ${storedChecksum}, got ${checksum}. ` +
            `Increment schema version or resolve the drift before deploying.`,
          );
        }
        // Platform DDL under advisory lock for concurrent startup safety
        for (const stmt of ddl.consent) {
          await client.query(stmt);
        }
        await client.query('COMMIT');
        this._currentSchemaVersion = schema.version;
        this._schemas.set(schema.version, schema);
        const now = new Date().toISOString() as DateTime;
        return { success: true, fromVersion, toVersion: schema.version, appliedAt: now };
      }

      // Apply platform DDL (consent) under the advisory lock before ontology DDL.
      // Serializes concurrent startup so only one pod creates the schema/tables.
      for (const stmt of ddl.consent) {
        await client.query(stmt);
      }

      // Execute ontology DDL statements (ddl.all includes consent which is
      // idempotent, so running it again is harmless)
      for (const stmt of ddl.all) {
        await client.query(stmt);
      }

      // Record migration
      await client.query(
        `INSERT INTO ${ledger} (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
        [schema.version, checksum],
      );

      await client.query('COMMIT');
    } catch (err) {
      // Keep the migration's own error: a failed ROLLBACK means the connection
      // is unusable, so discard it rather than report that instead.
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      // The graph setup DDL runs `SET search_path = ag_catalog, ...`, and a
      // session-level SET survives COMMIT. Its text is part of the migration
      // checksum, so it cannot become SET LOCAL without failing the checksum of
      // every database it already ran on; reset the session instead, before the
      // connection goes back to the pool. Pool connections belong to the
      // provider and run on the default path, so RESET restores what was there.
      // If even that fails, discard the connection.
      if (!broken) {
        try {
          await client.query('RESET search_path');
        } catch {
          broken = true;
        }
      }
      client.release(broken);
    }

    this._currentSchemaVersion = schema.version;
    this._schemas.set(schema.version, schema);

    const now = new Date().toISOString() as DateTime;
    return {
      success: true,
      fromVersion,
      toVersion: schema.version,
      appliedAt: now,
    };
  }

  /**
   * Create this data schema's migration ledger on first use, and adopt the
   * history of the ledger the provider used before the name was qualified.
   *
   * That ledger was whatever `_schema_migrations` resolved to through the
   * session's default search_path, `"$user", public`. With the compose and Helm
   * defaults (role `openfoundry`, AGE graph `openfoundry` created before the
   * first boot) "$user" names the graph's schema, so the old ledger lives in
   * `openfoundry._schema_migrations`, not in public. Without adoption, an
   * upgraded database would look unmigrated: its DDL would be replayed, and the
   * checksum drift check skipped, for every version it already applied.
   *
   * Only a data schema the old code migrated has history to adopt, so a data
   * schema holding none of this provider's object or link tables starts with
   * an empty ledger. (An ontology with no types leaves no such table; its
   * history is not adopted, and its DDL, which creates no data tables, runs
   * again.) Without that check, every new data schema in a database with an
   * old ledger (for example public's) would inherit that ledger's versions and
   * fail their checksums, which is the sharing this change removes. A data
   * schema with such tables in it adopts whatever the old name resolves to, which is
   * the ledger the old code read for it; where that is the data schema's own
   * ledger (no "$user" schema, data in public), it is used as it is.
   *
   * Rows are copied, not moved; the old table is left in place. A legacy
   * ledger shared by several migrated data schemas is copied into each, which
   * keeps exactly the history each one saw before.
   */
  private async _ensureLedger(ledger: string): Promise<void> {
    const exists = await this._pool.query<{ oid: number | null }>(
      'SELECT to_regclass($1)::oid AS oid',
      [ledger],
    );
    if (exists.rows[0]?.oid) return;

    const client = await this._pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x4F46]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${ledger} (
          version INT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          checksum TEXT
        )
      `);
      // Resolve the old, unqualified name as the old code did on a clean
      // connection; SET LOCAL ends with this transaction.
      await client.query('SET LOCAL search_path TO DEFAULT');
      const found = await client.query<{ legacy: string | null; same: boolean | null }>(
        `SELECT to_regclass('_schema_migrations')::text AS legacy,
                to_regclass('_schema_migrations') = to_regclass($1) AS same`,
        [ledger],
      );
      const { legacy, same } = found.rows[0] ?? { legacy: null, same: null };
      // Evidence of an earlier migration: a table this provider creates, which
      // every object and link table is, recognised by its system columns
      // (_tenant_id, _id, _version), not by name, since a later version may
      // rename every type. Tables other code keeps in the schema do not count.
      // The schema is looked up by the same quoted identifier the DDL uses, so
      // its physical name matches.
      const migrated = legacy && !same
        ? ((await client.query(
            `SELECT 1 FROM pg_class c
              WHERE c.relnamespace = to_regnamespace($1)
                AND c.relkind IN ('r', 'p')
                AND (SELECT count(*) FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND NOT a.attisdropped
                        AND a.attname IN ('_tenant_id', '_id', '_version')) = 3
              LIMIT 1`,
            [pgIdent(this._dataSchema)],
          )).rowCount ?? 0) > 0
        : false;
      if (legacy && !same && migrated) {
        // regclass::text renders a name that is valid in this session.
        const copied = await client.query(
          `INSERT INTO ${ledger} (version, applied_at, checksum)
           SELECT version, applied_at, checksum FROM ${legacy}
           ON CONFLICT (version) DO NOTHING`,
        );
        if ((copied.rowCount ?? 0) > 0) {
          logger.info(
            { from: legacy, to: ledger, records: copied.rowCount },
            'Adopted migration records from the legacy ledger',
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async getSchema(_ctx: RequestContext, version?: number): Promise<OntologySchema> {
    const v = version ?? this._currentSchemaVersion;
    const schema = this._schemas.get(v);
    if (!schema) {
      throw new Error(`Schema version ${v} not found`);
    }
    return schema;
  }

  // ─── Objects ───

  async createObject(ctx: RequestContext, type: string, properties: Record<string, unknown>): Promise<OntologyObject> {
    return pgCreateObject(this._pool, ctx, type, properties, this._dataSchema);
  }

  async getObject(ctx: RequestContext, type: string, id: string): Promise<OntologyObject | null> {
    const obj = await withRetry(() => pgGetObject(this._pool, ctx, type, id, this._dataSchema));
    if (!obj) return null;
    // Follow SPI convention: return null for soft-deleted (like memory provider)
    if (obj._deletedAt) return null;
    return obj;
  }

  async updateObject(ctx: RequestContext, type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject> {
    return pgUpdateObject(this._pool, ctx, type, id, properties, this._dataSchema, undefined, expectedVersion);
  }

  async deleteObject(ctx: RequestContext, type: string, id: string, mode: 'soft' | 'hard'): Promise<void> {
    if (mode === 'soft') {
      await pgSoftDeleteObject(this._pool, ctx, type, id, this._dataSchema);
    } else {
      await pgHardDeleteObject(this._pool, ctx, type, id, this._dataSchema);
    }
  }

  async queryObjects(ctx: RequestContext, type: string, filter: FilterExpression, options?: QueryOptions): Promise<ObjectPage> {
    return withRetry(() => pgQueryObjects(this._pool, ctx, type, filter, options, this._dataSchema));
  }

  async aggregateObjects(ctx: RequestContext, type: string, query: AggregateQuery): Promise<AggregateResult> {
    return withRetry(() => pgAggregateObjects(this._pool, ctx, type, query, this._dataSchema));
  }

  async searchObjects(ctx: RequestContext, type: string, query: SearchQuery): Promise<SearchResult> {
    return withRetry(() => pgSearchObjects(this._pool, ctx, type, query, this._dataSchema));
  }

  async bulkMutate(ctx: RequestContext, request: BulkMutationRequest): Promise<BulkMutationResult> {
    // Idempotency check — scoped by tenant to prevent cross-tenant cache hits
    const cacheKey = `${ctx.tenantId}:${request.idempotencyKey}`;
    const cached = this._idempotencyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    let accepted = 0;
    let failed = 0;
    const errors: BulkMutationResult['errors'] = [];

    for (let i = 0; i < request.operations.length; i++) {
      const op = request.operations[i]!;
      try {
        switch (op.type) {
          case 'createObject':
            await pgCreateObject(this._pool, ctx, op.objectType, op.properties, this._dataSchema);
            break;
          case 'updateObject':
            await pgUpdateObject(this._pool, ctx, op.objectType, op.id, op.properties, this._dataSchema);
            break;
          case 'deleteObject':
            if (op.mode === 'soft') {
              await pgSoftDeleteObject(this._pool, ctx, op.objectType, op.id, this._dataSchema);
            } else {
              await pgHardDeleteObject(this._pool, ctx, op.objectType, op.id, this._dataSchema);
            }
            break;
        }
        accepted++;
      } catch (err) {
        failed++;
        errors.push({
          operationIndex: i,
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result: BulkMutationResult = { accepted, failed, errors };
    this._idempotencyCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + PostgresStorageProvider.IDEMPOTENCY_TTL_MS,
    });
    return result;
  }

  // ─── Links ───

  async createLink(
    ctx: RequestContext,
    type: string,
    fromId: string,
    toId: string,
    properties?: Record<string, unknown>,
  ): Promise<OntologyLink> {
    const def = this._getLinkTypeDef(type);
    const fromType = def?.fromType ?? 'unknown';
    const toType = def?.toType ?? 'unknown';
    const cardinality = def?.cardinality ?? 'MANY_TO_MANY';
    return pgCreateLink(
      this._pool, ctx, type,
      fromType, fromId,
      toType, toId,
      properties,
      cardinality,
      this._dataSchema,
    );
  }

  async getLink(ctx: RequestContext, type: string, linkId: string): Promise<OntologyLink | null> {
    const link = await withRetry(() => pgGetLink(this._pool, ctx, type, linkId, this._dataSchema));
    if (!link) return null;
    if (link._deletedAt) return null;
    return link;
  }

  async updateLink(ctx: RequestContext, type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink> {
    return pgUpdateLink(this._pool, ctx, type, linkId, properties, this._dataSchema, undefined, expectedVersion);
  }

  async deleteLink(ctx: RequestContext, type: string, linkId: string): Promise<void> {
    await pgDeleteLink(this._pool, ctx, type, linkId, this._dataSchema);
  }

  async getLinks(
    ctx: RequestContext,
    objectId: string,
    linkType: string,
    direction: 'inbound' | 'outbound',
    options?: QueryOptions,
  ): Promise<LinkPage> {
    return withRetry(() => pgGetLinks(this._pool, ctx, objectId, linkType, direction, options, this._dataSchema));
  }

  async traverse(
    ctx: RequestContext,
    startId: string,
    path: TraversalPath,
    options?: TraversalOptions,
  ): Promise<TraversalResult> {
    return withRetry(() => pgTraverse(this._pool, ctx, startId, path, options, this._dataSchema));
  }

  // ─── Transactions ───

  async beginTransaction(ctx: RequestContext): Promise<Transaction> {
    const tx = await PgTransaction.begin(this._pool, this._defaultIsolationLevel);
    return new PgSpiTransaction(
      this._pool,
      ctx,
      tx,
      this._dataSchema,
      (linkType) => this._getLinkTypeDef(linkType),
    );
  }

  // ─── Versioning ───

  async getObjectAtVersion(ctx: RequestContext, type: string, id: string, version: number): Promise<OntologyObject | null> {
    return withRetry(() => pgGetObjectAtVersion(this._pool, ctx, type, id, version, this._dataSchema));
  }

  async getObjectAtTime(ctx: RequestContext, type: string, id: string, timestamp: DateTime): Promise<OntologyObject | null> {
    return withRetry(() => pgGetObjectAtTime(this._pool, ctx, type, id, timestamp, this._dataSchema));
  }

  // ─── Indices ───

  async ensureIndex(_ctx: RequestContext, type: string, index: IndexDefinition): Promise<void> {
    const table = `${pgIdent(this._dataSchema)}.${pgIdent(snakeCase(type))}`;
    const column = pgIdent(snakeCase(index.field));
    const method = pgIndexMethod(index.indexType);
    const snakeType = snakeCase(type);
    const snakeField = snakeCase(index.field);

    if (index.unique) {
      const indexName = `"uq_${snakeType}_${snakeField}"`;
      await this._pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table} (${column})`,
      );
    } else {
      const indexName = `"idx_${snakeType}_${snakeField}_${method}"`;
      await this._pool.query(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING ${method} (${column})`,
      );
    }
  }

  async dropIndex(_ctx: RequestContext, type: string, field: string): Promise<void> {
    const snakeType = snakeCase(type);
    const snakeField = snakeCase(field);
    // Try dropping both unique and regular index names
    await this._pool.query(`DROP INDEX IF EXISTS ${pgIdent(this._dataSchema)}."uq_${snakeType}_${snakeField}"`);
    await this._pool.query(`DROP INDEX IF EXISTS ${pgIdent(this._dataSchema)}."idx_${snakeType}_${snakeField}_btree"`);
    await this._pool.query(`DROP INDEX IF EXISTS ${pgIdent(this._dataSchema)}."idx_${snakeType}_${snakeField}_hash"`);
    await this._pool.query(`DROP INDEX IF EXISTS ${pgIdent(this._dataSchema)}."idx_${snakeType}_${snakeField}_gin"`);
    await this._pool.query(`DROP INDEX IF EXISTS ${pgIdent(this._dataSchema)}."idx_${snakeType}_${snakeField}_gist"`);
  }

  async listIndexes(_ctx: RequestContext, type: string): Promise<IndexDefinition[]> {
    const tableName = snakeCase(type);
    const result = await this._pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
      [this._dataSchema, tableName],
    );
    const indexes: IndexDefinition[] = [];
    for (const row of result.rows) {
      const name = row.indexname as string;
      const def = row.indexdef as string;
      // Skip primary key indexes
      if (name.endsWith('_pkey')) continue;
      // Parse field name from index name convention: idx_type_field_method or uq_type_field
      const isUnique = name.startsWith('uq_') || def.toUpperCase().includes('UNIQUE');
      const methodMatch = def.match(/USING\s+(\w+)/i);
      const method = (methodMatch?.[1]?.toUpperCase() ?? 'BTREE') as IndexType;
      // Extract column name from parentheses
      const colMatch = def.match(/\(([^)]+)\)/);
      const col = colMatch?.[1]?.replace(/"/g, '').trim() ?? '';
      const field = col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      indexes.push({ field, indexType: method, unique: isUnique || undefined });
    }
    return indexes;
  }

  // ─── Health ───

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      // Basic connectivity
      await this._pool.query('SELECT 1');

      // Check AGE extension (required for graph/link traversal)
      const extResult = await this._pool.query(
        `SELECT extname FROM pg_extension WHERE extname = 'age'`,
      );
      const ageLoaded = extResult.rows.length > 0;

      // AGE is required when link types are registered (graph features active)
      const hasGraphFeatures = this._currentSchemaVersion > 0 &&
        [...this._schemas.values()].some(s => s.linkTypes.length > 0);
      const healthy = !hasGraphFeatures || ageLoaded;

      const latencyMs = Date.now() - start;
      return {
        healthy,
        provider: 'postgres',
        latencyMs,
        details: {
          ageExtension: ageLoaded,
          poolTotal: this._pool.totalCount,
          poolIdle: this._pool.idleCount,
          poolWaiting: this._pool.waitingCount,
          ...(hasGraphFeatures && !ageLoaded ? { degraded: 'AGE extension required for link traversal' } : {}),
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return {
        healthy: false,
        provider: 'postgres',
        latencyMs,
        details: {
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  capabilities(): StorageCapabilities {
    return {
      supportsTransactions: true,
      supportsTemporalQueries: true,
      supportsFullTextSearch: true,
      supportsGeoQueries: false,
      supportsGraphTraversal: true,
      supportsBulkMutations: true,
      maxTraversalDepth: 10,
      replicationSupport: 'NONE',
    };
  }

  // ─── Internal helpers ───

  private _getLinkTypeDef(linkType: string): LinkTypeDefinition | undefined {
    const schema = this._schemas.get(this._currentSchemaVersion);
    if (!schema) return undefined;
    return schema.linkTypes.find((lt) => lt.name === linkType);
  }
}
