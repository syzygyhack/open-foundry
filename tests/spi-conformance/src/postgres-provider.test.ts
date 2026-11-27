/**
 * SPI Conformance Suite - PostgreSQL Provider
 *
 * Runs the full conformance suite against PostgresStorageProvider, so both
 * providers are held to one contract. Requires PostgreSQL with Apache AGE; set
 * PG_TEST_URL or the suite is skipped (as in storage-postgres' own tests):
 *
 *   PG_TEST_URL=postgresql://postgres:postgres@localhost:5432/openfoundry_test pnpm test
 *
 * Every factory call gets its own data schema, so each test starts with empty
 * object and link tables and its own migration ledger. The previous provider is
 * closed and its schema dropped. Two stores sit outside the data schema: the
 * lineage table, from which the conformance tenants' rows are deleted between
 * tests, and the shared AGE mirror graph, which is left to accumulate (nothing
 * reads it; traversal is SQL over the link tables).
 */

import { afterAll, describe } from 'vitest';
import { PostgresStorageProvider } from '@openfoundry/storage-postgres';
import { runConformanceSuite } from './suite.js';
import type { KnownFailures } from './known-failures.js';
import { tenantA, tenantB, tenantC } from './fixtures.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

/**
 * Divergences from the contract still to be decided or fixed. Each runs; a
 * matching failure is reported as skipped, any other outcome fails the run.
 */
const knownFailures: KnownFailures = {
  'CRUD > getObject > returns null for non-existent type': {
    reason: 'Postgres throws (relation does not exist) where memory returns null; undecided which is the contract.',
    error: /^relation "[^"]+\.non_existent_type" does not exist$/,
  },
  'Queries > filter: eq > on non-existent field returns empty': {
    reason: 'Postgres throws (column does not exist) where memory returns no rows; undecided which is the contract.',
    error: /^column "nonexistent" does not exist$/,
  },
};

if (!PG_TEST_URL) {
  describe.skip('PostgresStorageProvider SPI conformance (PG_TEST_URL not set)', () => {});
} else {
  const u = new URL(PG_TEST_URL);
  const config = {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    maxPoolSize: 4,
  };
  const tenants = [tenantA, tenantB, tenantC].map((t) => t.tenantId);

  let seq = 0;
  let current: { provider: PostgresStorageProvider; schema: string } | undefined;

  async function retire(): Promise<void> {
    if (!current) return;
    const { provider, schema } = current;
    current = undefined;
    try {
      await provider.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await provider.close();
    }
  }

  const factory = async (): Promise<PostgresStorageProvider> => {
    await retire();
    const schema = `spi_conf_${process.pid}_${++seq}`;
    const provider = new PostgresStorageProvider({ ...config, dataSchema: schema });
    let created = false;
    try {
      // No IF NOT EXISTS: on a name collision, fail rather than adopt (and
      // later drop) a schema this run did not create.
      await provider.pool.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      // Lineage is tenant-keyed and shared across data schemas: clear only
      // the conformance tenants' rows, so nothing else in the database is hit.
      const lineage = await provider.pool.query<{ t: string | null }>(
        `SELECT to_regclass('lineage.field_provenance')::text AS t`,
      );
      if (lineage.rows[0]?.t) {
        await provider.pool.query(
          `DELETE FROM lineage.field_provenance WHERE tenant_id = ANY($1)`,
          [tenants],
        );
      }
    } catch (err) {
      if (created) {
        await provider.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      }
      await provider.close();
      throw err;
    }
    current = { provider, schema };
    return provider;
  };

  afterAll(retire);

  runConformanceSuite('PostgresStorageProvider', factory, { knownFailures });
}
