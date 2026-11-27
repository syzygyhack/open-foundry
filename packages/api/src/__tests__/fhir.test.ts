/**
 * Tests for the FHIR R4 read-only facade.
 *
 * Validates:
 * - Patient read by ID
 * - Patient search by NHS number (identifier)
 * - Patient search by name and birthdate
 * - FHIR resource conforms to NHS Digital profile structure
 * - Write operations (POST/PUT/DELETE) return 405
 * - Encounter search by patient reference
 * - Authorization and consent enforcement
 *
 * Test scenario from MVP Section 7.5:
 *   GIVEN Patient-1 exists in ontology with nhsNumber=1234567890
 *   WHEN  GET /fhir/Patient?identifier=nhs-number|1234567890
 *   THEN  FHIR Patient resource returned with correct NHS identifier mapping
 */

import { describe, it, expect, vi } from 'vitest';
import { createFhirRouter, buildPatientFilter } from '../fhir/router.js';
import { mapPatientToFhir, mapEncounterToFhir } from '../fhir/mappers.js';
import {
  NHS_NUMBER_SYSTEM,
  NHS_PATIENT_PROFILE,
  NHS_ENCOUNTER_PROFILE,
} from '../fhir/types.js';
import type { FhirRequest } from '../fhir/router.js';
import type { FhirPatient, FhirBundle, FhirEncounter, FhirOperationOutcome } from '../fhir/types.js';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';
import type { OntologyObject, RequestContext } from '@openfoundry/spi';
import { getAllLinks } from '../utils.js';

// ─── Fixtures ───

function createMockUser(): AuthenticatedUserInfo {
  return {
    id: 'user-1',
    name: 'Dr Smith',
    email: 'dr.smith@nhs.uk',
    roles: ['clinician'],
    groups: [],
    tenantId: 'tenant-1',
  };
}

function createPatientObject(id: string, overrides: Record<string, unknown> = {}): OntologyObject {
  return {
    _tenantId: 'tenant-1',
    _type: 'Patient',
    _id: id,
    _version: 1,
    _createdAt: '2025-01-01T00:00:00Z',
    _updatedAt: '2025-01-01T00:00:00Z',
    nhsNumber: '1234567890',
    name: 'Smith',
    dateOfBirth: '1990-05-15',
    status: 'ACTIVE',
    ...overrides,
  };
}

function createEncounterObject(id: string, patientId: string): OntologyObject {
  return {
    _tenantId: 'tenant-1',
    _type: 'Encounter',
    _id: id,
    _version: 1,
    _createdAt: '2025-06-01T09:00:00Z',
    _updatedAt: '2025-06-01T09:00:00Z',
    patientId,
    status: 'ACTIVE',
  };
}

function createMockDeps(): ApiDependencies {
  return {
    schema: {} as ApiDependencies['schema'],
    objectManager: {
      get: vi.fn(),
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiDependencies['objectManager'],
    linkManager: {
      getLinks: vi.fn().mockResolvedValue({ items: [], totalCount: 0, hasNextPage: false }),
      createLink: vi.fn(),
      updateLink: vi.fn(),
      deleteLink: vi.fn(),
      traverse: vi.fn(),
    } as unknown as ApiDependencies['linkManager'],
    actionExecutor: {
      execute: vi.fn(),
    } as unknown as ApiDependencies['actionExecutor'],
    authorizationService: {
      check: vi.fn().mockResolvedValue(true),
      listObjects: vi.fn().mockResolvedValue([]),
      getVisibleFields: vi.fn().mockReturnValue(undefined),
      redactFields: vi.fn().mockImplementation(
        (_userId: string, _roles: string[], _type: string, obj: Record<string, unknown>) => ({
          data: obj,
          _redactedFields: [],
        }),
      ),
      redactFieldsBatch: vi.fn().mockImplementation(
        (_userId: string, _roles: string[], _type: string, objects: Record<string, unknown>[]) =>
          objects.map(obj => ({ data: obj, _redactedFields: [] })),
      ),
      clearFieldCache: vi.fn(),
    } as unknown as ApiDependencies['authorizationService'],
    authenticator: {} as unknown as ApiDependencies['authenticator'],
    consentService: undefined,
    auditWriter: undefined,
    storage: {} as unknown as ApiDependencies['storage'],
  };
}

function fhirGet(path: string, query: Record<string, string> = {}): FhirRequest {
  return {
    method: 'GET',
    path,
    query,
    user: createMockUser(),
  };
}

// ─── Tests ───

describe('FHIR R4 read-only facade', () => {
  describe('Patient read by ID', () => {
    it('returns a FHIR Patient resource for a valid ID', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient/p-1'));

      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toContain('application/fhir+json');

      const body = res.body as FhirPatient;
      expect(body.resourceType).toBe('Patient');
      expect(body.id).toBe('p-1');
    });

    it('returns 404 for non-existent patient', async () => {
      const deps = createMockDeps();
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient/no-such'));

      expect(res.status).toBe(404);
      const body = res.body as FhirOperationOutcome;
      expect(body.resourceType).toBe('OperationOutcome');
    });

    it('returns 403 when user lacks authorization', async () => {
      const deps = createMockDeps();
      (deps.authorizationService.check as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient/p-1'));

      expect(res.status).toBe(403);
    });
  });

  describe('Patient search by NHS number (MVP Section 7.5)', () => {
    it('GET /fhir/Patient?identifier=nhs-number|1234567890 returns FHIR resource', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1');

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', {
        identifier: `${NHS_NUMBER_SYSTEM}|1234567890`,
      }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.resourceType).toBe('Bundle');
      expect(bundle.type).toBe('searchset');
      expect(bundle.total).toBe(1);
      expect(bundle.entry).toHaveLength(1);

      const fhirPatient = bundle.entry![0]!.resource as FhirPatient;
      expect(fhirPatient.resourceType).toBe('Patient');
    });

    it('FHIR Patient has correct identifier system and value', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1', { nhsNumber: '1234567890' });

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', {
        identifier: 'nhs-number|1234567890',
      }));

      const bundle = res.body as FhirBundle;
      const fhirPatient = bundle.entry![0]!.resource as FhirPatient;

      expect(fhirPatient.identifier).toBeDefined();
      expect(fhirPatient.identifier).toHaveLength(1);
      expect(fhirPatient.identifier![0]!.system).toBe(NHS_NUMBER_SYSTEM);
      expect(fhirPatient.identifier![0]!.value).toBe('1234567890');
    });

    it('FHIR Patient has correct name and birthDate mapping', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1', {
        nhsNumber: '1234567890',
        name: 'Smith',
        dateOfBirth: '1990-05-15',
      });

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', {
        identifier: 'nhs-number|1234567890',
      }));

      const bundle = res.body as FhirBundle;
      const fhirPatient = bundle.entry![0]!.resource as FhirPatient;

      expect(fhirPatient.name).toBeDefined();
      expect(fhirPatient.name).toHaveLength(1);
      expect(fhirPatient.name![0]!.family).toBe('Smith');
      expect(fhirPatient.birthDate).toBe('1990-05-15');
    });

    it('short-form identifier search also works (nhs-number|value)', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1');

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', {
        identifier: 'nhs-number|1234567890',
      }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.total).toBe(1);
    });

    it('returns empty bundle when no patients match', async () => {
      const deps = createMockDeps();
      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue([]);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [], totalCount: 0, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', {
        identifier: 'nhs-number|9999999999',
      }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.total).toBe(0);
      expect(bundle.entry).toBeUndefined();
    });
  });

  describe('Patient search by name and birthdate', () => {
    it('search by name works', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1', { name: 'Smith' });

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', { name: 'Smith' }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.total).toBe(1);

      // Verify the query filter used 'contains' for name
      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      const filter = queryMock.mock.calls[0]![1];
      // Combined filter: { and: [id IN [...], name contains 'Smith'] }
      expect(filter.and[1].field).toBe('name');
      expect(filter.and[1].operator).toBe('contains');
      expect(filter.and[1].value).toBe('Smith');
    });

    it('search by birthdate works', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1', { dateOfBirth: '1990-05-15' });

      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>)
        .mockResolvedValue(['patient:p-1']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [patient], totalCount: 1, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient', { birthdate: '1990-05-15' }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.total).toBe(1);
    });

    it('search without any parameters returns 400', async () => {
      const deps = createMockDeps();

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient'));

      expect(res.status).toBe(400);
      const body = res.body as FhirOperationOutcome;
      expect(body.resourceType).toBe('OperationOutcome');
      expect(body.issue[0]!.diagnostics).toContain('search parameter');
    });
  });

  describe('FHIR NHS Digital profile conformance', () => {
    it('Patient resource has NHS Digital profile in meta', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient/p-1'));

      const body = res.body as FhirPatient;
      expect(body.meta).toBeDefined();
      expect(body.meta!.profile).toContain(NHS_PATIENT_PROFILE);
    });

    it('Patient resource has version and lastUpdated in meta', async () => {
      const deps = createMockDeps();
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Patient/p-1'));

      const body = res.body as FhirPatient;
      expect(body.meta!.versionId).toBe('1');
      expect(body.meta!.lastUpdated).toBe('2025-01-01T00:00:00Z');
    });

    it('identifier uses correct NHS number system URI', () => {
      const patient = createPatientObject('p-1', { nhsNumber: '1234567890' });
      const fhir = mapPatientToFhir(patient);

      expect(fhir.identifier![0]!.system).toBe('https://fhir.nhs.uk/Id/nhs-number');
      expect(fhir.identifier![0]!.value).toBe('1234567890');
    });
  });

  describe('Structured-name decomposition (v0.2.0 B2)', () => {
    it('maps structured family/given to FHIR HumanName', () => {
      const patient = createPatientObject('p-1', {
        name: 'Jane Mary Doe',
        family: 'Doe',
        given: 'Jane Mary',
      });
      const fhir = mapPatientToFhir(patient);

      expect(fhir.name).toHaveLength(1);
      expect(fhir.name![0]!.family).toBe('Doe');
      expect(fhir.name![0]!.given).toEqual(['Jane', 'Mary']);
      expect(fhir.name![0]!.use).toBe('official');
    });

    it('falls back to the single name string when no structured components', () => {
      const patient = createPatientObject('p-1', { name: 'Smith', family: undefined, given: undefined });
      const fhir = mapPatientToFhir(patient);

      expect(fhir.name![0]!.family).toBe('Smith');
      expect(fhir.name![0]!.given).toBeUndefined();
    });

    it('explodes multiple given names on whitespace', () => {
      const patient = createPatientObject('p-1', { family: 'Doe', given: '  Jane   Mary  ' });
      const fhir = mapPatientToFhir(patient);

      expect(fhir.name![0]!.given).toEqual(['Jane', 'Mary']);
    });
  });

  describe('Encounter search (synthesized from AdmittedTo links)', () => {
    it('returns encounters synthesized from AdmittedTo links', async () => {
      const deps = createMockDeps();
      // Mock AdmittedTo links (Patient → Ward)
      const link1 = {
        _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: 'link-1',
        _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
        _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
        admissionDate: '2025-06-01T09:00:00Z', reason: 'Emergency',
      };
      const link2 = {
        _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: 'link-2',
        _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-2',
        _version: 1, _createdAt: '2025-05-15T10:00:00Z', _updatedAt: '2025-05-15T10:00:00Z',
        admissionDate: '2025-05-15T10:00:00Z', _deletedAt: '2025-05-20T12:00:00Z',
      };

      (deps.linkManager.getLinks as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ items: [link1, link2], totalCount: 2, hasNextPage: false });

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Encounter', { patient: 'Patient/p-1' }));

      expect(res.status).toBe(200);
      const bundle = res.body as FhirBundle;
      expect(bundle.total).toBe(2);
      expect(bundle.entry).toHaveLength(2);

      const encounter = bundle.entry![0]!.resource as FhirEncounter;
      expect(encounter.resourceType).toBe('Encounter');
      expect(encounter.subject!.reference).toBe('Patient/p-1');
      expect(encounter.meta!.profile).toContain(NHS_ENCOUNTER_PROFILE);
      expect(encounter.status).toBe('in-progress'); // Active (no _deletedAt)

      const discharged = bundle.entry![1]!.resource as FhirEncounter;
      expect(discharged.status).toBe('finished'); // Discharged (_deletedAt set)
    });

    it('reads every page of admissions, so old ones cannot crowd out the current one', async () => {
      const deps = createMockDeps();
      const mk = (i: number, deleted: boolean) => ({
        _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: `link-${i}`,
        _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
        _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
        admissionDate: '2025-06-01T09:00:00Z',
        ...(deleted ? { _deletedAt: '2025-06-02T09:00:00Z' } : {}),
      });
      // 100 discharged admissions fill the first page; the current one is on page two.
      const all = [...Array.from({ length: 100 }, (_, i) => mk(i, true)), mk(100, false)];
      (deps.linkManager.getLinks as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, _t: string, _d: string, opts: { limit: number; after?: string }) => {
          const from = opts.after === undefined ? 0 : Number(opts.after);
          const items = all.slice(from, from + opts.limit);
          return { items, totalCount: all.length, hasNextPage: from + opts.limit < all.length, cursor: String(from + items.length) };
        },
      );

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Encounter', { patient: 'Patient/p-1' }));
      const bundle = res.body as FhirBundle;
      expect(bundle.entry).toHaveLength(101);
      const ids = bundle.entry!.map((e) => (e.resource as FhirEncounter).id);
      expect(new Set(ids).size).toBe(101);
      const statuses = bundle.entry!.map((e) => (e.resource as FhirEncounter).status);
      expect(statuses.filter((s) => s === 'in-progress')).toHaveLength(1);
    });

    it('pages by cursor, so a link deleted between reads cannot hide the current admission', async () => {
      const deps = createMockDeps();
      const mk = (i: number, current = false) => ({
        _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: `link-${i}`,
        _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
        _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
        admissionDate: '2025-06-01T09:00:00Z',
        ...(current ? {} : { _deletedAt: '2025-06-02T09:00:00Z' }),
      });
      const all = [...Array.from({ length: 100 }, (_, i) => mk(i)), mk(100, true)];
      const calls: Array<{ after?: string; offset?: number }> = [];
      (deps.linkManager.getLinks as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, _t: string, _d: string, opts: { limit: number; after?: string; offset?: number }) => {
          calls.push({ after: opts.after, offset: opts.offset });
          // The first history record is purged after the first read: an offset
          // of 100 would now start past the current admission.
          if (calls.length === 2) all.shift();
          // Offsets and cursors both work, as on the real providers.
          const from = opts.after === undefined ? (opts.offset ?? 0) : all.findIndex((l) => l._id === opts.after) + 1;
          const items = all.slice(from, from + opts.limit);
          return { items, totalCount: all.length, hasNextPage: from + opts.limit < all.length, cursor: items.at(-1)?._id };
        },
      );

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Encounter', { patient: 'Patient/p-1' }));
      const entries = (res.body as FhirBundle).entry!;
      expect(entries.filter((e) => (e.resource as FhirEncounter).status === 'in-progress')).toHaveLength(1);
      expect(calls[1]).toEqual({ after: 'link-99', offset: undefined });
    });

    it('fails rather than looping when the provider never reports the last page', async () => {
      let n = 0;
      const getLinks = vi.fn().mockImplementation(async () => {
        const link = {
          _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: `link-${++n}`,
          _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
          _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
        };
        return { items: [link], totalCount: 1, hasNextPage: true, cursor: link._id };
      });
      await expect(
        getAllLinks({ getLinks }, 'p-1', 'AdmittedTo', 'outbound', { includeDeleted: true, maxPages: 5 }, {
          tenantId: 'tenant-1', actorId: 'a',
        } as RequestContext),
      ).rejects.toThrow(/after 5 pages/);
      expect(getLinks).toHaveBeenCalledTimes(5);
    });

    it('fails rather than looping when the provider ignores the cursor', async () => {
      const link = {
        _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: 'link-1',
        _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
        _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
      };
      const getLinks = vi.fn().mockResolvedValue({ items: [link], totalCount: 1, hasNextPage: true, cursor: 'c' });
      await expect(
        getAllLinks({ getLinks }, 'p-1', 'AdmittedTo', 'outbound', { includeDeleted: true, maxPages: 5 }, {
          tenantId: 'tenant-1', actorId: 'a',
        } as RequestContext),
      ).rejects.toThrow(/do not page by cursor/);
      expect(getLinks).toHaveBeenCalledTimes(2);
    });

    it('requires patient parameter', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Encounter'));

      expect(res.status).toBe(400);
    });

    it('checks authorization for the referenced patient', async () => {
      const deps = createMockDeps();
      (deps.authorizationService.check as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Encounter', { patient: 'Patient/p-1' }));

      expect(res.status).toBe(403);
    });
  });

  describe('write operations return 405', () => {
    it('POST returns 405 Method Not Allowed', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router({
        method: 'POST',
        path: 'Patient',
        query: {},
        user: createMockUser(),
      });

      expect(res.status).toBe(405);
      expect(res.headers['Allow']).toBe('GET, HEAD');
      const body = res.body as FhirOperationOutcome;
      expect(body.resourceType).toBe('OperationOutcome');
      expect(body.issue[0]!.diagnostics).toContain('read-only');
    });

    it('PUT returns 405 Method Not Allowed', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router({
        method: 'PUT',
        path: 'Patient/p-1',
        query: {},
        user: createMockUser(),
      });

      expect(res.status).toBe(405);
    });

    it('DELETE returns 405 Method Not Allowed', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router({
        method: 'DELETE',
        path: 'Patient/p-1',
        query: {},
        user: createMockUser(),
      });

      expect(res.status).toBe(405);
    });

    it('PATCH returns 405 Method Not Allowed', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router({
        method: 'PATCH',
        path: 'Patient/p-1',
        query: {},
        user: createMockUser(),
      });

      expect(res.status).toBe(405);
    });
  });

  describe('unsupported resource types', () => {
    it('returns 404 for unsupported resource type', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router(fhirGet('Observation/obs-1'));

      expect(res.status).toBe(404);
      const body = res.body as FhirOperationOutcome;
      expect(body.issue[0]!.diagnostics).toContain('not supported');
    });

    it('returns 400 for empty path', async () => {
      const deps = createMockDeps();
      const router = createFhirRouter({ deps });
      const res = await router(fhirGet(''));

      expect(res.status).toBe(400);
    });
  });
});

describe('FHIR mappers', () => {
  it('mapPatientToFhir produces correct structure', () => {
    const obj = createPatientObject('p-1', {
      nhsNumber: '1234567890',
      name: 'Smith',
      dateOfBirth: '1990-05-15',
    });

    const fhir = mapPatientToFhir(obj);

    expect(fhir.resourceType).toBe('Patient');
    expect(fhir.id).toBe('p-1');
    expect(fhir.meta!.profile).toEqual([NHS_PATIENT_PROFILE]);
    expect(fhir.identifier).toEqual([
      { system: NHS_NUMBER_SYSTEM, value: '1234567890' },
    ]);
    expect(fhir.name).toEqual([
      { family: 'Smith', use: 'official' },
    ]);
    expect(fhir.birthDate).toBe('1990-05-15');
  });

  it('mapPatientToFhir omits optional fields when absent', () => {
    const obj: OntologyObject = {
      _tenantId: 'tenant-1',
      _type: 'Patient',
      _id: 'p-2',
      _version: 1,
      _createdAt: '2025-01-01T00:00:00Z',
      _updatedAt: '2025-01-01T00:00:00Z',
    };

    const fhir = mapPatientToFhir(obj);

    expect(fhir.identifier).toBeUndefined();
    expect(fhir.name).toBeUndefined();
    expect(fhir.birthDate).toBeUndefined();
  });

  it('mapEncounterToFhir produces correct structure', () => {
    const obj = createEncounterObject('enc-1', 'p-1');
    const fhir = mapEncounterToFhir(obj, 'p-1');

    expect(fhir.resourceType).toBe('Encounter');
    expect(fhir.id).toBe('enc-1');
    expect(fhir.meta!.profile).toEqual([NHS_ENCOUNTER_PROFILE]);
    expect(fhir.subject!.reference).toBe('Patient/p-1');
    expect(fhir.status).toBe('in-progress');
    expect(fhir.class!.code).toBe('IMP');
  });

  it('mapEncounterToFhir maps finished status', () => {
    const obj: OntologyObject = {
      ...createEncounterObject('enc-2', 'p-1'),
      status: 'DISCHARGED',
    };
    const fhir = mapEncounterToFhir(obj);

    expect(fhir.status).toBe('finished');
  });
});

describe('buildPatientFilter', () => {
  it('builds filter from identifier with system|value', () => {
    const filter = buildPatientFilter({ identifier: 'nhs-number|1234567890' });
    expect(filter).toEqual({ field: 'nhsNumber', operator: 'eq', value: '1234567890' });
  });

  it('builds filter from full NHS system URI', () => {
    const filter = buildPatientFilter({
      identifier: `${NHS_NUMBER_SYSTEM}|1234567890`,
    });
    expect(filter).toEqual({ field: 'nhsNumber', operator: 'eq', value: '1234567890' });
  });

  it('builds filter from name', () => {
    const filter = buildPatientFilter({ name: 'Smith' });
    expect(filter).toEqual({ field: 'name', operator: 'contains', value: 'Smith' });
  });

  it('builds filter from birthdate', () => {
    const filter = buildPatientFilter({ birthdate: '1990-05-15' });
    expect(filter).toEqual({ field: 'dateOfBirth', operator: 'eq', value: '1990-05-15' });
  });

  it('combines multiple parameters with AND', () => {
    const filter = buildPatientFilter({ name: 'Smith', birthdate: '1990-05-15' });
    expect(filter).toEqual({
      and: [
        { field: 'name', operator: 'contains', value: 'Smith' },
        { field: 'dateOfBirth', operator: 'eq', value: '1990-05-15' },
      ],
    });
  });

  it('returns null when no parameters provided', () => {
    const filter = buildPatientFilter({});
    expect(filter).toBeNull();
  });
});
