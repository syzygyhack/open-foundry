/**
 * PostgreSQL transaction wrapper.
 *
 * Wraps a pg PoolClient in a BEGIN/COMMIT/ROLLBACK lifecycle.
 * All CRUD operations accept an optional PgTransaction to participate
 * in the same database transaction.
 */

import type { PoolClient, Pool } from 'pg';

/** Thin wrapper around a pg PoolClient with transaction lifecycle. */
export class PgTransaction {
  private _committed = false;
  private _rolledBack = false;
  /** COMMIT did not commit: the server rolled back, or the query failed. */
  private _failed = false;
  private _client: PoolClient;

  private constructor(client: PoolClient) {
    this._client = client;
  }

  /** Begin a new transaction and return the wrapper. */
  static async begin(pool: Pool, isolationLevel?: string): Promise<PgTransaction> {
    const client = await pool.connect();
    try {
      const level = isolationLevel ?? 'READ COMMITTED';
      await client.query(`BEGIN ISOLATION LEVEL ${level}`);
      return new PgTransaction(client);
    } catch (err) {
      client.release();
      throw err;
    }
  }

  /**
   * Access the underlying PoolClient for queries within this transaction.
   * Operations on one transaction must be awaited in turn, not run
   * concurrently: the client is a single session.
   */
  get client(): PoolClient {
    this.assertOpen();
    return this._client;
  }

  /**
   * Commit and release the client back to the pool. Throws if nothing was
   * committed; the transaction is then finished, and a following rollback()
   * is a no-op, so a caller's cleanup cannot mask the commit error.
   */
  async commit(): Promise<void> {
    this.assertOpen();
    let result: { command: string } | undefined;
    let error: unknown;
    try {
      result = await this._client.query('COMMIT');
    } catch (err) {
      error = err;
    }
    // COMMIT on a transaction that already hit an error does not fail: the
    // server rolls back and answers with the command tag ROLLBACK. Treating
    // that as success reported writes that were never stored.
    const aborted = error === undefined && result?.command === 'ROLLBACK';
    if (error === undefined && !aborted) {
      this._committed = true;
      this._client.release();
      return;
    }
    this._failed = true;
    // A failed COMMIT query leaves the session in an unknown state: discard it.
    this._client.release(error !== undefined);
    if (aborted) {
      throw new Error('Transaction was aborted by an earlier error and has been rolled back; nothing was committed');
    }
    throw error;
  }

  /**
   * Rollback and release the client back to the pool. The transaction is
   * finished either way. If ROLLBACK itself fails, the session's state is
   * unknown (it may still be in the transaction), so the client is discarded
   * rather than returned to the pool, and the error is thrown.
   */
  async rollback(): Promise<void> {
    // After a failed commit there is nothing left to roll back.
    if (this._failed) return;
    this.assertOpen();
    let error: unknown;
    try {
      await this._client.query('ROLLBACK');
    } catch (err) {
      error = err;
    }
    this._rolledBack = true;
    this._client.release(error !== undefined);
    if (error !== undefined) throw error;
  }

  get isOpen(): boolean {
    return !this._committed && !this._rolledBack && !this._failed;
  }

  private assertOpen(): void {
    if (this._committed) throw new Error('Transaction already committed');
    if (this._rolledBack) throw new Error('Transaction already rolled back');
    if (this._failed) throw new Error('Transaction already finished: its commit failed');
  }
}

/**
 * Helper type: something that can execute parameterized queries.
 * Either a Pool (auto-connect) or a PoolClient (within a transaction).
 */
export type Queryable = Pool | PoolClient;

/**
 * Resolve the queryable from an optional PgTransaction.
 * If a transaction is provided, use its client; otherwise use the pool.
 */
export function resolveQueryable(pool: Pool, tx?: PgTransaction): Queryable {
  return tx ? tx.client : pool;
}

/** Deadlock and serialization failure: the transaction can simply be rerun. */
const RERUNNABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

/**
 * Run fn in a transaction: the caller's, or else one of its own that commits
 * when fn resolves and rolls back when it throws. For operations whose
 * statements must be atomic (and whose row locks must last) even when called
 * outside a transaction.
 *
 * Its own transaction is rerun, up to three attempts in all, when Postgres
 * aborts it as a deadlock victim or for a serialization failure: row locks
 * (createLink's on both endpoints, for one) can meet a concurrent transaction
 * locking the same rows in the other order, and the victim has done nothing
 * that a rerun would duplicate. In a caller's transaction the error is the
 * caller's to handle: only the whole transaction can be rerun.
 */
export async function withTransaction<T>(
  pool: Pool,
  tx: PgTransaction | undefined,
  fn: (q: PoolClient) => Promise<T>,
): Promise<T> {
  if (tx) return fn(tx.client);
  for (let attempt = 1; ; attempt++) {
    const own = await PgTransaction.begin(pool);
    try {
      const result = await fn(own.client);
      await own.commit();
      return result;
    } catch (err) {
      if (own.isOpen) await own.rollback().catch(() => undefined);
      const code = (err as { code?: unknown } | null)?.code;
      if (attempt < MAX_ATTEMPTS && typeof code === 'string' && RERUNNABLE.has(code)) continue;
      throw err;
    }
  }
}
