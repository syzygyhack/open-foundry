/**
 * REST search: how the `fields` parameter is read.
 *
 * Repeating the parameter (?fields=a&fields=b) arrives as an array, which
 * was ignored, so the default fields were searched instead of the ones
 * named. Every occurrence is now read, comma-separated as before; an empty
 * `fields=` still names none.
 */

import { describe, it, expect } from 'vitest';
import { parseOdl } from '@openfoundry/odl';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ObjectManager, EngineEventEmitter } from '@openfoundry/engine';
import { generateRestRoutes } from '../rest/route-generator.js';
import { generateResolvers } from '../graphql/resolver-generator.js';
import { generateOpenApiSpec } from '../rest/openapi.js';
import { toOntologySchema } from '../schema-loader.js';
import type { ApiDependencies, AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

const rctx = { tenantId: 't1', actorId: 'alice', traceId: 'trace-1' };

const ODL = `
extend schema @namespace(name: "test.searchfields", version: "0.1.0")
type Ward @objectType {
  id: ID! @primary
  name: String!
  wing: String
  note: String
}
`;

async function setup() {
  const parsed = parseOdl(ODL);
  const storage = new MemoryStorageProvider();
  await storage.applySchema(rctx, toOntologySchema(parsed));
  const emitter = new EngineEventEmitter({ publish: async () => undefined } as never);
  const objectManager = new ObjectManager({ storage, schema: parsed, eventEmitter: emitter });
  await objectManager.create('Ward', { name: 'North', wing: 'East', note: 'findme in note' }, rctx);
  await objectManager.create('Ward', { name: 'findme', wing: 'West', note: 'x' }, rctx);
  await objectManager.create('Ward', { name: 'South', wing: 'findme', note: 'x' }, rctx);
  const deps = {
    schema: parsed,
    objectManager,
    authorizationService: {
      listObjects: async () => ['*'],
      getVisibleFields: () => undefined,
      redactFieldsBatch: (_u: string, _r: string[], _t: string, objs: unknown[]) => objs.map((data) => ({ data, _redactedFields: [] })),
    },
  } as unknown as ApiDependencies;
  const user: AuthenticatedUserInfo = { id: 'alice', name: 'A', email: 'a@x', roles: [], groups: [], tenantId: 't1' };
  const ctx: ResolverContext = { requestContext: rctx, user, deps };
  const gqlSearch = generateResolvers(parsed, deps).resolvers['Query']!['searchWards'] as (
    p: unknown, a: Record<string, unknown>, c: ResolverContext,
  ) => Promise<{ hits: unknown[]; hasNextPage: boolean; totalCount: number }>;
  const route = generateRestRoutes(parsed, deps).find((r) => r.method === 'GET' && r.pattern.endsWith('/search'))!;
  const raw = async (query: Record<string, string | string[] | undefined>) =>
    route.handler({ method: 'GET', path: '/', params: {}, query, body: undefined, user }, ctx);
  const rest = async (fields: string | string[] | undefined) => {
    const query: Record<string, string | string[] | undefined> = { q: 'findme' };
    if (fields !== undefined) query['fields'] = fields;
    const res = await route.handler({ method: 'GET', path: '/', params: {}, query, body: undefined, user }, ctx);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as { data: Array<{ node: Record<string, unknown> }> }).data.map((h) => h.node['name']).sort();
  };
  return Object.assign(rest, { parsed, raw, graphql: (args: Record<string, unknown>) => gqlSearch(undefined, { query: 'findme', ...args }, ctx) });
}

describe('REST search fields parameter', () => {
  it('a repeated fields parameter searches every field it names, and only those', async () => {
    const search = await setup();
    expect(await search(['name', 'wing'])).toEqual(['South', 'findme']);
    expect(await search(['name,note', 'wing'])).toEqual(['North', 'South', 'findme']);
  });

  it('one comma-separated parameter, an empty one and none behave as before', async () => {
    const search = await setup();
    expect(await search('name,wing')).toEqual(['South', 'findme']);
    expect(await search('note')).toEqual(['North']);
    const all = ['North', 'South', 'findme'];
    expect(await search('')).toEqual(all);
    expect(await search(undefined)).toEqual(all);
  });
});

describe('GraphQL search first', () => {
  it('a negative first is a page of none that still counts the hits', async () => {
    const search = await setup();
    // A negative LIMIT: a slice from the end on memory, an error on PostgreSQL.
    const page = await search.graphql({ first: -1 });
    expect(page.hits).toHaveLength(0);
    expect(page.totalCount).toBe(3);
    expect(page.hasNextPage).toBe(true);
    expect((await search.graphql({ first: 2 })).hits).toHaveLength(2);
  });
});

describe('OpenAPI search route', () => {
  it('documents the parameters the route reads and the keys it returns', async () => {
    const search = await setup();
    const spec = generateOpenApiSpec(search.parsed) as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: Record<string, unknown> }> } }>;
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const op = spec.paths['/api/v1/wards/search']!.get;
    expect(op.parameters.map((p) => p.name).sort()).toEqual(['fields', 'limit', 'offset', 'q']);
    const limit = op.parameters.find((p) => p.name === 'limit')!.schema;
    expect(limit).toMatchObject({ default: 20, maximum: 100 });

    const res = await search.raw({ q: 'findme', limit: '1', offset: '1' });
    const body = res.body as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    expect(Object.keys(body.pagination).sort()).toEqual(Object.keys(spec.components.schemas['Pagination']!.properties).sort());
    expect(Object.keys(body.data[0]!).sort()).toEqual(['node', 'score']);
    expect(body.pagination).toMatchObject({ limit: 1, offset: 1, totalCount: 3, hasNextPage: true, hasPreviousPage: true });
    // 0 is the default, not an empty page.
    expect((await search.raw({ q: 'findme', limit: '0' })).body).toMatchObject({ pagination: { limit: 20 } });
  });
});
