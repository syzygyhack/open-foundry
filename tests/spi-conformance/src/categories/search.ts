import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

export function registerSearchTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Search`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // Seed data for search tests
    async function seedPatients() {
      await provider.createObject(tenantA, 'Patient', {
        name: 'Alice Johnson',
        age: 30,
        status: 'active',
        email: 'alice@example.com',
      });
      await provider.createObject(tenantA, 'Patient', {
        name: 'Bob Smith',
        age: 25,
        status: 'active',
        email: 'bob@example.com',
      });
      await provider.createObject(tenantA, 'Patient', {
        name: 'Charlie Brown',
        age: 40,
        status: 'inactive',
        email: 'charlie@hospital.org',
      });
      await provider.createObject(tenantA, 'Patient', {
        name: 'Diana Prince',
        age: 35,
        status: 'active',
        email: 'diana@example.com',
      });
      await provider.createObject(tenantA, 'Patient', {
        name: 'Eve Alice Adams',
        age: 28,
        status: 'pending',
        email: 'eve@hospital.org',
      });
    }

    // ─── Basic text match ───

    describe('basic text match', () => {
      beforeEach(seedPatients);

      it('finds objects matching a simple query', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'Alice',
        });

        expect(result.hits.length).toBeGreaterThanOrEqual(1);
        const names = result.hits.map((h) => h.object.name);
        expect(names).toContain('Alice Johnson');
      });

      it('returns score for each hit', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'Alice',
        });

        for (const hit of result.hits) {
          expect(hit.score).toBeGreaterThan(0);
          expect(hit.object).toBeDefined();
          expect(hit.object._id).toBeDefined();
        }
      });

      it('returns totalCount', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'Alice',
        });

        expect(result.totalCount).toBeGreaterThanOrEqual(1);
      });
    });

    // ─── Case-insensitive match ───

    describe('case-insensitive match', () => {
      beforeEach(seedPatients);

      it('matches regardless of case', async () => {
        const lower = await provider.searchObjects(tenantA, 'Patient', { query: 'alice' });
        const upper = await provider.searchObjects(tenantA, 'Patient', { query: 'ALICE' });
        const mixed = await provider.searchObjects(tenantA, 'Patient', { query: 'aLiCe' });

        expect(lower.hits.length).toBeGreaterThanOrEqual(1);
        expect(upper.hits.length).toBe(lower.hits.length);
        expect(mixed.hits.length).toBe(lower.hits.length);
      });
    });

    // ─── Multi-field search ───

    describe('multi-field search', () => {
      beforeEach(seedPatients);

      it('searches across multiple string fields', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'hospital',
        });

        // "hospital" appears in email for Charlie and Eve
        expect(result.hits.length).toBeGreaterThanOrEqual(2);
      });

      it('searches only the fields listed, and none for an empty list', async () => {
        const inName = await provider.searchObjects(tenantA, 'Patient', { query: 'hospital', fields: ['name'] });
        expect(inName.hits).toHaveLength(0);
        // An empty list is a caller allowed to search no field (the API sends
        // it when field restrictions leave nothing searchable).
        const none = await provider.searchObjects(tenantA, 'Patient', { query: 'hospital', fields: [] });
        expect(none.hits).toHaveLength(0);
        expect(none.totalCount).toBe(0);
        // null is no list (GraphQL passes it for an explicit `fields: null`).
        const omitted = await provider.searchObjects(tenantA, 'Patient', { query: 'hospital', fields: null } as never);
        expect(omitted.hits.length).toBeGreaterThanOrEqual(2);
      });
    });

    // ─── Search with filter ───

    describe('search with filter', () => {
      beforeEach(seedPatients);

      it('applies additional filter to search results', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'example',
          filter: { field: 'status', operator: 'eq', value: 'active' },
        });

        // "example" in email for Alice, Bob, Diana — all active
        for (const hit of result.hits) {
          expect(hit.object.status).toBe('active');
        }
        expect(result.hits.length).toBeGreaterThanOrEqual(1);
      });
    });

    // ─── No results ───

    describe('no results', () => {
      beforeEach(seedPatients);

      it('returns empty hits when nothing matches', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'zzzznonexistent',
        });

        expect(result.hits).toHaveLength(0);
        expect(result.totalCount).toBe(0);
        expect(result.hasNextPage).toBe(false);
      });
    });

    // ─── Pagination ───

    describe('pagination', () => {
      beforeEach(seedPatients);

      it('respects limit', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'example',
          limit: 1,
        });

        expect(result.hits).toHaveLength(1);
        expect(result.totalCount).toBeGreaterThanOrEqual(2);
        expect(result.hasNextPage).toBe(true);
      });

      it('respects offset', async () => {
        const all = await provider.searchObjects(tenantA, 'Patient', {
          query: 'example',
        });

        const offset1 = await provider.searchObjects(tenantA, 'Patient', {
          query: 'example',
          offset: 1,
        });

        expect(offset1.hits.length).toBe(all.hits.length - 1);
        expect(offset1.totalCount).toBe(all.totalCount);
      });

      it('limit + offset combination', async () => {
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'example',
          limit: 1,
          offset: 1,
        });

        expect(result.hits).toHaveLength(1);
        expect(result.totalCount).toBeGreaterThanOrEqual(2);
      });
    });

    // ─── Score ordering ───

    describe('score ordering', () => {
      beforeEach(seedPatients);

      it('returns results sorted by score descending', async () => {
        // "Alice" appears twice in Eve's name: "Eve Alice Adams" has "Alice" once
        // "Alice Johnson" has "Alice" once as well
        // Both should appear, scores should be >= 1
        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'Alice',
        });

        expect(result.hits.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < result.hits.length; i++) {
          expect(result.hits[i - 1]!.score).toBeGreaterThanOrEqual(result.hits[i]!.score);
        }
      });
    });

    // ─── Field restriction ───

    describe('field restriction', () => {
      beforeEach(seedPatients);

      it('only searches specified fields', async () => {
        // "hospital" appears in email but not in name
        const nameOnly = await provider.searchObjects(tenantA, 'Patient', {
          query: 'hospital',
          fields: ['name'],
        });

        expect(nameOnly.hits).toHaveLength(0);

        const emailOnly = await provider.searchObjects(tenantA, 'Patient', {
          query: 'hospital',
          fields: ['email'],
        });

        expect(emailOnly.hits.length).toBeGreaterThanOrEqual(2);
      });
    });

    // ─── Soft-deleted exclusion ───

    describe('soft-deleted exclusion', () => {
      it('excludes soft-deleted objects from search results', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', {
          name: 'Deleted SearchTarget',
          age: 50,
          status: 'active',
        });
        await provider.createObject(tenantA, 'Patient', {
          name: 'Active SearchTarget',
          age: 30,
          status: 'active',
        });

        // Delete one
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');

        const result = await provider.searchObjects(tenantA, 'Patient', {
          query: 'SearchTarget',
        });

        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]!.object.name).toBe('Active SearchTarget');
      });
    });
  });
}
