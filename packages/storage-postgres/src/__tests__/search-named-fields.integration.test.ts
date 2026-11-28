/**
 * Integration tests: a search's named fields are the table's real columns.
 *
 * Search turned each named field into a column with fieldColName and put it
 * straight into the query. A declared property whose name the DDL spells
 * differently (`_label` is column "label") failed with "column does not
 * exist", as did any name with no column; a column that is not text (an
 * INTEGER, a DATE, JSONB) failed with "operator does not exist". The API
 * reported each as a retryable internal error. Now the provider resolves the
 * names against the catalog: names that work keep working, and the rest are
 * VALIDATION_ERROR naming them.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-search-fields', actorId: 'test-actor' };

// snakeCase gives 72 bytes: PostgreSQL stores the column cut to 63.
const LONG = 'note' + 'X'.repeat(34);

const schema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'SfWard',
      properties: [
        { name: 'name', type: 'String' },
        { name: '_label', type: 'String' },
        { name: 'familyName', type: 'String' },
        { name: 'note', type: 'String' },
        { name: 'status', type: 'WardStatus' },
        { name: LONG, type: 'String' },
        { name: 'beds', type: 'Int' },
        { name: 'opened', type: 'Date' },
        { name: 'meta', type: 'JSON' },
      ],
    },
    // A declared property spelled like the system field: `fields=_id` must
    // still search the system column (the API checks `_id` as the primary).
    { name: 'SfBadge', properties: [{ name: '_id', type: 'String' }, { name: 'code', type: 'String' }] },
    { name: 'SfTag', properties: [{ name: 'label', type: 'String' }] },
  ],
  linkTypes: [],
} as OntologySchema;

describeWithPg('search on named fields (PostgreSQL integration)', () => {
  let provider: PostgresStorageProvider;
  let dataSchema: string;
  let seq = 0;

  beforeEach(async () => {
    const u = new URL(PG_TEST_URL!);
    dataSchema = `sf_${process.pid}_${++seq}`;
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
    // Columns the current schema does not declare: a retired text column and
    // a fixed-width one, both still matched by ILIKE.
    await provider.pool.query(
      `CREATE DOMAIN "${dataSchema}".flag1 AS "char"; CREATE DOMAIN "${dataSchema}".flag2 AS "${dataSchema}".flag1`,
    );
    for (const t of ['sf_ward', 'sf_ward_history']) {
      await provider.pool.query(
        `ALTER TABLE "${dataSchema}".${t} ADD COLUMN legacy_note TEXT, ADD COLUMN code CHAR(6), ADD COLUMN flag "char", ADD COLUMN nested_flag "${dataSchema}".flag2, ADD COLUMN "Note" TEXT`,
      );
    }
    await provider.createObject(ctx, 'SfWard', {
      name: 'North', _label: 'Findme', familyName: 'Findme', status: 'FINDME', [LONG]: 'Findme',
      beds: 12, opened: '2026-02-01', meta: { wing: 'Findme' },
    });
    await provider.createObject(ctx, 'SfWard', { name: 'South', beds: 4 });
    await provider.pool.query(
      `UPDATE "${dataSchema}".sf_ward SET legacy_note = 'findme', code = 'FINDME', flag = 'Q', nested_flag = 'Q', "Note" = 'quotedonly' WHERE name = 'North'`,
    );
  });

  afterEach(async () => {
    try {
      await provider.pool.query(`DROP SCHEMA IF EXISTS "${dataSchema}" CASCADE`);
    } finally {
      await provider.close();
    }
  });

  const names = async (fields: string[], query = 'findme') =>
    (await provider.searchObjects(ctx, 'SfWard', { query, fields })).hits.map((h) => h.object['name']);

  it('a declared property whose column the DDL spells differently is searched', async () => {
    expect(await names(['_label'])).toEqual(['North']);
  });

  it('names that searched before still do: aliases, system fields, enums, long, legacy and fixed-width columns', async () => {
    for (const f of ['label', 'familyName', 'family_name', 'status', LONG, 'legacy_note', 'legacyNote', 'code']) {
      expect(await names([f]), f).toEqual(['North']);
    }
    expect(await names(['flag'], 'q')).toEqual(['North']);
    expect(await names(['nested_flag'], 'q')).toEqual(['North']);
    expect(await names(['_type'], 'sfward')).toHaveLength(2);
    expect(await names(['_tenantId'], 'search-fields')).toHaveLength(2);
    const north = (await provider.searchObjects(ctx, 'SfWard', { query: 'north', fields: ['name'] })).hits[0]!.object;
    expect(await names(['_id'], north._id)).toEqual(['North']);
  });

  it('a declared property spelled like a system field does not take its place', async () => {
    const badge = await provider.createObject(ctx, 'SfBadge', { _id: 'hidden-value', code: 'b1' } as never);
    const byId = (query: string) => provider.searchObjects(ctx, 'SfBadge', { query, fields: ['_id'] });
    expect((await byId('hidden-value')).hits).toHaveLength(0);
    expect((await byId(badge._id)).hits).toHaveLength(1);
  });

  it('a declared name sharing its column with another declared property is not resolved to it', async () => {
    await provider.createObject(ctx, 'SfTag', { label: 'sample' });
    // A later version declares `_label` too; its column ("label") exists, so
    // the two properties now share it.
    const v2 = structuredClone(schema);
    v2.version = 2;
    v2.objectTypes.find((t) => t.name === 'SfTag')!.properties.push({ name: '_label', type: 'String' } as never);
    await provider.applySchema(ctx, v2);
    const tag = (fields: string[]) => provider.searchObjects(ctx, 'SfTag', { query: 'sample', fields });
    expect((await tag(['label'])).hits).toHaveLength(1);
    await expect(tag(['_label'])).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { unknownFields: ['_label'] } });
  });

  it('a name with no column, or a column that is not text, is VALIDATION_ERROR naming them', async () => {
    for (const f of ['nosuch', 'beds', 'opened', 'meta', '_version', '_createdAt']) {
      await expect(names([f]), f).rejects.toMatchObject({ code: 'VALIDATION_ERROR', category: 'validation', retryable: false });
    }
    await expect(names(['name', 'nosuch', 'beds'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { unknownFields: ['nosuch'], nonTextFields: ['beds'] },
      message: expect.stringContaining('nosuch (no such field), beds (not a text field)'),
    });
  });

  it('the default still searches the text columns, and a page of none still counts the hits', async () => {
    const all = await provider.searchObjects(ctx, 'SfWard', { query: 'findme' });
    expect(all.hits.map((h) => h.object['name'])).toEqual(['North']);
    // The default names columns as it always has: a quoted "Note" column is
    // looked up as note (which exists here), so its value is not matched.
    expect((await provider.searchObjects(ctx, 'SfWard', { query: 'quotedonly' })).hits).toHaveLength(0);
    const none = await provider.searchObjects(ctx, 'SfWard', { query: 'findme', limit: 0, offset: 0 });
    expect(none.hits).toHaveLength(0);
    expect(none.totalCount).toBe(1);
    expect(none.hasNextPage).toBe(true);
  });
});
