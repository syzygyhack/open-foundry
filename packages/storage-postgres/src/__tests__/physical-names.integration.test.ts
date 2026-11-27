/**
 * Integration tests: catalog lookups use the names the DDL stored.
 *
 * The DDL names a type's table pgIdent(snakeCase(name)), which drops a leading
 * underscore, and PostgreSQL cuts identifiers to 63 bytes. Search's column
 * discovery and listIndexes looked tables up by snakeCase(name) and found
 * nothing for such types.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-physical-names', actorId: 'test-actor' };

// 44 characters (a valid graph label), but snakeCase gives 'ab_ab_...ab':
// 65 bytes, so the table and its history table are stored as one name.
const LONG = 'Ab'.repeat(22);
// snakeCase gives 59 bytes: the table keeps its name, its history table is cut.
const NEAR = 'Pn' + 'x'.repeat(56);
// snakeCase gives 50 bytes: an index on `commentary` gets a 71-byte name.
const MID = 'Pm' + 'x'.repeat(48);

const schema: OntologySchema = {
  version: 1,
  objectTypes: [
    { name: '_PnWard', properties: [{ name: 'name', type: 'String' }] },
    { name: NEAR, properties: [{ name: 'name', type: 'String' }] },
    { name: MID, properties: [{ name: 'commentary', type: 'String' }] },
  ],
  linkTypes: [],
} as OntologySchema;

describeWithPg('catalog lookups by physical name (PostgreSQL integration)', () => {
  let provider: PostgresStorageProvider;
  let dataSchema: string;
  let seq = 0;

  beforeEach(async () => {
    const u = new URL(PG_TEST_URL!);
    dataSchema = `pn_${process.pid}_${++seq}`;
    provider = new PostgresStorageProvider({
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      database: u.pathname.replace(/^\//, ''),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      maxPoolSize: 4,
      dataSchema,
    });
    await provider.pool.query(`CREATE SCHEMA "${dataSchema}"`);
    await provider.applySchema(ctx, schema);
  });

  afterEach(async () => {
    try {
      await provider.pool.query(`DROP SCHEMA IF EXISTS "${dataSchema}" CASCADE`);
    } finally {
      await provider.close();
    }
  });

  for (const type of ['_PnWard', NEAR]) {
    const what = type === NEAR ? 'a type whose history table name is cut' : 'a type named with a leading underscore';
    it(`search without fields finds text in ${what}`, async () => {
      await provider.createObject(ctx, type, { name: 'Findable ward' });
      const result = await provider.searchObjects(ctx, type, { query: 'Findable' });
      expect(result.hits).toHaveLength(1);
    });

    it(`listIndexes sees an index on ${what}`, async () => {
      await provider.ensureIndex(ctx, type, { field: 'name', indexType: 'BTREE' });
      const indexes = await provider.listIndexes(ctx, type);
      expect(indexes.map((i) => i.field)).toContain('name');
    });

    it(`dropIndex removes the index on ${what}, and only that one`, async () => {
      await provider.ensureIndex(ctx, type, { field: 'name', indexType: 'BTREE' });
      const all = async () =>
        (await provider.pool.query<{ t: string; i: string }>(
          `SELECT tablename AS t, indexname AS i FROM pg_indexes WHERE schemaname = $1`,
          [dataSchema],
        )).rows.map((r) => `${r.t}/${r.i}`);
      const before = await all();
      await provider.dropIndex(ctx, type, 'name');
      const after = await all();
      // Exactly one index went, and it was on the object table itself.
      const gone = before.filter((x) => !after.includes(x));
      expect(gone).toHaveLength(1);
      const table = gone[0]!.split('/')[0]!;
      expect(table.endsWith('_hist') || table.endsWith('_history')).toBe(false);
      expect(await provider.listIndexes(ctx, type)).toEqual([]);
    });

    it(`writes and reads history for ${what}`, async () => {
      const obj = await provider.createObject(ctx, type, { name: 'v1' });
      await provider.updateObject(ctx, type, obj._id, { name: 'v2' });
      expect((await provider.getObjectAtVersion(ctx, type, obj._id, 1))?.['name']).toBe('v1');
    });
  }

  it('ensureIndex keeps an index an earlier release made under a cut name', async () => {
    const table = `"${dataSchema}"."pm${'x'.repeat(48)}"`;
    const legacy = `idx_pm${'x'.repeat(48)}_commentary_btree`; // 71 bytes: stored cut
    await provider.pool.query(`CREATE INDEX "${legacy}" ON ${table} USING btree ("commentary")`);
    const count = async () =>
      (await provider.pool.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexdef LIKE '%(commentary)%'`,
        [dataSchema],
      )).rows[0].n;
    expect(await count()).toBe(1);
    await provider.ensureIndex(ctx, MID, { field: 'commentary', indexType: 'BTREE' });
    expect(await count()).toBe(1);
    // A partial unique index under the legacy unique name does not stand in
    // for the unique index: it is made.
    await provider.pool.query(
      `CREATE UNIQUE INDEX "uq_pm${'x'.repeat(48)}_commentary" ON ${table} ("commentary") WHERE "commentary" IS NOT NULL`,
    );
    expect(await count()).toBe(2);
    await provider.ensureIndex(ctx, MID, { field: 'commentary', indexType: 'BTREE', unique: true });
    expect(await count()).toBe(3);
    await provider.dropIndex(ctx, MID, 'commentary');
    expect(await count()).toBe(0);
  });

  it('keeps starting a version that was applied before the check existed', async () => {
    // Ward and _Ward with the same columns shared one table under the old
    // DDL. Record such a version as applied, the way an older release did.
    const legacy = {
      version: 7,
      objectTypes: [
        { name: 'PnWard', properties: [{ name: 'name', type: 'String' }] },
        { name: '_PnWard', properties: [{ name: 'name', type: 'String' }] },
      ],
      linkTypes: [],
    } as OntologySchema;
    const refused = provider.applySchema(ctx, legacy);
    await expect(refused).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Apply it with the check bypassed, as an older release would have.
    const typeMapping = await import('../schema/type-mapping.js');
    const spy = (await import('vitest')).vi.spyOn(typeMapping, 'assertDistinctPhysicalNames').mockImplementation(() => {});
    try {
      await provider.applySchema(ctx, legacy);
    } finally {
      spy.mockRestore();
    }
    // A restart applying the same version again succeeds.
    await expect(provider.applySchema(ctx, legacy)).resolves.toMatchObject({ success: true, toVersion: 7 });
  });

  it('refuses a schema whose tables would share a stored name', async () => {
    const tooLong = { version: 2, objectTypes: [...schema.objectTypes, { name: LONG, properties: [] }], linkTypes: [] };
    await expect(provider.applySchema(ctx, tooLong as OntologySchema)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const clash = { version: 2, objectTypes: [...schema.objectTypes, { name: 'PnWard', properties: [] }], linkTypes: [] };
    await expect(provider.applySchema(ctx, clash as OntologySchema)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
