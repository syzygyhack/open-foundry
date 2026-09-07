/**
 * Tests for WebSocket subscriptions (Section 8.1.4).
 *
 * Validates:
 * - SubscriptionManager bridges CloudEvents to PubSub
 * - fooChanged(id) filters by object ID
 * - foosChanged(filter) delivers type-level change events
 * - Authentication required for WebSocket connections
 * - Event-to-subscription mapping from CloudEvent types
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PubSub } from 'graphql-subscriptions';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import type { CloudEvent } from '@openfoundry/spi';
import type { ObjectEventData, LinkEventData } from '@openfoundry/engine';
import {
  SubscriptionManager,
  InMemorySubscribableEventBus,
  mapObjectEvent,
  mapLinkEvent,
  createIdFilteredSubscription,
  createFilteredSubscription,
} from '../subscriptions/subscription-manager.js';
import type {
  ChangeEvent,
} from '../subscriptions/subscription-manager.js';
import { generateResolvers } from '../graphql/resolver-generator.js';
import type { ApiDependencies, AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';

// ─── Fixtures ───

const NHS_ACUTE_ODL = `
extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
}

enum PatientStatus {
  ACTIVE
  DISCHARGED
  DECEASED
  TRANSFERRED
}

type Ward @objectType {
  id: ID! @primary
  name: String! @indexed
  specialty: String!
  capacity: Int! @constraint(expr: "value > 0")
}

type DischargePatient @actionType {
  patient: Patient! @param
  destination: String! @param
}
`;

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

function createObjectUpdatedEvent(
  objectType: string,
  objectId: string,
  overrides: Partial<ObjectEventData> = {},
): CloudEvent<ObjectEventData> {
  return {
    specversion: '1.0',
    id: `evt-${Date.now()}`,
    source: 'openfoundry://engine/ontology',
    type: 'openfoundry.object.updated',
    subject: `${objectType}/${objectId}`,
    time: '2025-01-15T10:30:00Z',
    datacontenttype: 'application/json',
    data: {
      objectType,
      objectId,
      version: 2,
      changes: { status: { old: 'ACTIVE', new: 'DISCHARGED' } },
      causedBy: { actionType: 'DischargePatient', actionId: 'act-1', actor: 'user:user-1' },
      ...overrides,
    },
  };
}

function createObjectCreatedEvent(
  objectType: string,
  objectId: string,
): CloudEvent<ObjectEventData> {
  return {
    specversion: '1.0',
    id: `evt-${Date.now()}`,
    source: 'openfoundry://engine/ontology',
    type: 'openfoundry.object.created',
    subject: `${objectType}/${objectId}`,
    time: '2025-01-15T10:30:00Z',
    datacontenttype: 'application/json',
    data: {
      objectType,
      objectId,
      version: 1,
      causedBy: { actionType: 'AdmitPatient', actionId: 'act-2', actor: 'user:user-1' },
    },
  };
}

function createLinkCreatedEvent(
  linkType: string,
  linkId: string,
  fromId: string,
  toId: string,
): CloudEvent<LinkEventData> {
  return {
    specversion: '1.0',
    id: `evt-${Date.now()}`,
    source: 'openfoundry://engine/ontology',
    type: 'openfoundry.link.created',
    subject: `${linkType}/${linkId}`,
    time: '2025-01-15T10:30:00Z',
    datacontenttype: 'application/json',
    data: {
      linkType,
      linkId,
      fromId,
      toId,
      version: 1,
      causedBy: { actionType: 'AdmitPatient', actionId: 'act-3' },
    },
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
    linkManager: {} as unknown as ApiDependencies['linkManager'],
    actionExecutor: {
      execute: vi.fn(),
    } as unknown as ApiDependencies['actionExecutor'],
    authorizationService: {
      check: vi.fn().mockResolvedValue(true),
      listObjects: vi.fn().mockResolvedValue([]),
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

function createMockContext(
  deps: ApiDependencies,
  user?: AuthenticatedUserInfo,
): ResolverContext {
  const u = user ?? createMockUser();
  return {
    requestContext: { tenantId: u.tenantId, actorId: u.id, traceId: 'test-trace' },
    user: u,
    deps,
  };
}

// ─── Tests ───

describe('CloudEvent to ChangeEvent mapping', () => {
  it('maps object.updated to UPDATED ChangeEvent', () => {
    const event = createObjectUpdatedEvent('Patient', 'p-1');
    const result = mapObjectEvent(event);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('patientChanged');
    expect(result!.changeEvent.changeType).toBe('UPDATED');
    expect(result!.changeEvent.object.id).toBe('p-1');
    expect(result!.changeEvent.object._type).toBe('Patient');
    expect(result!.changeEvent.previousValues).toEqual({
      status: { old: 'ACTIVE', new: 'DISCHARGED' },
    });
    expect(result!.changeEvent.causedBy).toEqual({
      actionType: 'DischargePatient',
      actionId: 'act-1',
    });
    expect(result!.changeEvent.timestamp).toBe('2025-01-15T10:30:00Z');
  });

  it('maps object.created to CREATED ChangeEvent', () => {
    const event = createObjectCreatedEvent('Patient', 'p-2');
    const result = mapObjectEvent(event);

    expect(result).not.toBeNull();
    expect(result!.topic).toBe('patientChanged');
    expect(result!.changeEvent.changeType).toBe('CREATED');
    expect(result!.changeEvent.object.id).toBe('p-2');
    expect(result!.changeEvent.previousValues).toBeNull();
  });

  it('maps object.deleted to DELETED ChangeEvent', () => {
    const event: CloudEvent<ObjectEventData> = {
      specversion: '1.0',
      id: 'evt-del',
      source: 'openfoundry://engine/ontology',
      type: 'openfoundry.object.deleted',
      subject: 'Patient/p-3',
      time: '2025-01-15T11:00:00Z',
      data: {
        objectType: 'Patient',
        objectId: 'p-3',
        version: 5,
      },
    };
    const result = mapObjectEvent(event);

    expect(result).not.toBeNull();
    expect(result!.changeEvent.changeType).toBe('DELETED');
    expect(result!.changeEvent.object.id).toBe('p-3');
  });

  it('returns null for unknown event types', () => {
    const event: CloudEvent<ObjectEventData> = {
      specversion: '1.0',
      id: 'evt-unknown',
      source: 'openfoundry://engine/ontology',
      type: 'openfoundry.action.completed',
      time: '2025-01-15T11:00:00Z',
      data: {
        objectType: 'Patient',
        objectId: 'p-1',
        version: 1,
      },
    };
    const result = mapObjectEvent(event);
    expect(result).toBeNull();
  });

  it('maps link.created to change notifications for both endpoints', () => {
    const event = createLinkCreatedEvent('PatientInWard', 'link-1', 'p-1', 'w-1');
    const result = mapLinkEvent(event);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.objectId).toBe('p-1');
    expect(result![1]!.objectId).toBe('w-1');
  });

  it('returns null for non-link event types', () => {
    const event: CloudEvent<LinkEventData> = {
      specversion: '1.0',
      id: 'evt-nope',
      source: 'openfoundry://engine/ontology',
      type: 'openfoundry.object.updated',
      time: '2025-01-15T11:00:00Z',
      data: {
        linkType: 'Fake',
        linkId: 'x',
        fromId: 'a',
        toId: 'b',
        version: 1,
      },
    };
    const result = mapLinkEvent(event);
    expect(result).toBeNull();
  });
});

describe('InMemorySubscribableEventBus', () => {
  it('delivers events to subscribers', async () => {
    const bus = new InMemorySubscribableEventBus();
    const received: CloudEvent[] = [];

    bus.subscribe((event) => received.push(event));

    const event = createObjectUpdatedEvent('Patient', 'p-1');
    await bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('supports unsubscribe', async () => {
    const bus = new InMemorySubscribableEventBus();
    const received: CloudEvent[] = [];

    const unsub = bus.subscribe((event) => received.push(event));
    unsub();

    await bus.publish(createObjectUpdatedEvent('Patient', 'p-1'));
    expect(received).toHaveLength(0);
  });

  it('stores events for inspection', async () => {
    const bus = new InMemorySubscribableEventBus();
    const event = createObjectUpdatedEvent('Patient', 'p-1');
    await bus.publish(event);

    expect(bus.events).toHaveLength(1);
    bus.clear();
    expect(bus.events).toHaveLength(0);
  });
});

describe('SubscriptionManager', () => {
  let pubsub: PubSub;
  let eventBus: InMemorySubscribableEventBus;

  beforeEach(() => {
    pubsub = new PubSub();
    eventBus = new InMemorySubscribableEventBus();
  });

  it('bridges CloudEvents to PubSub topics', async () => {
    const manager = new SubscriptionManager({
      pubsub,
      eventBus,
      authenticate: async () => ({ authenticated: true, user: createMockUser() }),
    });
    manager.start();

    // Subscribe to the PubSub topic
    const received: unknown[] = [];
    const iterator = pubsub.asyncIterableIterator('patientChanged');

    // Set up listener
    const listenPromise = iterator.next().then((result) => {
      received.push(result.value);
    });

    // Publish a CloudEvent
    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-1'));

    // Wait for delivery
    await listenPromise;

    expect(received).toHaveLength(1);
    const payload = received[0] as Record<string, ChangeEvent>;
    expect(payload['patientChanged']).toBeDefined();
    expect(payload['patientChanged']!.changeType).toBe('UPDATED');
    expect(payload['patientChanged']!.object.id).toBe('p-1');

    manager.stop();
  });

  it('does not publish events before start()', async () => {
    const publishSpy = vi.spyOn(pubsub, 'publish');

    const manager = new SubscriptionManager({
      pubsub,
      eventBus,
      authenticate: async () => ({ authenticated: true, user: createMockUser() }),
    });

    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-1'));

    expect(publishSpy).not.toHaveBeenCalled();
    manager.stop();
  });

  it('stops bridging after stop()', async () => {
    const publishSpy = vi.spyOn(pubsub, 'publish');

    const manager = new SubscriptionManager({
      pubsub,
      eventBus,
      authenticate: async () => ({ authenticated: true, user: createMockUser() }),
    });
    manager.start();
    manager.stop();

    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-1'));
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe('SubscriptionManager authentication', () => {
  it('authenticates valid connections', async () => {
    const user = createMockUser();
    const manager = new SubscriptionManager({
      pubsub: new PubSub(),
      eventBus: new InMemorySubscribableEventBus(),
      authenticate: async (params) => {
        if (params['authorization'] === 'Bearer valid-token') {
          return { authenticated: true, user };
        }
        return { authenticated: false, error: 'Invalid token' };
      },
    });

    const result = await manager.authenticateConnection({
      authorization: 'Bearer valid-token',
    });
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.user.id).toBe('user-1');
    }
  });

  it('rejects unauthenticated connections', async () => {
    const manager = new SubscriptionManager({
      pubsub: new PubSub(),
      eventBus: new InMemorySubscribableEventBus(),
      authenticate: async () => ({
        authenticated: false,
        error: 'No authorization header',
      }),
    });

    const result = await manager.authenticateConnection({});
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toBe('No authorization header');
    }
  });

  it('rejects connections with invalid tokens', async () => {
    const manager = new SubscriptionManager({
      pubsub: new PubSub(),
      eventBus: new InMemorySubscribableEventBus(),
      authenticate: async (params) => {
        if (params['authorization'] === 'Bearer valid-token') {
          return { authenticated: true, user: createMockUser() };
        }
        return { authenticated: false, error: 'Invalid token' };
      },
    });

    const result = await manager.authenticateConnection({
      authorization: 'Bearer bad-token',
    });
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.error).toBe('Invalid token');
    }
  });
});

describe('ID-filtered subscriptions', () => {
  let parsed: ParsedSchema;
  let ctx: ResolverContext;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
    ctx = createMockContext(createMockDeps(parsed));
  });

  it('delivers events matching the subscribed object ID', async () => {
    const pubsub = new PubSub();
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');

    // Subscribe filtering for patient p-1
    const iterator = sub.subscribe(null, { id: 'p-1' }, ctx);

    // Set up listener
    const resultPromise = iterator.next();

    // Publish matching event
    void pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    const result = await resultPromise;
    expect(result.done).toBe(false);
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.object.id).toBe('p-1');
  });

  it('filters out events for different object IDs', async () => {
    const pubsub = new PubSub();
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');

    // Subscribe filtering for patient p-1
    const iterator = sub.subscribe(null, { id: 'p-1' }, ctx);

    // Start listening first, then publish events with microtask delays
    // so the filter iterator can process each event
    const resultPromise = iterator.next();

    // Publish non-matching event, then after a microtask, publish matching event
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-2', _type: 'Patient' }, // Different ID
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    // Allow the filter to process the rejection and re-subscribe
    await new Promise(resolve => setTimeout(resolve, 10));

    // Now publish a matching event
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' }, // Matching ID
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:31:00Z',
      } satisfies ChangeEvent,
    });

    const result = await resultPromise;
    // Should skip p-2 and deliver p-1
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.object.id).toBe('p-1');
  });

  it('filters out events when authorizationService denies access', async () => {
    const pubsub = new PubSub();
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');

    // Override authorizationService to deny access to p-1, allow p-2
    const denyCtx = createMockContext(createMockDeps(parsed));
    (denyCtx.deps.authorizationService.check as ReturnType<typeof vi.fn>)
      .mockImplementation(async (_user: string, _rel: string, resource: string) =>
        !resource.endsWith(':p-1'),
      );

    const iterator = sub.subscribe(null, { id: 'p-1' }, denyCtx);
    const resultPromise = iterator.next();

    // Publish event for p-1 — authz will deny it
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Now allow access by changing mock, and publish again
    (denyCtx.deps.authorizationService.check as ReturnType<typeof vi.fn>)
      .mockResolvedValue(true);

    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:31:00Z',
      } satisfies ChangeEvent,
    });

    const result = await resultPromise;
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.timestamp).toBe('2025-01-15T10:31:00Z');
  });
});

describe('subscription resolver shape (graphql-js execution contract)', () => {
  let ctx: ResolverContext;
  beforeEach(() => { ctx = createMockContext(createMockDeps(parseOdl(NHS_ACUTE_ODL))); });

  // Regression: graphql-js `subscribe()` requires the source to be an
  // AsyncIterable (Symbol.asyncIterator), not just an AsyncIterator. A bare
  // iterator made EVERY subscription fail with graphql-ws close code 4500
  // ("Subscription field must return Async Iterable").
  it('subscribe() returns an AsyncIterable (has Symbol.asyncIterator → self)', () => {
    const pubsub = new PubSub();
    for (const sub of [
      createIdFilteredSubscription(pubsub, 'patientChanged').subscribe(null, { id: 'p-1' }, ctx),
      createFilteredSubscription(pubsub, 'patientChanged').subscribe(null, {}, ctx),
    ]) {
      const it = sub as AsyncIterableIterator<unknown>;
      expect(typeof it[Symbol.asyncIterator]).toBe('function');
      expect(it[Symbol.asyncIterator]()).toBe(it);
    }
  });

  // Regression: events are published keyed by the TOPIC (e.g. "patientChanged"),
  // but the subscription FIELD may differ (plural "patientsChanged"). Without an
  // explicit resolve, graphql-js's default resolver looks up the field name and
  // returns undefined — so `patientsChanged` delivered nothing.
  it('resolve() extracts the change event by topic key, not field name', () => {
    const evt = { changeType: 'UPDATED', object: { id: 'p-1', _type: 'Patient' } };
    const idSub = createIdFilteredSubscription(new PubSub(), 'patientChanged');
    const filterSub = createFilteredSubscription(new PubSub(), 'patientChanged');
    expect(idSub.resolve({ patientChanged: evt })).toBe(evt);
    // The plural foosChanged field receives the same topic-keyed payload.
    expect(filterSub.resolve({ patientChanged: evt })).toBe(evt);
    expect(filterSub.resolve({})).toBeUndefined();
  });
});

describe('Subscription auth fail-closed', () => {
  it('denies events when authorizationService is absent (ID-filtered)', async () => {
    const pubsub = new PubSub();
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');

    // Context with no authorizationService
    const noAuthCtx: ResolverContext = {
      requestContext: { tenantId: 'tenant-1', actorId: 'user-1', traceId: 'test' },
      user: createMockUser(),
      deps: { authorizationService: undefined } as unknown as ApiDependencies,
    };

    const iterator = sub.subscribe(null, { id: 'p-1' }, noAuthCtx);
    const resultPromise = iterator.next();

    // Publish matching event — should be denied (no authzService)
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Re-attach authzService and publish again — should pass
    noAuthCtx.deps = createMockDeps(parseOdl(NHS_ACUTE_ODL));
    // But the iterator captured the context at subscribe-time, so it still denies.
    // Publish a second event and return the iterator to verify denial.
    // Instead, use iterator.return to close and verify the first event was dropped.
    await iterator.return!();

    // Verify: the promise should resolve with done=true (iterator closed),
    // not with the denied event
    const result = await resultPromise;
    expect(result.done).toBe(true);
  });

  it('denies events when userId is absent (ID-filtered)', async () => {
    const pubsub = new PubSub();
    const parsed = parseOdl(NHS_ACUTE_ODL);
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');

    // Context with no user
    const noUserCtx: ResolverContext = {
      requestContext: { tenantId: 'tenant-1', actorId: 'anon', traceId: 'test' },
      user: undefined as unknown as AuthenticatedUserInfo,
      deps: createMockDeps(parsed),
    };

    const iterator = sub.subscribe(null, { id: 'p-1' }, noUserCtx);
    const resultPromise = iterator.next();

    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    await iterator.return!();

    const result = await resultPromise;
    expect(result.done).toBe(true);
  });

  it('denies events when authorizationService is absent (filtered)', async () => {
    const pubsub = new PubSub();
    const sub = createFilteredSubscription(pubsub, 'patientChanged');

    const noAuthCtx: ResolverContext = {
      requestContext: { tenantId: 'tenant-1', actorId: 'user-1', traceId: 'test' },
      user: createMockUser(),
      deps: { authorizationService: undefined } as unknown as ApiDependencies,
    };

    const iterator = sub.subscribe(null, {}, noAuthCtx);
    const resultPromise = iterator.next();

    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'CREATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    await iterator.return!();

    const result = await resultPromise;
    expect(result.done).toBe(true);
  });

  it('denies events when userId is absent (filtered)', async () => {
    const pubsub = new PubSub();
    const parsed = parseOdl(NHS_ACUTE_ODL);
    const sub = createFilteredSubscription(pubsub, 'patientChanged');

    const noUserCtx: ResolverContext = {
      requestContext: { tenantId: 'tenant-1', actorId: 'anon', traceId: 'test' },
      user: undefined as unknown as AuthenticatedUserInfo,
      deps: createMockDeps(parsed),
    };

    const iterator = sub.subscribe(null, {}, noUserCtx);
    const resultPromise = iterator.next();

    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'CREATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    await iterator.return!();

    const result = await resultPromise;
    expect(result.done).toBe(true);
  });
});

describe('Filtered subscriptions (foosChanged)', () => {
  let parsed: ParsedSchema;
  let ctx: ResolverContext;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
    ctx = createMockContext(createMockDeps(parsed));
  });

  it('delivers all events when no filter is provided', async () => {
    const pubsub = new PubSub();
    const sub = createFilteredSubscription(pubsub, 'patientChanged');

    const iterator = sub.subscribe(null, {}, ctx);
    const resultPromise = iterator.next();

    void pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'CREATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    const result = await resultPromise;
    expect(result.done).toBe(false);
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.changeType).toBe('CREATED');
  });

  it('filters by changeType', async () => {
    const pubsub = new PubSub();
    const sub = createFilteredSubscription(pubsub, 'patientChanged');

    const iterator = sub.subscribe(null, { filter: { changeType: 'DELETED' } }, ctx);

    // Start listening first
    const resultPromise = iterator.next();

    // Publish non-matching event (UPDATED)
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      } satisfies ChangeEvent,
    });

    // Allow the filter to process the rejection and re-subscribe
    await new Promise(resolve => setTimeout(resolve, 10));

    // Publish matching event (DELETED)
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'DELETED',
        object: { id: 'p-2', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:31:00Z',
      } satisfies ChangeEvent,
    });

    const result = await resultPromise;
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.changeType).toBe('DELETED');
    expect(payload['patientChanged']!.object.id).toBe('p-2');
  });
});

describe('Resolver generation with subscriptions', () => {
  let parsed: ParsedSchema;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
  });

  it('generates fooChanged subscription for each object type', () => {
    const deps = createMockDeps(parsed);
    const { resolvers } = generateResolvers(parsed, deps);
    const sub = resolvers['Subscription']!;

    expect(sub['patientChanged']).toBeDefined();
    expect(sub['wardChanged']).toBeDefined();

    // Verify they have subscribe function
    const patientSub = sub['patientChanged'] as { subscribe: Function };
    expect(patientSub.subscribe).toBeTypeOf('function');
  });

  it('generates foosChanged subscription for each object type', () => {
    const deps = createMockDeps(parsed);
    const { resolvers } = generateResolvers(parsed, deps);
    const sub = resolvers['Subscription']!;

    expect(sub['patientsChanged']).toBeDefined();
    expect(sub['wardsChanged']).toBeDefined();

    const patientsSub = sub['patientsChanged'] as { subscribe: Function };
    expect(patientsSub.subscribe).toBeTypeOf('function');
  });

  it('fooChanged subscribe returns an async iterator', () => {
    const deps = createMockDeps(parsed);
    const mockCtx = createMockContext(deps);
    const { resolvers } = generateResolvers(parsed, deps);
    const sub = resolvers['Subscription']!;

    const patientSub = sub['patientChanged'] as { subscribe: Function };
    const iterator = patientSub.subscribe(null, { id: 'p-1' }, mockCtx);

    // AsyncIterator should have a next method
    expect(iterator.next).toBeTypeOf('function');
  });

  it('foosChanged subscribe returns an async iterator', () => {
    const deps = createMockDeps(parsed);
    const mockCtx = createMockContext(deps);
    const { resolvers } = generateResolvers(parsed, deps);
    const sub = resolvers['Subscription']!;

    const patientsSub = sub['patientsChanged'] as { subscribe: Function };
    const iterator = patientsSub.subscribe(null, { filter: { changeType: 'UPDATED' } }, mockCtx);

    expect(iterator.next).toBeTypeOf('function');
  });

  it('fooChanged filters events by ID via PubSub', async () => {
    const deps = createMockDeps(parsed);
    const mockCtx = createMockContext(deps);
    const { resolvers, pubsub } = generateResolvers(parsed, deps);
    const sub = resolvers['Subscription']!;

    const patientSub = sub['patientChanged'] as { subscribe: Function };
    const iterator = patientSub.subscribe(null, { id: 'p-1' }, mockCtx) as AsyncIterator<unknown>;

    // Start listening first
    const resultPromise = iterator.next();

    // Publish event for p-2 (should be filtered) then p-1 (should pass)
    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-2', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:30:00Z',
      },
    });

    // Allow filter to process rejection
    await new Promise(resolve => setTimeout(resolve, 10));

    await pubsub.publish('patientChanged', {
      patientChanged: {
        changeType: 'UPDATED',
        object: { id: 'p-1', _type: 'Patient' },
        previousValues: null,
        causedBy: null,
        timestamp: '2025-01-15T10:31:00Z',
      },
    });

    const result = await resultPromise;
    const payload = result.value as Record<string, ChangeEvent>;
    // Should deliver p-1, not p-2
    expect(payload['patientChanged']!.object.id).toBe('p-1');
  });
});

describe('End-to-end: SubscriptionManager + subscription resolvers', () => {
  let parsed: ParsedSchema;
  let ctx: ResolverContext;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
    ctx = createMockContext(createMockDeps(parsed));
  });

  it('receives patient update event via full pipeline', async () => {
    const pubsub = new PubSub();
    const eventBus = new InMemorySubscribableEventBus();

    const manager = new SubscriptionManager({
      pubsub,
      eventBus,
      authenticate: async () => ({ authenticated: true, user: createMockUser() }),
    });
    manager.start();

    // Create subscription resolver
    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');
    const iterator = sub.subscribe(null, { id: 'p-1' }, ctx);

    // Wait for the next event
    const resultPromise = iterator.next();

    // Publish a CloudEvent through the engine event bus
    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-1'));

    const result = await resultPromise;
    expect(result.done).toBe(false);
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.changeType).toBe('UPDATED');
    expect(payload['patientChanged']!.object.id).toBe('p-1');
    expect(payload['patientChanged']!.object._type).toBe('Patient');
    expect(payload['patientChanged']!.previousValues).toEqual({
      status: { old: 'ACTIVE', new: 'DISCHARGED' },
    });
    expect(payload['patientChanged']!.causedBy).toEqual({
      actionType: 'DischargePatient',
      actionId: 'act-1',
    });

    manager.stop();
  });

  it('filters out events for other patients in full pipeline', async () => {
    const pubsub = new PubSub();
    const eventBus = new InMemorySubscribableEventBus();

    const manager = new SubscriptionManager({
      pubsub,
      eventBus,
      authenticate: async () => ({ authenticated: true, user: createMockUser() }),
    });
    manager.start();

    const sub = createIdFilteredSubscription(pubsub, 'patientChanged');
    const iterator = sub.subscribe(null, { id: 'p-1' }, ctx);

    const resultPromise = iterator.next();

    // Publish event for p-2 (should be filtered), then p-1 (should pass)
    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-2'));
    await eventBus.publish(createObjectUpdatedEvent('Patient', 'p-1'));

    const result = await resultPromise;
    const payload = result.value as Record<string, ChangeEvent>;
    expect(payload['patientChanged']!.object.id).toBe('p-1');

    manager.stop();
  });
});
