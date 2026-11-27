/**
 * Integration tests: graph-mirror writes on a server that does not preload
 * Apache AGE (shared_preload_libraries without 'age', as on many managed or
 * external databases).
 *
 * There, AGE is loaded into a session only when something in it first calls
 * into the library. A cypher() call cannot be that first call: AGE rewrites
 * cypher() at parse analysis, through a hook its library installs, so on a
 * fresh session the first cypher() fails ("unhandled cypher(cstring) function
 * call") and the mirror write is lost. The helper therefore touches an AGE type
 * first in the same message. LOAD 'age' is not an option for the runtime role:
 * a non-superuser may not LOAD it at all.
 *
 * Requires a PostgreSQL with Apache AGE installed but NOT preloaded, e.g.
 *
 *   docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=openfoundry_test \
 *     -p 5433:5432 apache/age:release_PG17_1.6.0 postgres -c shared_preload_libraries=
 *
 * with the extension and the openfoundry graph created. Set
 * PG_NOPRELOAD_TEST_URL (a superuser URL) or these tests are skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ageQuery } from '../graph/age-query.js';

const URL_ = process.env['PG_NOPRELOAD_TEST_URL'];
const describeNoPreload = URL_ ? describe : describe.skip;

const ROLE = `of_age_rt_${process.pid}`;
const LABEL = 'SpNoPreload';

describeNoPreload('AGE mirror writes without preload (PostgreSQL integration)', () => {
  let admin: pg.Pool;
  let runtimeUrl: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_, max: 1 });
    const { rows } = await admin.query<{ p: string }>("SELECT current_setting('shared_preload_libraries') AS p");
    // The premise: on a server that preloads AGE these tests prove nothing.
    expect(rows[0]!.p).not.toMatch(/\bage\b/);
    // A runtime role that is not a superuser and has only graph access.
    await admin.query(`CREATE ROLE "${ROLE}" LOGIN PASSWORD 'rt'`);
    await admin.query(`GRANT USAGE ON SCHEMA ag_catalog, openfoundry TO "${ROLE}"`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ag_catalog TO "${ROLE}"`);
    // Labels are tables in the graph's schema; create ours ahead so the role
    // needs no CREATE privilege.
    await admin.query(
      `LOAD 'age'; SET search_path = ag_catalog, public; ` +
        `SELECT create_vlabel('openfoundry', '${LABEL}') WHERE NOT EXISTS (` +
        `SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph ` +
        `WHERE g.name = 'openfoundry' AND l.name = '${LABEL}')`,
    );
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA openfoundry TO "${ROLE}"`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA openfoundry TO "${ROLE}"`);
    const u = new URL(URL_!);
    u.username = ROLE;
    u.password = 'rt';
    runtimeUrl = u.toString();
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP OWNED BY "${ROLE}"`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => undefined);
    await admin.end();
  });

  async function markerCount(marker: string): Promise<number> {
    const res = (await admin.query(
      `LOAD 'age'; SET LOCAL search_path = ag_catalog, "$user", public; ` +
        `SELECT * FROM cypher('openfoundry', $$MATCH (m:${LABEL} {id: '${marker}'}) RETURN m$$) AS (v agtype)`,
    )) as unknown as Array<{ rows: unknown[] }>;
    return res[2]!.rows.length;
  }

  it('the first mirror write on a fresh pooled connection reaches the graph', async () => {
    // A new pool: its first query opens a fresh session.
    const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    const marker = `pooled-${process.pid}`;
    try {
      await ageQuery(pool, `CREATE (:${LABEL} {id: '${marker}'})`);
    } finally {
      await pool.end();
    }
    expect(await markerCount(marker)).toBe(1);
  });

  it('the first mirror write in a transaction on a fresh connection reaches the graph', async () => {
    const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    const marker = `tx-${process.pid}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ageQuery(client, `CREATE (:${LABEL} {id: '${marker}'})`);
      const done = await client.query('COMMIT');
      expect(done.command).toBe('COMMIT');
    } finally {
      client.release();
      await pool.end();
    }
    expect(await markerCount(marker)).toBe(1);
  });
});
