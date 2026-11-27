/**
 * Best-effort writes to the Apache AGE mirror graph.
 *
 * Nothing reads the graph yet (traversal is SQL over the link tables), so a
 * failed mirror write is logged and swallowed. It must never cost the caller's
 * SQL write, and must never leave a setting on a pooled connection.
 */

import type { Pool, PoolClient } from 'pg';
import { createLogger } from '@openfoundry/observability';

const logger = createLogger('storage-postgres');

export const GRAPH_NAME = 'openfoundry';

let savepointSeq = 0;

function inTransaction(q: Pool | PoolClient): q is PoolClient {
  // CRUD helpers receive the pool (autocommit) or a PgTransaction's client.
  return typeof (q as PoolClient).release === 'function';
}

/**
 * Run one Cypher statement against the mirror graph.
 *
 * AGE resolves its operators (agtype @>, =) through search_path, so qualifying
 * cypher() is not enough: MATCH on a property map fails without ag_catalog on
 * the path. SET LOCAL and the query go in one simple-protocol message, so they
 * share one connection and one transaction (implicit, or the caller's).
 *
 * AGE need not be preloaded. Without preloading, a fresh session's first
 * cypher() fails, because AGE rewrites cypher() through a parser hook its
 * library installs when loaded. The message therefore starts with AGE_WARM,
 * which loads it. The helper does not run LOAD 'age': PostgreSQL checks LOAD's
 * privilege before noticing the library is loaded, so a non-superuser runtime
 * role gets "access to library "age" is not allowed" even where AGE is
 * preloaded.
 *
 * Inside a caller's transaction:
 * - The statement runs under a savepoint, created before the write is sent.
 *   Without one, a Cypher error aborts the whole transaction: every later
 *   statement then fails, and COMMIT quietly rolls back the caller's SQL
 *   write. Because the savepoint already exists, any failure of the write, a
 *   parse error of the whole message included, has a savepoint to return to.
 *   If the savepoint is refused, the transaction was already aborted by other
 *   SQL; the write is dropped and the abort left for COMMIT to report.
 * - The caller's search_path is read under the savepoint and restored before
 *   RELEASE. SET LOCAL survives RELEASE SAVEPOINT, so the rest of the caller's
 *   transaction would otherwise resolve unqualified names in ag_catalog.
 * - Writes on one client run one at a time, recovery included. pg queues a
 *   client's queries in order, so two unawaited writes otherwise interleave
 *   and the second lands inside the first's failure. Callers must still await
 *   their writes before COMMIT or release: a write still queued then would
 *   run on a client that is no longer theirs.
 */
export async function ageQuery(q: Pool | PoolClient, cypher: string): Promise<void> {
  if (!inTransaction(q)) return runPooled(q, cypher);
  const previous = queues.get(q) ?? Promise.resolve();
  const run = previous.then(() => runInTransaction(q, cypher));
  // runInTransaction rejects only when recovery itself fails; later writes
  // still run.
  queues.set(q, run.catch(() => undefined));
  return run;
}

/** Per-client tail of the mirror-write queue. */
const queues = new WeakMap<PoolClient, Promise<void>>();

const AGE_PATH = `SET LOCAL search_path = ag_catalog, "$user", public`;

/**
 * Loads AGE into the session if it is not loaded yet, without LOAD: casting
 * to an AGE type calls into the library, whose load installs the parser hook
 * the cypher() call that follows in the same message needs. A no-op where AGE
 * is preloaded. Statements in one simple-protocol message are analysed one at
 * a time, just before each runs, so the hook is in place in time.
 */
const AGE_WARM = `SELECT '1'::ag_catalog.agtype`;

function cypherStatement(cypher: string): string {
  return `SELECT * FROM cypher('${GRAPH_NAME}', $$${cypher}$$) AS (v agtype)`;
}

async function runPooled(q: Pool | PoolClient, cypher: string): Promise<void> {
  try {
    await q.query(`${AGE_WARM}; ${AGE_PATH}; ${cypherStatement(cypher)}`);
  } catch (err) {
    warn(err);
  }
}

async function runInTransaction(q: PoolClient, cypher: string): Promise<void> {
  const savepoint = `of_age_mirror_${++savepointSeq}`;
  try {
    await q.query(`SAVEPOINT ${savepoint}`);
  } catch (err) {
    // Already aborted: nothing to protect, and no savepoint to return to.
    warn(err);
    return;
  }
  try {
    // Read under the savepoint, so that even this failing (it can, e.g. when
    // the path cannot be converted to the client encoding) is recoverable.
    const shown = await q.query<{ search_path: string }>('SHOW search_path');
    const previousPath = shown.rows[0]!.search_path;
    await q.query(
      `${AGE_WARM}; ${AGE_PATH}; ${cypherStatement(cypher)}; ` +
        `SELECT set_config('search_path', ${q.escapeLiteral(previousPath)}, true); ` +
        `RELEASE SAVEPOINT ${savepoint}`,
    );
  } catch (err) {
    // Undo only the failed mirror write, its SET LOCAL included. If even this
    // fails the transaction is beyond saving; let the caller see that.
    await q.query(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    warn(err);
  }
}

function warn(err: unknown): void {
  if (process.env.NODE_ENV !== 'test') {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'AGE graph operation failed');
  }
}
