/**
 * Filters and schema errors end to end: generated REST routes and GraphQL
 * resolvers over a real ObjectManager/LinkManager and the memory provider, so
 * what is pinned is what a client sees, not what a mock returns.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ObjectManager, LinkManager, EngineEventEmitter } from '@openfoundry/engine';
import type { OntologyObject } from '@openfoundry/spi';
import { generateRestRoutes } from '../rest/route-generator.js';
import { generateResolvers } from '../graphql/resolver-generator.js';
import { toOntologySchema } from '../schema-loader.js';
import type { RestRequest, RestRoute } from '../rest/types.js';
import type { ApiDependencies, AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

const ODL = `
extend schema @namespace(name: "test.filters", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  name: String!
  status: String
}

type Ward @objectType {
  id: ID! @primary
  name: String!
}

type Badge @objectType {
  _recordId: ID! @primary
  name: String!
  label: String @computed(fn: "badgeLabel")
}

type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_MANY) {
  id: ID! @primary
}
`;

const USER: AuthenticatedUserInfo = {
  id: 'user-1',
  name: 'Tester',
  email: 't@example.org',
  roles: ['clinician'],
  groups: [],
  tenantId: 'tenant-1',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBody = any;

describe('filters and schema errors, end to end on the memory provider', () => {
  let parsed: ParsedSchema;
  let deps: ApiDependencies;
  let ctx: ResolverContext;
  let alice: OntologyObject;

  beforeEach(async () => {
    parsed = parseOdl(ODL);
    const storage = new MemoryStorageProvider();
    const requestContext = { tenantId: USER.tenantId, actorId: USER.id, traceId: 'trace-test' };
    await storage.applySchema(requestContext, toOntologySchema(parsed));
    const emitter = new EngineEventEmitter({ publish: async () => undefined } as never);
    const objectManager = new ObjectManager({ storage, schema: parsed, eventEmitter: emitter });
    const linkManager = new LinkManager({ storage, schema: parsed, eventEmitter: emitter });
    deps = {
      schema: parsed,
      objectManager,
      linkManager,
      authorizationService: {
        check: vi.fn().mockResolvedValue(true),
        listObjects: vi.fn().mockResolvedValue(['*']),
        getVisibleFields: vi.fn().mockReturnValue(undefined),
        redactFields: vi.fn((_u: string, _r: string[], _t: string, data: Record<string, unknown>) => ({
          data,
          _redactedFields: [],
        })),
        redactFieldsBatch: vi.fn((_u: string, _r: string[], _t: string, objs: Record<string, unknown>[]) =>
          objs.map((data) => ({ data, _redactedFields: [] })),
        ),
        clearFieldCache: vi.fn(),
      },
    } as unknown as ApiDependencies;
    ctx = { requestContext, user: USER, deps };
    alice = await storage.createObject(requestContext, 'Patient', { name: 'Alice', status: 'ACTIVE' });
    await storage.createObject(requestContext, 'Patient', { name: 'Bob', status: 'ACTIVE' });
  });

  function route(method: string, pattern: string): RestRoute {
    const r = generateRestRoutes(parsed, deps).find((x) => x.method === method && x.pattern === pattern);
    if (!r) throw new Error(`no route ${method} ${pattern}`);
    return r;
  }

  function request(overrides: Partial<RestRequest>): RestRequest {
    return { method: 'GET', path: '/', params: {}, query: {}, body: undefined, user: USER, ...overrides };
  }

  it('REST filter[id] finds the object by its primary key', async () => {
    const res = await route('GET', '/api/v1/patients').handler(request({ query: { 'filter[id]': alice._id } }), ctx);
    expect(res.status).toBe(200);
    expect((res.body as AnyBody).data).toHaveLength(1);
  });

  it('GraphQL filter {id: {eq}} finds the object by its primary key', async () => {
    const { resolvers } = generateResolvers(parsed, deps) as AnyBody;
    const conn = await resolvers.Query.patients(undefined, { filter: { id: { eq: alice._id } } }, ctx);
    expect(conn.edges).toHaveLength(1);
    expect(conn.totalCount).toBe(1);
  });

  it('REST aggregate with a filter on the primary field counts the object', async () => {
    const res = await route('POST', '/api/v1/patients/aggregate').handler(
      request({
        method: 'POST',
        body: { fields: [{ field: '*', fn: 'COUNT', alias: 'n' }], filter: { field: 'id', operator: 'eq', value: alice._id } },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify((res.body as AnyBody).data)).toContain('"n":1');
  });

  it('REST aggregate orderBy on an output alias spelled like the primary field sorts by the alias', async () => {
    const extra = await deps.objectManager.create('Patient', { name: 'Cy', status: 'DISCHARGED' }, ctx.requestContext);
    expect(extra).toBeTruthy();
    const res = await route('POST', '/api/v1/patients/aggregate').handler(
      request({
        method: 'POST',
        body: {
          fields: [{ field: '*', fn: 'COUNT', alias: 'id' }],
          groupBy: ['status'],
          orderBy: [{ field: 'id', direction: 'asc' }],
        },
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const groups = JSON.stringify((res.body as AnyBody).data);
    // DISCHARGED (1) sorts before ACTIVE (2), against the order groups are
    // first seen in.
    expect(groups.indexOf('DISCHARGED')).toBeGreaterThan(-1);
    expect(groups.indexOf('DISCHARGED')).toBeLessThan(groups.indexOf('ACTIVE'));
  });

  it('field restrictions are checked on the names the client sent, before the primary-field mapping', async () => {
    (deps.authorizationService.getVisibleFields as ReturnType<typeof vi.fn>).mockReturnValue(new Set(['name', 'status']));
    const res = await route('GET', '/api/v1/patients').handler(request({ query: { 'filter[id]': alice._id } }), ctx);
    expect(res.status).toBe(403);
    const { resolvers } = generateResolvers(parsed, deps) as AnyBody;
    await expect(
      resolvers.Query.patients(undefined, { filter: { id: { eq: alice._id } } }, ctx),
    ).rejects.toMatchObject({ extensions: { openfoundry: { code: 'FORBIDDEN', retryable: false } } });
  });

  describe('saved object sets and field restrictions', () => {
    const savedSet = (over: Record<string, unknown>) => {
      (deps as unknown as Record<string, unknown>)['objectSetManager'] = {
        get: vi.fn(async () => ({
          id: 'set-1',
          name: 'set',
          objectType: 'Patient',
          createdBy: USER.id,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          isPublic: false,
          tenantId: USER.tenantId,
          ...over,
        })),
      };
    };
    const restrict = (...visible: string[]) =>
      (deps.authorizationService.getVisibleFields as ReturnType<typeof vi.fn>).mockReturnValue(new Set(visible));
    const execute = () =>
      route('GET', '/api/v1/object-sets/:id/execute').handler(request({ params: { id: 'set-1' } }), ctx);
    const aggregate = () =>
      route('GET', '/api/v1/object-sets/:id/aggregate').handler(request({ params: { id: 'set-1' } }), ctx);

    it('a saved filter on the primary field finds the object', async () => {
      savedSet({ filter: { field: 'id', operator: 'eq', value: alice._id } });
      const res = await execute();
      expect(res.status).toBe(200);
      expect((res.body as AnyBody).data).toHaveLength(1);
    });

    it('a saved filter or sort on a field the caller cannot see is refused', async () => {
      restrict('name');
      savedSet({ filter: { field: 'id', operator: 'eq', value: alice._id } });
      expect((await execute()).status).toBe(403);
      savedSet({ filter: { field: 'status', operator: 'eq', value: 'ACTIVE' } });
      expect((await execute()).status).toBe(403);
      savedSet({ orderBy: [{ field: 'status', direction: 'asc' }] });
      expect((await execute()).status).toBe(403);
      savedSet({ filter: { field: 'name', operator: 'eq', value: 'Alice' } });
      expect((await execute()).status).toBe(200);
    });

    it('a hidden field cannot be reached by nesting or by its storage name', async () => {
      restrict('name');
      // A node with `field` but no `operator` is a logical node to storage.
      savedSet({ filter: { field: 'name', and: [{ field: 'status', operator: 'eq', value: 'ACTIVE' }] } });
      expect((await execute()).status).toBe(403);
      // _id is the primary field (id) under its storage name.
      savedSet({ filter: { field: '_id', operator: 'eq', value: alice._id } });
      expect((await execute()).status).toBe(403);
      const res = await route('GET', '/api/v1/patients').handler(request({ query: { 'filter[_id]': alice._id } }), ctx);
      expect(res.status).toBe(403);
    });

    it('a primary field named with a leading underscore is not exempt as a system field', async () => {
      restrict('name');
      const badge = await deps.objectManager.create('Badge', { name: 'B' }, ctx.requestContext);
      for (const key of ['filter[_recordId]', 'filter[_id]']) {
        const res = await route('GET', '/api/v1/badges').handler(request({ query: { [key]: badge._id } }), ctx);
        expect(res.status, key).toBe(403);
      }
      const { resolvers } = generateResolvers(parsed, deps) as AnyBody;
      await expect(
        resolvers.Query.badges(undefined, { filter: { _recordId: { eq: badge._id } } }, ctx),
      ).rejects.toBeInstanceOf(Error);
      // System fields stay usable.
      const live = await route('GET', '/api/v1/badges').handler(request({ query: { 'filter[_deleted_at]': '' } }), ctx);
      expect(live.status).not.toBe(403);
    });

    it('search under field restrictions: named fields are checked, default fields are visible text properties', async () => {
      restrict('name');
      const badge = await deps.objectManager.create('Badge', { name: 'Findme' }, ctx.requestContext);
      expect(badge).toBeTruthy();
      for (const f of ['_recordId', '_id']) {
        const res = await route('GET', '/api/v1/badges/search').handler(request({ query: { q: 'x', fields: f } }), ctx);
        expect(res.status, f).toBe(403);
      }
      // No fields named: the visible text properties only (not the primary,
      // which is stored as _id, not as a column).
      const spy = vi.spyOn(deps.objectManager, 'search');
      const res = await route('GET', '/api/v1/badges/search').handler(request({ query: { q: 'Findme' } }), ctx);
      expect(res.status).toBe(200);
      expect(spy.mock.calls[0]![1]).toMatchObject({ fields: ['name'] });
      // Even with the primary visible, it is not a column to search.
      restrict('name', '_recordId');
      await route('GET', '/api/v1/badges/search').handler(request({ query: { q: 'Findme' } }), ctx);
      expect(spy.mock.calls[1]![1]).toMatchObject({ fields: ['name'] });
      restrict('name', 'id');
      await route('GET', '/api/v1/patients/search').handler(request({ query: { q: 'Alice' } }), ctx);
      expect(spy.mock.calls[2]![1]).toMatchObject({ fields: ['name'] });
      // A visible @computed field has no column either.
      restrict('name', 'label');
      await route('GET', '/api/v1/badges/search').handler(request({ query: { q: 'Findme' } }), ctx);
      expect(spy.mock.calls[3]![1]).toMatchObject({ fields: ['name'] });
      spy.mockRestore();
      // GraphQL: a named system field outside the visible set is refused
      // before storage (it would be a text match on a non-text column).
      restrict('name');
      const { resolvers } = generateResolvers(parsed, deps) as AnyBody;
      // Refused as an authorization error (FORBIDDEN, not retryable), as REST
      // answers 403.
      const forbidden = { extensions: { openfoundry: { code: 'FORBIDDEN', retryable: false } } };
      for (const f of ['_version', '_recordId']) {
        await expect(
          resolvers.Query.searchBadges(undefined, { query: 'x', fields: [f] }, ctx),
          f,
        ).rejects.toMatchObject(forbidden);
      }
      await expect(
        resolvers.Query.badges(undefined, { filter: { _recordId: { eq: 'x' } } }, ctx),
      ).rejects.toMatchObject(forbidden);
    });

    it('an aggregate sorted by its own output alias is allowed under field restrictions', async () => {
      restrict('status');
      const res = await route('POST', '/api/v1/patients/aggregate').handler(
        request({
          method: 'POST',
          body: {
            fields: [{ field: '*', fn: 'COUNT', alias: 'total' }],
            groupBy: ['status'],
            orderBy: [{ field: 'total', direction: 'desc' }],
          },
        }),
        ctx,
      );
      expect(res.status).toBe(200);
      savedSet({
        aggregation: {
          fields: [{ field: '*', fn: 'count' }],
          groupBy: ['status'],
          orderBy: [{ field: 'count_*', direction: 'desc' }],
        },
      });
      expect((await aggregate()).status).toBe(200);
    });

    it('an aggregate sorted by a restricted field, or an alias spelled like one, is refused', async () => {
      restrict('status');
      const body = (alias: string, sort: string) => ({
        fields: [{ field: '*', fn: 'COUNT', alias }],
        groupBy: ['status'],
        orderBy: [{ field: sort, direction: 'desc' }],
      });
      const post = (b: unknown) =>
        route('POST', '/api/v1/patients/aggregate').handler(request({ method: 'POST', body: b }), ctx);
      expect((await post(body('total', 'name'))).status).toBe(403);
      expect((await post(body('name', 'name'))).status).toBe(403);
    });
  });

  it('REST filter on an undeclared field is 400 INVALID_FILTER, not retryable', async () => {
    const res = await route('GET', '/api/v1/patients').handler(request({ query: { 'filter[nope]': 'x' } }), ctx);
    expect(res.status).toBe(400);
    const error = (res.body as AnyBody).error;
    expect(error.code).toBe('INVALID_FILTER');
    expect(error.retryable).toBe(false);
  });

  it('REST links of an undeclared link type is 404 TYPE_NOT_FOUND', async () => {
    const res = await route('GET', '/api/v1/patients/:id/links/:linkType').handler(
      request({ params: { id: alice._id, linkType: 'NoSuchLink' } }),
      ctx,
    );
    expect(res.status).toBe(404);
    const error = (res.body as AnyBody).error;
    expect(error.code).toBe('TYPE_NOT_FOUND');
    expect(error.retryable).toBe(false);
  });
});
