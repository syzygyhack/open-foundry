/**
 * Tests for graph traversal logic.
 *
 * Validates:
 * - Single-step outbound and inbound traversal
 * - Multi-step traversal through the graph
 * - Depth limit enforcement (MAX_TRAVERSAL_DEPTH = 10)
 * - Soft-delete filtering
 * - Pagination (limit/offset)
 * - Empty result handling
 * - Tenant isolation
 */

import { describe, it, expect, vi } from 'vitest';
import { traverse } from '../links/traversal.js';
import type { Pool } from 'pg';
import type {
  RequestContext,
  TraversalPath,
  TraversalOptions,
} from '@openfoundry/spi';

// ── Mock helpers ───────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[] };
type QueryResponder = (sql: string, params: unknown[]) => QueryResult;

function createMockPool(responder: QueryResponder): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) =>
      Promise.resolve(responder(sql, params)),
    ),
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

function makeLinkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _tenant_id: 'tenant-1',
    _type: 'AdmittedTo',
    _id: 'link-1',
    _from_type: 'Patient',
    _from_id: 'patient-1',
    _to_type: 'Ward',
    _to_id: 'ward-1',
    _version: 1,
    _created_at: new Date('2025-01-01T00:00:00Z'),
    _updated_at: new Date('2025-01-01T00:00:00Z'),
    _deleted_at: null,
    ...overrides,
  };
}

function makeObjectRow(type: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _tenant_id: 'tenant-1',
    _type: type,
    _id: id,
    _version: 1,
    _created_at: new Date('2025-01-01T00:00:00Z'),
    _updated_at: new Date('2025-01-01T00:00:00Z'),
    _deleted_at: null,
    ...overrides,
  };
}

/**
 * Object rows for an object-table query: one per requested ID (params[1]),
 * typed after the table (`"ward"` -> Ward), so the start-object and target
 * visibility checks find what they ask for.
 */
function objectRowsFor(sql: string, params: unknown[]): QueryResult {
  const table = /FROM "[^"]+"\."([a-z_]+)"/.exec(sql)?.[1] ?? '';
  const type = table.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
  const ids = (params[1] as string[] | undefined) ?? [];
  return { rows: ids.map((id) => makeObjectRow(type, id)) };
}

// ════════════════════════════════════════════════════════════════════

describe('traverse()', () => {
  // ── Single-step traversal ──────────────────────────────────────

  describe('single-step outbound traversal', () => {
    it('follows outbound links from start node', async () => {
      const pool = createMockPool((sql, params) => {
        if (sql.includes('admitted_to')) {
          return { rows: [makeLinkRow()] };
        }
        return objectRowsFor(sql, params);
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!._id).toBe('ward-1');
      expect(result.nodes[0]!._type).toBe('Ward');
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]!._type).toBe('AdmittedTo');
      expect(result.totalCount).toBe(1);
    });
  });

  describe('single-step inbound traversal', () => {
    it('follows inbound links to start node', async () => {
      const pool = createMockPool((sql, params) => {
        if (sql.includes('admitted_to')) {
          return {
            rows: [makeLinkRow({
              _from_type: 'Patient',
              _from_id: 'patient-1',
              _to_type: 'Ward',
              _to_id: 'ward-1',
            })],
          };
        }
        return objectRowsFor(sql, params);
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'inbound' }],
      };

      const result = await traverse(pool, createCtx(), 'ward-1', path);

      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
    });
  });

  // ── Empty results ──────────────────────────────────────────────

  describe('empty results', () => {
    it('returns empty nodes when no matching links exist', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });
  });

  // ── Depth limit ────────────────────────────────────────────────

  describe('depth limit enforcement', () => {
    it('throws when path exceeds MAX_TRAVERSAL_DEPTH (10)', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const steps = Array.from({ length: 11 }, () => ({
        linkType: 'SomeLink',
        direction: 'outbound' as const,
      }));
      const path: TraversalPath = { steps };

      await expect(
        traverse(pool, createCtx(), 'start-id', path),
      ).rejects.toThrow(/exceeds maximum of 10/);
    });

    it('allows path at exactly MAX_TRAVERSAL_DEPTH (10)', async () => {
      const pool = createMockPool(() => ({ rows: [] }));

      const steps = Array.from({ length: 10 }, () => ({
        linkType: 'SomeLink',
        direction: 'outbound' as const,
      }));
      const path: TraversalPath = { steps };

      // Should not throw — returns empty because no links found
      const result = await traverse(pool, createCtx(), 'start-id', path);
      expect(result.nodes).toHaveLength(0);
    });
  });

  // ── Soft-delete filtering ──────────────────────────────────────

  describe('soft-delete filtering', () => {
    it('excludes deleted items by default', async () => {
      const pool = createMockPool((sql) => {
        // Verify the SQL includes the deleted_at filter
        if (sql.includes('admitted_to')) {
          expect(sql).toContain('_deleted_at');
          return { rows: [makeLinkRow()] };
        }
        if (sql.includes('ward')) {
          expect(sql).toContain('_deleted_at');
          return { rows: [makeObjectRow('Ward', 'ward-1')] };
        }
        return { rows: [] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      await traverse(pool, createCtx(), 'patient-1', path);
    });

    it('includes deleted items when includeDeleted is true', async () => {
      let linkSql = '';
      const pool = createMockPool((sql) => {
        if (sql.includes('admitted_to')) {
          linkSql = sql;
          return { rows: [makeLinkRow()] };
        }
        return { rows: [makeObjectRow('Ward', 'ward-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };
      const options: TraversalOptions = { includeDeleted: true };

      await traverse(pool, createCtx(), 'patient-1', path, options);

      // When includeDeleted is true, the SQL should NOT filter on _deleted_at
      expect(linkSql).not.toContain('_deleted_at');
    });
  });

  // ── Pagination ─────────────────────────────────────────────────

  describe('pagination', () => {
    it('applies limit and offset to returned nodes', async () => {
      const pool = createMockPool((sql, params) => {
        if (sql.includes('admitted_to')) {
          return {
            rows: [
              makeLinkRow({ _to_id: 'ward-1', _id: 'link-1' }),
              makeLinkRow({ _to_id: 'ward-2', _id: 'link-2' }),
              makeLinkRow({ _to_id: 'ward-3', _id: 'link-3' }),
            ],
          };
        }
        return objectRowsFor(sql, params);
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };
      const options: TraversalOptions = { limit: 2, offset: 1 };

      const result = await traverse(pool, createCtx(), 'patient-1', path, options);

      expect(result.nodes).toHaveLength(2);
      expect(result.totalCount).toBe(3);
    });

    it('defaults to limit=100, offset=0', async () => {
      const pool = createMockPool((sql, params) => {
        if (sql.includes('admitted_to')) {
          return {
            rows: Array.from({ length: 101 }, (_, i) => makeLinkRow({ _to_id: `ward-${i}`, _id: `link-${i}` })),
          };
        }
        return objectRowsFor(sql, params);
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      expect(result.nodes).toHaveLength(100);
      expect(result.totalCount).toBe(101);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────

  describe('tenant isolation', () => {
    it('includes tenant_id in all queries', async () => {
      const queriedParams: unknown[][] = [];
      const pool = createMockPool((sql, params) => {
        queriedParams.push(params);
        if (sql.includes('admitted_to')) {
          return { rows: [makeLinkRow({ _tenant_id: 'tenant-abc' })] };
        }
        return { rows: [makeObjectRow('Ward', 'ward-1')] };
      });

      const path: TraversalPath = {
        steps: [{ linkType: 'AdmittedTo', direction: 'outbound' }],
      };

      await traverse(pool, createCtx('tenant-abc'), 'patient-1', path);

      // Every query should have tenant-abc as $1
      for (const params of queriedParams) {
        expect(params[0]).toBe('tenant-abc');
      }
    });
  });

  // ── Multi-step traversal ───────────────────────────────────────

  describe('multi-step traversal', () => {
    it('breaks traversal when frontier becomes empty', async () => {
      const pool = createMockPool((sql, params) => {
        // First step finds a link; the second step's link table is empty.
        if (sql.includes('admitted_to')) return { rows: [makeLinkRow()] };
        if (sql.includes('bed_in_ward')) return { rows: [] };
        return objectRowsFor(sql, params);
      });

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'inbound' },
        ],
      };

      const result = await traverse(pool, createCtx(), 'patient-1', path);

      // Second step found nothing — only terminal step nodes are returned
      expect(result.nodes).toHaveLength(0);
      // But edges from step 1 are still collected
      expect(result.edges).toHaveLength(1);
    });
  });
});
