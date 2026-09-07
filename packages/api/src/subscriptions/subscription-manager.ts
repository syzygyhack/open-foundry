/**
 * WebSocket subscription manager (Section 8.1.4).
 *
 * Bridges CloudEvents from the engine EventBus into GraphQL PubSub,
 * handles ID and filter-based subscription routing, and enforces
 * authentication on WebSocket connections.
 */

import type { PubSub } from 'graphql-subscriptions';
import type { CloudEvent } from '@openfoundry/spi';
import type { ObjectEventData, LinkEventData } from '@openfoundry/engine';
import type { EventBus } from '@openfoundry/engine';
import type { AuthenticatedUserInfo, ResolverContext } from '../graphql/types.js';
import { lowerFirst, toSnakeCase } from '../utils.js';
import { logger } from '../logger.js';

// ─── Types ───

/** A change event delivered to GraphQL subscribers. */
export interface ChangeEvent {
  changeType: 'CREATED' | 'UPDATED' | 'DELETED';
  object: { id: string; _type: string };
  previousValues: Record<string, { old: unknown; new: unknown }> | null;
  causedBy: { actionType: string | null; actionId: string | null } | null;
  timestamp: string;
}

/** Filter criteria for foosChanged subscriptions. */
export interface SubscriptionFilter {
  [field: string]: unknown;
}

/** Result of authenticating a WebSocket connection. */
export type ConnectionAuthResult =
  | { authenticated: true; user: AuthenticatedUserInfo }
  | { authenticated: false; error: string };

/** Function that authenticates a WebSocket connection from connection params. */
export type ConnectionAuthenticator = (
  connectionParams: Record<string, unknown>,
) => Promise<ConnectionAuthResult>;

// ─── CloudEvent to ChangeEvent mapping ───

const OBJECT_EVENT_CHANGE_MAP: Record<string, ChangeEvent['changeType']> = {
  'openfoundry.object.created': 'CREATED',
  'openfoundry.object.updated': 'UPDATED',
  'openfoundry.object.deleted': 'DELETED',
};

const LINK_EVENT_TYPES: Set<string> = new Set([
  'openfoundry.link.created',
  'openfoundry.link.updated',
  'openfoundry.link.deleted',
]);

/**
 * Convert a CloudEvent with ObjectEventData into a ChangeEvent
 * and the topic it should be published to.
 */
export function mapObjectEvent(
  event: CloudEvent<ObjectEventData>,
): { topic: string; changeEvent: ChangeEvent } | null {
  const changeType = OBJECT_EVENT_CHANGE_MAP[event.type];
  if (!changeType || !event.data) return null;

  const data = event.data;
  const topic = `${lowerFirst(data.objectType)}Changed`;

  const changeEvent: ChangeEvent = {
    changeType,
    object: { id: data.objectId, _type: data.objectType },
    previousValues: data.changes ?? null,
    causedBy: data.causedBy
      ? {
          actionType: data.causedBy.actionType ?? null,
          actionId: data.causedBy.actionId ?? null,
        }
      : null,
    timestamp: event.time,
  };

  return { topic, changeEvent };
}

/**
 * Convert a CloudEvent with LinkEventData into ChangeEvents
 * for the related object types.  Link events trigger change
 * notifications on both endpoints.
 */
export function mapLinkEvent(
  event: CloudEvent<LinkEventData>,
): { topic: string; objectId: string }[] | null {
  if (!LINK_EVENT_TYPES.has(event.type) || !event.data) return null;

  const data = event.data;
  // A link event affects both endpoints.  The subject field is "LinkType/linkId"
  // and the data carries fromId and toId.  We produce generic notifications
  // for each end.  The consuming subscription resolvers will refetch the
  // objects to build the full ChangeEvent payloads.
  //
  // TODO: Topics are keyed by object ID (e.g. "patient-123") rather than
  // type-level topics (e.g. "Patient"). Clients subscribing to "all Patient
  // changes" won't receive link events unless they subscribe to every patient
  // ID individually. Consider adding type-level topic publishing alongside
  // the per-ID topics.
  return [
    { topic: data.fromId, objectId: data.fromId },
    { topic: data.toId, objectId: data.toId },
  ];
}

// ─── Subscribable EventBus adapter ───

/**
 * Extends EventBus with a subscribe method so the subscription manager
 * can receive CloudEvents.
 */
export interface SubscribableEventBus extends EventBus {
  subscribe(handler: (event: CloudEvent) => void): () => void;
}

/**
 * In-memory subscribable event bus for testing and single-instance deploys.
 */
export class InMemorySubscribableEventBus implements SubscribableEventBus {
  public readonly events: CloudEvent[] = [];
  private handlers: Array<(event: CloudEvent) => void> = [];

  async publish(event: CloudEvent): Promise<void> {
    this.events.push(event);
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  subscribe(handler: (event: CloudEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  clear(): void {
    this.events.length = 0;
  }
}

// ─── Subscription Manager ───

export interface SubscriptionManagerConfig {
  pubsub: PubSub;
  eventBus: SubscribableEventBus;
  authenticate: ConnectionAuthenticator;
}

/**
 * Manages the bridge between CloudEvents and GraphQL subscriptions.
 *
 * - Subscribes to the event bus for CloudEvents
 * - Maps them to ChangeEvent payloads
 * - Publishes to PubSub topics for GraphQL delivery
 * - Authenticates WebSocket connections
 */
export class SubscriptionManager {
  private readonly pubsub: PubSub;
  private readonly eventBus: SubscribableEventBus;
  private readonly authenticate: ConnectionAuthenticator;
  private unsubscribe: (() => void) | null = null;

  constructor(config: SubscriptionManagerConfig) {
    this.pubsub = config.pubsub;
    this.eventBus = config.eventBus;
    this.authenticate = config.authenticate;
  }

  /**
   * Start listening for CloudEvents and bridging them to PubSub.
   */
  start(): void {
    if (this.unsubscribe) return; // Already started

    this.unsubscribe = this.eventBus.subscribe((event: CloudEvent) => {
      this.handleCloudEvent(event);
    });
  }

  /**
   * Stop listening for CloudEvents.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Authenticate a WebSocket connection.
   * Called during the graphql-ws connection_init phase.
   */
  async authenticateConnection(
    connectionParams: Record<string, unknown>,
  ): Promise<ConnectionAuthResult> {
    return this.authenticate(connectionParams);
  }

  /**
   * Get the PubSub instance for use by subscription resolvers.
   */
  getPubSub(): PubSub {
    return this.pubsub;
  }

  // ─── Internal ───

  private handleCloudEvent(event: CloudEvent): void {
    // Handle object lifecycle events
    if (OBJECT_EVENT_CHANGE_MAP[event.type]) {
      const mapped = mapObjectEvent(event as CloudEvent<ObjectEventData>);
      if (mapped) {
        // CQ-19: Log errors from pubsub publish instead of silently swallowing
        this.pubsub.publish(mapped.topic, {
          [mapped.topic]: mapped.changeEvent,
        }).catch((err: unknown) => {
          logger.warn({ topic: mapped.topic, err: err instanceof Error ? err.message : String(err) }, 'PubSub publish failed');
        });
      }
      return;
    }

    // Handle link lifecycle events — emit change events for related objects
    if (LINK_EVENT_TYPES.has(event.type)) {
      const mappedLinks = mapLinkEvent(event as CloudEvent<LinkEventData>);
      if (mappedLinks) {
        for (const link of mappedLinks) {
          // Publish a minimal change notification; the subscription resolver
          // will refetch the full object if needed.
          const changeEvent: ChangeEvent = {
            changeType: 'UPDATED',
            object: { id: link.objectId, _type: 'unknown' },
            previousValues: null,
            causedBy: null,
            timestamp: event.time,
          };
          // Use a generic topic based on the objectId
          this.pubsub.publish(link.topic, { [link.topic]: changeEvent }).catch((err: unknown) => {
            logger.warn({ topic: link.topic, err: err instanceof Error ? err.message : String(err) }, 'PubSub link event publish failed');
          });
        }
      }
    }
  }
}

// ─── Subscription resolver helpers ───

/**
 * Create a subscription resolver that filters by object ID.
 *
 * Used for `fooChanged(id: ID!)` subscriptions.
 *
 * Authorization: Each emitted event is checked against FGA — subscribers
 * only receive events for objects they have `viewer` access to.
 */
export function createIdFilteredSubscription(
  pubsub: PubSub,
  topic: string,
): {
  subscribe: (_parent: unknown, args: { id: string }, ctx: ResolverContext) => AsyncIterator<unknown>;
  resolve: (payload: unknown) => unknown;
} {
  return {
    // The payload is published keyed by `topic` (e.g. "patientChanged"); the
    // subscription FIELD may differ (e.g. plural "patientsChanged"). Extract the
    // change event by the topic key so graphql-js's default field resolver
    // (which would look up the field name) doesn't return undefined.
    resolve: (payload: unknown) => (payload as Record<string, unknown> | undefined)?.[topic],
    subscribe: (_parent: unknown, args: { id: string }, ctx: ResolverContext) => {
      const baseIterator = pubsub.asyncIterableIterator(topic);
      const authzService = ctx?.deps?.authorizationService;
      const userId = ctx?.user?.id;

      return filterAsyncIteratorAsync(baseIterator, async (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const event = p[topic] as ChangeEvent | undefined;
        if (!event) return false;
        if (event.object.id !== args.id) return false;

        // Fail closed: deny events when authorization context is unavailable
        if (!authzService || !userId) return false;

        // Authorize: check viewer access on the specific object
        const fgaType = toSnakeCase(event.object._type);
        const allowed = await authzService.check(
          `user:${userId}`,
          'viewer',
          `${fgaType}:${event.object.id}`,
        );
        if (!allowed) return false;
        return true;
      });
    },
  };
}

/**
 * Create a subscription resolver for type-level changes with optional filter.
 *
 * Used for `foosChanged(filter: FooFilter)` subscriptions.
 *
 * Authorization: Each emitted event is checked against FGA — subscribers
 * only receive events for objects they have `viewer` access to.
 */
export function createFilteredSubscription(
  pubsub: PubSub,
  topic: string,
): {
  subscribe: (_parent: unknown, args: { filter?: SubscriptionFilter }, ctx: ResolverContext) => AsyncIterator<unknown>;
  resolve: (payload: unknown) => unknown;
} {
  return {
    // See createIdFilteredSubscription: payload is keyed by `topic`, field name
    // may differ (plural). Extract by topic key.
    resolve: (payload: unknown) => (payload as Record<string, unknown> | undefined)?.[topic],
    subscribe: (_parent: unknown, args: { filter?: SubscriptionFilter }, ctx: ResolverContext) => {
      const baseIterator = pubsub.asyncIterableIterator(topic);
      const authzService = ctx?.deps?.authorizationService;
      const userId = ctx?.user?.id;

      return filterAsyncIteratorAsync(baseIterator, async (payload: unknown) => {
        const p = payload as Record<string, unknown>;
        const event = p[topic] as ChangeEvent | undefined;
        if (!event) return false;

        // Apply user-provided filters
        if (args.filter && Object.keys(args.filter).length > 0) {
          if (!matchesFilter(event, args.filter)) return false;
        }

        // Fail closed: deny events when authorization context is unavailable
        if (!authzService || !userId) return false;

        // Authorize: check viewer access on the specific object
        const fgaType = toSnakeCase(event.object._type);
        const allowed = await authzService.check(
          `user:${userId}`,
          'viewer',
          `${fgaType}:${event.object.id}`,
        );
        if (!allowed) return false;
        return true;
      });
    },
  };
}

/**
 * Check if a ChangeEvent matches a subscription filter.
 * Matches on changeType if provided.
 */
function matchesFilter(event: ChangeEvent, filter: SubscriptionFilter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (value == null) continue;

    if (key === 'changeType') {
      if (event.changeType !== value) return false;
      continue;
    }

    // Match on object fields when available
    const objField = (event.object as Record<string, unknown>)[key];
    if (objField !== undefined && objField !== value) return false;
  }
  return true;
}

/**
 * Wrap an AsyncIterator with an async predicate filter.
 * Supports both sync and async predicates (e.g. FGA authorization checks).
 */
function filterAsyncIteratorAsync<T>(
  iterator: AsyncIterator<T>,
  predicate: (value: T) => Promise<boolean>,
): AsyncIterableIterator<T> {
  const wrapped: AsyncIterableIterator<T> = {
    // graphql-js `subscribe()` requires an AsyncIterable (it checks for
    // Symbol.asyncIterator). Returning a bare AsyncIterator (next/return/throw
    // only) makes every subscription fail with "Subscription field must return
    // Async Iterable" (graphql-ws close code 4500). Make this self-iterable.
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return wrapped;
    },
    next(): Promise<IteratorResult<T>> {
      return new Promise((resolve, reject) => {
        const getNext = (): void => {
          iterator.next().then(
            (result) => {
              if (result.done) {
                resolve(result);
                return;
              }
              predicate(result.value).then(
                (matches) => {
                  if (matches) {
                    resolve(result);
                  } else {
                    getNext();
                  }
                },
                (err) => reject(err),
              );
            },
            (err) => reject(err),
          );
        };
        getNext();
      });
    },
    return: iterator.return
      ? (value?: unknown) => iterator.return!(value)
      : undefined,
    throw: iterator.throw
      ? (err?: unknown) => iterator.throw!(err)
      : undefined,
  } as AsyncIterableIterator<T>;
  return wrapped;
}
