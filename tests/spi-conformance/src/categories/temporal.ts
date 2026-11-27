/**
 * SPI Conformance Tests: Temporal / Versioning Operations
 *
 * Validates that a StorageProvider correctly implements point-in-time
 * retrieval by version number, point-in-time retrieval by timestamp,
 * and monotonic version history tracking per the SPI spec (Section 3.1).
 */

import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, baseSchema } from '../fixtures.js';

/** Small delay to ensure distinct timestamps between operations. */
const tick = () => new Promise<void>((r) => setTimeout(r, 10));

export function registerTemporalTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Temporal`, () => {
    let provider: StorageProvider;
    let ctx: RequestContext;

    beforeEach(async () => {
      provider = await factory();
      ctx = tenantA;
      await provider.applySchema(ctx, baseSchema);
    });

    // =========================================================================
    // 1. Point-in-time by Version
    // =========================================================================

    describe('Point-in-time by version', () => {
      it('getObjectAtVersion returns version 1 after creation', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Alice',
          age: 30,
        });

        const v1 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 1);

        expect(v1).not.toBeNull();
        expect(v1!._id).toBe(created._id);
        expect(v1!._version).toBe(1);
        expect(v1!.name).toBe('Alice');
        expect(v1!.age).toBe(30);
      });

      it('getObjectAtVersion returns version 2 after update', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Alice',
          age: 30,
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Alice Updated',
          age: 31,
        });

        const v2 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 2);

        expect(v2).not.toBeNull();
        expect(v2!._version).toBe(2);
        expect(v2!.name).toBe('Alice Updated');
        expect(v2!.age).toBe(31);
      });

      it('getObjectAtVersion returns version 3 after second update', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Alice',
          age: 30,
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Alice V2',
          age: 31,
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Alice V3',
          age: 32,
        });

        const v3 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 3);

        expect(v3).not.toBeNull();
        expect(v3!._version).toBe(3);
        expect(v3!.name).toBe('Alice V3');
        expect(v3!.age).toBe(32);
      });

      it('getObjectAtVersion returns null for non-existent version', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Alice',
          age: 30,
        });

        const result = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 99);

        expect(result).toBeNull();
      });

      it('getObjectAtVersion returns null for non-existent object', async () => {
        const result = await provider.getObjectAtVersion(ctx, 'Patient', 'non-existent-id', 1);

        expect(result).toBeNull();
      });

      it('getObjectAtVersion preserves property values at each version', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Alice',
          age: 30,
          status: 'new',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          status: 'active',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          status: 'discharged',
          age: 31,
        });

        const v1 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 1);
        const v2 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 2);
        const v3 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 3);

        expect(v1!.name).toBe('Alice');
        expect(v1!.status).toBe('new');
        expect(v1!.age).toBe(30);

        expect(v2!.status).toBe('active');

        expect(v3!.status).toBe('discharged');
        expect(v3!.age).toBe(31);
      });
    });

    // =========================================================================
    // 2. Point-in-time by Timestamp
    // =========================================================================

    describe('Point-in-time by timestamp', () => {
      it('getObjectAtTime returns object state at creation time', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Bob',
          age: 40,
        });

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          created._id,
          created._createdAt,
        );

        expect(result).not.toBeNull();
        expect(result!._id).toBe(created._id);
        expect(result!.name).toBe('Bob');
        expect(result!.age).toBe(40);
      });

      it('getObjectAtTime returns updated state after update timestamp', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Bob',
          age: 40,
        });

        await tick();

        const updated = await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Bob Updated',
          age: 41,
        });

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          created._id,
          updated._updatedAt,
        );

        expect(result).not.toBeNull();
        expect(result!.name).toBe('Bob Updated');
        expect(result!.age).toBe(41);
      });

      it('getObjectAtTime returns null for timestamp before object creation', async () => {
        const pastTimestamp = new Date(Date.now() - 60_000).toISOString();

        await tick();

        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Bob',
          age: 40,
        });

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          created._id,
          pastTimestamp,
        );

        expect(result).toBeNull();
      });

      it('getObjectAtTime returns original state for timestamp between create and update', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Bob',
          age: 40,
        });

        await tick();

        const betweenTimestamp = new Date().toISOString();

        await tick();

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Bob Updated',
          age: 41,
        });

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          created._id,
          betweenTimestamp,
        );

        expect(result).not.toBeNull();
        expect(result!.name).toBe('Bob');
        expect(result!.age).toBe(40);
        expect(result!._version).toBe(1);
      });

      it('getObjectAtTime with far-future timestamp returns latest version', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Bob',
          age: 40,
        });

        await tick();

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Bob V2',
          age: 41,
        });

        await tick();

        const updated2 = await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Bob V3',
          age: 42,
        });

        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          created._id,
          farFuture,
        );

        expect(result).not.toBeNull();
        expect(result!.name).toBe('Bob V3');
        expect(result!.age).toBe(42);
        expect(result!._version).toBe(updated2._version);
      });

      it('getObjectAtTime returns null for non-existent object', async () => {
        const now = new Date().toISOString();

        const result = await provider.getObjectAtTime(
          ctx,
          'Patient',
          'non-existent-id',
          now,
        );

        expect(result).toBeNull();
      });
    });

    // =========================================================================
    // 3. Version History
    // =========================================================================

    describe('Version history', () => {
      it('version increments monotonically with updates', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
        });
        expect(created._version).toBe(1);

        const u1 = await provider.updateObject(ctx, 'Patient', created._id, {
          age: 26,
        });
        expect(u1._version).toBe(2);

        const u2 = await provider.updateObject(ctx, 'Patient', created._id, {
          age: 27,
        });
        expect(u2._version).toBe(3);

        const u3 = await provider.updateObject(ctx, 'Patient', created._id, {
          age: 28,
        });
        expect(u3._version).toBe(4);
      });

      it('soft-delete increments version', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
        });
        expect(created._version).toBe(1);

        await provider.updateObject(ctx, 'Patient', created._id, {
          age: 26,
        });

        await provider.deleteObject(ctx, 'Patient', created._id, 'soft');

        // The soft-deleted version should be retrievable at version 3
        const v3 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 3);

        expect(v3).not.toBeNull();
        expect(v3!._version).toBe(3);
        expect(v3!._deletedAt).toBeDefined();
      });

      it('each version has correct _updatedAt timestamp', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
        });

        await tick();

        const u1 = await provider.updateObject(ctx, 'Patient', created._id, {
          age: 26,
        });

        await tick();

        const u2 = await provider.updateObject(ctx, 'Patient', created._id, {
          age: 27,
        });

        const v1 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 1);
        const v2 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 2);
        const v3 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 3);

        expect(v1!._updatedAt).toBe(created._updatedAt);
        expect(v2!._updatedAt).toBe(u1._updatedAt);
        expect(v3!._updatedAt).toBe(u2._updatedAt);

        // Timestamps should be chronologically ordered
        expect(v1!._updatedAt <= v2!._updatedAt).toBe(true);
        expect(v2!._updatedAt <= v3!._updatedAt).toBe(true);
      });

      it('version 1 has _createdAt equal to _updatedAt', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
        });

        const v1 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 1);

        expect(v1).not.toBeNull();
        expect(v1!._createdAt).toBe(v1!._updatedAt);
      });

      it('updated versions have _updatedAt > _createdAt', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
        });

        await tick();

        await provider.updateObject(ctx, 'Patient', created._id, {
          age: 26,
        });

        const v2 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 2);

        expect(v2).not.toBeNull();
        expect(v2!._createdAt).toBe(created._createdAt);
        expect(v2!._updatedAt > v2!._createdAt).toBe(true);
      });

      it('version history survives multiple property changes (all versions retrievable)', async () => {
        const created = await provider.createObject(ctx, 'Patient', {
          name: 'Carol',
          age: 25,
          status: 'new',
          email: 'carol@example.com',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          status: 'active',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          age: 26,
          email: 'carol.new@example.com',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          status: 'review',
        });

        await provider.updateObject(ctx, 'Patient', created._id, {
          name: 'Carol Smith',
          status: 'discharged',
        });

        // All 5 versions should be independently retrievable
        const v1 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 1);
        const v2 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 2);
        const v3 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 3);
        const v4 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 4);
        const v5 = await provider.getObjectAtVersion(ctx, 'Patient', created._id, 5);

        expect(v1).not.toBeNull();
        expect(v2).not.toBeNull();
        expect(v3).not.toBeNull();
        expect(v4).not.toBeNull();
        expect(v5).not.toBeNull();

        expect(v1!._version).toBe(1);
        expect(v2!._version).toBe(2);
        expect(v3!._version).toBe(3);
        expect(v4!._version).toBe(4);
        expect(v5!._version).toBe(5);

        // Verify property snapshots
        expect(v1!.name).toBe('Carol');
        expect(v1!.status).toBe('new');
        expect(v1!.age).toBe(25);
        expect(v1!.email).toBe('carol@example.com');

        expect(v2!.status).toBe('active');

        expect(v3!.age).toBe(26);
        expect(v3!.email).toBe('carol.new@example.com');

        expect(v4!.status).toBe('review');

        expect(v5!.name).toBe('Carol Smith');
        expect(v5!.status).toBe('discharged');
      });
    });
  });
}
