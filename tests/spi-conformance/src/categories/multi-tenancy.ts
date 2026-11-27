import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, tenantB, tenantC, baseSchema } from '../fixtures.js';

export function registerMultiTenancyTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Multi-tenancy`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // ─── Object Isolation ───

    describe('object isolation', () => {
      it('object created by tenant A not visible to tenant B', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'SecretA' });
        const result = await provider.getObject(tenantB, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('object created by tenant A not visible to tenant C', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'SecretA2' });
        const result = await provider.getObject(tenantC, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('object created by tenant B not visible to tenant A', async () => {
        const obj = await provider.createObject(tenantB, 'Patient', { name: 'SecretB' });
        const result = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('each tenant sees only their own objects via queryObjects', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'TenantA-1' });
        await provider.createObject(tenantA, 'Patient', { name: 'TenantA-2' });
        await provider.createObject(tenantB, 'Patient', { name: 'TenantB-1' });

        const pageA = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'exists', value: true });
        const pageB = await provider.queryObjects(tenantB, 'Patient', { field: 'name', operator: 'exists', value: true });

        expect(pageA.items.every(o => o._tenantId === tenantA.tenantId)).toBe(true);
        expect(pageB.items.every(o => o._tenantId === tenantB.tenantId)).toBe(true);
      });

      it('queryObjects for tenant A returns correct count', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'A1' });
        await provider.createObject(tenantA, 'Patient', { name: 'A2' });
        await provider.createObject(tenantA, 'Patient', { name: 'A3' });
        await provider.createObject(tenantB, 'Patient', { name: 'B1' });

        const page = await provider.queryObjects(tenantA, 'Patient', { field: 'name', operator: 'exists', value: true });
        expect(page.totalCount).toBe(3);
      });

      it('queryObjects for tenant B returns correct count', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'A1' });
        await provider.createObject(tenantB, 'Patient', { name: 'B1' });
        await provider.createObject(tenantB, 'Patient', { name: 'B2' });

        const page = await provider.queryObjects(tenantB, 'Patient', { field: 'name', operator: 'exists', value: true });
        expect(page.totalCount).toBe(2);
      });

      it('tenants can create objects with same properties independently', async () => {
        const objA = await provider.createObject(tenantA, 'Patient', { name: 'SameName', age: 30 });
        const objB = await provider.createObject(tenantB, 'Patient', { name: 'SameName', age: 30 });
        expect(objA._id).not.toBe(objB._id);
        expect(objA._tenantId).toBe(tenantA.tenantId);
        expect(objB._tenantId).toBe(tenantB.tenantId);
      });
    });

    // ─── Link Isolation ───

    describe('link isolation', () => {
      it('link created by tenant A not visible to tenant B', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        const result = await provider.getLink(tenantB, 'AssignedTo', link._id);
        expect(result).toBeNull();
      });

      it('getLinks for tenant A returns only A links', async () => {
        const pA = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
        const cA = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
        await provider.createLink(tenantA, 'AssignedTo', pA._id, cA._id);

        const page = await provider.getLinks(tenantA, pA._id, 'AssignedTo', 'outbound');
        expect(page.items.every(l => l._tenantId === tenantA.tenantId)).toBe(true);
      });

      it('getLinks for tenant B returns only B links', async () => {
        const pB = await provider.createObject(tenantB, 'Patient', { name: 'PB' });
        const cB = await provider.createObject(tenantB, 'CareTeam', { name: 'CB' });
        await provider.createLink(tenantB, 'AssignedTo', pB._id, cB._id);

        const page = await provider.getLinks(tenantB, pB._id, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(1);
        expect(page.items[0]!._tenantId).toBe(tenantB.tenantId);
      });

      it('tenant B cannot delete tenant A link', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        await expect(provider.deleteLink(tenantB, 'AssignedTo', link._id)).rejects.toThrow();
      });

      it('tenant B cannot update tenant A link', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        await expect(provider.updateLink(tenantB, 'AssignedTo', link._id, { role: 'hack' })).rejects.toThrow();
      });

      it('links between tenant A objects invisible to tenant B', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        const page = await provider.getLinks(tenantB, p._id, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(0);
      });
    });

    // ─── Cross-Tenant Blocked ───

    describe('cross-tenant blocked', () => {
      it('tenant B cannot read tenant A object', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Private' });
        const result = await provider.getObject(tenantB, 'Patient', obj._id);
        expect(result).toBeNull();
      });

      it('tenant B cannot update tenant A object', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Private' });
        await expect(
          provider.updateObject(tenantB, 'Patient', obj._id, { name: 'Hacked' }),
        ).rejects.toThrow();
      });

      it('tenant B cannot delete tenant A object', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Private' });
        await expect(
          provider.deleteObject(tenantB, 'Patient', obj._id, 'soft'),
        ).rejects.toThrow();
      });

      it('cross-tenant operations do not leak data', async () => {
        await provider.createObject(tenantA, 'Patient', { name: 'LeakTest' });
        // Tenant B tries to query - should not see tenant A data
        const page = await provider.queryObjects(tenantB, 'Patient', { field: 'name', operator: 'eq', value: 'LeakTest' });
        expect(page.items).toHaveLength(0);
      });
    });

    // ─── Version History Isolation ───

    describe('version history isolation', () => {
      it('getObjectAtVersion scoped to requesting tenant', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Versioned' });
        const result = await provider.getObjectAtVersion(tenantB, 'Patient', obj._id, 1);
        expect(result).toBeNull();
      });

      it('tenant B cannot see tenant A version history', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'V1' });
        await provider.updateObject(tenantA, 'Patient', obj._id, { name: 'V2' });
        const v1 = await provider.getObjectAtVersion(tenantB, 'Patient', obj._id, 1);
        const v2 = await provider.getObjectAtVersion(tenantB, 'Patient', obj._id, 2);
        expect(v1).toBeNull();
        expect(v2).toBeNull();
      });

      it('getObjectAtTime scoped to requesting tenant', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'TimeV' });
        const ts = new Date().toISOString();
        const result = await provider.getObjectAtTime(tenantB, 'Patient', obj._id, ts);
        expect(result).toBeNull();
      });

      it('tenant B cannot see tenant A temporal data', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Temporal' });
        const ts = new Date(Date.now() + 1000).toISOString();
        const result = await provider.getObjectAtTime(tenantB, 'Patient', obj._id, ts);
        expect(result).toBeNull();
      });
    });

    // ─── Transaction Isolation ───

    describe('transaction isolation', () => {
      it('transaction in tenant A context only affects tenant A', async () => {
        const objB = await provider.createObject(tenantB, 'Patient', { name: 'TenantBData' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.createObject('Patient', { name: 'TenantAData' });
        await tx.commit();
        const fetchedB = await provider.getObject(tenantB, 'Patient', objB._id);
        expect(fetchedB).not.toBeNull();
        expect(fetchedB!.name).toBe('TenantBData');
      });

      it('rollback in tenant A does not affect tenant B', async () => {
        const objB = await provider.createObject(tenantB, 'Patient', { name: 'SafeB' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.createObject('Patient', { name: 'WillRollback' });
        await tx.rollback();
        const fetchedB = await provider.getObject(tenantB, 'Patient', objB._id);
        expect(fetchedB).not.toBeNull();
      });
    });

    // ─── Bulk Mutation Isolation ───

    describe('bulk mutation isolation', () => {
      it('bulk mutations scoped to requesting tenant', async () => {
        const result = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'mt-bulk-1',
          operations: [
            { type: 'createObject', objectType: 'Patient', properties: { name: 'BulkA' } },
          ],
        });
        expect(result.accepted).toBe(1);
        const page = await provider.queryObjects(tenantB, 'Patient', { field: 'name', operator: 'eq', value: 'BulkA' });
        expect(page.items).toHaveLength(0);
      });

      it('bulk mutations cannot affect other tenant data', async () => {
        const objA = await provider.createObject(tenantA, 'Patient', { name: 'ProtectedA' });
        const result = await provider.bulkMutate(tenantB, {
          idempotencyKey: 'mt-bulk-2',
          operations: [
            { type: 'updateObject', objectType: 'Patient', id: objA._id, properties: { name: 'Hacked' } },
          ],
        });
        expect(result.failed).toBe(1);
        const fetched = await provider.getObject(tenantA, 'Patient', objA._id);
        expect(fetched!.name).toBe('ProtectedA');
      });

      it('idempotency keys are independent per invocation', async () => {
        const r1 = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'shared-key',
          operations: [{ type: 'createObject', objectType: 'Patient', properties: { name: 'IdemA' } }],
        });
        expect(r1.accepted).toBe(1);
        // Same key returns cached
        const r2 = await provider.bulkMutate(tenantA, {
          idempotencyKey: 'shared-key',
          operations: [{ type: 'createObject', objectType: 'Patient', properties: { name: 'IdemA2' } }],
        });
        expect(r2).toEqual(r1);
      });
    });
  });
}
