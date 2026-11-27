/**
 * Integration tests for PostgresStorageProvider — full provider lifecycle.
 *
 * Exercises: applySchema -> create objects -> create links -> query ->
 * traverse -> temporal -> bulk mutate -> transactions -> delete.
 *
 * Requires a running PostgreSQL instance. Set PG_TEST_URL env var or
 * these tests will be skipped. Example:
 *
 *   PG_TEST_URL=postgresql://localhost:5432/openfoundry_test npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type {
  RequestContext,
  OntologySchema,
  FilterExpression,
  TraversalPath,
  DateTime,
} from '@openfoundry/spi';
import { PostgresStorageProvider } from '../postgres-storage-provider.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

// Parse connection URL into config
function parseUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    user: u.username,
    password: u.password,
  };
}

const describeWithPg = PG_TEST_URL ? describe : describe.skip;

describeWithPg('PostgresStorageProvider lifecycle (integration)', () => {
  let provider: PostgresStorageProvider;
  const ctx: RequestContext = { tenantId: 'tenant-provider-001', actorId: 'test-actor' };

  const testSchema: OntologySchema = {
    version: 1,
    objectTypes: [
      {
        name: 'Patient',
        properties: [
          { name: 'nhsNumber', type: 'String', required: false },
          { name: 'familyName', type: 'String', required: false },
          { name: 'givenName', type: 'String', required: false },
          { name: 'active', type: 'Boolean', required: false },
        ],
        indexes: [],
      },
      {
        name: 'Ward',
        properties: [
          { name: 'name', type: 'String', required: false },
          { name: 'capacity', type: 'Int', required: false },
        ],
        indexes: [],
      },
      {
        name: 'Bed',
        properties: [
          { name: 'bedNumber', type: 'String', required: false },
          { name: 'status', type: 'String', required: false },
        ],
        indexes: [],
      },
    ],
    linkTypes: [
      {
        name: 'AdmittedTo',
        fromType: 'Patient',
        toType: 'Ward',
        cardinality: 'MANY_TO_MANY' as const,
        properties: [
          // ODL link types carry `id: ID! @primary`, which convertLinkType maps
          // to an `id` column that createLink populates — model it here too.
          { name: 'id', type: 'ID', required: true },
          { name: 'reason', type: 'String', required: false },
        ],
      },
      {
        name: 'BedInWard',
        fromType: 'Ward',
        toType: 'Bed',
        cardinality: 'ONE_TO_MANY' as const,
        properties: [
          { name: 'id', type: 'ID', required: true },
        ],
      },
    ],
  };

  beforeAll(async () => {
    const config = parseUrl(PG_TEST_URL!);
    provider = new PostgresStorageProvider(config);

    // Drop pre-existing tables to start clean
    const pool = provider.pool;
    await pool.query(`
      DROP TABLE IF EXISTS "public"."patient_history" CASCADE;
      DROP TABLE IF EXISTS "public"."patient" CASCADE;
      DROP TABLE IF EXISTS "public"."ward_history" CASCADE;
      DROP TABLE IF EXISTS "public"."ward" CASCADE;
      DROP TABLE IF EXISTS "public"."bed_history" CASCADE;
      DROP TABLE IF EXISTS "public"."bed" CASCADE;
      DROP TABLE IF EXISTS "public"."admitted_to" CASCADE;
      DROP TABLE IF EXISTS "public"."bed_in_ward" CASCADE;
      -- The ledger too: with it left behind, a re-run against the same
      -- database sees version 1 as applied and never recreates the tables.
      DROP TABLE IF EXISTS "public"."_schema_migrations";
    `);
  });

  afterAll(async () => {
    if (provider) {
      const pool = provider.pool;
      await pool.query('DROP TABLE IF EXISTS "public"."admitted_to" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed_in_ward" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."bed" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."ward_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."ward" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."patient_history" CASCADE');
      await pool.query('DROP TABLE IF EXISTS "public"."patient" CASCADE');
      await provider.close();
    }
  });

  // -------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------

  describe('capabilities', () => {
    it('returns correct MVP capabilities', () => {
      const caps = provider.capabilities();
      expect(caps.supportsTransactions).toBe(true);
      expect(caps.supportsTemporalQueries).toBe(true);
      expect(caps.supportsFullTextSearch).toBe(true);
      expect(caps.supportsGeoQueries).toBe(false);
      expect(caps.supportsGraphTraversal).toBe(true);
      expect(caps.supportsBulkMutations).toBe(true);
      expect(caps.maxTraversalDepth).toBe(10);
      expect(caps.replicationSupport).toBe('NONE');
    });
  });

  // -------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------

  describe('healthCheck', () => {
    it('reports healthy when connected', async () => {
      const status = await provider.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.provider).toBe('postgres');
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      expect(status.details).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------

  describe('applySchema', () => {
    it('applies schema and creates tables', async () => {
      const result = await provider.applySchema(ctx, testSchema);
      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(1);
      expect(result.appliedAt).toBeDefined();
    });

    it('getSchema returns the applied schema', async () => {
      const schema = await provider.getSchema(ctx, 1);
      expect(schema.version).toBe(1);
      expect(schema.objectTypes.length).toBe(3);
      expect(schema.linkTypes.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Object CRUD
  // -------------------------------------------------------------------

  describe('object CRUD', () => {
    beforeEach(async () => {
      const pool = provider.pool;
      // Clean data tables between tests (tables created by applySchema)
      await pool.query('DELETE FROM "public"."admitted_to"');
      await pool.query('DELETE FROM "public"."bed_in_ward"');
      await pool.query('DELETE FROM "public"."bed_history"');
      await pool.query('DELETE FROM "public"."bed"');
      await pool.query('DELETE FROM "public"."ward_history"');
      await pool.query('DELETE FROM "public"."ward"');
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');
    });

    it('creates and retrieves an object', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        nhsNumber: '9876543210',
        familyName: 'TestPatient',
        givenName: 'Lifecycle',
        active: true,
      });

      expect(obj._tenantId).toBe(ctx.tenantId);
      expect(obj._type).toBe('Patient');
      expect(obj._version).toBe(1);
      expect(obj['nhsNumber']).toBe('9876543210');

      const fetched = await provider.getObject(ctx, 'Patient', obj._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(obj._id);
      expect(fetched!['familyName']).toBe('TestPatient');
    });

    it('updates an object', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        familyName: 'Before',
      });

      const updated = await provider.updateObject(ctx, 'Patient', obj._id, {
        familyName: 'After',
      });

      expect(updated._version).toBe(2);
      expect(updated['familyName']).toBe('After');
    });

    it('soft-deletes an object (getObject returns null)', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        familyName: 'ToDelete',
      });

      await provider.deleteObject(ctx, 'Patient', obj._id, 'soft');

      // Provider.getObject returns null for soft-deleted
      const fetched = await provider.getObject(ctx, 'Patient', obj._id);
      expect(fetched).toBeNull();
    });

    it('hard-deletes an object', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        familyName: 'HardDelete',
      });

      await provider.deleteObject(ctx, 'Patient', obj._id, 'hard');

      const fetched = await provider.getObject(ctx, 'Patient', obj._id);
      expect(fetched).toBeNull();
    });

    it('queries objects with filter', async () => {
      await provider.createObject(ctx, 'Patient', { familyName: 'Alpha', active: true });
      await provider.createObject(ctx, 'Patient', { familyName: 'Beta', active: true });
      await provider.createObject(ctx, 'Patient', { familyName: 'Gamma', active: false });

      const filter: FilterExpression = { field: 'active', operator: 'eq', value: true };
      const page = await provider.queryObjects(ctx, 'Patient', filter);

      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Link CRUD + Traversal
  // -------------------------------------------------------------------

  describe('links and traversal', () => {
    let patientId: string;
    let wardId: string;
    let bed1Id: string;
    let bed2Id: string;

    beforeEach(async () => {
      const pool = provider.pool;
      await pool.query('DELETE FROM "public"."admitted_to"');
      await pool.query('DELETE FROM "public"."bed_in_ward"');
      await pool.query('DELETE FROM "public"."bed_history"');
      await pool.query('DELETE FROM "public"."bed"');
      await pool.query('DELETE FROM "public"."ward_history"');
      await pool.query('DELETE FROM "public"."ward"');
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');

      // Seed objects
      const patient = await provider.createObject(ctx, 'Patient', {
        familyName: 'Smith',
        givenName: 'John',
      });
      const ward = await provider.createObject(ctx, 'Ward', {
        name: 'CardiacUnit',
        capacity: 20,
      });
      const bed1 = await provider.createObject(ctx, 'Bed', {
        bedNumber: 'CU-01',
        status: 'available',
      });
      const bed2 = await provider.createObject(ctx, 'Bed', {
        bedNumber: 'CU-02',
        status: 'occupied',
      });

      patientId = patient._id;
      wardId = ward._id;
      bed1Id = bed1._id;
      bed2Id = bed2._id;
    });

    it('creates and retrieves a link', async () => {
      const link = await provider.createLink(ctx, 'AdmittedTo', patientId, wardId, {
        reason: 'Emergency',
      });

      expect(link._type).toBe('AdmittedTo');
      expect(link._fromId).toBe(patientId);
      expect(link._toId).toBe(wardId);
      expect(link['reason']).toBe('Emergency');

      const fetched = await provider.getLink(ctx, 'AdmittedTo', link._id);
      expect(fetched).not.toBeNull();
      expect(fetched!._id).toBe(link._id);
    });

    it('updates a link', async () => {
      const link = await provider.createLink(ctx, 'AdmittedTo', patientId, wardId, {
        reason: 'Emergency',
      });

      const updated = await provider.updateLink(ctx, 'AdmittedTo', link._id, {
        reason: 'Scheduled',
      });

      expect(updated._version).toBe(2);
      expect(updated['reason']).toBe('Scheduled');
    });

    it('deletes a link (soft-delete)', async () => {
      const link = await provider.createLink(ctx, 'AdmittedTo', patientId, wardId);
      await provider.deleteLink(ctx, 'AdmittedTo', link._id);

      const fetched = await provider.getLink(ctx, 'AdmittedTo', link._id);
      // Provider.getLink returns null for soft-deleted
      expect(fetched).toBeNull();
    });

    it('getLinks returns outbound links', async () => {
      await provider.createLink(ctx, 'BedInWard', wardId, bed1Id);
      await provider.createLink(ctx, 'BedInWard', wardId, bed2Id);

      const page = await provider.getLinks(ctx, wardId, 'BedInWard', 'outbound');
      expect(page.items.length).toBe(2);
      expect(page.totalCount).toBe(2);
    });

    it('traverses 2-hop path: Patient -> Ward -> Bed', async () => {
      await provider.createLink(ctx, 'AdmittedTo', patientId, wardId);
      await provider.createLink(ctx, 'BedInWard', wardId, bed1Id);
      await provider.createLink(ctx, 'BedInWard', wardId, bed2Id);

      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'outbound' },
        ],
      };

      const result = await provider.traverse(ctx, patientId, path);

      expect(result.nodes.length).toBe(2);
      expect(result.edges.length).toBe(3); // 1 AdmittedTo + 2 BedInWard

      const bedNumbers = result.nodes.map((n) => n['bedNumber']).sort();
      expect(bedNumbers).toEqual(['CU-01', 'CU-02']);
    });
  });

  // -------------------------------------------------------------------
  // Temporal queries
  // -------------------------------------------------------------------

  describe('temporal queries', () => {
    beforeEach(async () => {
      const pool = provider.pool;
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');
    });

    it('getObjectAtVersion returns correct version', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        familyName: 'V1Name',
      });
      await provider.updateObject(ctx, 'Patient', obj._id, {
        familyName: 'V2Name',
      });

      const v1 = await provider.getObjectAtVersion(ctx, 'Patient', obj._id, 1);
      expect(v1).not.toBeNull();
      expect(v1!._version).toBe(1);
      expect(v1!['familyName']).toBe('V1Name');

      const v2 = await provider.getObjectAtVersion(ctx, 'Patient', obj._id, 2);
      expect(v2).not.toBeNull();
      expect(v2!._version).toBe(2);
      expect(v2!['familyName']).toBe('V2Name');
    });

    it('getObjectAtTime returns state at given timestamp', async () => {
      const obj = await provider.createObject(ctx, 'Patient', {
        familyName: 'TimeV1',
      });

      await new Promise((r) => setTimeout(r, 50));
      const betweenTime = new Date().toISOString() as DateTime;
      await new Promise((r) => setTimeout(r, 50));

      await provider.updateObject(ctx, 'Patient', obj._id, {
        familyName: 'TimeV2',
      });

      const atBetween = await provider.getObjectAtTime(ctx, 'Patient', obj._id, betweenTime);
      expect(atBetween).not.toBeNull();
      expect(atBetween!._version).toBe(1);
      expect(atBetween!['familyName']).toBe('TimeV1');
    });
  });

  // -------------------------------------------------------------------
  // Bulk mutations
  // -------------------------------------------------------------------

  describe('bulkMutate', () => {
    beforeEach(async () => {
      const pool = provider.pool;
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');
    });

    it('creates multiple objects in a bulk operation', async () => {
      const result = await provider.bulkMutate(ctx, {
        idempotencyKey: 'bulk-test-001',
        operations: [
          { type: 'createObject', objectType: 'Patient', properties: { familyName: 'Bulk1' } },
          { type: 'createObject', objectType: 'Patient', properties: { familyName: 'Bulk2' } },
          { type: 'createObject', objectType: 'Patient', properties: { familyName: 'Bulk3' } },
        ],
      });

      expect(result.accepted).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.errors.length).toBe(0);

      // Verify objects exist
      const filter: FilterExpression = { field: 'familyName', operator: 'startsWith', value: 'Bulk' };
      const page = await provider.queryObjects(ctx, 'Patient', filter);
      expect(page.items.length).toBe(3);
    });

    it('returns cached result for same idempotency key', async () => {
      const request = {
        idempotencyKey: 'bulk-idem-001',
        operations: [
          { type: 'createObject' as const, objectType: 'Patient', properties: { familyName: 'Idem1' } },
        ],
      };

      const first = await provider.bulkMutate(ctx, request);
      const second = await provider.bulkMutate(ctx, request);

      expect(first.accepted).toBe(1);
      expect(second.accepted).toBe(1);

      // Only one object created (second call was cached)
      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'Idem1' };
      const page = await provider.queryObjects(ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
    });

    it('reports per-item errors without aborting batch', async () => {
      // Create one object first, then try to update a nonexistent one
      await provider.createObject(ctx, 'Patient', { familyName: 'Exists' });

      const result = await provider.bulkMutate(ctx, {
        idempotencyKey: 'bulk-error-001',
        operations: [
          { type: 'createObject', objectType: 'Patient', properties: { familyName: 'New' } },
          { type: 'updateObject', objectType: 'Patient', id: 'nonexistent', properties: { familyName: 'X' } },
          { type: 'createObject', objectType: 'Patient', properties: { familyName: 'New2' } },
        ],
      });

      expect(result.accepted).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.operationIndex).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Transactions (SPI Transaction interface)
  // -------------------------------------------------------------------

  describe('transactions', () => {
    beforeEach(async () => {
      const pool = provider.pool;
      await pool.query('DELETE FROM "public"."admitted_to"');
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');
      await pool.query('DELETE FROM "public"."ward_history"');
      await pool.query('DELETE FROM "public"."ward"');
    });

    it('committed transaction persists changes', async () => {
      const tx = await provider.beginTransaction(ctx);
      await tx.createObject('Patient', { familyName: 'TxTest' });
      await tx.commit();

      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxTest' };
      const page = await provider.queryObjects(ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
    });

    it('rolled-back transaction discards changes', async () => {
      const tx = await provider.beginTransaction(ctx);
      await tx.createObject('Patient', { familyName: 'TxRollback' });
      await tx.rollback();

      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxRollback' };
      const page = await provider.queryObjects(ctx, 'Patient', filter);
      expect(page.items.length).toBe(0);
    });

    it('multi-operation transaction commits atomically', async () => {
      const tx = await provider.beginTransaction(ctx);
      const obj = await tx.createObject('Patient', { familyName: 'TxMulti', givenName: 'Step1' });
      await tx.updateObject('Patient', obj._id, { givenName: 'Step2' });
      await tx.commit();

      const filter: FilterExpression = { field: 'familyName', operator: 'eq', value: 'TxMulti' };
      const page = await provider.queryObjects(ctx, 'Patient', filter);
      expect(page.items.length).toBe(1);
      expect(page.items[0]!['givenName']).toBe('Step2');
      expect(page.items[0]!._version).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // ensureIndex
  // -------------------------------------------------------------------

  describe('ensureIndex', () => {
    it('creates an index without error', async () => {
      // Should not throw
      await provider.ensureIndex(ctx, 'Patient', { field: 'familyName', indexType: 'BTREE' });

      // Verify index exists
      const result = await provider.pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'patient' AND indexname = 'idx_patient_family_name_btree'`,
      );
      expect(result.rows.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Full lifecycle: create -> link -> traverse -> delete
  // -------------------------------------------------------------------

  describe('full lifecycle', () => {
    beforeEach(async () => {
      const pool = provider.pool;
      await pool.query('DELETE FROM "public"."admitted_to"');
      await pool.query('DELETE FROM "public"."bed_in_ward"');
      await pool.query('DELETE FROM "public"."bed_history"');
      await pool.query('DELETE FROM "public"."bed"');
      await pool.query('DELETE FROM "public"."ward_history"');
      await pool.query('DELETE FROM "public"."ward"');
      await pool.query('DELETE FROM "public"."patient_history"');
      await pool.query('DELETE FROM "public"."patient"');
    });

    it('exercises the complete provider lifecycle', async () => {
      // 1. Create objects
      const patient = await provider.createObject(ctx, 'Patient', {
        nhsNumber: '1234567890',
        familyName: 'LifecyclePatient',
        givenName: 'Test',
        active: true,
      });
      const ward = await provider.createObject(ctx, 'Ward', {
        name: 'LifecycleWard',
        capacity: 10,
      });
      const bed = await provider.createObject(ctx, 'Bed', {
        bedNumber: 'L-01',
        status: 'available',
      });

      expect(patient._id).toBeDefined();
      expect(ward._id).toBeDefined();
      expect(bed._id).toBeDefined();

      // 2. Create links
      const admLink = await provider.createLink(ctx, 'AdmittedTo', patient._id, ward._id, {
        reason: 'Routine check',
      });
      const bedLink = await provider.createLink(ctx, 'BedInWard', ward._id, bed._id);

      expect(admLink._id).toBeDefined();
      expect(bedLink._id).toBeDefined();

      // 3. Query objects
      const patientFilter: FilterExpression = {
        field: 'familyName',
        operator: 'eq',
        value: 'LifecyclePatient',
      };
      const queryResult = await provider.queryObjects(ctx, 'Patient', patientFilter);
      expect(queryResult.items.length).toBe(1);
      expect(queryResult.items[0]!._id).toBe(patient._id);

      // 4. Traverse: Patient -> Ward -> Bed
      const path: TraversalPath = {
        steps: [
          { linkType: 'AdmittedTo', direction: 'outbound' },
          { linkType: 'BedInWard', direction: 'outbound' },
        ],
      };
      const travResult = await provider.traverse(ctx, patient._id, path);
      expect(travResult.nodes.length).toBe(1);
      expect(travResult.nodes[0]!['bedNumber']).toBe('L-01');

      // 5. Delete link
      await provider.deleteLink(ctx, 'AdmittedTo', admLink._id);
      const deletedLink = await provider.getLink(ctx, 'AdmittedTo', admLink._id);
      expect(deletedLink).toBeNull();

      // 6. Soft-delete patient
      await provider.deleteObject(ctx, 'Patient', patient._id, 'soft');
      const deletedPatient = await provider.getObject(ctx, 'Patient', patient._id);
      expect(deletedPatient).toBeNull();

      // 7. Temporal: still accessible via version history
      const v1 = await provider.getObjectAtVersion(ctx, 'Patient', patient._id, 1);
      expect(v1).not.toBeNull();
      expect(v1!['familyName']).toBe('LifecyclePatient');

      // 8. Hard-delete remaining
      await provider.deleteObject(ctx, 'Ward', ward._id, 'hard');
      expect(await provider.getObject(ctx, 'Ward', ward._id)).toBeNull();

      await provider.deleteObject(ctx, 'Bed', bed._id, 'hard');
      expect(await provider.getObject(ctx, 'Bed', bed._id)).toBeNull();
    });
  });
});
