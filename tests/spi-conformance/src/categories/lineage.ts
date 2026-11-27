import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

export function registerLineageTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Lineage`, () => {
    let provider: StorageProvider;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
    });

    // ─── Provenance via Version History ───

    describe('provenance via version history', () => {
      it('object creation captures initial state as version 1', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Initial', age: 30 });
        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        expect(v1).not.toBeNull();
        expect(v1!.name).toBe('Initial');
        expect(v1!.age).toBe(30);
        expect(v1!._version).toBe(1);
      });

      it('each update creates new version preserving field changes', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Evolving', age: 20 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 25 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 30, status: 'active' });

        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        const v2 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 2);
        const v3 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 3);

        expect(v1!.age).toBe(20);
        expect(v2!.age).toBe(25);
        expect(v3!.age).toBe(30);
        expect(v3!.status).toBe('active');
      });

      it('version history tracks changes via _updatedAt', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Track' });
        await new Promise(r => setTimeout(r, 10));
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 40 });

        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        const v2 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 2);
        expect(v1!._updatedAt).toBeDefined();
        expect(v2!._updatedAt).toBeDefined();
        expect(v2!._updatedAt >= v1!._updatedAt).toBe(true);
      });

      it('version history is complete (no gaps)', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Complete' });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 1 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 2 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 3 });

        for (let v = 1; v <= 4; v++) {
          const snapshot = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, v);
          expect(snapshot).not.toBeNull();
          expect(snapshot!._version).toBe(v);
        }
      });

      it('version history preserves full object state', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Full', age: 10, status: 'new' });
        await provider.updateObject(tenantA, 'Patient', obj._id, { age: 20 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { status: 'active' });

        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        expect(v1!.name).toBe('Full');
        expect(v1!.age).toBe(10);
        expect(v1!.status).toBe('new');

        const v2 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 2);
        expect(v2!.name).toBe('Full');
        expect(v2!.age).toBe(20);
        expect(v2!.status).toBe('new');

        const v3 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 3);
        expect(v3!.name).toBe('Full');
        expect(v3!.age).toBe(20);
        expect(v3!.status).toBe('active');
      });
    });

    // ─── Lineage via Graph Traversal ───

    describe('lineage via graph traversal', () => {
      it('single-step outbound traversal shows direct relationships', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'Source' });
        const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'Target1' });
        const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'Target2' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
        await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
        });
        expect(result.nodes).toHaveLength(2);
        expect(result.edges).toHaveLength(2);
      });

      it('single-step inbound traversal shows reverse relationships', async () => {
        const p1 = await provider.createObject(tenantA, 'Patient', { name: 'P1' });
        const p2 = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Team' });
        await provider.createLink(tenantA, 'AssignedTo', p1._id, c._id);
        await provider.createLink(tenantA, 'AssignedTo', p2._id, c._id);

        const result = await provider.traverse(tenantA, c._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'inbound' }],
        });
        expect(result.nodes).toHaveLength(2);
      });

      it('multi-step traversal shows transitive lineage', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'Start' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Middle' });
        const m = await provider.createObject(tenantA, 'Medication', { name: 'End' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        await provider.createLink(tenantA, 'Prescribes', c._id, m._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [
            { linkType: 'AssignedTo', direction: 'outbound' },
            { linkType: 'Prescribes', direction: 'outbound' },
          ],
        });
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0]!.name).toBe('End');
      });

      it('traversal with filters narrows results', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'FilterStart' });
        const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'Alpha' });
        const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'Beta' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
        await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [{
            linkType: 'AssignedTo',
            direction: 'outbound',
            filter: { field: 'name', operator: 'eq', value: 'Alpha' },
          }],
        });
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0]!.name).toBe('Alpha');
      });

      it('traversal pagination works correctly', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'PagStart' });
        const teams = [];
        for (let i = 0; i < 5; i++) {
          const c = await provider.createObject(tenantA, 'CareTeam', { name: `Team${i}` });
          await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
          teams.push(c);
        }

        const result = await provider.traverse(tenantA, p._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
        }, { limit: 3 });
        expect(result.nodes).toHaveLength(3);
        expect(result.totalCount).toBe(5);
      });

      it('traversal returns both nodes and edges', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'NodeEdge' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Team' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
        });
        expect(result.nodes).toHaveLength(1);
        expect(result.edges).toHaveLength(1);
        expect(result.edges[0]!._fromId).toBe(p._id);
        expect(result.edges[0]!._toId).toBe(c._id);
      });
    });

    // ─── Lineage Query Patterns ───

    describe('lineage query patterns', () => {
      it('find all CareTeams for a Patient', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'QueryP' });
        const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'QTeam1' });
        const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'QTeam2' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
        await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
        });
        expect(result.nodes).toHaveLength(2);
      });

      it('find all Patients for a CareTeam', async () => {
        const p1 = await provider.createObject(tenantA, 'Patient', { name: 'QP1' });
        const p2 = await provider.createObject(tenantA, 'Patient', { name: 'QP2' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'SharedTeam' });
        await provider.createLink(tenantA, 'AssignedTo', p1._id, c._id);
        await provider.createLink(tenantA, 'AssignedTo', p2._id, c._id);

        const result = await provider.traverse(tenantA, c._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'inbound' }],
        });
        expect(result.nodes).toHaveLength(2);
      });

      it('find medications prescribed by a team', async () => {
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Prescribers' });
        const m1 = await provider.createObject(tenantA, 'Medication', { name: 'Med1' });
        const m2 = await provider.createObject(tenantA, 'Medication', { name: 'Med2' });
        await provider.createLink(tenantA, 'Prescribes', c._id, m1._id);
        await provider.createLink(tenantA, 'Prescribes', c._id, m2._id);

        const result = await provider.traverse(tenantA, c._id, {
          steps: [{ linkType: 'Prescribes', direction: 'outbound' }],
        });
        expect(result.nodes).toHaveLength(2);
      });

      it('full care chain: Patient -> CareTeam -> Medication', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'Chain' });
        const c = await provider.createObject(tenantA, 'CareTeam', { name: 'ChainTeam' });
        const m = await provider.createObject(tenantA, 'Medication', { name: 'ChainMed' });
        await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
        await provider.createLink(tenantA, 'Prescribes', c._id, m._id);

        const result = await provider.traverse(tenantA, p._id, {
          steps: [
            { linkType: 'AssignedTo', direction: 'outbound' },
            { linkType: 'Prescribes', direction: 'outbound' },
          ],
        });
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0]!._type).toBe('Medication');
      });

      it('empty traversal returns empty result', async () => {
        const p = await provider.createObject(tenantA, 'Patient', { name: 'Lonely' });
        const result = await provider.traverse(tenantA, p._id, {
          steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
        });
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
      });
    });

    // ─── Change Tracking ───

    describe('change tracking', () => {
      it('_version tracks modification count', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Counter' });
        expect(obj._version).toBe(1);
        const u1 = await provider.updateObject(tenantA, 'Patient', obj._id, { age: 1 });
        expect(u1._version).toBe(2);
        const u2 = await provider.updateObject(tenantA, 'Patient', obj._id, { age: 2 });
        expect(u2._version).toBe(3);
      });

      it('_createdAt is immutable across updates', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Immutable' });
        const createdAt = obj._createdAt;
        await new Promise(r => setTimeout(r, 10));
        const updated = await provider.updateObject(tenantA, 'Patient', obj._id, { age: 99 });
        expect(updated._createdAt).toBe(createdAt);
      });

      it('_updatedAt changes on every update', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Mutable' });
        await new Promise(r => setTimeout(r, 10));
        const u1 = await provider.updateObject(tenantA, 'Patient', obj._id, { age: 1 });
        expect(u1._updatedAt >= obj._updatedAt).toBe(true);
      });

      it('soft-delete records _deletedAt as deletion provenance', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Deleted' });
        await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
        const page = await provider.queryObjects(tenantA, 'Patient',
          { field: '_id', operator: 'eq', value: obj._id },
          { includeDeleted: true },
        );
        expect(page.items[0]!._deletedAt).toBeDefined();
      });

      it('object state before and after update independently retrievable', async () => {
        const obj = await provider.createObject(tenantA, 'Patient', { name: 'Before', age: 10 });
        await provider.updateObject(tenantA, 'Patient', obj._id, { name: 'After', age: 20 });

        const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
        const v2 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 2);
        expect(v1!.name).toBe('Before');
        expect(v1!.age).toBe(10);
        expect(v2!.name).toBe('After');
        expect(v2!.age).toBe(20);
      });
    });
  });
}
