/**
 * Integration test: named search on a database whose encoding is not UTF-8.
 *
 * PostgreSQL cuts an identifier to 63 bytes in the database's encoding.
 * Named search resolves a field to a column by its stored name; computing
 * that cut client-side in UTF-8 picked a different column on a LATIN1
 * database, where `é` is one byte, not two. The server now does the cut.
 *
 * Requires PostgreSQL with Apache AGE, and rights to create a database. Set
 * PG_TEST_URL or this test is skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-latin1', actorId: 'test-actor' };

// In LATIN1 these are 62 and 63 bytes: two columns. In UTF-8 the second is
// 65 bytes, and its 63-byte cut is the first.
const SHORT = 'a'.repeat(61) + 'é';
const LONG = 'a'.repeat(61) + 'éé';

describeWithPg('named search on a LATIN1 database (PostgreSQL integration)', () => {
  const db = `of_latin1_${process.pid}`;
  let admin: pg.Pool;
  let provider: PostgresStorageProvider;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: PG_TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db} ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    const u = new URL(PG_TEST_URL!);
    provider = new PostgresStorageProvider({
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      database: db,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      maxPoolSize: 2,
    });
    await provider.pool.query('CREATE EXTENSION IF NOT EXISTS age');
    await provider.applySchema(ctx, {
      version: 1,
      objectTypes: [{ name: 'L1Ward', properties: [{ name: 'name', type: 'String' }] }],
      linkTypes: [],
    } as OntologySchema);
    for (const t of ['l1_ward', 'l1_ward_history']) {
      await provider.pool.query(`ALTER TABLE ${t} ADD COLUMN "${SHORT}" TEXT, ADD COLUMN "${LONG}" TEXT`);
    }
    await provider.createObject(ctx, 'L1Ward', { name: 'North' });
    await provider.pool.query(`UPDATE l1_ward SET "${SHORT}" = 'other', "${LONG}" = 'needle'`);
  });

  afterAll(async () => {
    await provider?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  });

  it('a long non-ASCII field name reaches the column PostgreSQL stored for it', async () => {
    const hits = async (field: string, query: string) =>
      (await provider.searchObjects(ctx, 'L1Ward', { query, fields: [field] })).hits.length;
    expect(await hits(LONG, 'needle')).toBe(1);
    expect(await hits(SHORT, 'needle')).toBe(0);
    expect(await hits(SHORT, 'other')).toBe(1);
  });
});
