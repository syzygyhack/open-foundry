import { describe, it, expect, beforeEach } from 'vitest';
import type { StorageProvider } from '@openfoundry/spi';
import type { ProviderFactory } from '../suite.js';
import { tenantA, tenantB, baseSchema } from '../fixtures.js';

export function registerLinkTests(name: string, factory: ProviderFactory): void {
  describe(`[${name}] SPI Conformance: Links`, () => {
    let provider: StorageProvider;
    let patientId1: string;
    let patientId2: string;
    let teamId1: string;
    let teamId2: string;

    beforeEach(async () => {
      provider = await factory();
      await provider.applySchema(tenantA, baseSchema);
      const p1 = await provider.createObject(tenantA, 'Patient', { name: 'Patient1' });
      const p2 = await provider.createObject(tenantA, 'Patient', { name: 'Patient2' });
      const t1 = await provider.createObject(tenantA, 'CareTeam', { name: 'Team1' });
      const t2 = await provider.createObject(tenantA, 'CareTeam', { name: 'Team2' });
      patientId1 = p1._id;
      patientId2 = p2._id;
      teamId1 = t1._id;
      teamId2 = t2._id;
    });

    // ─── Create Link ───

    describe('createLink', () => {
      it('assigns correct _type', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._type).toBe('AssignedTo');
      });

      it('assigns auto-generated _id', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._id).toBeDefined();
        expect(typeof link._id).toBe('string');
        expect(link._id.length).toBeGreaterThan(0);
      });

      it('assigns correct _fromId and _toId', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._fromId).toBe(patientId1);
        expect(link._toId).toBe(teamId1);
      });

      it('assigns _version = 1', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._version).toBe(1);
      });

      it('assigns _createdAt timestamp', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._createdAt).toBeDefined();
      });

      it('creates link without properties', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._type).toBe('AssignedTo');
        // No custom properties set
        expect(link.role).toBeUndefined();
      });
    });

    // ─── Link Properties ───

    describe('link properties', () => {
      it('creates link with custom properties', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'primary' });
        expect(link.role).toBe('primary');
      });

      it('properties retrievable via getLink', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'secondary' });
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched!.role).toBe('secondary');
      });

      it('updateLink changes properties', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'old' });
        const updated = await provider.updateLink(tenantA, 'AssignedTo', link._id, { role: 'new' });
        expect(updated.role).toBe('new');
      });

      it('updateLink increments version', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const updated = await provider.updateLink(tenantA, 'AssignedTo', link._id, { role: 'updated' });
        expect(updated._version).toBe(2);
      });
    });

    // ─── Get Link ───

    describe('getLink', () => {
      it('retrieves link by type and id', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched).not.toBeNull();
        expect(fetched!._id).toBe(link._id);
      });

      it('returns null for non-existent link id', async () => {
        const result = await provider.getLink(tenantA, 'AssignedTo', 'nonexistent');
        expect(result).toBeNull();
      });

      it('returns null for wrong link type', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const result = await provider.getLink(tenantA, 'PrimaryDoctor', link._id);
        expect(result).toBeNull();
      });

      it('retrieved link is a copy', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'original' });
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        (fetched as Record<string, unknown>).role = 'tampered';
        const refetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(refetched!.role).toBe('original');
      });
    });

    // ─── Delete Link ───

    describe('deleteLink', () => {
      it('deleted link returns null from getLink', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        const result = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(result).toBeNull();
      });

      it('delete non-existent link throws', async () => {
        await expect(
          provider.deleteLink(tenantA, 'AssignedTo', 'nonexistent'),
        ).rejects.toThrow();
      });

      it('deleted link disappears from getLinks', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(0);
      });

      it('delete link from wrong tenant throws', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await expect(
          provider.deleteLink(tenantB, 'AssignedTo', link._id),
        ).rejects.toThrow();
      });

      // Deletion is a soft delete: the link stays readable on request so that
      // history projections (discharged admissions as finished FHIR/CDM
      // Encounters, GraphQL @link(history) fields) work on every provider.

      it('deleted link is returned by getLinks with includeDeleted', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', {
          includeDeleted: true,
        });
        expect(page.items).toHaveLength(1);
        expect(page.totalCount).toBe(1);
        expect(page.items[0]!._id).toBe(link._id);
        expect(page.items[0]!._deletedAt).toBeDefined();
        expect(page.items[0]!._version).toBe(link._version + 1);
      });

      it('deleted link is traversed with includeDeleted', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        const path = { steps: [{ linkType: 'AssignedTo', direction: 'outbound' as const }] };
        const hidden = await provider.traverse(tenantA, patientId1, path);
        expect(hidden.edges).toHaveLength(0);
        const shown = await provider.traverse(tenantA, patientId1, path, { includeDeleted: true });
        expect(shown.edges.map((e) => e._id)).toEqual([link._id]);
        expect(shown.nodes.map((n) => n._id)).toEqual([teamId1]);
      });

      it('deleted link stays hidden from another tenant with includeDeleted', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        const page = await provider.getLinks(tenantB, patientId1, 'AssignedTo', 'outbound', {
          includeDeleted: true,
        });
        expect(page.items).toHaveLength(0);
      });

      it('deleting an already-deleted link throws', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        await expect(
          provider.deleteLink(tenantA, 'AssignedTo', link._id),
        ).rejects.toThrow();
      });

      it('creating a link with the ID of a deleted link throws', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        await expect(
          provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { _engineLinkId: link._id }),
        ).rejects.toThrow();
        const history = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', {
          includeDeleted: true,
        });
        expect(history.items.map((l) => [l._id, l._deletedAt !== undefined && l._deletedAt !== null])).toEqual([
          [link._id, true],
        ]);
      });

      it('updating a deleted link throws', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', link._id);
        await expect(
          provider.updateLink(tenantA, 'AssignedTo', link._id, { role: 'lead' }),
        ).rejects.toThrow();
      });
    });

    // ─── Get Links Direction ───

    describe('getLinks direction', () => {
      it('outbound returns links from object', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(2);
        expect(page.totalCount).toBe(2);
      });

      it('inbound returns links to object', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId2, teamId1);
        const page = await provider.getLinks(tenantA, teamId1, 'AssignedTo', 'inbound');
        expect(page.items).toHaveLength(2);
      });

      it('returns empty for object with no links', async () => {
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(0);
        expect(page.totalCount).toBe(0);
      });

      it('outbound filters by link type', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const page = await provider.getLinks(tenantA, patientId1, 'PrimaryDoctor', 'outbound');
        expect(page.items).toHaveLength(0);
      });

      it('inbound filters by link type', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const page = await provider.getLinks(tenantA, teamId1, 'PrimaryDoctor', 'inbound');
        expect(page.items).toHaveLength(0);
      });
    });

    // ─── Cardinality ONE_TO_ONE ───

    describe('cardinality ONE_TO_ONE', () => {
      it('allows first link', async () => {
        const link = await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        expect(link._type).toBe('PrimaryDoctor');
      });

      it('prevents second outbound from same source', async () => {
        await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        await expect(
          provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId2),
        ).rejects.toThrow(/[Cc]ardinality/);
      });

      it('prevents second inbound to same target', async () => {
        await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        await expect(
          provider.createLink(tenantA, 'PrimaryDoctor', patientId2, teamId1),
        ).rejects.toThrow(/[Cc]ardinality/);
      });

      it('allows new link after deleting previous', async () => {
        const link = await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        await provider.deleteLink(tenantA, 'PrimaryDoctor', link._id);
        const newLink = await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId2);
        expect(newLink._type).toBe('PrimaryDoctor');
      });
    });

    // ─── Cardinality ONE_TO_MANY ───

    describe('cardinality ONE_TO_MANY', () => {
      it('allows multiple outbound from same source', async () => {
        const a1 = await provider.createObject(tenantA, 'Appointment', { date: '2025-01-01' });
        const a2 = await provider.createObject(tenantA, 'Appointment', { date: '2025-02-01' });
        await provider.createLink(tenantA, 'HasAppointment', patientId1, a1._id);
        await provider.createLink(tenantA, 'HasAppointment', patientId1, a2._id);
        const page = await provider.getLinks(tenantA, patientId1, 'HasAppointment', 'outbound');
        expect(page.items).toHaveLength(2);
      });

      it('prevents duplicate inbound to same target', async () => {
        const a1 = await provider.createObject(tenantA, 'Appointment', { date: '2025-01-01' });
        await provider.createLink(tenantA, 'HasAppointment', patientId1, a1._id);
        await expect(
          provider.createLink(tenantA, 'HasAppointment', patientId2, a1._id),
        ).rejects.toThrow(/[Cc]ardinality/);
      });

      it('allows new inbound after deleting previous', async () => {
        const a1 = await provider.createObject(tenantA, 'Appointment', { date: '2025-01-01' });
        const link = await provider.createLink(tenantA, 'HasAppointment', patientId1, a1._id);
        await provider.deleteLink(tenantA, 'HasAppointment', link._id);
        const newLink = await provider.createLink(tenantA, 'HasAppointment', patientId2, a1._id);
        expect(newLink._toId).toBe(a1._id);
      });

      it('different sources to different targets succeeds', async () => {
        const a1 = await provider.createObject(tenantA, 'Appointment', { date: '2025-01-01' });
        const a2 = await provider.createObject(tenantA, 'Appointment', { date: '2025-02-01' });
        await provider.createLink(tenantA, 'HasAppointment', patientId1, a1._id);
        await provider.createLink(tenantA, 'HasAppointment', patientId2, a2._id);
        // Both succeed without error
      });
    });

    // ─── Cardinality MANY_TO_MANY ───

    describe('cardinality MANY_TO_MANY', () => {
      it('allows any combination', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        await provider.createLink(tenantA, 'AssignedTo', patientId2, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId2, teamId2);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items).toHaveLength(2);
      });

      it('allows multiple links of same type between same pair', async () => {
        // MANY_TO_MANY should allow multiple links between same pair
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'primary' });
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'consultant' });
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items.length).toBeGreaterThanOrEqual(2);
      });

      it('multiple sources and targets all succeed', async () => {
        const p3 = await provider.createObject(tenantA, 'Patient', { name: 'Patient3' });
        const t3 = await provider.createObject(tenantA, 'CareTeam', { name: 'Team3' });
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId2, t3._id);
        await provider.createLink(tenantA, 'AssignedTo', p3._id, teamId2);
        // All succeed
      });
    });

    // ─── Multiple Links Between Same Pair ───

    describe('multiple links between same pair', () => {
      it('different link types between same pair allowed', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        const assigned = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        const primary = await provider.getLinks(tenantA, patientId1, 'PrimaryDoctor', 'outbound');
        expect(assigned.items).toHaveLength(1);
        expect(primary.items).toHaveLength(1);
      });

      it('MANY_TO_MANY allows duplicate pairs with different properties', async () => {
        const l1 = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'nurse' });
        const l2 = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'advisor' });
        expect(l1._id).not.toBe(l2._id);
      });
    });

    // ─── Referential Integrity ───

    describe('referential integrity', () => {
      it('link _fromType and _toType set from schema', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        expect(link._fromType).toBe('Patient');
        expect(link._toType).toBe('CareTeam');
      });

      it('links with properties preserve all custom fields', async () => {
        const med = await provider.createObject(tenantA, 'Medication', { name: 'Aspirin' });
        const link = await provider.createLink(tenantA, 'Prescribes', teamId1, med._id, {
          prescribedAt: '2025-01-01',
          reason: 'headache',
        });
        expect(link.prescribedAt).toBe('2025-01-01');
        expect(link.reason).toBe('headache');
      });

      it('getLinks pagination works', async () => {
        const t3 = await provider.createObject(tenantA, 'CareTeam', { name: 'Team3' });
        const t4 = await provider.createObject(tenantA, 'CareTeam', { name: 'Team4' });
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, t3._id);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, t4._id);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { limit: 2, offset: 0 });
        expect(page.items).toHaveLength(2);
        expect(page.totalCount).toBe(4);
        expect(page.hasNextPage).toBe(true);
      });
    });
  });
}
