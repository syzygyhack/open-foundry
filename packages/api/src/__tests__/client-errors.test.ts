/**
 * What a client is told about a thrown error, on REST and GraphQL.
 *
 * Only a platform error keeps its code, message and details: a PlatformError
 * (the engine's and the object-set stores' structured errors, SchemaGuardError,
 * OpenFoundryError), or an Error carrying one of the spec's well-known codes.
 * A database, runtime or SDK error is INTERNAL_ERROR with a generic message.
 * GraphQL also sets extensions.code, where Apollo would otherwise put
 * INTERNAL_SERVER_ERROR for every Open Foundry error. The throw shapes here
 * are the real ones: the stores and providers are called, not imitated.
 */

import { describe, it, expect } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { parseOdl } from '@openfoundry/odl';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ObjectManager, EngineEventEmitter, InMemoryObjectSetStore, ObjectSetManager } from '@openfoundry/engine';
import { AuthorizationError, ConsentError } from '@openfoundry/security';
import { OpenFoundryError } from '@openfoundry/spi';
import { createOpenFoundryError, wrapError } from '../graphql/errors.js';
import { wrapErrorToRest } from '../rest/errors.js';
import { generateRestRoutes } from '../rest/route-generator.js';
import { toOntologySchema } from '../schema-loader.js';
import type { ApiDependencies, AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

const rctx = { tenantId: 't1', actorId: 'alice', traceId: 'trace-1' };

async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

interface Envelope { status: number; code: string; category: string; message: string; retryable: boolean; details: unknown }

function rest(err: unknown): Envelope {
  const res = wrapErrorToRest(err, 'trace-1');
  const e = (res.body as { error: Omit<Envelope, 'status'> }).error;
  return { status: res.status, ...e };
}

function graphql(err: unknown) {
  const e = wrapError(err, 'trace-1');
  return { message: e.message, code: e.extensions['code'], of: e.extensions['openfoundry'] as Record<string, unknown> };
}

const ODL = `
extend schema @namespace(name: "test.errors", version: "0.1.0")
type Patient @objectType {
  id: ID! @primary
  name: String!
}
`;

async function provider() {
  const parsed = parseOdl(ODL);
  const storage = new MemoryStorageProvider();
  await storage.applySchema(rctx, toOntologySchema(parsed));
  return { parsed, storage };
}

describe('client errors: platform errors keep their code, others are internal', () => {
  it('an object-set store error (a plain PlatformError object) keeps its code, category and message', async () => {
    const store = new InMemoryObjectSetStore();
    const missing = await thrown(() => store.update(rctx, 'nope', { name: 'x' }));
    expect(rest(missing)).toMatchObject({ status: 404, code: 'OBJECT_SET_NOT_FOUND', category: 'not_found', retryable: false, message: 'Object set nope not found' });
    expect(graphql(missing)).toMatchObject({ code: 'OBJECT_SET_NOT_FOUND', message: 'Object set nope not found', of: { code: 'OBJECT_SET_NOT_FOUND', category: 'not_found' } });

    const set = await store.create(rctx, { name: 's', objectType: 'Patient', createdBy: 'alice', isPublic: true, tenantId: 't1' } as never);
    const notMine = await thrown(() => store.delete({ ...rctx, actorId: 'bob' }, set.id));
    expect(rest(notMine)).toMatchObject({ status: 403, code: 'FORBIDDEN', category: 'authorization' });
    expect(rest(notMine).message).toContain('Only the creator');

    // An Error with a code outside the well-known list, as the store threw it,
    // was an internal 500; it is now a platform error.
    const anonymous = await thrown(() => store.create({ tenantId: 't1' }, { name: 's', objectType: 'Patient', isPublic: true } as never));
    expect(rest(anonymous)).toMatchObject({ status: 403, code: 'UNAUTHENTICATED', category: 'authorization', retryable: false });
  });

  it('a REST saved-set update of a missing set is 404, not a retryable 500', async () => {
    const { parsed, storage } = await provider();
    const emitter = new EngineEventEmitter({ publish: async () => undefined } as never);
    const objectManager = new ObjectManager({ storage, schema: parsed, eventEmitter: emitter });
    const deps = {
      schema: parsed,
      objectManager,
      objectSetManager: new ObjectSetManager(new InMemoryObjectSetStore(), objectManager),
      authorizationService: {},
    } as unknown as ApiDependencies;
    const user: AuthenticatedUserInfo = { id: 'alice', name: 'A', email: 'a@x', roles: [], groups: [], tenantId: 't1' };
    const ctx: ResolverContext = { requestContext: rctx, user, deps };
    const put = generateRestRoutes(parsed, deps).find((r) => r.method === 'PUT' && r.pattern === '/api/v1/object-sets/:id')!;
    const res = await put.handler({ method: 'PUT', path: '/', params: { id: 'nope' }, query: {}, body: { name: 'x' }, user }, ctx);
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: 'OBJECT_SET_NOT_FOUND', retryable: false });
  });

  it('provider errors: a version conflict is 409 and an undeclared type 404', async () => {
    const { storage } = await provider();
    const p = await storage.createObject(rctx, 'Patient', { name: 'A' });
    const conflict = await thrown(() => storage.updateObject(rctx, 'Patient', p._id, { name: 'B' }, p._version + 5));
    expect(rest(conflict)).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', category: 'conflict', retryable: false });
    const undeclared = await thrown(() => storage.getObject(rctx, 'Nope', 'x'));
    expect(rest(undeclared)).toMatchObject({ status: 404, code: 'TYPE_NOT_FOUND', category: 'not_found' });
    expect(graphql(undeclared)).toMatchObject({ code: 'TYPE_NOT_FOUND', of: { category: 'not_found' } });
  });

  it('a well-known code on a plain Error is kept; a consent denial is 403', async () => {
    expect(rest(Object.assign(new Error('bad field'), { code: 'VALIDATION_ERROR' }))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'bad field' });
    expect(rest(new ConsentError('CONSENT_DENIED', 'no consent'))).toMatchObject({ status: 403, code: 'CONSENT_DENIED', category: 'consent' });
  });

  it('database, Node and SDK error codes are not passed on', async () => {
    const urlError = await thrown(() => new URL('not a url'));
    const cases: unknown[] = [
      Object.assign(new Error('column "x" does not exist'), { code: '42703', severity: 'ERROR' }),
      urlError,
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' }),
      new AuthorizationError('CHECK_FAILED', 'OpenFGA unreachable at http://openfga:8080'),
      { code: 'X', message: 'not a platform error: no category' },
      new GraphQLError('upstream: relation "t" does not exist', { extensions: { code: 'UPSTREAM_DB' } }),
      new GraphQLError('upstream database failure', { extensions: { code: 'UPSTREAM_DB', openfoundry: { code: 'UPSTREAM_DB' } } }),
      new Error('boom'),
    ];
    expect((urlError as { code?: string }).code).toBe('ERR_INVALID_URL');
    // The API's own errors pass as they are.
    const own = createOpenFoundryError({ code: 'FORBIDDEN', category: 'authorization', message: 'no', retryable: false });
    expect(wrapError(own)).toBe(own);
    for (const err of cases) {
      expect(rest(err), String(err)).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', category: 'system', retryable: true, message: 'An internal error occurred', details: {} });
      expect(graphql(err)).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An internal error occurred' });
    }
  });

  it('a system-category platform error keeps its code but not its message or details', async () => {
    const err = new OpenFoundryError({ code: 'PROVIDER_ERROR', category: 'system', message: 'pool exhausted at 10.0.0.5', retryable: true, details: { host: '10.0.0.5' } });
    expect(rest(err)).toMatchObject({ status: 500, code: 'PROVIDER_ERROR', message: 'An internal error occurred', details: {} });
  });
});

describe('GraphQL error codes as Apollo Server returns them', () => {
  const typeDefs = `type Query { forbidden: String, invalid: String, unknown: String, database: String }`;
  const resolvers = {
    Query: {
      forbidden: () => {
        throw createOpenFoundryError({ code: 'FORBIDDEN', category: 'authorization', message: 'no', retryable: false });
      },
      invalid: () => {
        throw wrapError(Object.assign(new Error('bad field'), { code: 'VALIDATION_ERROR' }));
      },
      unknown: () => {
        throw wrapError(new Error('boom'));
      },
      database: () => {
        throw wrapError(Object.assign(new Error('column "x" does not exist'), { code: '42703', severity: 'ERROR' }));
      },
    },
  };

  async function errorOf(field: string) {
    const server = new ApolloServer({ typeDefs, resolvers });
    const res = await server.executeOperation({ query: `{ ${field} }` });
    await server.stop();
    if (res.body.kind !== 'single') throw new Error('expected a single result');
    return res.body.singleResult.errors?.[0];
  }

  it('extensions.code mirrors openfoundry.code', async () => {
    const forbidden = await errorOf('forbidden');
    expect(forbidden?.extensions?.['code']).toBe('FORBIDDEN');
    expect(forbidden?.extensions?.['openfoundry']).toMatchObject({ code: 'FORBIDDEN', category: 'authorization', retryable: false });
    const invalid = await errorOf('invalid');
    expect(invalid?.extensions?.['code']).toBe('VALIDATION_ERROR');
    expect(invalid?.message).toBe('bad field');
  });

  it('an internal or database error is INTERNAL_ERROR with the generic message', async () => {
    for (const field of ['unknown', 'database']) {
      const err = await errorOf(field);
      expect(err?.extensions?.['code'], field).toBe('INTERNAL_ERROR');
      expect(err?.extensions?.['openfoundry']).toMatchObject({ code: 'INTERNAL_ERROR', category: 'system', retryable: true });
      expect(err?.message).toBe('An internal error occurred');
    }
  });
});
