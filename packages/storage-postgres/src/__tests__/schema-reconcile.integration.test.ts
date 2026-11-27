/**
 * Integration tests: columns of properties added after their table was created
 * are added atomically, under the migration lock.
 *
 * An object table and its history table must gain a column together. Added by
 * separate autocommitted ALTERs, a write between them commits its object row
 * and then fails its history insert. The already-applied path used to run its
 * ALTERs straight on the pool; it now hands them to the locked path, which
 * runs them on one client inside one transaction.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-reconcile', actorId: 'test-actor' };

const v1: OntologySchema = {
  version: 1,
  objectTypes: [{ name: 'RcItem', properties: [{ name: 'name', type: 'String' }] }],
  linkTypes: [],
} as OntologySchema;

const v2: OntologySchema = {
  ...v1,
  version: 2,
  objectTypes: [
    {
      name: 'RcItem',
      properties: [
        { name: 'name', type: 'String' },
        { name: 'colour', type: 'String' },
      ],
    },
  ],
} as OntologySchema;

describeWithPg('column reconciliation (PostgreSQL integration)', () => {
  let provider: PostgresStorageProvider;
  let dataSchema: string;
  let seq = 0;

  function makeProvider(): PostgresStorageProvider {
    const u = new URL(PG_TEST_URL!);
    return new PostgresStorageProvider({
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      database: u.pathname.replace(/^\//, ''),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      maxPoolSize: 4,
      dataSchema,
    });
  }

  async function columns(table: string): Promise<string[]> {
    const r = await provider.pool.query<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [dataSchema, table],
    );
    return r.rows.map((x) => x.c);
  }

  beforeEach(async () => {
    dataSchema = `rc_${process.pid}_${++seq}`;
    provider = makeProvider();
    await provider.pool.query(`CREATE SCHEMA "${dataSchema}"`);
  });

  afterEach(async () => {
    try {
      await provider.pool.query(`DROP SCHEMA IF EXISTS "${dataSchema}" CASCADE`);
    } finally {
      await provider.close();
    }
  });

  it('an applied version with a missing column gets it on both tables, in one transaction', async () => {
    await provider.applySchema(ctx, v1);
    await provider.applySchema(ctx, v2);
    // The state reconciliation exists for: v2 recorded as applied, its column
    // missing (as on a database v2 reached before reconciliation existed).
    await provider.pool.query(`ALTER TABLE "${dataSchema}"."rc_item" DROP COLUMN "colour"`);
    await provider.pool.query(`ALTER TABLE "${dataSchema}"."rc_item_history" DROP COLUMN "colour"`);

    // A fresh provider, as at the next start-up. Record what goes straight to
    // the pool, outside any transaction of its own.
    await provider.close();
    provider = makeProvider();
    const onPool: string[] = [];
    const onClient: string[] = [];
    const pool = provider.pool as unknown as {
      query: (...a: unknown[]) => unknown;
      connect: (...a: unknown[]) => Promise<{ query: (...a: unknown[]) => unknown }>;
    };
    const original = pool.query.bind(pool);
    pool.query = (...a: unknown[]) => {
      if (typeof a[0] === 'string') onPool.push(a[0]);
      return original(...a);
    };
    const connect = pool.connect.bind(pool);
    pool.connect = async (...a: unknown[]) => {
      const client = await connect(...a);
      if (a.length === 0) {
        const query = client.query.bind(client);
        client.query = (...q: unknown[]) => {
          if (typeof q[0] === 'string') onClient.push(q[0]);
          return query(...q);
        };
      }
      return client;
    };

    await expect(provider.applySchema(ctx, v2)).resolves.toMatchObject({ success: true, toVersion: 2 });

    // On the migration client: BEGIN (READ COMMITTED), the advisory lock, both
    // ALTERs, then COMMIT.
    const at = (re: RegExp) => onClient.findIndex((s) => re.test(s));
    const alters = onClient.filter((s) => /^\s*ALTER TABLE/i.test(s) && s.includes(`"${dataSchema}"`));
    expect(alters).toHaveLength(2);
    expect(onClient[at(/^BEGIN/)]).toMatch(/READ COMMITTED/);
    expect(at(/^BEGIN/)).toBeLessThan(at(/pg_advisory_xact_lock/));
    expect(at(/pg_advisory_xact_lock/)).toBeLessThan(onClient.indexOf(alters[0]!));
    expect(onClient.indexOf(alters[1]!)).toBeLessThan(at(/^COMMIT/));

    // (The platform's consent DDL has idempotent ALTERs of its own; only the
    // data schema's tables are at issue.)
    expect(onPool.filter((s) => /^\s*ALTER TABLE/i.test(s) && s.includes(`"${dataSchema}"`))).toEqual([]);
    expect(await columns('rc_item')).toContain('colour');
    expect(await columns('rc_item_history')).toContain('colour');
    const created = await provider.createObject(ctx, 'RcItem', { name: 'a', colour: 'red' });
    expect((await provider.getObject(ctx, 'RcItem', created._id))!['colour']).toBe('red');
  });

  it('a start-up with nothing missing takes no migration lock', async () => {
    await provider.applySchema(ctx, v2);
    await provider.close();
    provider = makeProvider();
    const onPool: string[] = [];
    const pool = provider.pool as unknown as { query: (...a: unknown[]) => unknown; connect: (...a: unknown[]) => unknown };
    const original = pool.query.bind(pool);
    pool.query = (...a: unknown[]) => {
      if (typeof a[0] === 'string') onPool.push(a[0]);
      return original(...a);
    };
    let connects = 0;
    const connect = pool.connect.bind(pool);
    // pool.query checks a client out with a callback; a dedicated client (the
    // migration's) is checked out without one.
    pool.connect = (...a: unknown[]) => {
      if (a.length === 0) connects++;
      return connect(...a);
    };

    await provider.applySchema(ctx, v2);

    expect(connects).toBe(0);
    expect(onPool.some((s) => /pg_advisory/.test(s))).toBe(false);
  });
});
