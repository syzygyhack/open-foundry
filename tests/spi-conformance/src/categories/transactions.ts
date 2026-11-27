import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

export function registerTransactionTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Transactions`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // ─── Commit ───

    describe('commit', () => {
      it('committed object creation persists', async () => {
        const tx = await provider.beginTransaction(tenantA);
        const obj = await tx.createObject('Patient', { name: 'TxCreate' });
        await tx.commit();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched).not.toBeNull();
        expect(fetched!.name).toBe('TxCreate');
      });

      it('committed object update persists', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Before', age: 10 });
        const tx = await provider.beginTransaction(tenantA);
        await tx.updateObject('Patient', obj._id, { age: 99 });
        await tx.commit();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched!.age).toBe(99);
      });

      it('committed link creation persists', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
        const tx = await provider.beginTransaction(tenantA);
        const link = await tx.createLink('AssignedTo', p._id, c._id);
        await tx.commit();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched).not.toBeNull();
      });

      it('committed link update persists', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id, { role: 'old' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.updateLink('AssignedTo', link._id, { role: 'new' });
        await tx.commit();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched!.role).toBe('new');
      });

      it('committed soft-delete persists', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'ToDelete' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteObject('Patient', obj._id, 'soft');
        await tx.commit();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched).toBeNull();
      });
    });

    // ─── Rollback ───

    describe('rollback', () => {
      it('reverts object creation', async () => {
        const tx = await provider.beginTransaction(tenantA);
        const obj = await tx.createObject('Patient', { name: 'Rollback' });
        await tx.rollback();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched).toBeNull();
      });

      it('reverts object update', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Original', age: 20 });
        const tx = await provider.beginTransaction(tenantA);
        await tx.updateObject('Patient', obj._id, { age: 99 });
        await tx.rollback();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched!.age).toBe(20);
        expect(fetched!._version).toBe(1);
      });

      it('reverts soft-delete', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Undelete' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteObject('Patient', obj._id, 'soft');
        await tx.rollback();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched).not.toBeNull();
        expect(fetched!._deletedAt).toBeUndefined();
      });

      it('reverts hard-delete', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'HardUndo' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteObject('Patient', obj._id, 'hard');
        await tx.rollback();
        const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
        expect(fetched).not.toBeNull();
      });

      it('reverts link creation', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
        const tx = await provider.beginTransaction(tenantA);
        const link = await tx.createLink('AssignedTo', p._id, c._id);
        await tx.rollback();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched).toBeNull();
      });

      it('reverts link update', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id, { role: 'original' });
        const tx = await provider.beginTransaction(tenantA);
        await tx.updateLink('AssignedTo', link._id, { role: 'changed' });
        await tx.rollback();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched!.role).toBe('original');
      });

      it('reverts link deletion', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
        const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteLink('AssignedTo', link._id);
        await tx.rollback();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched).not.toBeNull();
      });
    });

    // ─── Transaction State ───

    describe('transaction state', () => {
      it('operations after commit throw', async () => {
        const tx = await provider.beginTransaction(tenantA);
        await tx.commit();
        await expect(tx.createObject('Patient', { name: 'Bad' })).rejects.toThrow(/committed/);
      });

      it('operations after rollback throw', async () => {
        const tx = await provider.beginTransaction(tenantA);
        await tx.rollback();
        await expect(tx.createObject('Patient', { name: 'Bad' })).rejects.toThrow(/rolled back/);
      });

      it('double commit throws', async () => {
        const tx = await provider.beginTransaction(tenantA);
        await tx.commit();
        await expect(tx.commit()).rejects.toThrow(/committed/);
      });

      it('double rollback throws', async () => {
        const tx = await provider.beginTransaction(tenantA);
        await tx.rollback();
        await expect(tx.rollback()).rejects.toThrow(/rolled back/);
      });
    });

    // ─── Atomic Behavior ───

    describe('atomic behavior', () => {
      it('multiple operations all commit together', async () => {
        const tx = await provider.beginTransaction(tenantA);
        const obj1 = await tx.createObject('Patient', { name: 'Atomic1' });
        const obj2 = await tx.createObject('Patient', { name: 'Atomic2' });
        const obj3 = await tx.createObject('CareTeam', { name: 'AtomicTeam' });
        await tx.commit();
        expect(await provider.getObject(tenantA, 'Patient', obj1._id)).not.toBeNull();
        expect(await provider.getObject(tenantA, 'Patient', obj2._id)).not.toBeNull();
        expect(await provider.getObject(tenantA, 'CareTeam', obj3._id)).not.toBeNull();
      });

      it('multiple operations all rollback together', async () => {
        const tx = await provider.beginTransaction(tenantA);
        const obj1 = await tx.createObject('Patient', { name: 'RB1' });
        const obj2 = await tx.createObject('Patient', { name: 'RB2' });
        await tx.rollback();
        expect(await provider.getObject(tenantA, 'Patient', obj1._id)).toBeNull();
        expect(await provider.getObject(tenantA, 'Patient', obj2._id)).toBeNull();
      });

      it('mixed object and link operations in single transaction', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'MixP' });
        const tx = await provider.beginTransaction(tenantA);
        const team = await tx.createObject('CareTeam', { name: 'MixTeam' });
        const link = await tx.createLink('AssignedTo', p._id, team._id);
        await tx.updateObject('Patient', p._id, { status: 'linked' });
        await tx.commit();
        expect(await provider.getObject(tenantA, 'CareTeam', team._id)).not.toBeNull();
        expect(await provider.getLink(tenantA, 'AssignedTo', link._id)).not.toBeNull();
        const updated = await provider.getObject(tenantA, 'Patient', p._id);
        expect(updated!.status).toBe('linked');
      });
    });
  });
}
