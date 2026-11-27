/**
 * Tests for the REST API layer.
 *
 * Tests auto-generated REST routes with mocked Engine, Security, and Action
 * dependencies. Uses the NHS Acute ODL schema to validate:
 * - GET /api/v1/patients (list with pagination)
 * - GET /api/v1/patients/:id (get by ID)
 * - POST /api/v1/actions/AdmitPatient (execute action)
 * - GET /api/v1/patients/:id/links/:linkType (linked objects)
 * - GET /api/v1/patients/:id/history (version history)
 * - Error responses with correct HTTP status codes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import type { OntologyObject, ObjectPage, LinkPage } from '@openfoundry/spi';
import { SchemaGuardError } from '@openfoundry/spi';
import type { ActionResult } from '@openfoundry/actions';
import { generateRestRoutes } from '../rest/route-generator.js';
import { mapErrorToHttpStatus, createRestErrorResponse, wrapErrorToRest } from '../rest/errors.js';
import type { RestRequest, RestRoute } from '../rest/types.js';
import type { ApiDependencies, AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

// ─── NHS Acute ODL fixture ───

const NHS_ACUTE_ODL = `
extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
  triageCategory: TriageCategory
}

enum PatientStatus {
  ACTIVE
  DISCHARGED
  DECEASED
  TRANSFERRED
}

enum TriageCategory {
  P1_IMMEDIATE
  P2_URGENT
  P3_DELAYED
  P4_EXPECTANT
}

type Ward @objectType {
  id: ID! @primary
  name: String! @indexed
  specialty: String!
  capacity: Int! @constraint(expr: "value > 0")
}

type Bed @objectType {
  id: ID! @primary
  number: String! @indexed
  type: BedType!
  status: BedStatus!
}

enum BedType {
  STANDARD
  ICU
  HDU
  ISOLATION
  TROLLEY
}

enum BedStatus {
  AVAILABLE
  OCCUPIED
  CLEANING
  OUT_OF_SERVICE
}

type Consultant @objectType {
  id: ID! @primary
  gmcNumber: String @unique @indexed
  name: String!
  specialty: String!
}

type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}

type AdmitPatient @actionType {
  patient: Patient! @param
  ward: Ward! @param
  reason: String @param
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}
`;

// ─── Mock factories ───

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
    nhsNumber: `NHS-${id}`,
    name: `Patient ${id}`,
    dateOfBirth: '1990-01-01',
    status: 'ACTIVE',
    triageCategory: null,
    ...overrides,
  };
}

function createMockDeps(schema: ParsedSchema): ApiDependencies {
  return {
    schema,
    objectManager: {
      get: vi.fn(),
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiDependencies['objectManager'],
    linkManager: {
      getLinks: vi.fn(),
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
    manifestRegistry: {
      get: (name: string) => ({
        action: name,
        version: 1,
        reversible: false,
        preconditions: [],
        effects: [],
        sideEffects: [],
      }),
    },
    consentService: undefined,
    auditWriter: undefined,
    storage: {
      getObjectAtVersion: vi.fn(),
    } as unknown as ApiDependencies['storage'],
  };
}

function createMockRequest(overrides: Partial<RestRequest> = {}): RestRequest {
  return {
    method: 'GET',
    path: '/api/v1/patients',
    params: {},
    query: {},
    body: undefined,
    user: createMockUser(),
    ...overrides,
  };
}

function createResolverContext(deps: ApiDependencies, user?: AuthenticatedUserInfo): ResolverContext {
  const u = user ?? createMockUser();
  return {
    requestContext: {
      tenantId: u.tenantId,
      actorId: u.id,
      traceId: 'trace-test',
    },
    user: u,
    deps,
  };
}

// ─── Route helper ───

function findRoute(routes: RestRoute[], method: string, pathPattern: string): RestRoute | undefined {
  return routes.find(r => r.method === method && r.pattern === pathPattern);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBody = any;

// ─── Tests ───

describe('REST API', () => {
  let parsed: ParsedSchema;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
  });

  describe('route generation', () => {
    it('generates routes for each object type', () => {
      const deps = createMockDeps(parsed);
      const routes = generateRestRoutes(parsed, deps);

      // Each object type generates: list, getById, links, history
      // Plus actions
      const patientList = findRoute(routes, 'GET', '/api/v1/patients');
      const patientById = findRoute(routes, 'GET', '/api/v1/patients/:id');
      const patientLinks = findRoute(routes, 'GET', '/api/v1/patients/:id/links/:linkType');
      const patientHistory = findRoute(routes, 'GET', '/api/v1/patients/:id/history');

      expect(patientList).toBeDefined();
      expect(patientById).toBeDefined();
      expect(patientLinks).toBeDefined();
      expect(patientHistory).toBeDefined();
    });

    it('generates action routes', () => {
      const deps = createMockDeps(parsed);
      const routes = generateRestRoutes(parsed, deps);

      const admitAction = findRoute(routes, 'POST', '/api/v1/actions/AdmitPatient');
      const dischargeAction = findRoute(routes, 'POST', '/api/v1/actions/DischargePatient');

      expect(admitAction).toBeDefined();
      expect(dischargeAction).toBeDefined();
    });

    it('generates routes for all object types', () => {
      const deps = createMockDeps(parsed);
      const routes = generateRestRoutes(parsed, deps);

      expect(findRoute(routes, 'GET', '/api/v1/wards')).toBeDefined();
      expect(findRoute(routes, 'GET', '/api/v1/wards/:id')).toBeDefined();
      expect(findRoute(routes, 'GET', '/api/v1/beds')).toBeDefined();
      expect(findRoute(routes, 'GET', '/api/v1/beds/:id')).toBeDefined();
      expect(findRoute(routes, 'GET', '/api/v1/consultants')).toBeDefined();
      expect(findRoute(routes, 'GET', '/api/v1/consultants/:id')).toBeDefined();
    });
  });

  describe('GET /api/v1/patients (list)', () => {
    it('returns paginated list', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2', 'patient:p-3']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      const page: ObjectPage = {
        items: [createPatientObject('p-1'), createPatientObject('p-2')],
        totalCount: 3,
        hasNextPage: true,
      };
      queryMock.mockResolvedValue(page);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients')!;

      const req = createMockRequest({
        query: { limit: '2', offset: '0' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe('p-1');
      expect(body.data[1].id).toBe('p-2');
      expect(body.pagination).toBeDefined();
      expect(body.pagination.totalCount).toBe(3);
      expect(body.pagination.hasNextPage).toBe(true);
    });

    it('applies query param filters', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({
        items: [createPatientObject('p-1')],
        totalCount: 1,
        hasNextPage: false,
      });

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients')!;

      const req = createMockRequest({
        query: { 'filter[status]': 'ACTIVE' },
      });
      const ctx = createResolverContext(deps);
      await route.handler(req, ctx);

      const queryArgs = queryMock.mock.calls[0]!;
      const filter = queryArgs[1];
      // Should include both auth filter and user filter
      expect(filter).toBeDefined();
    });
  });

  describe('list filters and schema errors', () => {
    it('a filter on the primary field reaches storage as _id', async () => {
      const deps = createMockDeps(parsed);
      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>).mockResolvedValue(['*']);
      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ items: [], totalCount: 0, hasNextPage: false });

      const route = findRoute(generateRestRoutes(parsed, deps), 'GET', '/api/v1/patients')!;
      await route.handler(createMockRequest({ query: { 'filter[id]': 'p-1' } }), createResolverContext(deps));

      const filter = JSON.stringify(queryMock.mock.calls[0]![1]);
      expect(filter).toContain('"field":"_id","operator":"eq","value":"p-1"');
      expect(filter).not.toContain('"field":"id"');
    });

    it('an undeclared filter field is a non-retryable 400 INVALID_FILTER', async () => {
      const deps = createMockDeps(parsed);
      (deps.authorizationService.listObjects as ReturnType<typeof vi.fn>).mockResolvedValue(['*']);
      (deps.objectManager.query as ReturnType<typeof vi.fn>).mockRejectedValue(
        new SchemaGuardError('INVALID_FILTER', 'Filter on Patient names undeclared field(s): nope'),
      );

      const route = findRoute(generateRestRoutes(parsed, deps), 'GET', '/api/v1/patients')!;
      const res = await route.handler(createMockRequest({ query: { 'filter[nope]': 'x' } }), createResolverContext(deps));

      expect(res.status).toBe(400);
      const error = (res.body as { error: { code: string; retryable: boolean; message: string } }).error;
      expect(error.code).toBe('INVALID_FILTER');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('nope');
    });

    it('an unknown type from storage is a 404 TYPE_NOT_FOUND', async () => {
      const res = wrapErrorToRest(new SchemaGuardError('TYPE_NOT_FOUND', 'Link type NoSuchLink is not declared'));
      expect(res.status).toBe(404);
      expect((res.body as { error: { retryable: boolean } }).error.retryable).toBe(false);
    });
  });

  describe('GET /api/v1/patients/:id (get by ID)', () => {
    it('returns single patient', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue(patient);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id')!;

      const req = createMockRequest({
        params: { id: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data.id).toBe('p-1');
      expect(body.data.nhsNumber).toBe('NHS-p-1');
      expect(body.data.name).toBe('Patient p-1');
    });

    it('returns 404 for non-existent patient', async () => {
      const deps = createMockDeps(parsed);
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue(null);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id')!;

      const req = createMockRequest({
        params: { id: 'no-such' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(404);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('OBJECT_NOT_FOUND');
      expect(body.error.category).toBe('not_found');
    });

    it('returns 403 when user lacks access', async () => {
      const deps = createMockDeps(parsed);
      const checkMock = deps.authorizationService.check as ReturnType<typeof vi.fn>;
      checkMock.mockResolvedValue(false);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id')!;

      const req = createMockRequest({
        params: { id: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.category).toBe('authorization');
    });
  });

  describe('POST /api/v1/actions/AdmitPatient (execute action)', () => {
    it('executes action and returns result', async () => {
      const deps = createMockDeps(parsed);
      const executeMock = deps.actionExecutor.execute as ReturnType<typeof vi.fn>;
      const actionResult: ActionResult = {
        success: true,
        actionId: 'act_123',
        errors: [],
        affectedObjects: [
          { type: 'Patient', id: 'p-1', changeType: 'updated' },
        ],
      };
      executeMock.mockResolvedValue(actionResult);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'POST', '/api/v1/actions/AdmitPatient')!;

      const req = createMockRequest({
        method: 'POST',
        body: { patient: 'p-1', ward: 'w-1', reason: 'Emergency admission' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(body.data.actionId).toBe('act_123');
      expect(body.data.affectedObjects).toHaveLength(1);
      expect(body.data.affectedObjects[0].typeName).toBe('Patient');
    });

    it('passes correct params to ActionExecutor', async () => {
      const deps = createMockDeps(parsed);
      const executeMock = deps.actionExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValue({
        success: true,
        actionId: 'act_456',
        errors: [],
        affectedObjects: [],
      });

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'POST', '/api/v1/actions/AdmitPatient')!;

      const req = createMockRequest({
        method: 'POST',
        body: { patient: 'p-1', ward: 'w-1' },
      });
      const ctx = createResolverContext(deps);
      await route.handler(req, ctx);

      expect(executeMock).toHaveBeenCalledTimes(1);
      const callArgs = executeMock.mock.calls[0]!;
      const manifest = callArgs[0];
      const params = callArgs[1];
      const actor = callArgs[2];
      expect(manifest.action).toBe('AdmitPatient');
      expect(params).toEqual({ patient: 'p-1', ward: 'w-1' });
      expect(actor.id).toBe('user-1');
      expect(actor.type).toBe('user');
    });
  });

  describe('GET /api/v1/patients/:id/links/:linkType', () => {
    it('returns linked objects', async () => {
      const deps = createMockDeps(parsed);
      const getLinksMock = deps.linkManager.getLinks as ReturnType<typeof vi.fn>;
      const linkPage: LinkPage = {
        items: [
          {
            _tenantId: 'tenant-1',
            _type: 'AdmittedTo',
            _id: 'link-1',
            _fromType: 'Patient',
            _fromId: 'p-1',
            _toType: 'Ward',
            _toId: 'w-1',
            _version: 1,
            _createdAt: '2025-01-01T00:00:00Z',
            _updatedAt: '2025-01-01T00:00:00Z',
          },
        ],
        totalCount: 1,
        hasNextPage: false,
      };
      getLinksMock.mockResolvedValue(linkPage);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id/links/:linkType')!;

      const req = createMockRequest({
        params: { id: 'p-1', linkType: 'AdmittedTo' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]._toId).toBe('w-1');
    });
  });

  describe('GET /api/v1/patients/:id/history', () => {
    it('returns version history', async () => {
      const deps = createMockDeps(parsed);
      const getAtVersionMock = deps.storage.getObjectAtVersion as ReturnType<typeof vi.fn>;

      // Current object has version 3
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue(createPatientObject('p-1', { _version: 3 }));

      getAtVersionMock
        .mockResolvedValueOnce(createPatientObject('p-1', { _version: 1, _updatedAt: '2025-01-01T00:00:00Z' }))
        .mockResolvedValueOnce(createPatientObject('p-1', { _version: 2, _updatedAt: '2025-01-02T00:00:00Z' }))
        .mockResolvedValueOnce(createPatientObject('p-1', { _version: 3, _updatedAt: '2025-01-03T00:00:00Z' }));

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id/history')!;

      const req = createMockRequest({
        params: { id: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(3);
      expect(body.data[0]._version).toBe(1);
      expect(body.data[2]._version).toBe(3);
    });
  });

  describe('POST /api/v1/patients/aggregate (aggregate)', () => {
    it('generates aggregate route for each object type', () => {
      const deps = createMockDeps(parsed);
      const routes = generateRestRoutes(parsed, deps);

      expect(findRoute(routes, 'POST', '/api/v1/patients/aggregate')).toBeDefined();
      expect(findRoute(routes, 'POST', '/api/v1/wards/aggregate')).toBeDefined();
      expect(findRoute(routes, 'POST', '/api/v1/beds/aggregate')).toBeDefined();
      expect(findRoute(routes, 'POST', '/api/v1/consultants/aggregate')).toBeDefined();
    });

    it('calls objectManager.aggregate and returns result', async () => {
      const deps = createMockDeps(parsed);
      // Auth: allow aggregate to proceed
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2']);

      const aggregateMock = vi.fn().mockResolvedValue({
        groups: [{ keys: {}, values: { count: 5 } }],
        totalGroups: 1,
      });
      (deps.objectManager as unknown as Record<string, unknown>).aggregate = aggregateMock;

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'POST', '/api/v1/patients/aggregate')!;

      const req = createMockRequest({
        method: 'POST',
        body: {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          groupBy: ['status'],
        },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data.groups).toHaveLength(1);
      expect(body.data.totalGroups).toBe(1);
      expect(aggregateMock).toHaveBeenCalledTimes(1);

      const callArgs = aggregateMock.mock.calls[0]!;
      expect(callArgs[0]).toBe('Patient');
      expect(callArgs[1].fields).toEqual([{ field: '*', fn: 'count', alias: 'count' }]);
      expect(callArgs[1].groupBy).toEqual(['status']);
    });

    it('passes filter and pagination to aggregate query', async () => {
      const deps = createMockDeps(parsed);
      // Auth: allow aggregate to proceed
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1']);

      const aggregateMock = vi.fn().mockResolvedValue({
        groups: [],
        totalGroups: 0,
      });
      (deps.objectManager as unknown as Record<string, unknown>).aggregate = aggregateMock;

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'POST', '/api/v1/patients/aggregate')!;

      const req = createMockRequest({
        method: 'POST',
        body: {
          fields: [{ field: '*', fn: 'count', alias: 'count' }],
          filter: { field: 'status', operator: 'eq', value: 'ACTIVE' },
          limit: 10,
          offset: 5,
        },
      });
      const ctx = createResolverContext(deps);
      await route.handler(req, ctx);

      const callArgs = aggregateMock.mock.calls[0]!;
      // Filter now includes auth ID filter combined with user filter
      expect(callArgs[1].filter).toBeDefined();
      expect(callArgs[1].filter.and).toBeDefined();
      const userFilter = callArgs[1].filter.and[1];
      expect(userFilter).toEqual({ field: 'status', operator: 'eq', value: 'ACTIVE' });
      expect(callArgs[1].limit).toBe(10);
      expect(callArgs[1].offset).toBe(5);
    });
  });

  describe('error responses', () => {
    it('maps error categories to correct HTTP status codes', () => {
      expect(mapErrorToHttpStatus('validation')).toBe(400);
      expect(mapErrorToHttpStatus('authorization')).toBe(403);
      expect(mapErrorToHttpStatus('consent')).toBe(403);
      expect(mapErrorToHttpStatus('not_found')).toBe(404);
      expect(mapErrorToHttpStatus('conflict')).toBe(409);
      expect(mapErrorToHttpStatus('rate_limit')).toBe(429);
      expect(mapErrorToHttpStatus('quota')).toBe(429);
      expect(mapErrorToHttpStatus('timeout')).toBe(504);
      expect(mapErrorToHttpStatus('system')).toBe(500);
    });

    it('creates REST error response with unified error model', () => {
      const response = createRestErrorResponse({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
        message: 'Patient not found',
        retryable: false,
        details: { type: 'Patient', id: 'p-1' },
        traceId: 'trace-123',
      });
      const body = response.body as AnyBody;

      expect(response.status).toBe(404);
      expect(body.error.code).toBe('OBJECT_NOT_FOUND');
      expect(body.error.category).toBe('not_found');
      expect(body.error.message).toBe('Patient not found');
      expect(body.error.retryable).toBe(false);
      expect(body.error.details).toEqual({ type: 'Patient', id: 'p-1' });
      expect(body.error.traceId).toBe('trace-123');
      expect(body.error.timestamp).toBeDefined();
    });

    it('handles unknown errors with 500 status', async () => {
      const deps = createMockDeps(parsed);
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockRejectedValue(new Error('Database connection failed'));

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id')!;

      const req = createMockRequest({
        params: { id: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.category).toBe('system');
    });

    it('handles action errors with correct status', async () => {
      const deps = createMockDeps(parsed);
      const executeMock = deps.actionExecutor.execute as ReturnType<typeof vi.fn>;
      const err = new Error('Validation failed') as Error & { code: string };
      err.code = 'VALIDATION_ERROR';
      executeMock.mockRejectedValue(err);

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'POST', '/api/v1/actions/AdmitPatient')!;

      const req = createMockRequest({
        method: 'POST',
        body: { patient: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('field-level redaction via REST', () => {
    it('redacts unauthorized fields', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const redactMock = deps.authorizationService.redactFields as ReturnType<typeof vi.fn>;
      redactMock.mockImplementation(
        (_userId: string, _roles: string[], _type: string, obj: Record<string, unknown>) => ({
          data: {
            ...obj,
            dateOfBirth: null,
            nhsNumber: null,
          },
          _redactedFields: ['dateOfBirth', 'nhsNumber'],
        }),
      );

      const routes = generateRestRoutes(parsed, deps);
      const route = findRoute(routes, 'GET', '/api/v1/patients/:id')!;

      const req = createMockRequest({
        params: { id: 'p-1' },
      });
      const ctx = createResolverContext(deps);
      const res = await route.handler(req, ctx);
      const body = res.body as AnyBody;

      expect(res.status).toBe(200);
      expect(body.data.dateOfBirth).toBeNull();
      expect(body.data.nhsNumber).toBeNull();
      expect(body.data._redactedFields).toEqual(['dateOfBirth', 'nhsNumber']);
    });
  });
});
