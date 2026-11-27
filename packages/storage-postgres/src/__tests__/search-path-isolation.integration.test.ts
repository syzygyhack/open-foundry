/**
 * Integration tests: the provider must not leave pooled connections on a
 * changed search_path, and each data schema keeps its own migration ledger.
 *
 * The AGE graph setup DDL and the Cypher helpers used to run
 * `SET search_path = ag_catalog, ...` at session level. The setting survived
 * COMMIT and stayed on the pooled connection, so later unqualified names (the
 * migration ledger was one) resolved into ag_catalog. maxPoolSize is 1 here so
 * every query reuses the one connection the earlier work touched.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped:
 *
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PgTransaction } from '../transactions/index.js';
import { ageQuery } from '../graph/age-query.js';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

function configFor(dataSchema: string) {
  const u = new URL(PG_TEST_URL!);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    maxPoolSize: 1,
    dataSchema,
  };
}

const ctx: RequestContext = { tenantId: 'tenant-search-path', actorId: 'test-actor' };

function schemaWith(objectType: string): OntologySchema {
  return {
    version: 1,
    objectTypes: [
      { name: `${objectType}Ward`, properties: [{ name: 'name', type: 'String' }] },
      { name: `${objectType}Bed`, properties: [{ name: 'label', type: 'String' }] },
    ],
    linkTypes: [
      {
        name: `${objectType}BedInWard`,
        fromType: `${objectType}Bed`,
        toType: `${objectType}Ward`,
        cardinality: 'MANY_TO_ONE',
        properties: [{ name: 'id', type: 'ID' }],
      },
    ],
  } as OntologySchema;
}

describeWithPg('search_path isolation and per-schema migration ledger (PostgreSQL integration)', () => {
  const open: Array<{ provider: PostgresStorageProvider; schema: string }> = [];
  let seq = 0;

  async function provider(): Promise<{ provider: PostgresStorageProvider; schema: string }> {
    const schema = `sp_iso_${process.pid}_${++seq}`;
    const p = new PostgresStorageProvider(configFor(schema));
    try {
      // No IF NOT EXISTS: a name collision must fail here, before afterEach
      // would drop a schema this test did not create.
      await p.pool.query(`CREATE SCHEMA "${schema}"`);
    } catch (err) {
      await p.close();
      throw err;
    }
    const entry = { provider: p, schema };
    open.push(entry);
    return entry;
  }

  async function searchPath(p: PostgresStorageProvider): Promise<string> {
    const { rows } = await p.pool.query<{ search_path: string }>('SHOW search_path');
    return rows[0]!.search_path;
  }

  afterEach(async () => {
    // Close every pool even if a drop fails; report the first failure.
    let first: unknown;
    for (const { provider: p, schema } of open.splice(0)) {
      try {
        await p.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } catch (err) {
        first ??= err;
      } finally {
        await p.close().catch((err: unknown) => { first ??= err; });
      }
    }
    if (first !== undefined) throw first;
  });

  it('applySchema leaves the pooled connection on its original search_path', async () => {
    const { provider: p } = await provider();
    const before = await searchPath(p);
    await p.applySchema(ctx, schemaWith('Sp1'));
    expect(await searchPath(p)).toBe(before);
  });

  it('graph mirror writes leave search_path unchanged and reach the graph', async () => {
    const { provider: p } = await provider();
    // Baseline from the untouched connection: taken after applySchema it would
    // already include any leak from the migration and hide one from the writes.
    const before = await searchPath(p);
    await p.applySchema(ctx, schemaWith('Sp2'));

    const ward = await p.createObject(ctx, 'Sp2Ward', { name: 'A' });
    const bed = await p.createObject(ctx, 'Sp2Bed', { label: 'A1' });
    await p.createLink(ctx, 'Sp2BedInWard', bed._id, ward._id);
    expect(await searchPath(p)).toBe(before);

    // The vertex really landed in the AGE graph (failures there are swallowed,
    // so a broken helper would otherwise pass silently).
    const results = (await p.pool.query(
      `SET LOCAL search_path = ag_catalog, "$user", public; ` +
        `SELECT * FROM cypher('openfoundry', $$MATCH (b:Sp2Bed {id: '${bed._id}'})-[e:Sp2BedInWard]->(w:Sp2Ward {id: '${ward._id}'}) RETURN e$$) AS (v agtype)`,
    )) as unknown as Array<{ rows: unknown[] }>;
    expect(results[1]!.rows).toHaveLength(1);
    expect(await searchPath(p)).toBe(before);
  });

  it('providers on different data schemas keep separate ledgers', async () => {
    const a = await provider();
    const b = await provider();
    // Same version number, different DDL: with one shared ledger the second
    // apply failed with "already applied but DDL checksum differs".
    await a.provider.applySchema(ctx, schemaWith('SpA'));
    await expect(b.provider.applySchema(ctx, schemaWith('SpB'))).resolves.toMatchObject({ success: true });

    for (const { provider: p, schema } of [a, b]) {
      const { rows } = await p.pool.query(`SELECT version FROM "${schema}"."_schema_migrations"`);
      expect(rows.map((r: { version: number }) => r.version)).toEqual([1]);
    }
  });

  it('a failed mirror write inside a transaction does not lose the SQL write', async () => {
    const { provider: p } = await provider();
    // Make the vertex write fail: an edge label of the same name exists, so
    // AGE rejects `CREATE (:SpTxWard ...)` ("label ... is for edges").
    const labelInGraph = `FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph
      WHERE g.name = 'openfoundry' AND l.name = 'SpTxWard'`;
    await p.pool.query(
      `SET LOCAL search_path = ag_catalog, "$user", public; ` +
        `SELECT create_elabel('openfoundry', 'SpTxWard') WHERE NOT EXISTS (SELECT 1 ${labelInGraph})`,
    );
    // The premise: the label is an edge label in this graph, so the write fails.
    const kind = await p.pool.query<{ kind: string }>(`SELECT l.kind ${labelInGraph}`);
    expect(kind.rows).toEqual([{ kind: 'e' }]);
    await p.applySchema(ctx, schemaWith('SpTx'));

    const tx = await p.beginTransaction(ctx);
    let ward: { _id: string };
    try {
      ward = await tx.createObject('SpTxWard', { name: 'kept' });
      await tx.commit();
    } catch (err) {
      // Free the pool's only connection for afterEach.
      await tx.rollback().catch(() => undefined);
      throw err;
    }

    // Before the savepoint, the Cypher error aborted the transaction and
    // COMMIT silently rolled the row back.
    expect(await p.getObject(ctx, 'SpTxWard', ward._id)).toMatchObject({ name: 'kept' });
  });

  it('two overlapping mirror writes on one transaction, the first failing, keep the SQL write and the second write', async () => {
    const { provider: p, schema } = await provider();
    await p.pool.query(`CREATE TABLE "${schema}"."sp_overlap" (v TEXT)`);
    const marker = `${schema}_second`;
    const tx = await PgTransaction.begin(p.pool);
    try {
      await tx.client.query(`INSERT INTO "${schema}"."sp_overlap" VALUES ('kept')`);
      // Not awaited in turn: pg queues both on the one client. Unqueued, the
      // second SAVEPOINT ran inside the first's failure, and the second write
      // was refused or its recovery aborted the transaction.
      await Promise.all([
        ageQuery(tx.client, 'THIS IS NOT CYPHER'),
        ageQuery(tx.client, `CREATE (:SpOverlapMarker {id: '${marker}'})`),
      ]);
      await tx.commit();
    } finally {
      // On failure, free the pool's only connection for afterEach.
      if (tx.isOpen) await tx.rollback().catch(() => undefined);
    }
    const { rows } = await p.pool.query(`SELECT v FROM "${schema}"."sp_overlap"`);
    expect(rows).toEqual([{ v: 'kept' }]);
    // The second write really ran, rather than being dropped.
    const found = (await p.pool.query(
      `SET LOCAL search_path = ag_catalog, "$user", public; ` +
        `SELECT * FROM cypher('openfoundry', $$MATCH (m:SpOverlapMarker {id: '${marker}'}) RETURN m$$) AS (v agtype)`,
    )) as unknown as Array<{ rows: unknown[] }>;
    expect(found[1]!.rows).toHaveLength(1);
  });

  it('a mirror write inside a transaction leaves the transaction on its search_path', async () => {
    const { provider: p } = await provider();
    const tx = await PgTransaction.begin(p.pool);
    try {
      const show = async () => (await tx.client.query<{ search_path: string }>('SHOW search_path')).rows[0]!.search_path;
      const before = await show();
      await ageQuery(tx.client, 'RETURN 1');
      // SET LOCAL survives RELEASE SAVEPOINT; without a restore, the rest of
      // the caller's transaction resolved unqualified names in ag_catalog.
      expect(await show()).toBe(before);
      await tx.commit();
    } finally {
      if (tx.isOpen) await tx.rollback().catch(() => undefined);
    }
  });

  it('a mirror write whose search_path cannot be shown keeps the SQL write', async () => {
    const { provider: p, schema } = await provider();
    await p.pool.query(`CREATE TABLE "${schema}"."sp_enc" (v TEXT)`);
    const tx = await PgTransaction.begin(p.pool);
    try {
      await tx.client.query(`INSERT INTO "${schema}"."sp_enc" VALUES ('kept')`);
      // A path LATIN1 cannot represent: SHOW search_path fails with 22P05.
      await tx.client.query(`SET LOCAL search_path = "東京", public`);
      await tx.client.query(`SET LOCAL client_encoding = 'LATIN1'`);
      // The premise, checked under a savepoint of its own: on a database whose
      // encoding lets SHOW succeed here (SQL_ASCII), this test proves nothing.
      await tx.client.query('SAVEPOINT premise');
      await expect(tx.client.query('SHOW search_path')).rejects.toMatchObject({ code: '22P05' });
      await tx.client.query('ROLLBACK TO SAVEPOINT premise; RELEASE SAVEPOINT premise');
      await ageQuery(tx.client, 'RETURN 1');
      await tx.client.query(`SET LOCAL client_encoding = 'UTF8'`);
      await tx.commit();
    } finally {
      if (tx.isOpen) await tx.rollback().catch(() => undefined);
    }
    const { rows } = await p.pool.query(`SELECT v FROM "${schema}"."sp_enc"`);
    expect(rows).toEqual([{ v: 'kept' }]);
  });

  it('a mirror write that fails to parse inside a transaction keeps the transaction usable', async () => {
    const { provider: p } = await provider();
    const tx = await PgTransaction.begin(p.pool);
    try {
      // $$ ends the dollar quote early, so the whole message fails to parse
      // and nothing in it runs, the savepoint included.
      await ageQuery(tx.client, 'RETURN 1 $$ garbage');
      await expect(tx.client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
      await tx.commit();
    } finally {
      if (tx.isOpen) await tx.rollback().catch(() => undefined);
    }
  });

  it('a mirror write on an already-aborted transaction leaves the abort to COMMIT', async () => {
    const { provider: p } = await provider();
    const tx = await PgTransaction.begin(p.pool);
    try {
      await tx.client.query('SELECT 1/0').catch(() => undefined);
      // No savepoint was created, so there is nothing to roll back to; the
      // mirror write is dropped rather than throwing "savepoint does not exist".
      await expect(ageQuery(tx.client, 'RETURN 1')).resolves.toBeUndefined();
      await expect(tx.commit()).rejects.toThrow(/aborted/);
    } finally {
      if (tx.isOpen) await tx.rollback().catch(() => undefined);
    }
  });

  it('commit of an aborted transaction throws instead of reporting success', async () => {
    const { provider: p } = await provider();
    const tx = await PgTransaction.begin(p.pool);
    await tx.client.query('SELECT 1/0').catch(() => undefined);
    await expect(tx.commit()).rejects.toThrow(/aborted/);
    expect(tx.isOpen).toBe(false);
  });

  /**
   * Run fn with a legacy ledger, holding `rows`, where the old unqualified
   * name resolved: the "$user" schema. That is the compose/Helm case (there
   * "$user" names the AGE graph's schema). Only what this helper created is
   * dropped; an existing ledger there belongs to someone else, so the test
   * refuses to run rather than write into it.
   */
  async function withLegacyLedger(
    p: PostgresStorageProvider,
    rows: Array<{ version: number; checksum: string }>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const { rows: who } = await p.pool.query<{ u: string }>('SELECT current_user AS u');
    const userSchema = who[0]!.u;
    let createdSchema = false;
    let createdLedger = false;
    try {
      try {
        await p.pool.query(`CREATE SCHEMA "${userSchema}"`);
        createdSchema = true;
      } catch (err) {
        if ((err as { code?: string }).code !== '42P06') throw err; // duplicate_schema
      }
      // No IF NOT EXISTS: if another session owns a ledger here, fail.
      await p.pool.query(`CREATE TABLE "${userSchema}"."_schema_migrations" (
        version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT)`);
      createdLedger = true;
      for (const r of rows) {
        await p.pool.query(
          `INSERT INTO "${userSchema}"."_schema_migrations" (version, checksum) VALUES ($1, $2)`,
          [r.version, r.checksum],
        );
      }
      await fn();
    } finally {
      if (createdLedger) await p.pool.query(`DROP TABLE IF EXISTS "${userSchema}"."_schema_migrations"`);
      // RESTRICT: anything another session put in the schema meanwhile stays,
      // and so does the schema.
      if (createdSchema) await p.pool.query(`DROP SCHEMA IF EXISTS "${userSchema}" RESTRICT`).catch(() => undefined);
    }
  }

  it('adopts the history of the ledger the unqualified name resolved to', async () => {
    const { provider: p, schema } = await provider();
    await withLegacyLedger(p, [{ version: 1, checksum: 'legacy-checksum' }], async () => {
      // A data schema the old code migrated. Its table is named for none of
      // the current types (a later version may rename them all); the
      // provider's system columns are the evidence.
      await p.pool.query(
        `CREATE TABLE "${schema}"."sp_leg_renamed_ward" ("_tenant_id" TEXT, "_id" TEXT, "_version" INTEGER)`,
      );
      // The old code would have read version 1 from that ledger and rejected
      // a different DDL for it; so must the new one.
      await expect(p.applySchema(ctx, schemaWith('SpLeg'))).rejects.toThrow(/checksum differs/);
      const ledger = await p.pool.query(`SELECT version, checksum FROM "${schema}"."_schema_migrations"`);
      expect(ledger.rows).toEqual([{ version: 1, checksum: 'legacy-checksum' }]);
    });
  });

  it('a fresh data schema does not inherit an old ledger it never used', async () => {
    const { provider: p, schema } = await provider();
    await withLegacyLedger(p, [{ version: 1, checksum: 'other-schema' }], async () => {
      // Another component's table is no evidence of a migration here.
      await p.pool.query(`CREATE TABLE "${schema}"."sp_unrelated" (tenant_id TEXT, id TEXT)`);
      // That ledger describes some other data schema, not this one.
      await expect(p.applySchema(ctx, schemaWith('SpFresh'))).resolves.toMatchObject({ success: true });
      const ledger = await p.pool.query(`SELECT checksum FROM "${schema}"."_schema_migrations"`);
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0].checksum).not.toBe('other-schema');
    });
  });

  it('re-applying a version against a changed DDL is still rejected', async () => {
    const { provider: p, schema } = await provider();
    await p.applySchema(ctx, schemaWith('SpC'));
    // A second provider on the same data schema sees the ledger the first wrote.
    const again = new PostgresStorageProvider(configFor(schema));
    try {
      await expect(again.applySchema(ctx, schemaWith('SpD'))).rejects.toThrow(/checksum differs/);
    } finally {
      await again.close();
    }
  });
});
