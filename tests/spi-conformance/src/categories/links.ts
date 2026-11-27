import { describe, expect, beforeEach } from 'vitest';
import { it } from '../known-failures.js';
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
        // A declared property not set reads back as null, on both providers.
        expect(link.role).toBeNull();
        const fetched = await provider.getLink(tenantA, 'AssignedTo', link._id);
        expect(fetched!.role).toBeNull();
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

    // ─── Endpoint visibility (spec §3.3 rule 3) ───

    describe('links to soft-deleted objects', () => {
      it('getLinks leaves out a link whose other end is soft-deleted, unless asked', async () => {
        const live = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        await provider.deleteObject(tenantA, 'CareTeam', teamId2, 'soft');
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items.map((l) => l._id)).toEqual([live._id]);
        expect(page.totalCount).toBe(1);
        const all = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { includeDeleted: true });
        expect(all.items).toHaveLength(2);
      });

      it('getLinks of a soft-deleted object is empty unless asked', async () => {
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteObject(tenantA, 'Patient', patientId1, 'soft');
        expect((await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound')).items).toHaveLength(0);
        expect(
          (await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { includeDeleted: true })).items,
        ).toHaveLength(1);
      });

      it('getLinks returns links oldest first', async () => {
        const first = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await new Promise((r) => setTimeout(r, 5));
        const second = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        const page = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound');
        expect(page.items.map((l) => l._id)).toEqual([first._id, second._id]);
      });
    });

    // ─── Hard delete of an endpoint (spec §3.3 rule 6) ───

    describe('cursor paging (after / cursor)', () => {
      async function seed(n: number): Promise<{ ids: string[]; teams: string[] }> {
        const teams: string[] = [];
        for (let i = 0; i < n; i++) {
          const team = await provider.createObject(tenantA, 'CareTeam', { name: `Cursor ${i}` });
          teams.push(team._id);
          await provider.createLink(tenantA, 'AssignedTo', patientId1, team._id);
        }
        const all = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { limit: 1000 });
        return { ids: all.items.map((l) => l._id), teams: all.items.map((l) => l._toId) };
      }
      const page = (after?: string, limit = 3) =>
        provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { limit, ...(after ? { after } : {}) });

      it('returns every link once, in getLinks order, and says when it is done', async () => {
        const { ids } = await seed(7);
        const seen: string[] = [];
        const sizes: number[] = [];
        let after: string | undefined;
        for (let i = 0; i < 10; i++) {
          const p = await page(after);
          seen.push(...p.items.map((l) => l._id));
          sizes.push(p.items.length);
          if (!p.hasNextPage) break;
          expect(p.cursor).toBeDefined();
          after = p.cursor;
        }
        expect(seen).toEqual(ids);
        expect(sizes).toEqual([3, 3, 1]);
        // An exactly full last page reports no next page.
        const full = await page(undefined, 7);
        expect(full.items).toHaveLength(7);
        expect(full.hasNextPage).toBe(false);
        const rest = await page(full.cursor);
        expect(rest.items).toEqual([]);
        expect(rest.hasNextPage).toBe(false);
        expect(rest.cursor).toBeUndefined();
      });

      it('does not shift when links before the cursor are deleted', async () => {
        const { ids, teams } = await seed(7);
        const first = await page();
        // Soft-delete the first link, and hard-delete the second link's target.
        await provider.deleteLink(tenantA, 'AssignedTo', ids[0]!);
        await provider.deleteObject(tenantA, 'CareTeam', teams[1]!, 'hard');
        const second = await page(first.cursor);
        expect(second.items.map((l) => l._id)).toEqual(ids.slice(3, 6));
        // An offset page would have moved two links back.
        const byOffset = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { limit: 3, offset: 3 });
        expect(byOffset.items.map((l) => l._id)).toEqual(ids.slice(5, 7));
      });

      it('pages over soft-deleted links too with includeDeleted', async () => {
        const { ids } = await seed(4);
        await provider.deleteLink(tenantA, 'AssignedTo', ids[2]!);
        const first = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { limit: 2, includeDeleted: true });
        const second = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', {
          limit: 2,
          includeDeleted: true,
          after: first.cursor,
        });
        expect([...first.items, ...second.items].map((l) => l._id)).toEqual(ids);
        expect(second.items[0]!._deletedAt).toBeTruthy();
      });

      it('refuses a cursor with an offset, and a malformed cursor', async () => {
        const { ids } = await seed(2);
        expect(ids).toHaveLength(2);
        const first = await page(undefined, 1);
        await expect(
          provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { after: first.cursor, offset: 1 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(page('not-a-cursor')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        // A real cursor with junk appended, and well-formed cursors whose
        // position is not a valid timestamp for any provider.
        await expect(page(`${first.cursor}!`)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        const forged = (t: string) => Buffer.from(JSON.stringify({ t, id: ids[0] }), 'utf8').toString('base64url');
        await expect(page(forged('bogus'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(page(forged('99999999999999999999999'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        await expect(page(forged('2026-02-30T00:00:00.000Z'))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        for (const bad of [{ limit: -1 }, { limit: 1.5 }, { offset: -1 }, { offset: 1e21 }]) {
          await expect(
            provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', bad),
            JSON.stringify(bad),
          ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        }
      });
    });

    describe('hard delete of an endpoint', () => {
      it('removes its outbound and inbound links, live and soft-deleted', async () => {
        const med = await provider.createObject(tenantA, 'Medication', { name: 'Aspirin' });
        const out1 = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'primary' });
        const out2 = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId2);
        await provider.deleteLink(tenantA, 'AssignedTo', out2._id);
        // A soft-deleted link to the object being deleted goes too.
        const gone = await provider.createLink(tenantA, 'AssignedTo', patientId2, teamId1);
        await provider.deleteLink(tenantA, 'AssignedTo', gone._id);
        const inbound = await provider.createLink(tenantA, 'Prescribes', teamId1, med._id);

        await provider.deleteObject(tenantA, 'CareTeam', teamId1, 'hard');

        const fromPatient2 = await provider.getLinks(tenantA, patientId2, 'AssignedTo', 'outbound', { includeDeleted: true });
        expect(fromPatient2.items).toHaveLength(0);

        expect(await provider.getLink(tenantA, 'AssignedTo', out1._id)).toBeNull();
        expect(await provider.getLink(tenantA, 'Prescribes', inbound._id)).toBeNull();
        const fromPatient = await provider.getLinks(tenantA, patientId1, 'AssignedTo', 'outbound', { includeDeleted: true });
        // Only the soft-deleted link to the surviving team remains.
        expect(fromPatient.items.map((l) => l._id)).toEqual([out2._id]);
        const toMed = await provider.getLinks(tenantA, med._id, 'Prescribes', 'inbound', { includeDeleted: true });
        expect(toMed.items).toHaveLength(0);
        const fromTeam = await provider.traverse(tenantA, teamId1, {
          steps: [{ linkType: 'Prescribes', direction: 'outbound' }],
        });
        expect(fromTeam.nodes).toHaveLength(0);
        expect(fromTeam.edges).toHaveLength(0);
      });

      it('leaves other objects\' links alone', async () => {
        const kept = await provider.createLink(tenantA, 'AssignedTo', patientId2, teamId2);
        await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        await provider.deleteObject(tenantA, 'Patient', patientId1, 'hard');
        expect(await provider.getLink(tenantA, 'AssignedTo', kept._id)).not.toBeNull();
      });

      it('frees the surviving endpoint\'s cardinality slot', async () => {
        await provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId1);
        await provider.deleteObject(tenantA, 'CareTeam', teamId1, 'hard');
        // ONE_TO_ONE: before, the dangling link still held patient1's slot.
        await expect(provider.createLink(tenantA, 'PrimaryDoctor', patientId1, teamId2)).resolves.toMatchObject({
          _toId: teamId2,
        });
      });

      it('is rolled back with its transaction, links and history included', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1, { role: 'primary' });
        await provider.updateObject(tenantA, 'Patient', patientId1, { age: 40 });
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteObject('Patient', patientId1, 'hard');
        await tx.rollback();

        expect(await provider.getObject(tenantA, 'Patient', patientId1)).toMatchObject({ age: 40 });
        expect(await provider.getLink(tenantA, 'AssignedTo', link._id)).toMatchObject({ role: 'primary' });
        expect(await provider.getObjectAtVersion(tenantA, 'Patient', patientId1, 1)).toMatchObject({ name: 'Patient1' });
      });

      it('in a committed transaction removes the links', async () => {
        const link = await provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1);
        const tx = await provider.beginTransaction(tenantA);
        await tx.deleteObject('Patient', patientId1, 'hard');
        await tx.commit();
        expect(await provider.getLink(tenantA, 'AssignedTo', link._id)).toBeNull();
      });
    });

    describe('unknown link types', () => {
      it('rejects a link type the schema does not declare with TYPE_NOT_FOUND', async () => {
        await expect(provider.createLink(tenantA, 'NoSuchLink', patientId1, teamId1)).rejects.toMatchObject({
          code: 'TYPE_NOT_FOUND',
        });
        await expect(provider.getLinks(tenantA, patientId1, 'NoSuchLink', 'outbound')).rejects.toMatchObject({
          code: 'TYPE_NOT_FOUND',
        });
        await expect(
          provider.traverse(tenantA, patientId1, { steps: [{ linkType: 'NoSuchLink', direction: 'outbound' }] }),
        ).rejects.toMatchObject({ code: 'TYPE_NOT_FOUND' });
      });

      it('rejects a traversal step filter on a field its target type does not declare', async () => {
        await expect(
          provider.traverse(tenantA, patientId1, {
            steps: [{ linkType: 'AssignedTo', direction: 'outbound', filter: { field: 'age', operator: 'eq', value: 1 } }],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
      });
    });

    describe('endpoints must exist (spec §3.3 rule 5)', () => {
      it('rejects a link to an object that does not exist', async () => {
        await expect(provider.createLink(tenantA, 'AssignedTo', patientId1, 'no-such-team')).rejects.toThrow(
          /does not exist/,
        );
      });

      it('rejects a link from a soft-deleted object', async () => {
        await provider.deleteObject(tenantA, 'Patient', patientId1, 'soft');
        await expect(provider.createLink(tenantA, 'AssignedTo', patientId1, teamId1)).rejects.toThrow(/soft-deleted/);
      });

      it('rejects a link to another tenant\'s object', async () => {
        const other = await provider.createObject(tenantB, 'CareTeam', { name: 'Elsewhere' });
        await expect(provider.createLink(tenantA, 'AssignedTo', patientId1, other._id)).rejects.toThrow(/does not exist/);
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
