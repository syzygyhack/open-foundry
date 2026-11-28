import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '../memory-storage-provider.js';
import type {
  RequestContext,
  OntologySchema,
  FilterExpression,
  BulkMutationRequest,
} from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenantA: RequestContext = { tenantId: 'tenant-a', actorId: 'actor-1' };
const tenantB: RequestContext = { tenantId: 'tenant-b', actorId: 'actor-2' };

const schema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'integer' },
        { name: 'status', type: 'string' },
      ],
    },
    {
      name: 'CareTeam',
      properties: [{ name: 'name', type: 'string', required: true }],
    },
    {
      name: 'Appointment',
      properties: [{ name: 'date', type: 'string' }],
    },
  ],
  linkTypes: [
    {
      name: 'AssignedTo',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'MANY_TO_MANY',
    },
    {
      name: 'PrimaryDoctor',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_ONE',
    },
    {
      name: 'HasAppointment',
      fromType: 'Patient',
      toType: 'Appointment',
      cardinality: 'ONE_TO_MANY',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryStorageProvider', () => {
  let provider: MemoryStorageProvider;

  beforeEach(async () => {
    provider = new MemoryStorageProvider();
    await provider.applySchema(tenantA, schema);
  });

  // ─── Capabilities & Health ───

  describe('capabilities', () => {
    it('returns correct capability flags', () => {
      const caps = provider.capabilities();
      expect(caps.supportsTransactions).toBe(true);
      expect(caps.supportsTemporalQueries).toBe(true);
      expect(caps.supportsGraphTraversal).toBe(true);
      expect(caps.supportsBulkMutations).toBe(true);
      expect(caps.supportsFullTextSearch).toBe(true);
      expect(caps.supportsGeoQueries).toBe(false);
    });

    it('reports healthy', async () => {
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.provider).toBe('memory');
    });
  });

  // ─── Schema ───

  describe('schema', () => {
    it('applies and retrieves schema', async () => {
      const result = await provider.applySchema(tenantA, schema);
      expect(result.success).toBe(true);
      expect(result.toVersion).toBe(1);

      const retrieved = await provider.getSchema(tenantA, 1);
      expect(retrieved.version).toBe(1);
      expect(retrieved.objectTypes).toHaveLength(3);
    });

    it('throws on missing schema version', async () => {
      await expect(provider.getSchema(tenantA, 99)).rejects.toThrow();
    });
  });

  // ─── Object CRUD ───

  describe('objects', () => {
    it('creates an object with system fields', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', {
        name: 'Alice',
        age: 30,
      });
      expect(obj._tenantId).toBe('tenant-a');
      expect(obj._type).toBe('Patient');
      expect(obj._id).toBeDefined();
      expect(obj._version).toBe(1);
      expect(obj._createdAt).toBeDefined();
      expect(obj._updatedAt).toBeDefined();
      expect(obj.name).toBe('Alice');
      expect(obj.age).toBe(30);
    });

    it('retrieves an object by type and id', async () => {
      const created = await provider.createObject(tenantA, 'Patient', { name: 'Bob' });
      const fetched = await provider.getObject(tenantA, 'Patient', created._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(created._id);
      expect(fetched!.name).toBe('Bob');
    });

    it('returns null for non-existent object', async () => {
      const result = await provider.getObject(tenantA, 'Patient', 'nope');
      expect(result).toBeNull();
    });

    it('updates an object and increments version', async () => {
      const created = await provider.createObject(tenantA, 'Patient', { name: 'Charlie', age: 25 });
      const updated = await provider.updateObject(tenantA, 'Patient', created._id, { age: 26 });
      expect(updated._version).toBe(2);
      expect(updated.age).toBe(26);
      expect(updated.name).toBe('Charlie');
    });

    it('soft-deletes an object (excluded from getObject)', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Dana' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
      const result = await provider.getObject(tenantA, 'Patient', obj._id);
      expect(result).toBeNull();
    });

    it('hard-deletes an object permanently', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Eve' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'hard');
      const result = await provider.getObject(tenantA, 'Patient', obj._id);
      expect(result).toBeNull();
    });

    it('throws when updating a deleted object', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Frank' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');
      await expect(
        provider.updateObject(tenantA, 'Patient', obj._id, { name: 'Frank2' }),
      ).rejects.toThrow('deleted');
    });

    it('bumps version + updatedAt even for an empty-payload update (parity invariant)', async () => {
      const created = await provider.createObject(tenantA, 'Patient', { name: 'Gita' });
      const updated = await provider.updateObject(tenantA, 'Patient', created._id, {});
      expect(updated._version).toBe(2);
      expect(updated.name).toBe('Gita');
      // matches PostgresObjectStore.update which always bumps updated_at (rc.2 fix).
    });

    it('optimistic concurrency: stale expectedVersion is rejected with VERSION_CONFLICT', async () => {
      const created = await provider.createObject(tenantA, 'Patient', { name: 'Hugo', age: 1 });
      // succeeds at the current version (1) → now version 2
      await provider.updateObject(tenantA, 'Patient', created._id, { age: 2 }, 1);
      // a second writer holding the stale version 1 must be rejected
      await expect(
        provider.updateObject(tenantA, 'Patient', created._id, { age: 3 }, 1),
      ).rejects.toThrow(/version 2, expected 1|VERSION_CONFLICT/);
    });
  });

  // ─── Soft-delete semantics ───

  describe('soft-delete semantics', () => {
    it('excludes soft-deleted objects from queryObjects by default', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Ghost' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');

      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'name',
        operator: 'eq',
        value: 'Ghost',
      });
      expect(page.items).toHaveLength(0);
    });

    it('includes soft-deleted objects when includeDeleted is true', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Ghost2' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');

      const page = await provider.queryObjects(
        tenantA,
        'Patient',
        { field: 'name', operator: 'eq', value: 'Ghost2' },
        { includeDeleted: true },
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!._deletedAt).toBeDefined();
    });
  });

  // ─── Filter expressions ───

  describe('filter expressions', () => {
    beforeEach(async () => {
      await provider.createObject(tenantA, 'Patient', { name: 'Alice', age: 30, status: 'active' });
      await provider.createObject(tenantA, 'Patient', { name: 'Bob', age: 25, status: 'active' });
      await provider.createObject(tenantA, 'Patient', { name: 'Charlie', age: 40, status: 'inactive' });
    });

    it('eq filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'name',
        operator: 'eq',
        value: 'Alice',
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.name).toBe('Alice');
    });

    it('neq filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'status',
        operator: 'neq',
        value: 'inactive',
      });
      expect(page.items).toHaveLength(2);
    });

    it('gt filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'age',
        operator: 'gt',
        value: 25,
      });
      expect(page.items).toHaveLength(2);
    });

    it('lt filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'age',
        operator: 'lt',
        value: 30,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.name).toBe('Bob');
    });

    it('in filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'name',
        operator: 'in',
        value: ['Alice', 'Charlie'],
      });
      expect(page.items).toHaveLength(2);
    });

    it('contains filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'name',
        operator: 'contains',
        value: 'li',
      });
      expect(page.items).toHaveLength(2); // Alice, Charlie
    });

    it('gte filter (boundary inclusive)', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'age', operator: 'gte', value: 30,
      });
      expect(page.items.map(p => p.name).sort()).toEqual(['Alice', 'Charlie']); // 30 incl, 40
    });

    it('lte filter (boundary inclusive)', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'age', operator: 'lte', value: 30,
      });
      expect(page.items.map(p => p.name).sort()).toEqual(['Alice', 'Bob']); // 30 incl, 25
    });

    it('startsWith filter', async () => {
      const page = await provider.queryObjects(tenantA, 'Patient', {
        field: 'name', operator: 'startsWith', value: 'A',
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.name).toBe('Alice');
    });

    it('AND logical filter', async () => {
      const filter: FilterExpression = {
        and: [
          { field: 'status', operator: 'eq', value: 'active' },
          { field: 'age', operator: 'gt', value: 26 },
        ],
      };
      const page = await provider.queryObjects(tenantA, 'Patient', filter);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.name).toBe('Alice');
    });

    it('OR logical filter', async () => {
      const filter: FilterExpression = {
        or: [
          { field: 'name', operator: 'eq', value: 'Alice' },
          { field: 'name', operator: 'eq', value: 'Charlie' },
        ],
      };
      const page = await provider.queryObjects(tenantA, 'Patient', filter);
      expect(page.items).toHaveLength(2);
    });

    it('NOT logical filter', async () => {
      const filter: FilterExpression = {
        not: { field: 'status', operator: 'eq', value: 'active' },
      };
      const page = await provider.queryObjects(tenantA, 'Patient', filter);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.name).toBe('Charlie');
    });

    it('pagination with limit and offset', async () => {
      const page = await provider.queryObjects(
        tenantA,
        'Patient',
        { field: 'status', operator: 'eq', value: 'active' },
        { limit: 1, offset: 0 },
      );
      expect(page.items).toHaveLength(1);
      expect(page.totalCount).toBe(2);
      expect(page.hasNextPage).toBe(true);
    });

    it('sorting by field', async () => {
      const page = await provider.queryObjects(
        tenantA,
        'Patient',
        { field: 'age', operator: 'gt', value: 0 },
        { orderBy: [{ field: 'age', direction: 'desc' }] },
      );
      expect(page.items[0]!.name).toBe('Charlie');
      expect(page.items[1]!.name).toBe('Alice');
      expect(page.items[2]!.name).toBe('Bob');
    });
  });

  // ─── Links ───

  describe('links', () => {
    it('rejects a link ID already held by another tenant instead of overwriting it', async () => {
      const pa = await provider.createObject(tenantA, 'Patient', { name: 'A' });
      const ca = await provider.createObject(tenantA, 'CareTeam', { name: 'TA' });
      const pb = await provider.createObject(tenantB, 'Patient', { name: 'B' });
      const cb = await provider.createObject(tenantB, 'CareTeam', { name: 'TB' });
      const link = await provider.createLink(tenantA, 'AssignedTo', pa._id, ca._id, { _engineLinkId: 'same-id' });
      await provider.deleteLink(tenantA, 'AssignedTo', link._id);

      await expect(
        provider.createLink(tenantB, 'AssignedTo', pb._id, cb._id, { _engineLinkId: 'same-id' }),
      ).rejects.toThrow(/already exists/);
      const history = await provider.getLinks(tenantA, pa._id, 'AssignedTo', 'outbound', { includeDeleted: true });
      expect(history.items.map((l) => l._id)).toEqual(['same-id']);
    });

    it('creates and retrieves a link', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'Linked' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'TeamA' });
      const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id, { note: 'primary' });

      expect(link._type).toBe('AssignedTo');
      expect(link._fromId).toBe(p._id);
      expect(link._toId).toBe(c._id);
      expect(link.note).toBe('primary');

      const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(link._id);
    });

    it('updates a link', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });
      const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id, { note: 'old' });

      const updated = await provider.updateLink(tenantA, 'AssignedTo', link._id, { note: 'new' });
      expect(updated.note).toBe('new');
      expect(updated._version).toBe(2);
    });

    it('deletes a link', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C2' });
      const link = await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);

      await provider.deleteLink(tenantA, 'AssignedTo', link._id);
      const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
      expect(fetched).toBeNull();
    });

    it('getLinks returns outbound links for an object', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'Multi' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'T1' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'T2' });
      await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
      await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

      const page = await provider.getLinks(tenantA, p._id, 'AssignedTo', 'outbound');
      expect(page.items).toHaveLength(2);
      expect(page.totalCount).toBe(2);
    });

    it('getLinks returns inbound links for an object', async () => {
      const p1 = await provider.createObject(tenantA, 'Patient', { name: 'P1' });
      const p2 = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Team' });
      await provider.createLink(tenantA, 'AssignedTo', p1._id, c._id);
      await provider.createLink(tenantA, 'AssignedTo', p2._id, c._id);

      const page = await provider.getLinks(tenantA, c._id, 'AssignedTo', 'inbound');
      expect(page.items).toHaveLength(2);
    });
  });

  // ─── Link cardinality enforcement ───

  describe('link cardinality', () => {
    it('ONE_TO_ONE prevents duplicate outbound', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'C1' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'C2' });

      await provider.createLink(tenantA, 'PrimaryDoctor', p._id, c1._id);
      await expect(
        provider.createLink(tenantA, 'PrimaryDoctor', p._id, c2._id),
      ).rejects.toThrow('Cardinality violation');
    });

    it('ONE_TO_ONE prevents duplicate inbound', async () => {
      const p1 = await provider.createObject(tenantA, 'Patient', { name: 'P1' });
      const p2 = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });

      await provider.createLink(tenantA, 'PrimaryDoctor', p1._id, c._id);
      await expect(
        provider.createLink(tenantA, 'PrimaryDoctor', p2._id, c._id),
      ).rejects.toThrow('Cardinality violation');
    });

    it('ONE_TO_MANY allows multiple outbound but prevents duplicate inbound', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
      const a1 = await provider.createObject(tenantA, 'Appointment', { date: '2024-01-01' });
      const a2 = await provider.createObject(tenantA, 'Appointment', { date: '2024-02-01' });

      // Multiple outbound from same patient: OK (one-to-MANY)
      await provider.createLink(tenantA, 'HasAppointment', p._id, a1._id);
      await provider.createLink(tenantA, 'HasAppointment', p._id, a2._id);

      // But same appointment can't belong to multiple patients (ONE-to-many)
      const p2 = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
      await expect(
        provider.createLink(tenantA, 'HasAppointment', p2._id, a1._id),
      ).rejects.toThrow('Cardinality violation');
    });

    it('MANY_TO_MANY allows any combination', async () => {
      const p1 = await provider.createObject(tenantA, 'Patient', { name: 'P1' });
      const p2 = await provider.createObject(tenantA, 'Patient', { name: 'P2' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'C1' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'C2' });

      // All should succeed
      await provider.createLink(tenantA, 'AssignedTo', p1._id, c1._id);
      await provider.createLink(tenantA, 'AssignedTo', p1._id, c2._id);
      await provider.createLink(tenantA, 'AssignedTo', p2._id, c1._id);
      await provider.createLink(tenantA, 'AssignedTo', p2._id, c2._id);
    });

    it('cardinality enforcement ignores deleted links', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'C1' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'C2' });

      const link = await provider.createLink(tenantA, 'PrimaryDoctor', p._id, c1._id);
      await provider.deleteLink(tenantA, 'PrimaryDoctor', link._id);

      // Should succeed because first link was deleted
      await provider.createLink(tenantA, 'PrimaryDoctor', p._id, c2._id);
    });
  });

  // ─── Traversal ───

  describe('traverse', () => {
    it('traverses a single-step path', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'Traveler' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'TeamX' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'TeamY' });
      await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
      await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

      const result = await provider.traverse(tenantA, p._id, {
        steps: [{ linkType: 'AssignedTo', direction: 'outbound' }],
      });

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });

    it('traverses multi-step path', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'Start' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'Middle' });
      const a = await provider.createObject(tenantA, 'Appointment', { date: '2024-06-01' });

      // Create a link type for CareTeam -> Appointment (add to schema)
      const schema2: OntologySchema = {
        ...schema,
        version: 2,
        linkTypes: [
          ...schema.linkTypes,
          { name: 'Scheduled', fromType: 'CareTeam', toType: 'Appointment', cardinality: 'ONE_TO_MANY' },
        ],
      };
      await provider.applySchema(tenantA, schema2);

      await provider.createLink(tenantA, 'AssignedTo', p._id, c._id);
      await provider.createLink(tenantA, 'Scheduled', c._id, a._id);

      const result = await provider.traverse(tenantA, p._id, {
        steps: [
          { linkType: 'AssignedTo', direction: 'outbound' },
          { linkType: 'Scheduled', direction: 'outbound' },
        ],
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!._type).toBe('Appointment');
    });

    it('applies filter in traversal step', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'Start' });
      const c1 = await provider.createObject(tenantA, 'CareTeam', { name: 'Alpha' });
      const c2 = await provider.createObject(tenantA, 'CareTeam', { name: 'Beta' });
      await provider.createLink(tenantA, 'AssignedTo', p._id, c1._id);
      await provider.createLink(tenantA, 'AssignedTo', p._id, c2._id);

      const result = await provider.traverse(tenantA, p._id, {
        steps: [
          {
            linkType: 'AssignedTo',
            direction: 'outbound',
            filter: { field: 'name', operator: 'eq', value: 'Alpha' },
          },
        ],
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.name).toBe('Alpha');
    });

    it('throws when path exceeds MAX_TRAVERSAL_DEPTH (10)', async () => {
      const steps = Array.from({ length: 11 }, () => ({
        linkType: 'AssignedTo',
        direction: 'outbound' as const,
      }));

      await expect(
        provider.traverse(tenantA, 'start-id', { steps }),
      ).rejects.toThrow(/exceeds maximum of 10/);
    });

    it('allows path at exactly MAX_TRAVERSAL_DEPTH (10)', async () => {
      const steps = Array.from({ length: 10 }, () => ({
        linkType: 'AssignedTo',
        direction: 'outbound' as const,
      }));

      // Should not throw — returns empty because no links found at depth
      const result = await provider.traverse(tenantA, 'start-id', { steps });
      expect(result.nodes).toHaveLength(0);
    });
  });

  // ─── Transactions ───

  describe('transactions', () => {
    it('commit persists changes', async () => {
      const tx = await provider.beginTransaction(tenantA);
      const obj = await tx.createObject('Patient', { name: 'TxPatient' });
      await tx.commit();

      const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('TxPatient');
    });

    it('rollback reverts object creation', async () => {
      const tx = await provider.beginTransaction(tenantA);
      const obj = await tx.createObject('Patient', { name: 'Rollback' });
      await tx.rollback();

      const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
      expect(fetched).toBeNull();
    });

    it('rollback reverts object update', async () => {
      const original = await provider.createObject(tenantA, 'Patient', { name: 'Before', age: 20 });
      const tx = await provider.beginTransaction(tenantA);
      await tx.updateObject('Patient', original._id, { age: 99 });
      await tx.rollback();

      const fetched = await provider.getObject(tenantA, 'Patient', original._id);
      expect(fetched!.age).toBe(20);
      expect(fetched!._version).toBe(1);
    });

    it('rollback reverts link creation', async () => {
      const p = await provider.createObject(tenantA, 'Patient', { name: 'P' });
      const c = await provider.createObject(tenantA, 'CareTeam', { name: 'C' });

      const tx = await provider.beginTransaction(tenantA);
      const link = await tx.createLink('AssignedTo', p._id, c._id);
      await tx.rollback();

      const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
      expect(fetched).toBeNull();
    });

    it('rollback reverts soft-delete', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Undelete' });
      const tx = await provider.beginTransaction(tenantA);
      await tx.deleteObject('Patient', obj._id, 'soft');
      await tx.rollback();

      const fetched = await provider.getObject(tenantA, 'Patient', obj._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._deletedAt).toBeUndefined();
    });

    it('prevents operations after commit', async () => {
      const tx = await provider.beginTransaction(tenantA);
      await tx.commit();
      await expect(tx.createObject('Patient', { name: 'Bad' })).rejects.toThrow('committed');
    });

    it('prevents operations after rollback', async () => {
      const tx = await provider.beginTransaction(tenantA);
      await tx.rollback();
      await expect(tx.createObject('Patient', { name: 'Bad' })).rejects.toThrow('rolled back');
    });
  });

  // ─── Versioning ───

  describe('versioning', () => {
    it('retrieves object at specific version', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'V1', age: 10 });
      await provider.updateObject(tenantA, 'Patient', obj._id, { age: 20 });
      await provider.updateObject(tenantA, 'Patient', obj._id, { age: 30 });

      const v1 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 1);
      expect(v1!.age).toBe(10);
      expect(v1!._version).toBe(1);

      const v2 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 2);
      expect(v2!.age).toBe(20);

      const v3 = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 3);
      expect(v3!.age).toBe(30);
    });

    it('returns null for non-existent version', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'V' });
      const result = await provider.getObjectAtVersion(tenantA, 'Patient', obj._id, 99);
      expect(result).toBeNull();
    });

    it('retrieves object at specific time', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'TimeV', age: 10 });
      const afterCreate = new Date().toISOString();

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await provider.updateObject(tenantA, 'Patient', obj._id, { age: 20 });

      const atCreate = await provider.getObjectAtTime(tenantA, 'Patient', obj._id, afterCreate);
      expect(atCreate!.age).toBe(10);
    });

    it('returns null for time before object existed', async () => {
      const beforeCreate = new Date(Date.now() - 100000).toISOString();
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Future' });
      const result = await provider.getObjectAtTime(tenantA, 'Patient', obj._id, beforeCreate);
      expect(result).toBeNull();
    });
  });

  // ─── Tenant isolation ───

  describe('tenant isolation', () => {
    it('objects created by tenant A are invisible to tenant B', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Secret' });
      const result = await provider.getObject(tenantB, 'Patient', obj._id);
      expect(result).toBeNull();
    });

    it('queryObjects scoped to requesting tenant', async () => {
      await provider.createObject(tenantA, 'Patient', { name: 'TenantA' });
      await provider.createObject(tenantB, 'Patient', { name: 'TenantB' });

      const pageA = await provider.queryObjects(tenantA, 'Patient', { field: '_type', operator: 'eq', value: 'Patient' });
      expect(pageA.items.every((o) => o._tenantId === 'tenant-a')).toBe(true);

      const pageB = await provider.queryObjects(tenantB, 'Patient', { field: '_type', operator: 'eq', value: 'Patient' });
      expect(pageB.items.every((o) => o._tenantId === 'tenant-b')).toBe(true);
    });

    it('links scoped to requesting tenant', async () => {
      const pA = await provider.createObject(tenantA, 'Patient', { name: 'PA' });
      const cA = await provider.createObject(tenantA, 'CareTeam', { name: 'CA' });
      const link = await provider.createLink(tenantA, 'AssignedTo', pA._id, cA._id);

      const fromA = await provider.getLink(tenantA, 'AssignedTo', link._id);
      expect(fromA).not.toBeNull();

      const fromB = await provider.getLink(tenantB, 'AssignedTo', link._id);
      expect(fromB).toBeNull();
    });

    it('version history scoped to requesting tenant', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'VTenant' });
      const resultB = await provider.getObjectAtVersion(tenantB, 'Patient', obj._id, 1);
      expect(resultB).toBeNull();
    });
  });

  // ─── Bulk mutations ───

  describe('bulkMutate', () => {
    it('processes multiple operations', async () => {
      const result = await provider.bulkMutate(tenantA, {
        idempotencyKey: 'bulk-1',
        operations: [
          { type: 'createObject', objectType: 'Patient', properties: { name: 'Bulk1' } },
          { type: 'createObject', objectType: 'Patient', properties: { name: 'Bulk2' } },
        ],
      });
      expect(result.accepted).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('returns cached result for duplicate idempotency key', async () => {
      const req: BulkMutationRequest = {
        idempotencyKey: 'idem-1',
        operations: [
          { type: 'createObject', objectType: 'Patient', properties: { name: 'Idem' } },
        ],
      };
      const first = await provider.bulkMutate(tenantA, req);
      const second = await provider.bulkMutate(tenantA, req);
      expect(second).toEqual(first);
    });

    it('reports failures per operation', async () => {
      const obj = await provider.createObject(tenantA, 'Patient', { name: 'Existing' });
      await provider.deleteObject(tenantA, 'Patient', obj._id, 'soft');

      const result = await provider.bulkMutate(tenantA, {
        idempotencyKey: 'bulk-fail',
        operations: [
          { type: 'createObject', objectType: 'Patient', properties: { name: 'OK' } },
          { type: 'updateObject', objectType: 'Patient', id: obj._id, properties: { name: 'Fail' } },
        ],
      });
      expect(result.accepted).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.operationIndex).toBe(1);
    });
  });

  // ─── Index (no-op) ───

  describe('ensureIndex', () => {
    it('succeeds without error', async () => {
      await expect(provider.ensureIndex(tenantA, 'Patient', { field: 'name', indexType: 'BTREE' })).resolves.toBeUndefined();
    });
  });

  describe('links made with no schema applied', () => {
    // Their endpoint types are recorded as 'unknown'; they must still be read,
    // traversed, hidden and cascaded like any other link.
    it('are read, traversed, hidden with a soft-deleted endpoint, and cascade on hard delete', async () => {
      const bare = new MemoryStorageProvider();
      const a = await bare.createObject(tenantA, 'Patient', { name: 'A' });
      const b = await bare.createObject(tenantA, 'CareTeam', { name: 'B' });
      const c = await bare.createObject(tenantA, 'CareTeam', { name: 'C' });
      await bare.createLink(tenantA, 'AssignedTo', a._id, b._id);
      await bare.createLink(tenantA, 'AssignedTo', a._id, c._id);

      const live = await bare.getLinks(tenantA, a._id, 'AssignedTo', 'outbound');
      expect(live.items.map((l) => l._toId).sort()).toEqual([b._id, c._id].sort());
      const reached = await bare.traverse(tenantA, a._id, { steps: [{ linkType: 'AssignedTo', direction: 'outbound' }] });
      expect(reached.nodes.map((n) => n._id).sort()).toEqual([b._id, c._id].sort());

      await bare.deleteObject(tenantA, 'CareTeam', b._id, 'soft');
      expect((await bare.getLinks(tenantA, a._id, 'AssignedTo', 'outbound')).items.map((l) => l._toId)).toEqual([c._id]);

      await bare.deleteObject(tenantA, 'CareTeam', c._id, 'hard');
      const all = await bare.getLinks(tenantA, a._id, 'AssignedTo', 'outbound', { includeDeleted: true });
      expect(all.items.map((l) => l._toId)).toEqual([b._id]);
    });

    it("do not reach another tenant's object", async () => {
      const bare = new MemoryStorageProvider();
      const a = await bare.createObject(tenantA, 'Patient', { name: 'A' });
      const other = await bare.createObject(tenantB, 'CareTeam', { name: 'B' });
      await bare.createLink(tenantA, 'AssignedTo', a._id, other._id);
      expect((await bare.getLinks(tenantA, a._id, 'AssignedTo', 'outbound')).items).toEqual([]);
    });
  });

  describe('search', () => {
    it('a property named like an Object.prototype member is searched and highlighted', async () => {
      const p = new MemoryStorageProvider();
      await p.applySchema(tenantA, {
        version: 1,
        objectTypes: [{ name: 'Badge', properties: [{ name: 'constructor', type: 'String' }] }],
        linkTypes: [],
      } as OntologySchema);
      await p.createObject(tenantA, 'Badge', { constructor: 'STAFF' });
      for (const fields of [undefined, ['constructor']]) {
        const result = await p.searchObjects(tenantA, 'Badge', { query: 'staff', fields });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]!.highlights).toEqual({ constructor: ['STAFF'] });
      }
    });
  });
});
