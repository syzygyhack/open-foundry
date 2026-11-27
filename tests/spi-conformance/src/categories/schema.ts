/**
 * SPI Conformance Tests: Schema Operations
 *
 * Validates that a StorageProvider correctly implements schema apply,
 * retrieval, versioning, migration, and error handling per the SPI spec.
 */

import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { OntologySchema, StorageProvider, RequestContext, MigrationResult } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema, schemaV2, schemaV3 } from '../fixtures.js';

export function registerSchemaTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Schema`, () => {
    let provider: StorageProvider;
    let ctx: RequestContext;

    beforeEach(async () => {
      provider = await factory();
      ctx = tenantA;
    });

    // =========================================================================
    // 1. Schema Apply
    // =========================================================================

    describe('Schema apply', () => {
      it('apply schema returns success with correct version numbers', async () => {
        const result: MigrationResult = await provider.applySchema(ctx, baseSchema);

        expect(result.success).toBe(true);
        expect(result.toVersion).toBe(1);
      });

      it('apply schema records the appliedAt timestamp', async () => {
        const before = new Date().toISOString();
        const result = await provider.applySchema(ctx, baseSchema);
        const after = new Date().toISOString();

        expect(result.appliedAt).toBeDefined();
        expect(typeof result.appliedAt).toBe('string');
        // appliedAt should be between before and after (inclusive)
        expect(result.appliedAt >= before).toBe(true);
        expect(result.appliedAt <= after).toBe(true);
      });

      it('apply schema with version 1 sets fromVersion to 0', async () => {
        const result = await provider.applySchema(ctx, baseSchema);

        expect(result.fromVersion).toBe(0);
        expect(result.toVersion).toBe(1);
      });

      it('apply multiple schema versions sequentially', async () => {
        const r1 = await provider.applySchema(ctx, baseSchema);
        expect(r1.success).toBe(true);
        expect(r1.fromVersion).toBe(0);
        expect(r1.toVersion).toBe(1);

        const r2 = await provider.applySchema(ctx, schemaV2);
        expect(r2.success).toBe(true);
        expect(r2.fromVersion).toBe(1);
        expect(r2.toVersion).toBe(2);

        const r3 = await provider.applySchema(ctx, schemaV3);
        expect(r3.success).toBe(true);
        expect(r3.fromVersion).toBe(2);
        expect(r3.toVersion).toBe(3);
      });

      it('a property added in a later version is writable, and reads back null on older records', async () => {
        await provider.applySchema(ctx, baseSchema);
        const before = await provider.createObject(ctx, 'Patient', { name: 'Before' });
        const v2: OntologySchema = {
          ...baseSchema,
          version: 2,
          objectTypes: baseSchema.objectTypes.map((t) =>
            t.name === 'Patient' ? { ...t, properties: [...t.properties, { name: 'nickname', type: 'String' }] } : t,
          ),
        };
        await provider.applySchema(ctx, v2);
        const after = await provider.createObject(ctx, 'Patient', { name: 'After', nickname: 'Al' });
        expect((await provider.getObject(ctx, 'Patient', after._id))!.nickname).toBe('Al');
        expect((await provider.getObject(ctx, 'Patient', before._id))!.nickname).toBeNull();
      });

      it('a property added later with a default reads back the default, old records included', async () => {
        await provider.applySchema(ctx, baseSchema);
        const before = await provider.createObject(ctx, 'Patient', { name: 'Before' });
        const v2: OntologySchema = {
          ...baseSchema,
          version: 2,
          objectTypes: baseSchema.objectTypes.map((t) =>
            t.name === 'Patient'
              ? { ...t, properties: [...t.properties, { name: 'priority', type: 'Int', defaultValue: 3 }] }
              : t,
          ),
        };
        await provider.applySchema(ctx, v2);
        const after = await provider.createObject(ctx, 'Patient', { name: 'After' });
        expect((await provider.getObject(ctx, 'Patient', after._id))!.priority).toBe(3);
        expect((await provider.getObject(ctx, 'Patient', before._id))!.priority).toBe(3);
      });

      it('a property added later with an index on it is applied, and can be filtered on', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.createObject(ctx, 'Patient', { name: 'Before' });
        const v2: OntologySchema = {
          ...baseSchema,
          version: 2,
          objectTypes: baseSchema.objectTypes.map((t) =>
            t.name === 'Patient'
              ? {
                  ...t,
                  properties: [...t.properties, { name: 'ward', type: 'String' }],
                  indexes: [...(t.indexes ?? []), { field: 'ward', indexType: 'BTREE' as const }],
                }
              : t,
          ),
        };
        await expect(provider.applySchema(ctx, v2)).resolves.toMatchObject({ success: true, toVersion: 2 });
        await provider.createObject(ctx, 'Patient', { name: 'After', ward: 'W1' });
        const page = await provider.queryObjects(ctx, 'Patient', { field: 'ward', operator: 'eq', value: 'W1' });
        expect(page.items.map((p) => p.name)).toEqual(['After']);
      });

      it('apply schema is idempotent (re-applying same version succeeds)', async () => {
        const r1 = await provider.applySchema(ctx, baseSchema);
        expect(r1.success).toBe(true);

        const r2 = await provider.applySchema(ctx, baseSchema);
        expect(r2.success).toBe(true);
        expect(r2.toVersion).toBe(1);
      });
    });

    // =========================================================================
    // 2. Schema Retrieval
    // =========================================================================

    describe('Schema retrieval', () => {
      it('getSchema returns applied schema with correct version', async () => {
        await provider.applySchema(ctx, baseSchema);

        const schema = await provider.getSchema(ctx);

        expect(schema).toBeDefined();
        expect(schema.version).toBe(1);
      });

      it('getSchema returns schema with all object types', async () => {
        await provider.applySchema(ctx, baseSchema);

        const schema = await provider.getSchema(ctx);
        const objectTypeNames = schema.objectTypes.map((ot) => ot.name);

        expect(objectTypeNames).toContain('Patient');
        expect(objectTypeNames).toContain('CareTeam');
        expect(objectTypeNames).toContain('Appointment');
        expect(objectTypeNames).toContain('Medication');
        expect(objectTypeNames).toContain('Observation');
        expect(schema.objectTypes.length).toBe(baseSchema.objectTypes.length);
      });

      it('getSchema returns schema with all link types', async () => {
        await provider.applySchema(ctx, baseSchema);

        const schema = await provider.getSchema(ctx);
        const linkTypeNames = schema.linkTypes.map((lt) => lt.name);

        expect(linkTypeNames).toContain('AssignedTo');
        expect(linkTypeNames).toContain('PrimaryDoctor');
        expect(linkTypeNames).toContain('HasAppointment');
        expect(linkTypeNames).toContain('Prescribes');
        expect(linkTypeNames).toContain('HasObservation');
        expect(linkTypeNames).toContain('TeamLead');
        expect(schema.linkTypes.length).toBe(baseSchema.linkTypes.length);
      });

      it('getSchema returns property definitions including types and required flags', async () => {
        await provider.applySchema(ctx, baseSchema);

        const schema = await provider.getSchema(ctx);
        const patient = schema.objectTypes.find((ot) => ot.name === 'Patient');
        expect(patient).toBeDefined();

        const nameProperty = patient!.properties.find((p) => p.name === 'name');
        expect(nameProperty).toBeDefined();
        expect(nameProperty!.type).toBe('String');
        expect(nameProperty!.required).toBe(true);

        const ageProperty = patient!.properties.find((p) => p.name === 'age');
        expect(ageProperty).toBeDefined();
        expect(ageProperty!.type).toBe('Int');
        // age is not required, so required should be falsy (undefined or false)
        expect(ageProperty!.required).toBeFalsy();
      });

      it('getSchema with explicit version parameter returns that version', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);

        const v1 = await provider.getSchema(ctx, 1);
        expect(v1.version).toBe(1);
        expect(v1.objectTypes.length).toBe(baseSchema.objectTypes.length);

        const v2 = await provider.getSchema(ctx, 2);
        expect(v2.version).toBe(2);
        expect(v2.objectTypes.length).toBe(schemaV2.objectTypes.length);
      });
    });

    // =========================================================================
    // 3. Schema Versioning
    // =========================================================================

    describe('Schema versioning', () => {
      it('getSchema without version returns current (latest) schema', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);

        const current = await provider.getSchema(ctx);

        expect(current.version).toBe(2);
      });

      it('multiple versions are independently retrievable', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);
        await provider.applySchema(ctx, schemaV3);

        const v1 = await provider.getSchema(ctx, 1);
        const v2 = await provider.getSchema(ctx, 2);
        const v3 = await provider.getSchema(ctx, 3);

        expect(v1.version).toBe(1);
        expect(v2.version).toBe(2);
        expect(v3.version).toBe(3);
      });

      it('schema version numbers track correctly across migrations', async () => {
        const r1 = await provider.applySchema(ctx, baseSchema);
        const r2 = await provider.applySchema(ctx, schemaV2);
        const r3 = await provider.applySchema(ctx, schemaV3);

        expect(r1.fromVersion).toBe(0);
        expect(r1.toVersion).toBe(1);
        expect(r2.fromVersion).toBe(1);
        expect(r2.toVersion).toBe(2);
        expect(r3.fromVersion).toBe(2);
        expect(r3.toVersion).toBe(3);
      });

      it('each schema version preserves its own object types', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);

        const v1 = await provider.getSchema(ctx, 1);
        const v2 = await provider.getSchema(ctx, 2);

        const v1Names = v1.objectTypes.map((ot) => ot.name);
        const v2Names = v2.objectTypes.map((ot) => ot.name);

        // v1 should NOT contain Referral
        expect(v1Names).not.toContain('Referral');
        // v2 should contain Referral
        expect(v2Names).toContain('Referral');
        // v2 should still contain all v1 types
        for (const name of v1Names) {
          expect(v2Names).toContain(name);
        }
      });

      it('each schema version preserves its own link types', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);
        await provider.applySchema(ctx, schemaV3);

        const v1 = await provider.getSchema(ctx, 1);
        const v2 = await provider.getSchema(ctx, 2);
        const v3 = await provider.getSchema(ctx, 3);

        const v1Links = v1.linkTypes.map((lt) => lt.name);
        const v2Links = v2.linkTypes.map((lt) => lt.name);
        const v3Links = v3.linkTypes.map((lt) => lt.name);

        // v1 should NOT contain ReferredBy or Supervises
        expect(v1Links).not.toContain('ReferredBy');
        expect(v1Links).not.toContain('Supervises');
        // v2 should contain ReferredBy but NOT Supervises
        expect(v2Links).toContain('ReferredBy');
        expect(v2Links).not.toContain('Supervises');
        // v3 should contain both
        expect(v3Links).toContain('ReferredBy');
        expect(v3Links).toContain('Supervises');
      });
    });

    // =========================================================================
    // 4. Schema Migration
    // =========================================================================

    describe('Schema migration', () => {
      it('migration from v1 to v2 shows correct fromVersion/toVersion', async () => {
        await provider.applySchema(ctx, baseSchema);
        const result = await provider.applySchema(ctx, schemaV2);

        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(2);
      });

      it('non-breaking migration (adding object type) succeeds', async () => {
        await provider.applySchema(ctx, baseSchema);
        const result = await provider.applySchema(ctx, schemaV2);

        expect(result.success).toBe(true);

        const schema = await provider.getSchema(ctx);
        const objectTypeNames = schema.objectTypes.map((ot) => ot.name);
        expect(objectTypeNames).toContain('Referral');
      });

      it('non-breaking migration (adding link type) succeeds', async () => {
        await provider.applySchema(ctx, baseSchema);
        await provider.applySchema(ctx, schemaV2);
        const result = await provider.applySchema(ctx, schemaV3);

        expect(result.success).toBe(true);

        const schema = await provider.getSchema(ctx);
        const linkTypeNames = schema.linkTypes.map((lt) => lt.name);
        expect(linkTypeNames).toContain('Supervises');
      });

      it('migration result has success=true for valid migration', async () => {
        const r1 = await provider.applySchema(ctx, baseSchema);
        expect(r1.success).toBe(true);

        const r2 = await provider.applySchema(ctx, schemaV2);
        expect(r2.success).toBe(true);

        const r3 = await provider.applySchema(ctx, schemaV3);
        expect(r3.success).toBe(true);
      });

      it('migration preserves existing data (create objects with v1, apply v2, verify objects still exist)', async () => {
        await provider.applySchema(ctx, baseSchema);

        // Create some objects under v1
        const patient = await provider.createObject(ctx, 'Patient', {
          name: 'Alice Smith',
          age: 30,
          status: 'active',
        });
        expect(patient._id).toBeDefined();

        const careTeam = await provider.createObject(ctx, 'CareTeam', {
          name: 'Cardiology',
          specialty: 'Heart',
        });
        expect(careTeam._id).toBeDefined();

        // Apply v2 migration
        const migration = await provider.applySchema(ctx, schemaV2);
        expect(migration.success).toBe(true);

        // Verify v1 objects still exist after migration
        const fetchedPatient = await provider.getObject(ctx, 'Patient', patient._id);
        expect(fetchedPatient).not.toBeNull();
        expect(fetchedPatient!.name).toBe('Alice Smith');
        expect(fetchedPatient!.age).toBe(30);

        const fetchedTeam = await provider.getObject(ctx, 'CareTeam', careTeam._id);
        expect(fetchedTeam).not.toBeNull();
        expect(fetchedTeam!.name).toBe('Cardiology');
      });
    });

    // =========================================================================
    // 5. Schema Errors
    // =========================================================================

    describe('Schema errors', () => {
      it('getSchema for non-existent version throws', async () => {
        await provider.applySchema(ctx, baseSchema);

        await expect(provider.getSchema(ctx, 999)).rejects.toThrow();
      });

      it('getSchema for version 0 when no schema applied throws', async () => {
        await expect(provider.getSchema(ctx, 0)).rejects.toThrow();
      });

      it('getSchema for version 99 throws', async () => {
        await provider.applySchema(ctx, baseSchema);

        await expect(provider.getSchema(ctx, 99)).rejects.toThrow();
      });

      it('apply schema then retrieve with wrong version throws', async () => {
        await provider.applySchema(ctx, baseSchema);

        // Only version 1 exists, version 5 should throw
        await expect(provider.getSchema(ctx, 5)).rejects.toThrow();
      });

      it('apply schema v3 directly (skipping v2) still works (versions are explicit, not sequential)', async () => {
        await provider.applySchema(ctx, baseSchema);

        // Skip v2, apply v3 directly
        const result = await provider.applySchema(ctx, schemaV3);
        expect(result.success).toBe(true);
        expect(result.toVersion).toBe(3);

        const schema = await provider.getSchema(ctx);
        expect(schema.version).toBe(3);
      });

      it('getSchema throws when no schema has been applied at all', async () => {
        // Provider is fresh with no schema - requesting any version should fail
        await expect(provider.getSchema(ctx)).rejects.toThrow();
      });

      it('getSchema for negative version throws', async () => {
        await provider.applySchema(ctx, baseSchema);

        await expect(provider.getSchema(ctx, -1)).rejects.toThrow();
      });
    });
  });
}
