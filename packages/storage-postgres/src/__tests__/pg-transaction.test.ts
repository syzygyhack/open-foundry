/**
 * Tests for PgTransaction — transaction lifecycle (BEGIN/COMMIT/ROLLBACK).
 *
 * Validates:
 * - begin() acquires a client and issues BEGIN
 * - commit() issues COMMIT and releases the client
 * - rollback() issues ROLLBACK and releases the client
 * - Client is always released even on error (finally semantics)
 * - State transitions: committed/rolledBack flags
 * - assertOpen() throws after commit/rollback
 * - resolveQueryable() returns correct queryable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgTransaction, resolveQueryable } from '../transactions/pg-transaction.js';
import type { Pool, PoolClient } from 'pg';

// ── Mock helpers ───────────────────────────────────────────────────

function createMockClient(): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function createMockPool(client?: PoolClient): Pool {
  const mockClient = client ?? createMockClient();
  return {
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as Pool;
}

// ════════════════════════════════════════════════════════════════════

describe('PgTransaction', () => {
  let mockClient: PoolClient;
  let mockPool: Pool;

  beforeEach(() => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
  });

  // ── begin() ────────────────────────────────────────────────────

  describe('begin()', () => {
    it('acquires a client from the pool and issues BEGIN', async () => {
      const tx = await PgTransaction.begin(mockPool);

      expect(mockPool.connect).toHaveBeenCalledOnce();
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL READ COMMITTED');
      expect(tx.isOpen).toBe(true);
    });

    it('releases client if BEGIN fails', async () => {
      (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('BEGIN failed'),
      );

      await expect(PgTransaction.begin(mockPool)).rejects.toThrow('BEGIN failed');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('re-throws the original error on BEGIN failure', async () => {
      const error = new Error('connection reset');
      (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

      await expect(PgTransaction.begin(mockPool)).rejects.toBe(error);
    });
  });

  // ── commit() ───────────────────────────────────────────────────

  describe('commit()', () => {
    it('issues COMMIT and releases the client', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.commit();

      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalledOnce();
      expect(tx.isOpen).toBe(false);
    });

    it('releases client even if COMMIT fails', async () => {
      const tx = await PgTransaction.begin(mockPool);
      (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('COMMIT failed'),
      );

      await expect(tx.commit()).rejects.toThrow('COMMIT failed');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('a failed COMMIT finishes the transaction and discards the client', async () => {
      const tx = await PgTransaction.begin(mockPool);
      (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection lost'));

      await expect(tx.commit()).rejects.toThrow('connection lost');
      // Session state is unknown after a failed COMMIT: destroy, do not pool.
      expect(mockClient.release).toHaveBeenCalledWith(true);
      expect(tx.isOpen).toBe(false);
      // The caller's cleanup (rollback in a catch) must not mask the error or
      // touch the released client.
      await expect(tx.rollback()).resolves.toBeUndefined();
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('COMMIT answered with ROLLBACK throws, and the following rollback is a no-op', async () => {
      const tx = await PgTransaction.begin(mockPool);
      (mockClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ command: 'ROLLBACK', rows: [] });

      await expect(tx.commit()).rejects.toThrow(/aborted/);
      expect(tx.isOpen).toBe(false);
      await expect(tx.rollback()).resolves.toBeUndefined();
      expect(mockClient.release).toHaveBeenCalledOnce();
      await expect(tx.commit()).rejects.toThrow(/already finished/);
    });

    it('throws if transaction already committed', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.commit();

      await expect(tx.commit()).rejects.toThrow('Transaction already committed');
    });

    it('throws if transaction already rolled back', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.rollback();

      await expect(tx.commit()).rejects.toThrow('Transaction already rolled back');
    });
  });

  // ── rollback() ─────────────────────────────────────────────────

  describe('rollback()', () => {
    it('issues ROLLBACK and releases the client', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.rollback();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledOnce();
      expect(tx.isOpen).toBe(false);
    });

    it('releases client even if ROLLBACK fails', async () => {
      const tx = await PgTransaction.begin(mockPool);
      (mockClient.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ROLLBACK failed'),
      );

      await expect(tx.rollback()).rejects.toThrow('ROLLBACK failed');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('throws if transaction already committed', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.commit();

      await expect(tx.rollback()).rejects.toThrow('Transaction already committed');
    });

    it('throws if transaction already rolled back', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.rollback();

      await expect(tx.rollback()).rejects.toThrow('Transaction already rolled back');
    });
  });

  // ── client getter ──────────────────────────────────────────────

  describe('client getter', () => {
    it('returns the underlying PoolClient while open', async () => {
      const tx = await PgTransaction.begin(mockPool);
      expect(tx.client).toBe(mockClient);
    });

    it('throws after commit', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.commit();

      expect(() => tx.client).toThrow('Transaction already committed');
    });

    it('throws after rollback', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.rollback();

      expect(() => tx.client).toThrow('Transaction already rolled back');
    });
  });

  // ── isOpen ─────────────────────────────────────────────────────

  describe('isOpen', () => {
    it('returns true before commit/rollback', async () => {
      const tx = await PgTransaction.begin(mockPool);
      expect(tx.isOpen).toBe(true);
    });

    it('returns false after commit', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.commit();
      expect(tx.isOpen).toBe(false);
    });

    it('returns false after rollback', async () => {
      const tx = await PgTransaction.begin(mockPool);
      await tx.rollback();
      expect(tx.isOpen).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════

describe('resolveQueryable()', () => {
  it('returns tx.client when transaction is provided', async () => {
    const mockClient = createMockClient();
    const mockPool = createMockPool(mockClient);
    const tx = await PgTransaction.begin(mockPool);

    const q = resolveQueryable(mockPool, tx);
    expect(q).toBe(mockClient);
  });

  it('returns pool when no transaction is provided', () => {
    const mockPool = createMockPool();

    const q = resolveQueryable(mockPool);
    expect(q).toBe(mockPool);
  });

  it('returns pool when transaction is undefined', () => {
    const mockPool = createMockPool();

    const q = resolveQueryable(mockPool, undefined);
    expect(q).toBe(mockPool);
  });
});
