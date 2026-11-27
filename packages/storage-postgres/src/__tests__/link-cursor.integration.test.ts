/**
 * Integration tests: getLinks cursors keep PostgreSQL's full timestamp.
 *
 * A link's _createdAt is returned with millisecond precision, but the column
 * has microseconds, and links made in one transaction share one timestamp.
 * A cursor built from the returned timestamp would re-read or skip links in
 * either case; the cursor carries the column's exact value instead.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-link-cursor', actorId: 'test-actor' };

const schema: OntologySchema = {
  version: 1,
  objectTypes: [
    { name: 'LcWard', properties: [{ name: 'name', type: 'String' }] },
    { name: 'LcBed', properties: [{ name: 'label', type: 'String' }] },
  ],
  linkTypes: [
    { name: 'LcBedInWard', fromType: 'LcBed', toType: 'LcWard', cardinality: 'MANY_TO_MANY', properties: [{ name: 'id', type: 'ID' }] },
  ],
} as OntologySchema;

describeWithPg('getLinks cursors (PostgreSQL integration)', () => {
  let provider: PostgresStorageProvider;
  let dataSchema: string;
  let seq = 0;

  beforeEach(async () => {
    const u = new URL(PG_TEST_URL!);
    dataSchema = `lc_${process.pid}_${++seq}`;
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

  async function readAll(bed: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await provider.getLinks(ctx, bed, 'LcBedInWard', 'outbound', { limit, ...(after ? { after } : {}) });
      ids.push(...page.items.map((l) => l._id));
      if (!page.hasNextPage) return ids;
      after = page.cursor;
    }
    throw new Error('cursor paging did not end');
  }

  it('pages links within one millisecond, and links sharing one timestamp, exactly once', async () => {
    const bed = await provider.createObject(ctx, 'LcBed', { label: 'B' });
    const ward = await provider.createObject(ctx, 'LcWard', { name: 'W' });
    for (let i = 0; i < 6; i++) await provider.createLink(ctx, 'LcBedInWard', bed._id, ward._id);
    // Three links 100 µs apart within one millisecond, three on one instant.
    await provider.pool.query(
      `UPDATE "${dataSchema}"."lc_bed_in_ward" t SET "_created_at" = '2026-01-01T00:00:00.000Z'::timestamptz
         + (CASE WHEN s.n <= 3 THEN s.n * 100 ELSE 500 END) * INTERVAL '1 microsecond'
         FROM (SELECT "_id", row_number() OVER (ORDER BY "_id") AS n FROM "${dataSchema}"."lc_bed_in_ward") s
        WHERE t."_id" = s."_id"`,
    );
    const all = (await provider.getLinks(ctx, bed._id, 'LcBedInWard', 'outbound', { limit: 1000 })).items.map((l) => l._id);
    expect(new Set(all.map((id) => id)).size).toBe(6);
    for (const limit of [1, 2, 4]) expect(await readAll(bed._id, limit)).toEqual(all);
  });

  it('reports a next page when a link commits between the count and the page', async () => {
    const bed = await provider.createObject(ctx, 'LcBed', { label: 'B' });
    const ward = await provider.createObject(ctx, 'LcWard', { name: 'W' });
    await provider.createLink(ctx, 'LcBedInWard', bed._id, ward._id);
    const table = `"${dataSchema}"."lc_bed_in_ward"`;
    // Right after getLinks counts (one link), another link commits that sorts
    // first: the page then holds it, and the counted link moves to page two.
    const pool = provider.pool as unknown as { query: (...a: unknown[]) => Promise<unknown> };
    const query = pool.query.bind(pool);
    let injected = false;
    pool.query = async (...a: unknown[]) => {
      const result = await query(...a);
      if (!injected && typeof a[0] === 'string' && a[0].startsWith('SELECT COUNT(*) AS cnt') && a[0].includes(table)) {
        injected = true;
        const other = await provider.pool.connect();
        try {
          await other.query(
            `INSERT INTO ${table} ("_tenant_id", "_id", "_type", "_from_type", "_from_id", "_to_type", "_to_id",
                                    "_version", "_created_at", "_updated_at", "id")
             SELECT "_tenant_id", 'early', "_type", "_from_type", "_from_id", "_to_type", "_to_id",
                    "_version", "_created_at" - INTERVAL '1 second', "_updated_at", 'early' FROM ${table} LIMIT 1`,
          );
        } finally {
          other.release();
        }
      }
      return result;
    };

    const first = await provider.getLinks(ctx, bed._id, 'LcBedInWard', 'outbound', { limit: 1 });
    expect(injected).toBe(true);
    expect(first.totalCount).toBe(1);
    expect(first.items.map((l) => l._id)).toEqual(['early']);
    expect(first.hasNextPage).toBe(true);
    const rest = await provider.getLinks(ctx, bed._id, 'LcBedInWard', 'outbound', { limit: 1, after: first.cursor });
    expect(rest.items).toHaveLength(1);
    expect(rest.hasNextPage).toBe(false);
  });
});
