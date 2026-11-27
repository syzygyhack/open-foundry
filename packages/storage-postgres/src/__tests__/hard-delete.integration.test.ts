/**
 * Integration tests: hard delete removes an object's links even when a link
 * to it is being created at the same time.
 *
 * Without locking, createLink's endpoint check and its INSERT could straddle a
 * concurrent hard delete and leave a link to an object that no longer exists.
 * createLink now holds a share lock on both endpoints for its transaction, and
 * hard delete locks the object row before removing links.
 *
 * Requires PostgreSQL with Apache AGE. Set PG_TEST_URL or these tests are
 * skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OntologySchema, RequestContext } from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];
const describeWithPg = PG_TEST_URL ? describe : describe.skip;

const ctx: RequestContext = { tenantId: 'tenant-hard-delete', actorId: 'test-actor' };

const schema: OntologySchema = {
  version: 1,
  objectTypes: [
    { name: 'HdWard', properties: [{ name: 'name', type: 'String' }] },
    { name: 'HdBed', properties: [{ name: 'label', type: 'String' }] },
  ],
  linkTypes: [
    {
      name: 'HdBedInWard',
      fromType: 'HdBed',
      toType: 'HdWard',
      cardinality: 'MANY_TO_MANY',
      properties: [{ name: 'id', type: 'ID' }],
    },
  ],
} as OntologySchema;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeWithPg('hard delete vs concurrent createLink (PostgreSQL integration)', () => {
  let provider: PostgresStorageProvider;
  let dataSchema: string;
  let seq = 0;

  beforeEach(async () => {
    const u = new URL(PG_TEST_URL!);
    dataSchema = `hd_${process.pid}_${++seq}`;
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

  it('a delete that starts while a link to the object is uncommitted waits, then removes the link', async () => {
    const ward = await provider.createObject(ctx, 'HdWard', { name: 'A' });
    const bed = await provider.createObject(ctx, 'HdBed', { label: 'A1' });

    const tx = await provider.beginTransaction(ctx);
    let deleted = false;
    let del: Promise<void> | undefined;
    try {
      await tx.createLink('HdBedInWard', bed._id, ward._id);
      del = provider.deleteObject(ctx, 'HdWard', ward._id, 'hard').then(() => {
        deleted = true;
      });
      await sleep(300);
      // The delete is waiting for the link's transaction.
      expect(deleted).toBe(false);
      await tx.commit();
    } finally {
      await tx.rollback().catch(() => undefined);
    }
    await del;

    const left = await provider.getLinks(ctx, bed._id, 'HdBedInWard', 'outbound', { includeDeleted: true });
    expect(left.items).toHaveLength(0);
  });

  it('a link created while a delete of its endpoint is uncommitted waits, then is refused', async () => {
    const ward = await provider.createObject(ctx, 'HdWard', { name: 'B' });
    const bed = await provider.createObject(ctx, 'HdBed', { label: 'B1' });

    const tx = await provider.beginTransaction(ctx);
    let settled = false;
    let create: Promise<unknown> | undefined;
    try {
      await tx.deleteObject('HdWard', ward._id, 'hard');
      create = provider.createLink(ctx, 'HdBedInWard', bed._id, ward._id).finally(() => {
        settled = true;
      });
      // Observe the rejection later; do not let it go unhandled meanwhile.
      create.catch(() => undefined);
      await sleep(300);
      expect(settled).toBe(false);
      await tx.commit();
    } finally {
      await tx.rollback().catch(() => undefined);
    }
    await expect(create).rejects.toThrow(/does not exist/);

    const left = await provider.getLinks(ctx, bed._id, 'HdBedInWard', 'outbound', { includeDeleted: true });
    expect(left.items).toHaveLength(0);
  });

  it('a hard delete in a transaction above READ COMMITTED is refused, and changes nothing', async () => {
    const u = new URL(PG_TEST_URL!);
    const rr = new PostgresStorageProvider({
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      database: u.pathname.replace(/^\//, ''),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      maxPoolSize: 2,
      dataSchema,
      defaultIsolationLevel: 'REPEATABLE READ',
    });
    try {
      await rr.applySchema(ctx, schema);
      const ward = await rr.createObject(ctx, 'HdWard', { name: 'RR' });
      const bed = await rr.createObject(ctx, 'HdBed', { label: 'RR1' });
      const tx = await rr.beginTransaction(ctx);
      try {
        // The snapshot is taken here; a link committed after it would be
        // invisible to the delete's DELETE of the link rows.
        await tx.createObject('HdBed', { label: 'snapshot' });
        await expect(tx.deleteObject('HdWard', ward._id, 'hard')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        // Refused before doing anything: with the transaction still open, the
        // ward's row is neither locked nor deleted.
        const probe = await rr.pool.query(
          `SELECT "_id" FROM "${dataSchema}"."hd_ward" WHERE "_id" = $1 FOR UPDATE NOWAIT`,
          [ward._id],
        );
        expect(probe.rows).toHaveLength(1);
      } finally {
        await tx.rollback().catch(() => undefined);
      }
      // Outside a transaction it runs in its own (READ COMMITTED) one.
      await rr.createLink(ctx, 'HdBedInWard', bed._id, ward._id);
      await rr.deleteObject(ctx, 'HdWard', ward._id, 'hard');
      const left = await rr.getLinks(ctx, bed._id, 'HdBedInWard', 'outbound', { includeDeleted: true });
      expect(left.items).toHaveLength(0);
    } finally {
      await rr.close();
    }
  });

  /** Resolves once another backend waits on a lock in a statement matching `like`; throws after 5 s. */
  async function waitForLockWait(like: string): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const waiting = await provider.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE $1`,
        [like],
      );
      if (waiting.rows[0].n > 0) return;
      await sleep(20);
    }
    throw new Error(`no backend waited on a lock in a statement like ${like}`);
  }

  /** Wraps every client checked out of the pool (not pool.query's own). */
  function onCheckout(fn: (client: { query: (...a: unknown[]) => unknown }) => void): void {
    const pool = provider.pool as unknown as {
      connect: (...a: unknown[]) => Promise<{ query: (...a: unknown[]) => unknown }>;
    };
    const connect = pool.connect.bind(pool);
    // The pool hands the same client out again: wrap each one once.
    const seen = new WeakSet<object>();
    pool.connect = (async (...a: unknown[]) => {
      const client = await connect(...a);
      if (a.length === 0 && !seen.has(client)) {
        seen.add(client);
        fn(client);
      }
      return client;
    }) as typeof pool.connect;
  }

  it('a createLink chosen as a deadlock victim is rerun and succeeds', async () => {
    const ward = await provider.createObject(ctx, 'HdWard', { name: 'D' });
    const bed = await provider.createObject(ctx, 'HdBed', { label: 'D1' });
    const other = await provider.pool.connect();
    // Each attempt of createLink locks its endpoints FOR SHARE on its own client.
    let attempts = 0;
    onCheckout((client) => {
      const query = client.query.bind(client);
      client.query = (...a: unknown[]) => {
        if (typeof a[0] === 'string' && /FOR SHARE/i.test(a[0]) && a[0].includes('"hd_bed"')) attempts++;
        return query(...a);
      };
    });
    let create: Promise<unknown> | undefined;
    try {
      // Another transaction holds the ward (createLink's second lock) ...
      await other.query('BEGIN');
      await other.query(`UPDATE "${dataSchema}"."hd_ward" SET "name" = 'D2' WHERE "_id" = $1`, [ward._id]);
      // ... while createLink, holding the bed, waits for it ...
      create = provider.createLink(ctx, 'HdBedInWard', bed._id, ward._id);
      create.catch(() => undefined);
      await waitForLockWait('%FOR SHARE%');
      // ... and then wants the bed: a cycle. createLink began waiting first,
      // so its deadlock check fires first and it is the one aborted.
      await other.query(`UPDATE "${dataSchema}"."hd_bed" SET "label" = 'D3' WHERE "_id" = $1`, [bed._id]);
      await other.query('COMMIT');
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      other.release();
    }
    await expect(create).resolves.toMatchObject({ _fromId: bed._id, _toId: ward._id });
    // Aborted once, then rerun.
    expect(attempts).toBe(2);
  }, 15_000);

  it('an update racing a hard delete leaves no history of the deleted object', async () => {
    const ward = await provider.createObject(ctx, 'HdWard', { name: 'H' });
    const historyInsert = `INSERT INTO "${dataSchema}"."hd_ward_history"`;

    // Hold the update between its row write and its history insert.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const held = new Promise<void>((r) => (reached = r));
    let armed = true;
    const holdHistory = (target: { query: (...a: unknown[]) => unknown }): void => {
      const query = target.query.bind(target);
      target.query = (...a: unknown[]) => {
        if (armed && typeof a[0] === 'string' && a[0].trimStart().startsWith(historyInsert)) {
          armed = false;
          reached();
          return gate.then(() => query(...a));
        }
        return query(...a);
      };
    };
    holdHistory(provider.pool as unknown as { query: (...a: unknown[]) => unknown });
    onCheckout(holdHistory);

    const update = provider.updateObject(ctx, 'HdWard', ward._id, { name: 'H2' });
    update.catch(() => undefined);
    let del: Promise<void> | undefined;
    try {
      // Bounded: if the update never reaches its history insert, fail here.
      await Promise.race([
        held,
        sleep(5000).then(() => {
          throw new Error('the update never reached its history INSERT');
        }),
      ]);
      del = provider.deleteObject(ctx, 'HdWard', ward._id, 'hard');
      del.catch(() => undefined);
      // The delete must wait for the update's row lock (with autocommit writes
      // the row was already committed and the delete ran straight through).
      await waitForLockWait('%hd_ward%');
    } finally {
      // On any failure above, let both finish so no client stays checked out.
      release();
      await Promise.allSettled([update, del]);
    }
    await expect(update).resolves.toMatchObject({ _version: 2 });
    await del;

    const left = await provider.pool.query(
      `SELECT count(*)::int AS n FROM "${dataSchema}"."hd_ward_history" WHERE "_id" = $1`,
      [ward._id],
    );
    expect(left.rows[0].n).toBe(0);
    expect(await provider.getObjectAtVersion(ctx, 'HdWard', ward._id, 2)).toBeNull();
  }, 20_000);
});
