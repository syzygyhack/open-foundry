import { describe, it, expect, vi } from 'vitest';
import {
  NHS_ACUTE_CDM_PROFILE,
  projectToCdm,
  findMappingBySourceType,
  findMappingByCdmResource,
  createCdmRouter,
} from '../cdm/index.js';
import type { CdmRequest } from '../cdm/index.js';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';

describe('CDM mapping profile', () => {
  it('declares the operational subset and a profile/CDM version', () => {
    expect(NHS_ACUTE_CDM_PROFILE.profileVersion).toBeTruthy();
    expect(NHS_ACUTE_CDM_PROFILE.cdmVersion).toBeTruthy();
    expect(NHS_ACUTE_CDM_PROFILE.subset).toEqual(
      expect.arrayContaining(['Patient', 'Ward', 'Bed', 'Admission', 'Discharge', 'Transfer', 'Staff', 'Encounter']),
    );
  });

  it('maps every modelled source type in the subset', () => {
    const sourceTypes = NHS_ACUTE_CDM_PROFILE.resources.map(r => r.sourceType);
    expect(sourceTypes).toEqual(
      expect.arrayContaining(['Patient', 'Ward', 'Bed', 'Consultant', 'DischargeRecord', 'AdmittedTo']),
    );
  });

  it('records gap-register entries (incl. resolved Transfer / Patient.name, open Staff)', () => {
    const areas = NHS_ACUTE_CDM_PROFILE.gaps.map(g => g.area);
    expect(areas).toContain('Transfer');
    expect(areas).toContain('Staff');
    // Every gap has an issue + fallback
    for (const g of NHS_ACUTE_CDM_PROFILE.gaps) {
      expect(g.issue.length).toBeGreaterThan(0);
      expect(g.fallback.length).toBeGreaterThan(0);
    }
  });

  it('Consultant and Staff both project to the CDM Practitioner resource (v0.2.0 B4)', () => {
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Consultant')?.cdmResource).toBe('Practitioner');
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Staff')?.cdmResource).toBe('Practitioner');
  });

  it('projects a Staff record to Practitioner with identifier and role', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Staff')!;
    const rec = projectToCdm(
      { _id: 's-1', _version: 1, staffId: 'STAFF-9', name: 'Nurse Okafor', role: 'NURSE', specialty: 'General' },
      mapping, NHS_ACUTE_CDM_PROFILE,
    );
    expect(rec.resourceType).toBe('Practitioner');
    expect(rec['identifier']).toBe('STAFF-9');
    expect(rec['role']).toBe('NURSE');
    expect(rec['specialty']).toBe('General');
  });

  it('Ward and Bed both project to the CDM Location resource', () => {
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Ward')?.cdmResource).toBe('Location');
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Bed')?.cdmResource).toBe('Location');
  });

  it('finds mappings by source type and by CDM resource name', () => {
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Patient')?.cdmResource).toBe('Patient');
    expect(findMappingByCdmResource(NHS_ACUTE_CDM_PROFILE, 'Practitioner')?.sourceType).toBe('Consultant');
    expect(findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Nonexistent')).toBeUndefined();
  });
});

describe('CDM projection', () => {
  const patient = {
    _id: 'p-1',
    _version: 3,
    _updatedAt: '2026-05-25T10:00:00.000Z',
    nhsNumber: '9434765919',
    name: 'Jane Doe',
    given: 'Jane',
    family: 'Doe',
    dateOfBirth: '1980-04-01',
    status: 'DISCHARGED',
    triageCategory: 'P2_URGENT',
  };

  it('projects a Patient with mapped fields and enum remap', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Patient')!;
    const rec = projectToCdm(patient, mapping, NHS_ACUTE_CDM_PROFILE);

    expect(rec.resourceType).toBe('Patient');
    expect(rec.id).toBe('p-1');
    expect(rec['nhsNumber']).toBe('9434765919');
    expect(rec['birthDate']).toBe('1980-04-01');
    // status enum remap: DISCHARGED → inactive
    expect(rec['status']).toBe('inactive');
  });

  it('projects structured family/given components (v0.2.0 B2)', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Patient')!;
    const rec = projectToCdm(patient, mapping, NHS_ACUTE_CDM_PROFILE);

    expect(rec['name']).toBe('Jane Doe');
    expect(rec['family']).toBe('Doe');
    expect(rec['given']).toBe('Jane');
  });

  it('attaches provenance with source version, timestamp, and lossy fields', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Patient')!;
    const rec = projectToCdm(patient, mapping, NHS_ACUTE_CDM_PROFILE);

    expect(rec._provenance.sourceType).toBe('Patient');
    expect(rec._provenance.sourceId).toBe('p-1');
    expect(rec._provenance.sourceVersion).toBe(3);
    expect(rec._provenance.sourceUpdatedAt).toBe('2026-05-25T10:00:00.000Z');
    expect(rec._provenance.profileVersion).toBe(NHS_ACUTE_CDM_PROFILE.profileVersion);
    // given, status, triageCategory are declared lossy (name is no longer
    // lossy now that family/given carry the structured decomposition)
    expect(rec._provenance.lossyFields).toEqual(
      expect.arrayContaining(['given', 'status', 'triageCategory']),
    );
    expect(rec._provenance.lossyFields).not.toContain('name');
  });

  it('injects constant fields (Ward → Location kind=ward)', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Ward')!;
    const rec = projectToCdm(
      { _id: 'w-1', _version: 1, name: 'Acute Medical Unit', specialty: 'General Medicine', capacity: 24 },
      mapping, NHS_ACUTE_CDM_PROFILE,
    );
    expect(rec.resourceType).toBe('Location');
    expect(rec['kind']).toBe('ward');
    expect(rec['name']).toBe('Acute Medical Unit');
    expect(rec['capacity']).toBe(24);
  });

  it('remaps Bed status (CLEANING → unavailable, lossy)', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Bed')!;
    const rec = projectToCdm(
      { _id: 'b-1', _version: 1, number: 'B12', type: 'ICU', status: 'CLEANING' },
      mapping, NHS_ACUTE_CDM_PROFILE,
    );
    expect(rec['kind']).toBe('bed');
    expect(rec['status']).toBe('unavailable');
    expect(rec._provenance.lossyFields).toContain('status');
  });

  it('projects an Encounter from a flattened AdmittedTo link with derived status', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'AdmittedTo')!;
    const rec = projectToCdm(
      {
        _id: 'l-1', _version: 1,
        patientId: 'p-1', wardId: 'w-1',
        admissionDate: '2026-05-20T08:00:00.000Z',
        reason: 'chest pain',
        status: 'ACTIVE',
      },
      mapping, NHS_ACUTE_CDM_PROFILE,
    );
    expect(rec.resourceType).toBe('Encounter');
    expect(rec['patient']).toBe('p-1');
    expect(rec['location']).toBe('w-1');
    // status derived: ACTIVE → in-progress
    expect(rec['status']).toBe('in-progress');
  });

  it('omits absent optional fields', () => {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'Patient')!;
    const rec = projectToCdm(
      { _id: 'p-2', _version: 1, name: 'No NHS Number', status: 'ACTIVE' },
      mapping, NHS_ACUTE_CDM_PROFILE,
    );
    expect(rec['nhsNumber']).toBeUndefined();
    expect('nhsNumber' in rec).toBe(false);
  });
});

// ─── Router-level coverage (mocked deps) ───

function makeUser(): AuthenticatedUserInfo {
  return { id: 'u-1', tenantId: 't-1', roles: ['clinician'] } as AuthenticatedUserInfo;
}

interface AuthzCalls {
  check: Array<{ relation: string; object: string }>;
  list: Array<{ relation: string; type: string }>;
}

function makeDeps(over: {
  checkResult?: boolean;
  listResult?: string[];
  getResult?: Record<string, unknown> | null;
  queryItems?: Record<string, unknown>[];
}): { deps: ApiDependencies; calls: AuthzCalls } {
  const calls: AuthzCalls = { check: [], list: [] };
  const deps = {
    authorizationService: {
      clearFieldCache: () => {},
      check: vi.fn(async (_user: string, relation: string, object: string) => {
        calls.check.push({ relation, object });
        return over.checkResult ?? true;
      }),
      listObjects: vi.fn(async (_user: string, relation: string, type: string) => {
        calls.list.push({ relation, type });
        return over.listResult ?? ['*'];
      }),
      redactFields: (_id: string, _roles: string[], _type: string, obj: Record<string, unknown>) => ({ data: obj, _redactedFields: [] as string[] }),
      redactFieldsBatch: (_id: string, _roles: string[], _type: string, items: Record<string, unknown>[]) => items.map(data => ({ data, _redactedFields: [] as string[] })),
    },
    objectManager: {
      get: vi.fn(async () => over.getResult ?? null),
      query: vi.fn(async () => ({ items: over.queryItems ?? [] })),
    },
    linkManager: { getLinks: vi.fn(async () => ({ items: [] })) },
  } as unknown as ApiDependencies;
  return { deps, calls };
}

describe('CDM Encounter projection', () => {
  it('reads every page of admissions, so old ones cannot crowd out the current one', async () => {
    const { deps } = makeDeps({});
    const mk = (i: number, deleted: boolean) => ({
      _tenantId: 'tenant-1', _type: 'AdmittedTo', _id: `link-${i}`,
      _fromType: 'Patient', _fromId: 'p-1', _toType: 'Ward', _toId: 'ward-1',
      _version: 1, _createdAt: '2025-06-01T09:00:00Z', _updatedAt: '2025-06-01T09:00:00Z',
      admissionDate: '2025-06-01T09:00:00Z',
      ...(deleted ? { _deletedAt: '2025-06-02T09:00:00Z' } : {}),
    });
    const all = [...Array.from({ length: 100 }, (_, i) => mk(i, true)), mk(100, false)];
    (deps.linkManager.getLinks as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, _t: string, _d: string, opts: { limit: number; offset: number }) => ({
        items: all.slice(opts.offset, opts.offset + opts.limit),
        totalCount: all.length,
        hasNextPage: opts.offset + opts.limit < all.length,
      }),
    );
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Encounter', query: { patient: 'p-1' }, user: makeUser() });
    expect(res.status).toBe(200);
    const body = res.body as { total: number; records: Array<Record<string, unknown>> };
    expect(body.total).toBe(101);
    const ids = body.records.map((r) => JSON.stringify(r['id'] ?? r['identifier'] ?? r));
    expect(new Set(ids).size).toBe(101);
    expect(JSON.stringify(body.records)).toContain('link-100');
  });
});

describe('CDM router authorization type derivation', () => {
  it('derives snake_case FGA type for multi-word source types (DischargeRecord → discharge_record)', async () => {
    const { deps, calls } = makeDeps({
      getResult: { _id: 'd-1', _version: 1, patient: 'p-1', ward: 'w-1', destination: 'HOME', dischargeDate: '2026-05-25' },
    });
    const router = createCdmRouter({ deps });
    const req: CdmRequest = { method: 'GET', path: 'DischargeRecord/d-1', query: {}, user: makeUser() };

    const res = await router(req);
    expect(res.status).toBe(200);
    expect(calls.check).toEqual([{ relation: 'viewer', object: 'discharge_record:d-1' }]);
  });

  it('uses snake_case FGA type for list authorization', async () => {
    const { deps, calls } = makeDeps({ listResult: ['*'], queryItems: [] });
    const router = createCdmRouter({ deps });
    const req: CdmRequest = { method: 'GET', path: 'DischargeRecord', query: {}, user: makeUser() };

    await router(req);
    expect(calls.list).toEqual([{ relation: 'viewer', type: 'discharge_record' }]);
  });

  it('leaves single-word types unchanged (Patient → patient)', async () => {
    const { deps, calls } = makeDeps({
      getResult: { _id: 'p-1', _version: 1, name: 'Jane', status: 'ACTIVE' },
    });
    const router = createCdmRouter({ deps });
    await router({ method: 'GET', path: 'Patient/p-1', query: {}, user: makeUser() });
    expect(calls.check[0]!.object).toBe('patient:p-1');
  });

  it('empty list advertises the CDM resource name, not the source type (Ward → Location)', async () => {
    // Restricted with no authorized ids → empty-list branch.
    const { deps } = makeDeps({ listResult: [] });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Ward', query: {}, user: makeUser() });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['resourceType']).toBe('Location');
    expect(body['total']).toBe(0);
  });
});

describe('CDM router contract', () => {
  it('serves metadata publicly for GET and HEAD without a user', async () => {
    const { deps } = makeDeps({});
    const router = createCdmRouter({ deps });

    for (const method of ['GET', 'HEAD']) {
      const res = await router({ method, path: 'metadata', query: {} });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body['profileVersion']).toBe(NHS_ACUTE_CDM_PROFILE.profileVersion);
      expect(Array.isArray(body['gaps'])).toBe(true);
    }
  });

  it('requires authentication for data endpoints', async () => {
    const { deps } = makeDeps({});
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient', query: {} });
    expect(res.status).toBe(401);
  });

  it('rejects write methods', async () => {
    const { deps } = makeDeps({});
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'POST', path: 'Patient', query: {}, user: makeUser() });
    expect(res.status).toBe(405);
  });

  it('404s an unknown source type', async () => {
    const { deps } = makeDeps({});
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Nonexistent', query: {}, user: makeUser() });
    expect(res.status).toBe(404);
  });
});

describe('CDM dataset export (v0.2.0 B3)', () => {
  const rows = [
    { _id: 'p-1', _version: 1, nhsNumber: '111', name: 'Jane Doe', given: 'Jane', family: 'Doe', status: 'ACTIVE' },
    { _id: 'p-2', _version: 1, nhsNumber: '222', name: 'John, Jr Roe', given: 'John', family: 'Roe', status: 'DISCHARGED' },
  ];

  it('exports NDJSON by default — one full CDM record per line', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: rows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: {}, user: makeUser() });

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/x-ndjson');
    expect(res.headers['Content-Disposition']).toContain('attachment');
    expect(res.headers['Content-Disposition']).toContain('.ndjson');

    const lines = (res.body as string).split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.resourceType).toBe('Patient');
    expect(first.family).toBe('Doe');
    expect(first._provenance.sourceType).toBe('Patient');
  });

  it('exports CSV with a header row and lossy-field provenance column', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: rows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: { format: 'csv' }, user: makeUser() });

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.headers['Content-Disposition']).toContain('.csv');

    const lines = (res.body as string).split('\n');
    expect(lines[0]).toContain('resourceType,id');
    expect(lines[0]).toContain('_lossyFields');
    expect(lines).toHaveLength(3); // header + 2 rows
    // Value with a comma is quoted.
    expect(lines[2]).toContain('"John, Jr Roe"');
    // given is declared lossy in the profile → appears in the provenance column.
    expect(lines[1]).toContain('given');
  });

  it('serialises Date-valued columns as clean ISO in CSV (no double-quoting)', async () => {
    const dateRows = [
      { _id: 'p-9', _version: 1, nhsNumber: '999', name: 'Date Pat', status: 'ACTIVE', dateOfBirth: new Date('1992-07-20T00:00:00.000Z') },
    ];
    const { deps } = makeDeps({ listResult: ['*'], queryItems: dateRows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: { format: 'csv' }, user: makeUser() });

    const lines = (res.body as string).split('\n');
    // birthDate column carries a bare ISO date — not wrapped in extra quotes.
    expect(lines[1]).toContain('1992-07-20T00:00:00.000Z');
    expect(lines[1]).not.toContain('"""');
  });

  it('rejects an unsupported export format', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: rows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: { format: 'xml' }, user: makeUser() });
    expect(res.status).toBe(400);
  });

  it('export honours authorization (restricted with no ids → empty body)', async () => {
    const { deps } = makeDeps({ listResult: [], queryItems: rows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: {}, user: makeUser() });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });

  it('signals an un-truncated export via headers (not capped)', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: rows });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: {}, user: makeUser() });
    expect(res.headers['X-CDM-Export-Truncated']).toBe('false');
    expect(res.headers['X-CDM-Export-Limit']).toBeDefined();
  });

  it('requires authentication', async () => {
    const { deps } = makeDeps({});
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient/export', query: {} });
    expect(res.status).toBe(401);
  });
});

describe('CDM truncation signalling', () => {
  // The mock objectManager.query ignores the limit and returns all queryItems,
  // so a queryItems set larger than the route limit exercises the +1 probe and
  // the capped/slice logic. The list route uses QUERY_LIMIT=100.
  const overLimit = Array.from({ length: 101 }, (_, i) => ({
    _id: `p-${i}`, _version: 1, name: `Pat ${i}`, status: 'ACTIVE',
  }));

  it('list route caps at QUERY_LIMIT and flags truncated', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: overLimit });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient', query: {}, user: makeUser() });

    const body = res.body as { total: number; truncated: boolean; records: unknown[] };
    expect(body.truncated).toBe(true);
    expect(body.records).toHaveLength(100);
    expect(body.total).toBe(100);
  });

  it('list route reports truncated=false when under the cap', async () => {
    const { deps } = makeDeps({ listResult: ['*'], queryItems: overLimit.slice(0, 5) });
    const router = createCdmRouter({ deps });
    const res = await router({ method: 'GET', path: 'Patient', query: {}, user: makeUser() });
    expect((res.body as { truncated: boolean }).truncated).toBe(false);
  });
});
