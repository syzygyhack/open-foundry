/**
 * Tests for temporal query operations.
 *
 * Validates:
 * - getObjectAtVersion: retrieves object state at a specific version
 * - getObjectAtTime: retrieves object state at a point in time
 * - Correct SQL construction and parameterization
 * - History row to object mapping (snake_case → camelCase)
 * - Null return when no matching history entry
 * - Tenant isolation in queries
 */

import { describe, it, expect, vi } from 'vitest';
import { getObjectAtVersion, getObjectAtTime } from '../temporal/temporal-queries.js';
import type { Pool } from 'pg';
import type { RequestContext, DateTime } from '@openfoundry/spi';

// ── Mock helpers ───────────────────────────────────────────────────

function createMockPool(rows: Record<string, unknown>[] = []): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

function createCtx(tenantId = 'tenant-1'): RequestContext {
  return {
    tenantId,
    userId: 'user-1',
    traceId: 'trace-1',
    roles: ['clinician'],
  } as RequestContext;
}

function createHistoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _tenant_id: 'tenant-1',
    _type: 'Patient',
    _id: 'patient-1',
    _version: 3,
    _created_at: new Date('2025-01-01T00:00:00Z'),
    _updated_at: new Date('2025-01-15T10:00:00Z'),
    _deleted_at: null,
    _history_id: 'hist-1',
    _history_created_at: new Date('2025-01-15T10:00:00Z'),
    nhs_number: '1234567890',
    full_name: 'John Smith',
    date_of_birth: '1990-05-15',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════

describe('getObjectAtVersion', () => {
  it('returns object at the requested version', async () => {
    const row = createHistoryRow({ _version: 5 });
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 5);

    expect(result).not.toBeNull();
    expect(result!._id).toBe('patient-1');
    expect(result!._version).toBe(5);
    expect(result!._type).toBe('Patient');
    expect(result!._tenantId).toBe('tenant-1');
  });

  it('converts snake_case columns to camelCase properties', async () => {
    const row = createHistoryRow();
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 3);

    expect(result!.nhsNumber).toBe('1234567890');
    expect(result!.fullName).toBe('John Smith');
    expect(result!.dateOfBirth).toBe('1990-05-15');
  });

  it('converts Date objects to ISO strings for timestamps', async () => {
    const row = createHistoryRow();
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 3);

    expect(result!._createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result!._updatedAt).toBe('2025-01-15T10:00:00.000Z');
  });

  it('includes _deletedAt when row has non-null deleted_at', async () => {
    const row = createHistoryRow({ _deleted_at: new Date('2025-02-01T00:00:00Z') });
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 3);

    expect(result!._deletedAt).toBe('2025-02-01T00:00:00.000Z');
  });

  it('omits _deletedAt when row has null deleted_at', async () => {
    const row = createHistoryRow({ _deleted_at: null });
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 3);

    expect(result!._deletedAt).toBeUndefined();
  });

  it('returns null when no history entry exists for version', async () => {
    const pool = createMockPool([]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 999);

    expect(result).toBeNull();
  });

  it('passes correct parameters to SQL query', async () => {
    const pool = createMockPool([]);
    const ctx = createCtx('tenant-abc');

    await getObjectAtVersion(pool, ctx, 'Patient', 'patient-42', 7);

    const queryFn = pool.query as ReturnType<typeof vi.fn>;
    expect(queryFn).toHaveBeenCalledOnce();

    const [sql, params] = queryFn.mock.calls[0]!;
    expect(sql).toContain('_tenant_id');
    expect(sql).toContain('_id');
    expect(sql).toContain('_version');
    expect(params).toEqual(['tenant-abc', 'patient-42', 7]);
  });

  it('excludes system columns from mapped properties', async () => {
    const row = createHistoryRow();
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtVersion(pool, ctx, 'Patient', 'patient-1', 3);

    // History-specific columns should not appear as properties
    expect(result).not.toHaveProperty('historyId');
    expect(result).not.toHaveProperty('historyCreatedAt');
  });
});

// ════════════════════════════════════════════════════════════════════

describe('getObjectAtTime', () => {
  it('returns the most recent version at or before the timestamp', async () => {
    const row = createHistoryRow({ _version: 3 });
    const pool = createMockPool([row]);
    const ctx = createCtx();

    const result = await getObjectAtTime(
      pool, ctx, 'Patient', 'patient-1',
      '2025-01-15T12:00:00Z' as DateTime,
    );

    expect(result).not.toBeNull();
    expect(result!._version).toBe(3);
  });

  it('returns null when no history exists before timestamp', async () => {
    const pool = createMockPool([]);
    const ctx = createCtx();

    const result = await getObjectAtTime(
      pool, ctx, 'Patient', 'patient-1',
      '2020-01-01T00:00:00Z' as DateTime,
    );

    expect(result).toBeNull();
  });

  it('passes timestamp as parameter and uses ORDER BY DESC LIMIT 1', async () => {
    const pool = createMockPool([]);
    const ctx = createCtx('tenant-xyz');
    const timestamp = '2025-06-15T12:00:00Z' as DateTime;

    await getObjectAtTime(pool, ctx, 'Patient', 'patient-1', timestamp);

    const queryFn = pool.query as ReturnType<typeof vi.fn>;
    const [sql, params] = queryFn.mock.calls[0]!;
    // The version's own timestamp, not the history insert time.
    expect(sql).toContain('"_updated_at" <= $3');
    expect(sql).not.toContain('_history_created_at');
    expect(sql).toContain('ORDER BY "_version" DESC LIMIT 1');
    expect(params).toEqual(['tenant-xyz', 'patient-1', timestamp]);
  });

  it('uses custom schema when provided', async () => {
    const pool = createMockPool([]);
    const ctx = createCtx();

    await getObjectAtTime(
      pool, ctx, 'Patient', 'patient-1',
      '2025-01-01T00:00:00Z' as DateTime,
      'nhs_acute',
    );

    const queryFn = pool.query as ReturnType<typeof vi.fn>;
    const [sql] = queryFn.mock.calls[0]!;
    expect(sql).toContain('nhs_acute');
  });
});
