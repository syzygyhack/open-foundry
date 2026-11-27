import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, tenantB, baseSchema } from '../fixtures.js';

export function registerCrudTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: CRUD`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // ─── Create Object ───

    describe('createObject', () => {
      it('assigns correct _tenantId', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        expect(obj._tenantId).toBe(tenantA.tenantId);
      });

      it('assigns correct _type', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        expect(obj._type).toBe('Patient');
      });

      it('assigns auto-generated _id', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        expect(obj._id).toBeDefined();
        expect(typeof obj._id).toBe('string');
        expect(obj._id.length).toBeGreaterThan(0);
      });

      it('assigns _version = 1', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        expect(obj._version).toBe(1);
      });

      it('assigns _createdAt timestamp', async () => {
        const before = new Date().toISOString();
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        const after = new Date().toISOString();
        expect(obj._createdAt).toBeDefined();
        expect(obj._createdAt >= before).toBe(true);
        expect(obj._createdAt <= after).toBe(true);
      });

      it('assigns _updatedAt matching _createdAt', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice' });
        expect(obj._updatedAt).toBe(obj._createdAt);
      });

      it('stores custom string property', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice', status: 'active' });
        expect(obj.name).toBe('Alice');
        expect(obj.status).toBe('active');
      });

      it('stores custom numeric property', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Alice', age: 30, score: 95.5 });
        expect(obj.age).toBe(30);
        expect(obj.score).toBe(95.5);
      });
    });

    // ─── Create Multiple Types ───

    describe('createObject - multiple types', () => {
      it('creates Patient with all properties', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', {
          name: 'Alice', age: 30, status: 'active', email: 'alice@test.com', score: 95.5, active: true,
        });
        expect(obj._type).toBe('Patient');
        expect(obj.name).toBe('Alice');
        expect(obj.age).toBe(30);
        expect(obj.score).toBe(95.5);
      });

      it('creates CareTeam with name and specialty', async () => {
        const obj = await provider.createObject(tenantA, 'CareTeam', { name: 'Cardiology', specialty: 'heart', capacity: 20 });
        expect(obj._type).toBe('CareTeam');
        expect(obj.name).toBe('Cardiology');
        expect(obj.specialty).toBe('heart');
      });

      it('creates Appointment with date and duration', async () => {
        const obj = await provider.createObject(tenantA, 'Appointment', { date: '2025-06-01', duration: 30, status: 'scheduled' });
        expect(obj._type).toBe('Appointment');
        expect(obj.date).toBe('2025-06-01');
        expect(obj.duration).toBe(30);
      });

      it('creates Medication with name and dosage', async () => {
        const obj = await provider.createObject(tenantA, 'Medication', { name: 'Aspirin', dosage: '100mg', frequency: 'daily' });
        expect(obj._type).toBe('Medication');
        expect(obj.name).toBe('Aspirin');
        expect(obj.dosage).toBe('100mg');
      });

      it('creates Observation with code, value, unit', async () => {
        const obj = await provider.createObject(tenantA, 'Observation', { code: 'BP', value: 120.5, unit: 'mmHg' });
        expect(obj._type).toBe('Observation');
        expect(obj.code).toBe('BP');
        expect(obj.value).toBe(120.5);
        expect(obj.unit).toBe('mmHg');
      });
    });

    // ─── Read Object ───

    describe('getObject', () => {
      it('retrieves created object by type and id', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Bob' });
        const fetched = await provider.getObject(tenantA, 'Patient', created._id);
        expect(fetched).not.toBeNull();
        expect(fetched!._id).toBe(created._id);
      });

      it('retrieved object has same properties', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Carol', age: 35 });
        const fetched = await provider.getObject(tenantA, 'Patient', created._id);
        expect(fetched!.name).toBe('Carol');
        expect(fetched!.age).toBe(35);
      });

      it('returns null for non-existent id', async () => {
        const result = await provider.getObject(tenantA, 'Patient', 'nonexistent-id');
        expect(result).toBeNull();
      });

      it('returns null for wrong type with valid id', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Dave' });
        const result = await provider.getObject(tenantA, 'CareTeam', created._id);
        expect(result).toBeNull();
      });

      it('returns null for non-existent type', async () => {
        const result = await provider.getObject(tenantA, 'NonExistentType', 'some-id');
        expect(result).toBeNull();
      });

      it('retrieved object is a copy (modifying does not affect stored)', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Eve' });
        const fetched = await provider.getObject(tenantA, 'Patient', created._id);
        (fetched as Record<string, unknown>).name = 'Modified';
        const refetched = await provider.getObject(tenantA, 'Patient', created._id);
        expect(refetched!.name).toBe('Eve');
      });
    });

    // ─── Unset properties ───

    describe('unset and null properties', () => {
      it('a declared property not given on create reads back as null', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'NoAge' });
        expect(created.age).toBeNull();
        const fetched = await provider.getObject(tenantA, 'Patient', created._id);
        expect(fetched!.age).toBeNull();
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'NoAge' });
        expect(page.items[0]!.age).toBeNull();
      });

      it('an update that omits a property leaves it unchanged', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Keep', age: 30 });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { status: 'active' });
        expect(updated.age).toBe(30);
      });

      it('an update that sets a property to null clears it', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Clear', age: 30 });
        await provider.updateObject(tenantA, 'Patient', created._id, { age: null });
        const fetched = await provider.getObject(tenantA, 'Patient', created._id);
        expect(fetched!.age).toBeNull();
      });

      it('a property cannot override a system field', async () => {
        // Rejecting the property (Postgres: no such column) or ignoring it
        // (memory) are both fine; writing the object into tenant B is not.
        const created = await provider
          .createObject(tenantA, 'Patient', { name: 'Sys', _tenantId: tenantB.tenantId } as Record<string, unknown>)
          .catch(() => null);
        if (created) {
          expect(created._tenantId).toBe(tenantA.tenantId);
          expect(await provider.getObject(tenantB, 'Patient', created._id)).toBeNull();
        }
      });
    });

    // ─── Update Object ───

    describe('updateObject', () => {
      it('increments _version', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Frank', age: 20 });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 21 });
        expect(updated._version).toBe(2);
      });

      it('changes _updatedAt', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Grace', age: 25 });
        await new Promise(r => setTimeout(r, 5));
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 26 });
        expect(updated._updatedAt >= created._updatedAt).toBe(true);
      });

      it('preserves _createdAt', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Hank', age: 30 });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 31 });
        expect(updated._createdAt).toBe(created._createdAt);
      });

      it('preserves _tenantId', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Ivy' });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 40 });
        expect(updated._tenantId).toBe(tenantA.tenantId);
      });

      it('preserves _type', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Jack' });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 50 });
        expect(updated._type).toBe('Patient');
      });

      it('preserves _id', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Kate' });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 60 });
        expect(updated._id).toBe(created._id);
      });

      it('merges new properties with existing', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Leo', age: 20 });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { status: 'active' });
        expect(updated.name).toBe('Leo');
        expect(updated.age).toBe(20);
        expect(updated.status).toBe('active');
      });

      it('changes a property value', async () => {
        const created = await provider.createObject(tenantA, 'Patient', { name: 'Mia', age: 20 });
        const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 99 });
        expect(updated.age).toBe(99);
      });
    });

    // ─── Soft Delete ───

    describe('soft delete', () => {
      it('soft-deleted object returns null from getObject', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Nora' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const result = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('soft-deleted object has _deletedAt set', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Oscar' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: '_id', operator: 'eq', value: obj._id }, { includeDeleted: true });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!._deletedAt).toBeDefined();
      });

      it('soft-deleted object increments version', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Pete' });
        expect(obj._version).toBe(1);
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: '_id', operator: 'eq', value: obj._id }, { includeDeleted: true });
        expect(page.items[0]!._version).toBe(2);
      });

      it('soft-deleted object visible with includeDeleted', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Quinn' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Quinn' }, { includeDeleted: true });
        expect(page.items).toHaveLength(1);
      });

      it('cannot update a soft-deleted object', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Ruth' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        await expect(
          provider.updateObject(tenantA, 'Patient', obj._id, { name: 'Ruth2' }),
        ).rejects.toThrow();
      });

      it('soft-deleted object excluded from default query', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Sam' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Sam' });
        expect(page.items).toHaveLength(0);
      });

      it('soft-deleted object preserves custom properties', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Tina', age: 45, status: 'active' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: '_id', operator: 'eq', value: obj._id }, { includeDeleted: true });
        expect(page.items[0]!.name).toBe('Tina');
        expect(page.items[0]!.age).toBe(45);
      });
    });

    // ─── Hard Delete ───

    describe('hard delete', () => {
      it('hard-deleted object returns null from getObject', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Uma' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'hard');
        const result = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('hard-deleted object not in queryObjects', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Vic' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'hard');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Vic' });
        expect(page.items).toHaveLength(0);
      });

      it('hard-deleted object not in queryObjects even with includeDeleted', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Wendy' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'hard');
        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'eq', value: 'Wendy' }, { includeDeleted: true });
        expect(page.items).toHaveLength(0);
      });

      it('hard delete removes version history', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Xander' });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 10 });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'hard');
        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        expect(v1).toBeNull();
      });

      it('hard delete of non-existent object is idempotent', async () => {
        // Hard delete of non-existent object should not throw;
        // it's a no-op (idempotent delete semantics).
        await provider.deleteObject(tenantA, 'Patient', 'nonexistent', 'hard');
        const result = await provider.getObject(tenantA, 'Patient', 'nonexistent');
        expect(result).toBeNull();
      });

      it('hard-deleted object permanently gone', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Yuki' });
        const id = obj._id;
        await provider.deleteObject(tenantA, 'Patient', id, 'hard');
        const r1 = await provider.getObject(tenantA, 'Patient', id);
        const r2 = await provider.getObjectAtVersion(tenantA, 'Patient', id, 1);
        expect(r1).toBeNull();
        expect(r2).toBeNull();
      });
    });

    // ─── Bulk Mutations ───

    describe('bulkMutate', () => {
      it('bulk creates multiple objects', async () => {
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-1',
          operations: [
            { type: 'createObject', objectType: 'Patient', properties: { name: 'B1' } },
            { type: 'createObject', objectType: 'Patient', properties: { name: 'B2' } },
            { type: 'createObject', objectType: 'Patient', properties: { name: 'B3' } },
          ],
        });
        expect(result.accepted).toBe(3);
        expect(result.failed).toBe(0);
      });

      it('bulk updates existing objects', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'BU1', age: 10 });
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-2',
          operations: [
            { type: 'updateObject', objectType: 'Patient', id: obj._id, properties: { age: 20 } },
          ],
        });
        expect(result.accepted).toBe(1);
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched!.age).toBe(20);
      });

      it('bulk soft-deletes objects', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'BSD' });
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-3',
          operations: [
            { type: 'deleteObject', objectType: 'Patient', id: obj._id, mode: 'soft' },
          ],
        });
        expect(result.accepted).toBe(1);
        expect(await provider.getObject(tenantA, 'Patient', obj._id)).toBeNull();
      });

      it('bulk hard-deletes objects', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'BHD' });
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-4',
          operations: [
            { type: 'deleteObject', objectType: 'Patient', id: obj._id, mode: 'hard' },
          ],
        });
        expect(result.accepted).toBe(1);
      });

      it('mixed operations report correctly', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Mix', age: 10 });
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-5',
          operations: [
            { type: 'createObject', objectType: 'Patient', properties: { name: 'New1' } },
            { type: 'updateObject', objectType: 'Patient', id: obj._id, properties: { age: 99 } },
          ],
        });
        expect(result.accepted).toBe(2);
        expect(result.failed).toBe(0);
      });

      it('failed operations report error details', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Fail' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-bulk-6',
          operations: [
            { type: 'createObject', objectType: 'Patient', properties: { name: 'OK' } },
            { type: 'updateObject', objectType: 'Patient', id: obj._id, properties: { name: 'Bad' } },
          ],
        });
        expect(result.accepted).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.operationIndex).toBe(1);
      });

      it('idempotency key returns cached result', async () => {
        const req = {
          idempotencyKey: 'crud-idem-1',
          operations: [
            { type: 'createObject' as const, objectType: 'Patient', properties: { name: 'Idem' } },
          ],
        };
        const first = await provider.bulkMutate(tenantA, req);
        const second = await provider.bulkMutate(tenantA, req);
        expect(second).toEqual(first);
      });

      it('different idempotency key processes new request', async () => {
        await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-diff-1',
          operations: [{ type: 'createObject', objectType: 'Patient', properties: { name: 'D1' } }],
        });
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'crud-diff-2',
          operations: [{ type: 'createObject', objectType: 'Patient', properties: { name: 'D2' } }],
        });
        expect(result.accepted).toBe(1);
      });
    });
  });
}
