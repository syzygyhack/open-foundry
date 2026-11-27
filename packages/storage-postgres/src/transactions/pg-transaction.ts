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

  /** Rollback and release the client back to the pool. */
  async rollback(): Promise<void> {
    // After a failed commit there is nothing left to roll back.
    if (this._failed) return;
    this.assertOpen();
    try {
      await this._client.query('ROLLBACK');
      this._rolledBack = true;
    } finally {
      this._client.release();
    }
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
