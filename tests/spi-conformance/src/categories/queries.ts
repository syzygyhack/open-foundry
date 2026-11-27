import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider, FilterExpression } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

export function registerQueryTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Queries`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // Seed data for most filter tests
    async function seedPatients() {
      await provider.createObject(tenantA, 'Patient', { name: 'Alice', age: 30, status: 'active', email: 'alice@example.com', score: 95.5 });
      await provider.createObject(tenantA, 'Patient', { name: 'Bob', age: 25, status: 'active', email: 'bob@test.org', score: 82.0 });
      await provider.createObject(tenantA, 'Patient', { name: 'Charlie', age: 40, status: 'inactive', email: 'charlie@example.com', score: 70.5 });
      await provider.createObject(tenantA, 'Patient', { name: 'Diana', age: 35, status: 'active', email: 'diana@test.org', score: 88.0 });
      await provider.createObject(tenantA, 'Patient', { name: 'Eve', age: 28, status: 'pending', email: 'eve@example.com', score: 91.0 });
    }

    // ─── Unset values (null) ───

    describe('filters and unset values', () => {
      beforeEach(async () => {
        await seedPatients();
        // Frank has no status.
        await provider.createObject(tenantA, 'Patient', { name: 'Frank', age: 50 });
      });

      const names = (items: Array<Record<string, unknown>>) => items.map((i) => i.name).sort();

      it('neq matches a record whose field is unset', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'neq', value: 'inactive' });
        expect(names(page.items)).toEqual(['Alice', 'Bob', 'Diana', 'Eve', 'Frank']);
      });

      it('not(eq) matches a record whose field is unset', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', {
          not: { field: 'status', operator: 'eq', value: 'active' },
        });
        expect(names(page.items)).toEqual(['Charlie', 'Eve', 'Frank']);
      });

      it('eq null matches only the record whose field is unset', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'eq', value: null });
        expect(names(page.items)).toEqual(['Frank']);
      });

      it('eq with the value omitted is eq null', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'eq' } as FilterExpression);
        expect(names(page.items)).toEqual(['Frank']);
      });

      it('in with a null member also matches an unset field', async () => {
        const only = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'in', value: [null] });
        expect(names(only.items)).toEqual(['Frank']);
        const mixed = await provider.queryObjects(tenantA, 'Patient', {
          field: 'status',
          operator: 'in',
          value: [null, 'pending'],
        });
        expect(names(mixed.items).sort()).toEqual(['Eve', 'Frank']);
      });

      it('eq on a value never matches an unset field', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', {
          or: [{ field: 'status', operator: 'eq', value: 'pending' }, { field: 'status', operator: 'eq', value: 'x' }],
        });
        expect(names(page.items)).toEqual(['Eve']);
      });

      it('not(and) with an unset field negates as if the comparison were false', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', {
          not: { and: [{ field: 'status', operator: 'eq', value: 'active' }, { field: 'age', operator: 'gte', value: 30 }] },
        });
        expect(names(page.items)).toEqual(['Bob', 'Charlie', 'Eve', 'Frank']);
      });
    });

    // ─── Filter - Equality ───

    describe('filter: eq', () => {
      beforeEach(seedPatients);

      it('matches exact string value', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Alice' });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Alice');
      });

      it('matches exact number value', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'eq', value: 30 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Alice');
      });

      it('matches float value', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'score', operator: 'eq', value: 82.0 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Bob');
      });

      it('returns empty when no match', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'NonExistent' });
        expect(page.items).toHaveLength(0);
      });

      it('rejects a filter on an undeclared field with INVALID_FILTER', async () => {
        await expect(
          provider.queryObjects(tenantA, 'Patient', { field: 'nonexistent', operator: 'eq', value: 'x' }),
        ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
      });

      it('rejects inherited JavaScript names as undeclared fields', async () => {
        for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
          await expect(
            provider.queryObjects(tenantA, 'Patient', { field, operator: 'eq', value: null }),
            field,
          ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
        }
      });

      it('rejects an undeclared field nested in and/or/not, and with no rows of the type', async () => {
        const nested = {
          and: [
            { field: 'name', operator: 'eq', value: 'Alice' },
            { not: { or: [{ field: 'nonexistent', operator: 'exists', value: false }] } },
          ],
        } as FilterExpression;
        await expect(provider.queryObjects(tenantA, 'Patient', nested)).rejects.toMatchObject({ code: 'INVALID_FILTER' });
        // Appointment has no rows here: the answer must not depend on data.
        await expect(
          provider.queryObjects(tenantA, 'Appointment', { field: 'nonexistent', operator: 'exists', value: false }),
        ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
      });

      it('accepts system fields in either spelling, on a live and a deleted row', async () => {
        const live = await provider.createObject(tenantA, 'Patient', { name: 'SysLive' });
        const gone = await provider.createObject(tenantA, 'Patient', { name: 'SysGone' });
        await provider.deleteObject(tenantA, 'Patient', gone._id, 'soft');
        const ids = { field: '_id', operator: 'in', value: [live._id, gone._id] } as FilterExpression;
        const opts = { includeDeleted: true };
        const run = async (f: FilterExpression) =>
          (await provider.queryObjects(tenantA, 'Patient', { and: [ids, f] }, opts)).items.map((i) => i._id);
        for (const field of ['_deletedAt', '_deleted_at']) {
          expect(await run({ field, operator: 'exists', value: true })).toEqual([gone._id]);
          expect(await run({ field, operator: 'exists', value: false })).toEqual([live._id]);
          // An unset system field is null, as an unset property is.
          expect(await run({ field, operator: 'eq', value: null })).toEqual([live._id]);
          expect(await run({ field, operator: 'neq', value: null })).toEqual([gone._id]);
        }
      });
    });

    // ─── Filter - Inequality ───

    describe('filter: neq', () => {
      beforeEach(seedPatients);

      it('excludes matching string values', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'neq', value: 'inactive' });
        expect(page.items).toHaveLength(4);
      });

      it('excludes matching number values', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'neq', value: 30 });
        expect(page.items).toHaveLength(4);
      });

      it('returns all when value does not exist in data', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'status', operator: 'neq', value: 'archived' });
        expect(page.items).toHaveLength(5);
      });

      it('on string field', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'neq', value: 'Alice' });
        expect(page.items).toHaveLength(4);
        expect(page.items.every(i => i.name !== 'Alice')).toBe(true);
      });
    });

    // ─── Filter - Comparison ───

    describe('filter: comparison', () => {
      beforeEach(seedPatients);

      it('gt returns values greater than threshold', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'gt', value: 30 });
        expect(page.items).toHaveLength(2); // Charlie 40, Diana 35
      });

      it('gte returns values greater than or equal', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'gte', value: 30 });
        expect(page.items).toHaveLength(3); // Alice 30, Charlie 40, Diana 35
      });

      it('lt returns values less than threshold', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'lt', value: 30 });
        expect(page.items).toHaveLength(2); // Bob 25, Eve 28
      });

      it('lte returns values less than or equal', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'lte', value: 30 });
        expect(page.items).toHaveLength(3); // Alice 30, Bob 25, Eve 28
      });

      it('gt with boundary value excludes exact match', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'gt', value: 25 });
        expect(page.items.every(i => (i.age as number) > 25)).toBe(true);
      });

      it('gte with boundary value includes exact match', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'gte', value: 25 });
        expect(page.items.some(i => i.age === 25)).toBe(true);
      });
    });

    // ─── Filter - String operators ───

    describe('filter: string operators', () => {
      beforeEach(seedPatients);

      it('contains matches substring', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'contains', value: 'li' });
        expect(page.items).toHaveLength(2); // Alice, Charlie
      });

      it('contains is case-sensitive', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'contains', value: 'LI' });
        expect(page.items).toHaveLength(0);
      });

      it('startsWith matches prefix', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'startsWith', value: 'Al' });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Alice');
      });

      it('startsWith with full string', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'startsWith', value: 'Bob' });
        expect(page.items).toHaveLength(1);
      });

      it('startsWith returns empty for non-matching prefix', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'startsWith', value: 'Zz' });
        expect(page.items).toHaveLength(0);
      });
    });

    // ─── Filter - in ───

    describe('filter: in', () => {
      beforeEach(seedPatients);

      it('matches values in array', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'in', value: ['Alice', 'Charlie'] });
        expect(page.items).toHaveLength(2);
      });

      it('with single value', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'in', value: ['Bob'] });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Bob');
      });

      it('with empty array returns no results', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'in', value: [] });
        expect(page.items).toHaveLength(0);
      });

      it('with all values returns all', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient', {
          field: 'name', operator: 'in', value: ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'],
        });
        expect(page.items).toHaveLength(5);
      });
    });

    // ─── Filter - exists ───

    describe('filter: exists', () => {
      it('exists true returns objects with field set', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'HasAge', age: 30 });
        await provider.createObject(tenantA, 'Patient', { name: 'NoAge' });
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'exists', value: true });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items.every(i => i.age !== undefined && i.age !== null)).toBe(true);
      });

      it('exists false returns objects without field', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'HasAge', age: 30 });
        await provider.createObject(tenantA, 'Patient', { name: 'NoAge' });
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'age', operator: 'exists', value: false });
        expect(page.items.length).toBeGreaterThanOrEqual(1);
        expect(page.items.every(i => i.age === undefined || i.age === null)).toBe(true);
      });

      it('exists true on universal field matches all', async () => {
        await seedPatients();
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'exists', value: true });
        expect(page.items).toHaveLength(5);
      });

      it('exists false on universal field matches none', async () => {
        await seedPatients();
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'exists', value: false });
        expect(page.items).toHaveLength(0);
      });
    });

    // ─── Logical - AND ───

    describe('filter: AND', () => {
      beforeEach(seedPatients);

      it('two conditions narrow results', async () => {
        const filter: FilterExpression = {
          and: [
            { field: 'status', operator: 'eq', value: 'active' },
            { field: 'age', operator: 'gt', value: 26 },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(2); // Alice 30, Diana 35
      });

      it('three conditions', async () => {
        const filter: FilterExpression = {
          and: [
            { field: 'status', operator: 'eq', value: 'active' },
            { field: 'age', operator: 'gt', value: 26 },
            { field: 'score', operator: 'gt', value: 90 },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(1); // Alice
      });

      it('contradictory conditions return empty', async () => {
        const filter: FilterExpression = {
          and: [
            { field: 'status', operator: 'eq', value: 'active' },
            { field: 'status', operator: 'eq', value: 'inactive' },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(0);
      });

      it('single condition behaves as that filter', async () => {
        const filter: FilterExpression = {
          and: [{ field: 'name', operator: 'eq', value: 'Alice' }],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(1);
      });

      it('nested AND filters', async () => {
        const filter: FilterExpression = {
          and: [
            { and: [{ field: 'status', operator: 'eq', value: 'active' }] },
            { field: 'age', operator: 'lt', value: 35 },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(2); // Alice 30, Bob 25
      });
    });

    // ─── Logical - OR ───

    describe('filter: OR', () => {
      beforeEach(seedPatients);

      it('two conditions broaden results', async () => {
        const filter: FilterExpression = {
          or: [
            { field: 'name', operator: 'eq', value: 'Alice' },
            { field: 'name', operator: 'eq', value: 'Charlie' },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(2);
      });

      it('non-matching conditions return empty', async () => {
        const filter: FilterExpression = {
          or: [
            { field: 'name', operator: 'eq', value: 'Nobody1' },
            { field: 'name', operator: 'eq', value: 'Nobody2' },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(0);
      });

      it('one matching condition returns that match', async () => {
        const filter: FilterExpression = {
          or: [
            { field: 'name', operator: 'eq', value: 'Alice' },
            { field: 'name', operator: 'eq', value: 'Nobody' },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!.name).toBe('Alice');
      });

      it('all conditions matching returns all matches', async () => {
        const filter: FilterExpression = {
          or: [
            { field: 'status', operator: 'eq', value: 'active' },
            { field: 'status', operator: 'eq', value: 'inactive' },
            { field: 'status', operator: 'eq', value: 'pending' },
          ],
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(5);
      });
    });

    // ─── Logical - NOT ───

    describe('filter: NOT', () => {
      beforeEach(seedPatients);

      it('inverts a condition', async () => {
        const filter: FilterExpression = {
          not: { field: 'status', operator: 'eq', value: 'active' },
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(2); // Charlie inactive, Eve pending
      });

      it('NOT eq acts as neq', async () => {
        const filter: FilterExpression = {
          not: { field: 'name', operator: 'eq', value: 'Alice' },
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        expect(page.items).toHaveLength(4);
      });

      it('NOT with logical AND', async () => {
        const filter: FilterExpression = {
          not: {
            and: [
              { field: 'status', operator: 'eq', value: 'active' },
              { field: 'age', operator: 'gt', value: 26 },
            ],
          },
        };
        const page = await provider.queryObjects(tenantA, 'Patient', filter);
        // NOT(active AND age>26) => includes Bob(active,25), Charlie(inactive,40), Eve(pending,28)
        expect(page.items).toHaveLength(3);
      });
    });

    // ─── Pagination ───

    describe('pagination', () => {
      beforeEach(seedPatients);

      it('limit restricts result count', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { limit: 2 },
        );
        expect(page.items).toHaveLength(2);
      });

      it('offset skips initial results', async () => {
        const all = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'name', direction: 'asc' }] },
        );
        const offset = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'name', direction: 'asc' }], offset: 2 },
        );
        expect(offset.items[0]!.name).toBe(all.items[2]!.name);
      });

      it('limit + offset combination', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { limit: 2, offset: 1, orderBy: [{ field: 'name', direction: 'asc' }] },
        );
        expect(page.items).toHaveLength(2);
      });

      it('hasNextPage true when more results exist', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { limit: 2, offset: 0 },
        );
        expect(page.hasNextPage).toBe(true);
      });

      it('hasNextPage false on last page', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { limit: 10, offset: 0 },
        );
        expect(page.hasNextPage).toBe(false);
      });

      it('totalCount reflects full result set', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { limit: 2, offset: 0 },
        );
        expect(page.totalCount).toBe(5);
      });
    });

    // ─── Ordering ───

    describe('ordering', () => {
      beforeEach(seedPatients);

      it('orderBy ascending on numeric field', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'age', direction: 'asc' }] },
        );
        const ages = page.items.map(i => i.age as number);
        for (let i = 1; i < ages.length; i++) {
          expect(ages[i]!).toBeGreaterThanOrEqual(ages[i - 1]!);
        }
      });

      it('orderBy descending on numeric field', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'age', direction: 'desc' }] },
        );
        const ages = page.items.map(i => i.age as number);
        for (let i = 1; i < ages.length; i++) {
          expect(ages[i]!).toBeLessThanOrEqual(ages[i - 1]!);
        }
      });

      it('orderBy ascending on string field', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'name', direction: 'asc' }] },
        );
        expect(page.items[0]!.name).toBe('Alice');
        expect(page.items[4]!.name).toBe('Eve');
      });

      it('orderBy with multiple sort criteria', async () => {
        // Create patients with same status but different ages
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'status', operator: 'eq', value: 'active' },
          { orderBy: [{ field: 'status', direction: 'asc' }, { field: 'age', direction: 'asc' }] },
        );
        expect(page.items).toHaveLength(3);
      });

      it('orderBy combined with pagination', async () => {
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'exists', value: true },
          { orderBy: [{ field: 'age', direction: 'asc' }], limit: 2, offset: 0 },
        );
        expect(page.items).toHaveLength(2);
        expect(page.items[0]!.name).toBe('Bob'); // youngest age=25
      });
    });

    // ─── Soft-delete exclusion in queries ───

    describe('soft-delete exclusion', () => {
      it('excludes soft-deleted from default query', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Deleted' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Deleted' });
        expect(page.items).toHaveLength(0);
      });

      it('includeDeleted true returns soft-deleted', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Deleted2' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'eq', value: 'Deleted2' },
          { includeDeleted: true },
        );
        expect(page.items).toHaveLength(1);
      });

      it('soft-deleted has _deletedAt set', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Deleted3' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'eq', value: 'Deleted3' },
          { includeDeleted: true },
        );
        expect(page.items[0]!._deletedAt).toBeDefined();
      });

      it('includeDeleted false explicitly excludes', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Deleted4' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: 'name', operator: 'eq', value: 'Deleted4' },
          { includeDeleted: false },
        );
        expect(page.items).toHaveLength(0);
      });
    });
  });
}
