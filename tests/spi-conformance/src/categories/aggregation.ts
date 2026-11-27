import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

export function registerAggregationTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Aggregation`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // Seed data for aggregation tests
    async function seedPatients() {
      await provider.createObject(tenantA, 'Patient', { name: 'Alice', age: 30, status: 'active', score: 95.5 });
      await provider.createObject(tenantA, 'Patient', { name: 'Bob', age: 25, status: 'active', score: 82.0 });
      await provider.createObject(tenantA, 'Patient', { name: 'Charlie', age: 40, status: 'inactive', score: 70.5 });
      await provider.createObject(tenantA, 'Patient', { name: 'Diana', age: 35, status: 'active', score: 88.0 });
      await provider.createObject(tenantA, 'Patient', { name: 'Eve', age: 28, status: 'pending', score: 91.0 });
    }

    // ─── Count ───

    describe('count', () => {
      beforeEach(seedPatients);

      it('count all with field=*', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['count_*']).toBe(5);
        expect(result.totalGroups).toBe(1);
      });

      it('count with filter', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count' }],
          filter: { field: 'status', operator: 'eq', value: 'active' },
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['count_*']).toBe(3);
      });

      it('count on specific field counts non-null values', async () => {
        // Create a patient without a score
        await provider.createObject(tenantA, 'Patient', { name: 'Frank', age: 45, status: 'active' });

        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [
            { field: '*', fn: 'count', alias: 'total' },
            { field: 'score', fn: 'count', alias: 'withScore' },
          ],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['total']).toBe(6);
        expect(result.groups[0]!.values['withScore']).toBe(5);
      });
    });

    // ─── Numeric aggregates ───

    describe('numeric aggregates', () => {
      beforeEach(seedPatients);

      it('sum on numeric field', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: 'age', fn: 'sum' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['sum_age']).toBe(158); // 30+25+40+35+28
      });

      it('avg on numeric field', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: 'age', fn: 'avg' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['avg_age']).toBeCloseTo(31.6, 1); // 158/5
      });

      it('min on numeric field', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: 'age', fn: 'min' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['min_age']).toBe(25);
      });

      it('max on numeric field', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: 'age', fn: 'max' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['max_age']).toBe(40);
      });

      it('multiple aggregates in single query', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [
            { field: '*', fn: 'count', alias: 'total' },
            { field: 'age', fn: 'sum', alias: 'ageSum' },
            { field: 'age', fn: 'avg', alias: 'ageAvg' },
            { field: 'score', fn: 'min', alias: 'minScore' },
            { field: 'score', fn: 'max', alias: 'maxScore' },
          ],
        });
        expect(result.groups).toHaveLength(1);
        const v = result.groups[0]!.values;
        expect(v['total']).toBe(5);
        expect(v['ageSum']).toBe(158);
        expect(v['ageAvg']).toBeCloseTo(31.6, 1);
        expect(v['minScore']).toBeCloseTo(70.5, 1);
        expect(v['maxScore']).toBeCloseTo(95.5, 1);
      });
    });

    // ─── Group by ───

    describe('groupBy', () => {
      beforeEach(seedPatients);

      it('groupBy single field', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
        });
        expect(result.totalGroups).toBe(3); // active, inactive, pending

        const active = result.groups.find((g) => g.keys['status'] === 'active');
        const inactive = result.groups.find((g) => g.keys['status'] === 'inactive');
        const pending = result.groups.find((g) => g.keys['status'] === 'pending');

        expect(active).toBeDefined();
        expect(active!.values['count']).toBe(3);
        expect(inactive).toBeDefined();
        expect(inactive!.values['count']).toBe(1);
        expect(pending).toBeDefined();
        expect(pending!.values['count']).toBe(1);
      });

      it('groupBy with aggregate functions', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [
            { field: '*', fn: 'count', alias: 'count' },
            { field: 'age', fn: 'avg', alias: 'avgAge' },
          ],
          groupBy: ['status'],
        });

        const active = result.groups.find((g) => g.keys['status'] === 'active');
        expect(active).toBeDefined();
        expect(active!.values['count']).toBe(3);
        expect(active!.values['avgAge']).toBeCloseTo(30, 0); // (30+25+35)/3 = 30
      });

      it('groupBy multiple fields', async () => {
        // Add more data for multi-field grouping
        await provider.createObject(tenantA, 'Patient', { name: 'Frank', age: 50, status: 'active', score: 60 });
        await provider.createObject(tenantA, 'Patient', { name: 'Grace', age: 22, status: 'pending', score: 77 });

        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
        });
        // active: Alice,Bob,Diana,Frank = 4; inactive: Charlie = 1; pending: Eve,Grace = 2
        expect(result.totalGroups).toBe(3);
        const active = result.groups.find((g) => g.keys['status'] === 'active');
        expect(active!.values['count']).toBe(4);
      });
    });

    // ─── Empty results ───

    describe('empty results', () => {
      it('returns empty groups when no objects match', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          filter: { field: 'status', operator: 'eq', value: 'nonexistent' },
        });
        // With no groupBy, there's still one group but count is 0
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['count']).toBe(0);
      });

      it('returns empty groups when no objects exist', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
        });
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]!.values['count']).toBe(0);
      });

      it('returns no groups when groupBy with no matching data', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          filter: { field: 'status', operator: 'eq', value: 'nonexistent' },
        });
        expect(result.groups).toHaveLength(0);
        expect(result.totalGroups).toBe(0);
      });
    });

    // ─── Ordering ───

    describe('ordering of groups', () => {
      beforeEach(seedPatients);

      it('orders groups by aggregate value ascending', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'count', direction: 'asc' }],
        });
        expect(result.groups.length).toBeGreaterThanOrEqual(2);
        const counts = result.groups.map((g) => g.values['count'] as number);
        for (let i = 1; i < counts.length; i++) {
          expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
        }
      });

      it('orders by an alias that is not a plain SQL name, with the values intact', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [
            { field: '*', fn: 'count', alias: '_total' },
            { field: 'age', fn: 'max', alias: 'maxAge' },
            { field: '*', fn: 'count' },
          ],
          groupBy: ['status'],
          orderBy: [{ field: '_total', direction: 'desc' }],
        });
        expect(result.groups.map((g) => g.values['_total'])).toEqual([3, 1, 1]);
        expect(result.groups[0]!.keys['status']).toBe('active');
        expect(result.groups[0]!.values['maxAge']).toBe(35);
        expect(result.groups[0]!.values['count_*']).toBe(3);

        const byDefaultName = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'count_*', direction: 'asc' }],
        });
        expect(byDefaultName.groups.map((g) => g.values['count_*'])).toEqual([1, 1, 3]);
      });

      it('sorts a null group key or value last, in either direction', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'NoStatus' });
        for (const direction of ['asc', 'desc'] as const) {
          const byKey = await provider.aggregateObjects(tenantA, 'Patient', {
            fields: [{ field: '*', fn: 'count', alias: 'n' }],
            groupBy: ['status'],
            orderBy: [{ field: 'status', direction }],
          });
          expect(byKey.groups.at(-1)!.keys['status'], direction).toBeNull();
          const byValue = await provider.aggregateObjects(tenantA, 'Patient', {
            fields: [{ field: 'score', fn: 'max', alias: 'top' }],
            groupBy: ['status'],
            orderBy: [{ field: 'top', direction }],
          });
          expect(byValue.groups.at(-1)!.values['top'], direction).toBeNull();
        }
      });

      it('refuses an output named __proto__', async () => {
        await expect(
          provider.aggregateObjects(tenantA, 'Patient', { fields: [{ field: '*', fn: 'count', alias: '__proto__' }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      });

      it('refuses two outputs with one name', async () => {
        await expect(
          provider.aggregateObjects(tenantA, 'Patient', {
            fields: [
              { field: '*', fn: 'count', alias: 'same' },
              { field: 'score', fn: 'sum', alias: 'same' },
            ],
            groupBy: ['status'],
            orderBy: [{ field: 'same', direction: 'desc' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      });

      it('refuses an orderBy that is neither a groupBy field nor an aggregate output', async () => {
        await expect(
          provider.aggregateObjects(tenantA, 'Patient', {
            fields: [{ field: '*', fn: 'count', alias: 'n' }],
            groupBy: ['status'],
            orderBy: [{ field: 'age', direction: 'asc' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      });

      it('orders groups by group key', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'status', direction: 'asc' }],
        });
        const statuses = result.groups.map((g) => g.keys['status'] as string);
        const sorted = [...statuses].sort();
        expect(statuses).toEqual(sorted);
      });
    });

    // ─── Limit / Offset ───

    describe('limit and offset on groups', () => {
      beforeEach(seedPatients);

      it('limit restricts number of groups returned', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'status', direction: 'asc' }],
          limit: 2,
        });
        expect(result.groups).toHaveLength(2);
        expect(result.totalGroups).toBe(3); // Still reports total
      });

      it('offset skips initial groups', async () => {
        const allResult = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'status', direction: 'asc' }],
        });

        const offsetResult = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'status', direction: 'asc' }],
          offset: 1,
        });

        expect(offsetResult.groups[0]!.keys['status']).toBe(
          allResult.groups[1]!.keys['status'],
        );
      });

      it('limit + offset combination', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'status', direction: 'asc' }],
          limit: 1,
          offset: 1,
        });
        expect(result.groups).toHaveLength(1);
        expect(result.totalGroups).toBe(3);
      });
    });

    // ─── Custom aliases ───

    describe('custom aliases', () => {
      beforeEach(seedPatients);

      it('uses custom alias for aggregate result', async () => {
        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [
            { field: '*', fn: 'count', alias: 'patientCount' },
            { field: 'age', fn: 'avg', alias: 'averageAge' },
          ],
        });
        expect(result.groups[0]!.values['patientCount']).toBe(5);
        expect(result.groups[0]!.values['averageAge']).toBeCloseTo(31.6, 1);
      });
    });

    // ─── Soft-deleted exclusion ───

    describe('soft-deleted exclusion', () => {
      it('excludes soft-deleted objects from aggregation', async () => {
        const obj1 = await provider.createObject(tenantA, 'Patient', { name: 'A', age: 10, status: 'x' });
        await provider.createObject(tenantA, 'Patient', { name: 'B', age: 20, status: 'x' });
        await provider.deleteObject(tenantA, 'Patient', obj1._id, 'soft');

        const result = await provider.aggregateObjects(tenantA, 'Patient', {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
        });
        expect(result.groups[0]!.values['count']).toBe(1);
      });
    });
  });
}
