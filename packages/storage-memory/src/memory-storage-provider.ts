/**
 * In-memory StorageProvider implementation for testing.
 *
 * Data stored in Maps. Version history in arrays. Tenant isolation via
 * _tenantId filtering. Soft-delete via _deletedAt field.
 */

import type {
  StorageProvider,
  Transaction,
  RequestContext,
  OntologySchema,
  OntologyObject,
  OntologyLink,
  FilterExpression,
  FieldPredicate,
  LogicalPredicate,
  QueryOptions,
  TraversalPath,
  TraversalOptions,
  TraversalResult,
  BulkMutationRequest,
  BulkMutationResult,
  ObjectPage,
  LinkPage,
  MigrationResult,
  HealthStatus,
  StorageCapabilities,
  IndexDefinition,
  DateTime,
  LinkTypeDefinition,
  AggregateQuery,
  AggregateResult,
  AggregateGroup,
  SearchQuery,
  SearchResult,
  SearchHit,
} from '@openfoundry/spi';
import {
  assertObjectType,
  assertLinkType,
  assertFilterFields,
  systemFilterKey,
  SchemaGuardError,
  encodeLinkCursor,
  decodeLinkCursor,
  assertCursorOrOffset,
  OpenFoundryError,
} from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _counter = 0;
function genId(): string {
  return `mem_${Date.now().toString(36)}_${(++_counter).toString(36)}`;
}

function now(): DateTime {
  return new Date().toISOString() as DateTime;
}

/** Endpoint type recorded on a link made with no schema applied. */
const UNKNOWN_ENDPOINT_TYPE = 'unknown';

function isFieldPredicate(f: FilterExpression): f is FieldPredicate {
  return 'field' in f && 'operator' in f;
}

function isLogicalPredicate(f: FilterExpression): f is LogicalPredicate {
  return 'and' in f || 'or' in f || 'not' in f;
}

/** Deep clone a plain object. */
function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

function evaluateFilter(obj: Record<string, unknown>, filter: FilterExpression): boolean {
  if (isFieldPredicate(filter)) {
    return evaluateFieldPredicate(obj, filter);
  }
  if (isLogicalPredicate(filter)) {
    return evaluateLogicalPredicate(obj, filter);
  }
  return true;
}

function evaluateFieldPredicate(obj: Record<string, unknown>, pred: FieldPredicate): boolean {
  // System fields may be named either way (_deleted_at, _deletedAt), as on
  // Postgres, where both reach the same column.
  // An absent field is null, as an unset or NULL column is on Postgres: a live
  // object has no _deletedAt key, yet `_deleted_at eq null` must match it.
  // Own keys only: an inherited name (constructor, __proto__) is unset.
  const key = systemFilterKey(pred.field);
  const raw = Object.hasOwn(obj, key) ? obj[key] : undefined;
  const val = raw === undefined ? null : raw;
  const want = pred.value === undefined ? null : pred.value;
  switch (pred.operator) {
    case 'eq':
      return val === want;
    case 'neq':
      return val !== want;
    case 'gt':
      return typeof val === 'number' && typeof pred.value === 'number' && val > pred.value;
    case 'gte':
      return typeof val === 'number' && typeof pred.value === 'number' && val >= pred.value;
    case 'lt':
      return typeof val === 'number' && typeof pred.value === 'number' && val < pred.value;
    case 'lte':
      return typeof val === 'number' && typeof pred.value === 'number' && val <= pred.value;
    case 'in':
      return Array.isArray(pred.value) && (pred.value as unknown[]).some((v) => (v === undefined ? null : v) === val);
    case 'contains':
      return typeof val === 'string' && typeof pred.value === 'string' && val.includes(pred.value);
    case 'startsWith':
      return typeof val === 'string' && typeof pred.value === 'string' && val.startsWith(pred.value);
    case 'exists':
      return pred.value ? val !== undefined && val !== null : val === undefined || val === null;
    default:
      return false;
  }
}

function evaluateLogicalPredicate(obj: Record<string, unknown>, pred: LogicalPredicate): boolean {
  if (pred.and) {
    return pred.and.every((f) => evaluateFilter(obj, f));
  }
  if (pred.or) {
    return pred.or.some((f) => evaluateFilter(obj, f));
  }
  if (pred.not) {
    return !evaluateFilter(obj, pred.not);
  }
  return true;
}

// ---------------------------------------------------------------------------
// MemoryTransaction
// ---------------------------------------------------------------------------

class MemoryTransaction implements Transaction {
  private _committed = false;
  private _rolledBack = false;
  private _journal: Array<
    | { op: 'createObject'; key: string; value: OntologyObject }
    | { op: 'updateObject'; key: string; prev: OntologyObject; value: OntologyObject }
    | { op: 'deleteObjectSoft'; key: string; prev: OntologyObject; value: OntologyObject }
    | {
        op: 'deleteObjectHard';
        key: string;
        prev: OntologyObject;
        history: OntologyObject[] | undefined;
        links: Array<[string, OntologyLink]>;
      }
    | { op: 'createLink'; key: string; value: OntologyLink }
    | { op: 'updateLink'; key: string; prev: OntologyLink; value: OntologyLink }
    | { op: 'deleteLink'; key: string; prev: OntologyLink }
    | { op: 'version'; objectKey: string; snapshot: OntologyObject }
  > = [];

  constructor(private _provider: MemoryStorageProvider, private _ctx: RequestContext) {}

  private assertOpen(): void {
    if (this._committed) throw new Error('Transaction already committed');
    if (this._rolledBack) throw new Error('Transaction already rolled back');
  }

  async createObject(type: string, properties: Record<string, unknown>): Promise<OntologyObject> {
    this._provider._guardObject(type);
    this.assertOpen();
    const obj = this._provider._doCreateObject(this._ctx, type, properties);
    this._journal.push({ op: 'createObject', key: `${type}:${obj._id}`, value: obj });
    return clone(obj);
  }

  async updateObject(type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject> {
    this._provider._guardObject(type);
    this.assertOpen();
    const prev = this._provider._getObjectInternal(this._ctx, type, id);
    if (!prev) throw new Error(`Object ${type}:${id} not found`);
    const updated = this._provider._doUpdateObject(this._ctx, type, id, properties, expectedVersion);
    this._journal.push({ op: 'updateObject', key: `${type}:${id}`, prev: clone(prev), value: updated });
    return clone(updated);
  }

  async deleteObject(type: string, id: string, mode: 'soft' | 'hard'): Promise<void> {
    this._provider._guardObject(type);
    this.assertOpen();
    const prev = this._provider._getObjectInternal(this._ctx, type, id);
    if (!prev) throw new Error(`Object ${type}:${id} not found`);
    if (mode === 'soft') {
      const updated = this._provider._doSoftDeleteObject(this._ctx, type, id);
      this._journal.push({ op: 'deleteObjectSoft', key: `${type}:${id}`, prev: clone(prev), value: updated });
    } else {
      const removed = this._provider._doHardDeleteObject(this._ctx, type, id);
      this._journal.push({
        op: 'deleteObjectHard',
        key: `${type}:${id}`,
        prev: clone(prev),
        history: removed.history,
        links: removed.links,
      });
    }
  }

  async createLink(type: string, fromId: string, toId: string, properties?: Record<string, unknown>): Promise<OntologyLink> {
    this._provider._guardLink(type);
    this.assertOpen();
    const link = this._provider._doCreateLink(this._ctx, type, fromId, toId, properties);
    this._journal.push({ op: 'createLink', key: `${type}:${link._id}`, value: link });
    return clone(link);
  }

  async updateLink(type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink> {
    this._provider._guardLink(type);
    this.assertOpen();
    const prev = this._provider._getLinkInternal(this._ctx, type, linkId);
    if (!prev) throw new Error(`Link ${type}:${linkId} not found`);
    const updated = this._provider._doUpdateLink(this._ctx, type, linkId, properties, expectedVersion);
    this._journal.push({ op: 'updateLink', key: `${type}:${linkId}`, prev: clone(prev), value: updated });
    return clone(updated);
  }

  async deleteLink(type: string, linkId: string): Promise<void> {
    this._provider._guardLink(type);
    this.assertOpen();
    const prev = this._provider._getLinkInternal(this._ctx, type, linkId);
    if (!prev) throw new Error(`Link ${type}:${linkId} not found`);
    this._provider._doDeleteLink(this._ctx, type, linkId);
    this._journal.push({ op: 'deleteLink', key: `${type}:${linkId}`, prev: clone(prev) });
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this._committed = true;
    // Data already applied eagerly; commit is a no-op (journal kept for rollback).
  }

  async rollback(): Promise<void> {
    this.assertOpen();
    this._rolledBack = true;
    // Undo in reverse order
    for (let i = this._journal.length - 1; i >= 0; i--) {
      const entry = this._journal[i]!;
      switch (entry.op) {
        case 'createObject':
          this._provider._removeObject(entry.key);
          break;
        case 'updateObject':
        case 'deleteObjectSoft':
          this._provider._putObject(entry.key, entry.prev);
          // Also revert version history
          this._provider._popVersionHistory(entry.key);
          break;
        case 'deleteObjectHard':
          // Restore the object, its version history and its links.
          this._provider._putObject(entry.key, entry.prev);
          this._provider._putVersionHistory(entry.key, entry.history);
          for (const [key, link] of entry.links) this._provider._putLink(key, link);
          break;
        case 'createLink':
          this._provider._removeLink(entry.key);
          break;
        case 'updateLink':
          this._provider._putLink(entry.key, entry.prev);
          break;
        case 'deleteLink':
          this._provider._putLink(entry.key, entry.prev);
          break;
        case 'version':
          // Handled by updateObject rollback above
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MemoryStorageProvider
// ---------------------------------------------------------------------------

export class MemoryStorageProvider implements StorageProvider {
  /** type:id -> OntologyObject */
  private _objects = new Map<string, OntologyObject>();
  /** type:id -> OntologyLink */
  private _links = new Map<string, OntologyLink>();
  /** type:id -> OntologyObject[] (version history, chronological) */
  private _versionHistory = new Map<string, OntologyObject[]>();
  /** version -> OntologySchema */
  private _schemas = new Map<number, OntologySchema>();
  private _currentSchemaVersion = 0;
  /** idempotencyKey -> BulkMutationResult */
  private _idempotencyCache = new Map<string, BulkMutationResult>();

  // ─── Internal helpers (exposed for Transaction rollback) ───

  /** @internal */ _putObject(key: string, obj: OntologyObject): void {
    this._objects.set(key, obj);
  }
  /** @internal */ _removeObject(key: string): void {
    this._objects.delete(key);
    this._versionHistory.delete(key);
  }
  /** @internal */ _putVersionHistory(key: string, history: OntologyObject[] | undefined): void {
    if (history) this._versionHistory.set(key, history);
  }

  /** @internal */ _putLink(key: string, link: OntologyLink): void {
    this._links.set(key, link);
  }
  /** @internal */ _removeLink(key: string): void {
    this._links.delete(key);
  }
  /** @internal */ _popVersionHistory(key: string): void {
    const history = this._versionHistory.get(key);
    if (history && history.length > 0) {
      history.pop();
    }
  }

  /** @internal */ _getObjectInternal(_ctx: RequestContext, type: string, id: string): OntologyObject | null {
    const key = `${type}:${id}`;
    const obj = this._objects.get(key);
    if (!obj || obj._tenantId !== _ctx.tenantId) return null;
    return obj;
  }

  /** @internal */ _getLinkInternal(_ctx: RequestContext, type: string, linkId: string): OntologyLink | null {
    const key = `${type}:${linkId}`;
    const link = this._links.get(key);
    if (!link || link._tenantId !== _ctx.tenantId) return null;
    return link;
  }

  private _pushVersionHistory(key: string, snapshot: OntologyObject): void {
    let history = this._versionHistory.get(key);
    if (!history) {
      history = [];
      this._versionHistory.set(key, history);
    }
    history.push(clone(snapshot));
  }

  private _getLinkTypeDef(linkType: string): LinkTypeDefinition | undefined {
    const schema = this._schemas.get(this._currentSchemaVersion);
    if (!schema) return undefined;
    return schema.linkTypes.find((lt) => lt.name === linkType);
  }

  private _enforceCardinality(ctx: RequestContext, linkType: string, fromId: string, toId: string): void {
    const def = this._getLinkTypeDef(linkType);
    if (!def) return; // No schema constraint

    // Count active (non-deleted) links of this type
    const activeLinks = Array.from(this._links.values()).filter(
      (l) => l._type === linkType && l._tenantId === ctx.tenantId && !l._deletedAt,
    );

    if (def.cardinality === 'ONE_TO_ONE') {
      const existingFromOutbound = activeLinks.find((l) => l._fromId === fromId);
      if (existingFromOutbound) {
        throw new Error(`Cardinality violation: ONE_TO_ONE link ${linkType} already exists from ${fromId}`);
      }
      const existingToInbound = activeLinks.find((l) => l._toId === toId);
      if (existingToInbound) {
        throw new Error(`Cardinality violation: ONE_TO_ONE link ${linkType} already exists to ${toId}`);
      }
    } else if (def.cardinality === 'ONE_TO_MANY') {
      // Each "to" can only have one inbound link of this type
      const existingToInbound = activeLinks.find((l) => l._toId === toId);
      if (existingToInbound) {
        throw new Error(`Cardinality violation: ONE_TO_MANY link ${linkType} already exists to ${toId}`);
      }
    } else if (def.cardinality === 'MANY_TO_ONE') {
      // Each "from" can only have one outbound link of this type
      const existingFromOutbound = activeLinks.find((l) => l._fromId === fromId);
      if (existingFromOutbound) {
        throw new Error(`Cardinality violation: MANY_TO_ONE link ${linkType} already exists from ${fromId}`);
      }
    }
    // MANY_TO_MANY: no constraint
  }

  // ─── Internal mutation methods (used by provider + transaction) ───

  /**
   * Declared properties of an object or link type, each null (or, for an
   * object property, its default): an unset declared property reads back as
   * null, as on Postgres, where it is a NULL column. Unset and null are the
   * same value.
   */
  private _declaredNulls(kind: 'object' | 'link', type: string): Record<string, unknown> {
    const schema = this._schemas.get(this._currentSchemaVersion);
    const types: Array<{ name: string; properties?: Array<{ name: string }> }> =
      kind === 'object' ? (schema?.objectTypes ?? []) : (schema?.linkTypes ?? []);
    const def = types.find((t) => t.name === type);
    const nulls: Record<string, unknown> = {};
    for (const p of def?.properties ?? []) {
      // Object columns carry the property's default on Postgres; link columns
      // do not.
      const dflt = (p as { defaultValue?: unknown }).defaultValue;
      nulls[p.name] = kind === 'object' && dflt !== undefined ? clone(dflt) : null;
    }
    return nulls;
  }

  /** @internal */ _doCreateObject(ctx: RequestContext, type: string, properties: Record<string, unknown>): OntologyObject {
    const id = genId();
    const timestamp = now();
    const obj: OntologyObject = {
      ...this._declaredNulls('object', type),
      ...properties,
      _tenantId: ctx.tenantId,
      _type: type,
      _id: id,
      _version: 1,
      _createdAt: timestamp,
      _updatedAt: timestamp,
    };
    const key = `${type}:${id}`;
    this._objects.set(key, obj);
    this._pushVersionHistory(key, obj);
    return obj;
  }

  /** @internal */ _doUpdateObject(ctx: RequestContext, type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): OntologyObject {
    const key = `${type}:${id}`;
    const existing = this._objects.get(key);
    if (!existing || existing._tenantId !== ctx.tenantId) {
      throw new Error(`Object ${type}:${id} not found`);
    }
    if (existing._deletedAt) {
      throw new Error(`Object ${type}:${id} is deleted`);
    }
    if (expectedVersion !== undefined && existing._version !== expectedVersion) {
      throw new OpenFoundryError({ code: 'VERSION_CONFLICT', category: 'conflict', message: `Object ${type}:${id} has version ${existing._version}, expected ${expectedVersion}` });
    }
    const updated: OntologyObject = {
      ...existing,
      ...properties,
      _tenantId: existing._tenantId,
      _type: existing._type,
      _id: existing._id,
      _version: existing._version + 1,
      _createdAt: existing._createdAt,
      _updatedAt: now(),
    };
    this._objects.set(key, updated);
    this._pushVersionHistory(key, updated);
    return updated;
  }

  /** @internal */ _doSoftDeleteObject(ctx: RequestContext, type: string, id: string): OntologyObject {
    const key = `${type}:${id}`;
    const existing = this._objects.get(key);
    if (!existing || existing._tenantId !== ctx.tenantId) {
      throw new Error(`Object ${type}:${id} not found`);
    }
    const updated: OntologyObject = {
      ...existing,
      _deletedAt: now(),
      _version: existing._version + 1,
      _updatedAt: now(),
    };
    this._objects.set(key, updated);
    this._pushVersionHistory(key, updated);
    return updated;
  }

  /**
   * Hard delete (spec §3.3 rule 6): remove the object, its version history,
   * and every link from or to it, live or soft-deleted. Links are matched on
   * tenant, endpoint type and ID, so links left by an earlier delete are
   * removed too even when the object itself is already gone. Returns what was
   * removed, for transaction rollback.
   * @internal
   */
  _doHardDeleteObject(
    ctx: RequestContext,
    type: string,
    id: string,
  ): { history: OntologyObject[] | undefined; links: Array<[string, OntologyLink]> } {
    const key = `${type}:${id}`;
    const existing = this._objects.get(key);
    // Tenant isolation: deny access if object belongs to a different tenant
    if (existing && existing._tenantId !== ctx.tenantId) {
      throw new Error(`Object ${type}:${id} not found`);
    }
    const links: Array<[string, OntologyLink]> = [];
    for (const [linkKey, link] of this._links) {
      if (link._tenantId !== ctx.tenantId) continue;
      // An 'unknown' endpoint type (a link made with no schema applied)
      // matches by ID, as the endpoint lookup does.
      const at = (linkType: string, linkId: string) =>
        linkId === id && (linkType === type || linkType === UNKNOWN_ENDPOINT_TYPE);
      const touches = at(link._fromType, link._fromId) || at(link._toType, link._toId);
      if (touches) links.push([linkKey, clone(link)]);
    }
    for (const [linkKey] of links) this._links.delete(linkKey);
    const history = this._versionHistory.get(key)?.map((v) => clone(v));
    // Idempotent: nothing more to do if the object doesn't exist
    if (existing) {
      this._objects.delete(key);
      this._versionHistory.delete(key);
    }
    return { history, links };
  }

  /** @internal */ _doCreateLink(
    ctx: RequestContext,
    type: string,
    fromId: string,
    toId: string,
    properties?: Record<string, unknown>,
  ): OntologyLink {
    this._enforceCardinality(ctx, type, fromId, toId);
    // Honour engine-provided ID (UUIDv7) per SPI contract, fall back to genId
    const engineId = properties?._engineLinkId;
    const id = typeof engineId === 'string' ? engineId : genId();
    // Links are keyed by type and ID, not tenant, so writing over an existing
    // key would replace another record: a deleted link's history, or another
    // tenant's link. Postgres rejects a reused ID within a tenant (primary key
    // on tenant and ID); this also rejects it across tenants.
    if (this._links.has(`${type}:${id}`)) {
      throw new Error(`Link ${type}:${id} already exists`);
    }
    const timestamp = now();
    // Resolve fromType/toType from link type definition or default to 'unknown'
    const def = this._getLinkTypeDef(type);
    if (def) this._enforceEndpoints(ctx, def.fromType, fromId, def.toType, toId);
    // Strip _engineLinkId from user-facing properties
    const { _engineLinkId: _, ...userProps } = properties ?? {};
    const declared = this._declaredNulls('link', type);
    // ODL rule 11: a link type's `id: ID! @primary` property is the link's ID
    // unless given, as on Postgres.
    if ('id' in declared && !('id' in userProps)) userProps['id'] = id;
    const link: OntologyLink = {
      ...declared,
      _tenantId: ctx.tenantId,
      _type: type,
      _id: id,
      _fromType: def?.fromType ?? UNKNOWN_ENDPOINT_TYPE,
      _fromId: fromId,
      _toType: def?.toType ?? UNKNOWN_ENDPOINT_TYPE,
      _toId: toId,
      _version: 1,
      _createdAt: timestamp,
      _updatedAt: timestamp,
      ...userProps,
    };
    this._links.set(`${type}:${id}`, link);
    return link;
  }

  /**
   * Both endpoints must exist in this tenant and not be soft-deleted (spec
   * §3.3 rule 5), as the Postgres provider checks. Messages match its.
   */
  private _enforceEndpoints(ctx: RequestContext, fromType: string, fromId: string, toType: string, toId: string): void {
    const ends: Array<[string, string, string]> = [['source', fromType, fromId], ['target', toType, toId]];
    for (const [role, endType, endId] of ends) {
      const obj = this._objects.get(`${endType}:${endId}`);
      if (!obj || obj._tenantId !== ctx.tenantId) {
        throw new Error(`Referential integrity: ${role} object ${endType}:${endId} does not exist`);
      }
      if (obj._deletedAt) {
        throw new Error(`Referential integrity: ${role} object ${endType}:${endId} is soft-deleted`);
      }
    }
  }

  /** @internal */ _doUpdateLink(ctx: RequestContext, type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): OntologyLink {
    const key = `${type}:${linkId}`;
    const existing = this._links.get(key);
    // A soft-deleted link is history, not a live record: reject, as Postgres does.
    if (!existing || existing._tenantId !== ctx.tenantId || existing._deletedAt) {
      throw new Error(`Link ${type}:${linkId} not found`);
    }
    if (expectedVersion !== undefined && existing._version !== expectedVersion) {
      throw new OpenFoundryError({ code: 'VERSION_CONFLICT', category: 'conflict', message: `Link ${type}:${linkId} has version ${existing._version}, expected ${expectedVersion}` });
    }
    const updated: OntologyLink = {
      ...existing,
      ...properties,
      _tenantId: existing._tenantId,
      _type: existing._type,
      _id: existing._id,
      _fromType: existing._fromType,
      _fromId: existing._fromId,
      _toType: existing._toType,
      _toId: existing._toId,
      _version: existing._version + 1,
      _createdAt: existing._createdAt,
      _updatedAt: now(),
    };
    this._links.set(key, updated);
    return updated;
  }

  /**
   * Soft-delete a link: stamp _deletedAt and bump the version, as the Postgres
   * provider does. Default reads hide it; includeDeleted reads (link history,
   * e.g. discharged admissions) still return it.
   * @internal
   */
  _doDeleteLink(ctx: RequestContext, type: string, linkId: string): void {
    const key = `${type}:${linkId}`;
    const existing = this._links.get(key);
    if (!existing || existing._tenantId !== ctx.tenantId || existing._deletedAt) {
      throw new Error(`Link ${type}:${linkId} not found or already deleted`);
    }
    const timestamp = now();
    this._links.set(key, {
      ...existing,
      _version: existing._version + 1,
      _updatedAt: timestamp,
      _deletedAt: timestamp,
    });
  }

  // ─── Schema ───

  async applySchema(_ctx: RequestContext, schema: OntologySchema): Promise<MigrationResult> {
    const fromVersion = this._currentSchemaVersion;
    this._currentSchemaVersion = schema.version;
    this._schemas.set(schema.version, clone(schema));
    // A newly declared property reads back on records that predate it as an
    // added Postgres column does: its default on current objects (Postgres
    // fills existing rows with it), null in their history and on links.
    const fill = (rec: Record<string, unknown>, values: Record<string, unknown>, keepDefaults: boolean) => {
      for (const k of Object.keys(values)) if (!(k in rec)) rec[k] = keepDefaults ? values[k] : null;
    };
    for (const obj of this._objects.values()) fill(obj, this._declaredNulls('object', obj._type), true);
    for (const history of this._versionHistory.values()) {
      for (const snap of history) fill(snap, this._declaredNulls('object', snap._type), false);
    }
    for (const link of this._links.values()) fill(link, this._declaredNulls('link', link._type), false);
    return {
      success: true,
      fromVersion,
      toVersion: schema.version,
      appliedAt: now(),
    };
  }

  async getSchema(_ctx: RequestContext, version?: number): Promise<OntologySchema> {
    const v = version ?? this._currentSchemaVersion;
    const schema = this._schemas.get(v);
    if (!schema) {
      throw new Error(`Schema version ${v} not found`);
    }
    return clone(schema);
  }

  // ─── Objects ───

  async createObject(ctx: RequestContext, type: string, properties: Record<string, unknown>): Promise<OntologyObject> {
    this._guardObject(type);
    return clone(this._doCreateObject(ctx, type, properties));
  }

  async getObject(ctx: RequestContext, type: string, id: string): Promise<OntologyObject | null> {
    this._guardObject(type);
    const obj = this._getObjectInternal(ctx, type, id);
    if (!obj) return null;
    if (obj._deletedAt) return null;
    return clone(obj);
  }

  async updateObject(ctx: RequestContext, type: string, id: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyObject> {
    this._guardObject(type);
    return clone(this._doUpdateObject(ctx, type, id, properties, expectedVersion));
  }

  async deleteObject(ctx: RequestContext, type: string, id: string, mode: 'soft' | 'hard'): Promise<void> {
    this._guardObject(type);
    if (mode === 'soft') {
      this._doSoftDeleteObject(ctx, type, id);
    } else {
      this._doHardDeleteObject(ctx, type, id);
    }
  }

  async queryObjects(ctx: RequestContext, type: string, filter: FilterExpression, options?: QueryOptions): Promise<ObjectPage> {
    this._guardObject(type);
    this._guardFilter('object', type, filter);
    let items = Array.from(this._objects.values()).filter((obj) => {
      if (obj._tenantId !== ctx.tenantId) return false;
      if (obj._type !== type) return false;
      if (!options?.includeDeleted && obj._deletedAt) return false;
      return evaluateFilter(obj as Record<string, unknown>, filter);
    });

    const totalCount = items.length;

    // Sorting
    if (options?.orderBy) {
      for (const sort of [...options.orderBy].reverse()) {
        items.sort((a, b) => {
          const aVal = (a as Record<string, unknown>)[sort.field];
          const bVal = (b as Record<string, unknown>)[sort.field];
          if (aVal === bVal) return 0;
          if (aVal === undefined || aVal === null) return 1;
          if (bVal === undefined || bVal === null) return -1;
          const cmp = aVal < bVal ? -1 : 1;
          return sort.direction === 'desc' ? -cmp : cmp;
        });
      }
    }

    // Pagination — enforce maximum limit to prevent DoS (matches Postgres provider)
    const MAX_QUERY_LIMIT = 1000;
    const offset = options?.offset ?? 0;
    const limit = Math.min(options?.limit ?? 100, MAX_QUERY_LIMIT);
    items = items.slice(offset, offset + limit);

    return {
      items: items.map((i) => clone(i)),
      totalCount,
      hasNextPage: offset + limit < totalCount,
    };
  }

  async aggregateObjects(ctx: RequestContext, type: string, query: AggregateQuery): Promise<AggregateResult> {
    this._guardObject(type);
    this._guardFilter('object', type, query.filter);
    if (!query.fields || query.fields.length === 0) {
      throw new Error('Aggregate query must specify at least one field');
    }
    // Validate aggregate functions upfront (before grouping) so invalid
    // functions always throw, even when there are zero matching rows.
    const ALLOWED_FNS = new Set(['count', 'sum', 'avg', 'min', 'max']);
    // Output names must be distinct (as on Postgres): results are keyed by
    // them, and an orderBy names one.
    const outputNames = new Set<string>();
    for (const f of query.fields) {
      const name = f.alias ?? `${f.fn}_${f.field}`;
      if (outputNames.has(name)) {
        throw new SchemaGuardError('VALIDATION_ERROR', `Aggregate output "${name}" is named twice`);
      }
      // Values are returned in a plain object, where this key sets the prototype.
      if (name === '__proto__') throw new SchemaGuardError('VALIDATION_ERROR', 'Aggregate output may not be named __proto__');
      outputNames.add(name);
    }
    for (const aggField of query.fields) {
      if (!ALLOWED_FNS.has(aggField.fn.toLowerCase())) {
        throw new Error(`Invalid aggregate function: ${aggField.fn}`);
      }
    }
    // 1. Collect matching objects (tenant-scoped, non-deleted)
    let items = Array.from(this._objects.values()).filter((obj) => {
      if (obj._tenantId !== ctx.tenantId) return false;
      if (obj._type !== type) return false;
      if (obj._deletedAt) return false;
      if (query.filter) return evaluateFilter(obj as Record<string, unknown>, query.filter);
      return true;
    });

    // 2. Group by groupBy fields
    const groupMap = new Map<string, Record<string, unknown>[]>();
    const groupKeyMap = new Map<string, Record<string, unknown>>();

    for (const obj of items) {
      const keys: Record<string, unknown> = {};
      if (query.groupBy) {
        for (const field of query.groupBy) {
          keys[field] = (obj as Record<string, unknown>)[field] ?? null;
        }
      }
      const groupKey = JSON.stringify(keys);
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, []);
        groupKeyMap.set(groupKey, keys);
      }
      groupMap.get(groupKey)!.push(obj as Record<string, unknown>);
    }

    // If no items and no groupBy, return empty
    if (groupMap.size === 0 && (!query.groupBy || query.groupBy.length === 0)) {
      // No groupBy: aggregate over all matching items as a single group
      groupMap.set('{}', []);
      groupKeyMap.set('{}', {});
      // Re-add all items to the single group
      for (const obj of items) {
        groupMap.get('{}')!.push(obj as Record<string, unknown>);
      }
    }

    // 3. Compute aggregates per group
    let groups: AggregateGroup[] = [];

    for (const [groupKey, groupItems] of groupMap) {
      const keys = groupKeyMap.get(groupKey)!;
      const values: Record<string, number | null> = {};

      for (const aggField of query.fields) {
        const fnLower = aggField.fn.toLowerCase();
        const alias = aggField.alias ?? `${aggField.fn}_${aggField.field}`;

        if (fnLower === 'count') {
          if (aggField.field === '*') {
            values[alias] = groupItems.length;
          } else {
            values[alias] = groupItems.filter(
              (item) => item[aggField.field] !== undefined && item[aggField.field] !== null,
            ).length;
          }
        } else {
          // sum, avg, min, max — only on numeric fields
          const numericValues = groupItems
            .map((item) => item[aggField.field])
            .filter((v): v is number => typeof v === 'number');

          if (numericValues.length === 0) {
            values[alias] = null;
          } else {
            switch (fnLower) {
              case 'sum':
                values[alias] = numericValues.reduce((a, b) => a + b, 0);
                break;
              case 'avg':
                values[alias] = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
                break;
              case 'min':
                values[alias] = Math.min(...numericValues);
                break;
              case 'max':
                values[alias] = Math.max(...numericValues);
                break;
            }
          }
        }
      }

      groups.push({ keys, values });
    }

    const totalGroups = groups.length;

    // 4. Apply ordering
    if (query.orderBy && query.orderBy.length > 0) {
      // A grouping key, else an aggregate output (as on Postgres); anything
      // else is not part of the result and is refused.
      const outputs = new Set(query.fields.map((f) => f.alias ?? `${f.fn}_${f.field}`));
      const keyFields = new Set(query.groupBy ?? []);
      for (const sort of query.orderBy) {
        if (!keyFields.has(sort.field) && !outputs.has(sort.field)) {
          throw new SchemaGuardError(
            'VALIDATION_ERROR',
            `Aggregate orderBy "${sort.field}" is neither a groupBy field nor an aggregate output`,
          );
        }
      }
      for (const sort of [...query.orderBy].reverse()) {
        const fromKeys = keyFields.has(sort.field);
        groups.sort((a, b) => {
          const aVal = (fromKeys ? a.keys[sort.field] : a.values[sort.field]) as unknown;
          const bVal = (fromKeys ? b.keys[sort.field] : b.values[sort.field]) as unknown;
          if (aVal === bVal) return 0;
          if (aVal === undefined || aVal === null) return 1;
          if (bVal === undefined || bVal === null) return -1;
          const cmp = aVal < bVal ? -1 : 1;
          return sort.direction === 'desc' ? -cmp : cmp;
        });
      }
    }

    // 5. Apply limit/offset
    const offset = query.offset ?? 0;
    const limit = query.limit ?? groups.length;
    groups = groups.slice(offset, offset + limit);

    return { groups, totalGroups };
  }

  async searchObjects(ctx: RequestContext, type: string, query: SearchQuery): Promise<SearchResult> {
    this._guardObject(type);
    this._guardFilter('object', type, query.filter);
    // Guard against empty search queries (matches Postgres provider behavior)
    if (!query.query || query.query.trim().length === 0) {
      return { hits: [], totalCount: 0, hasNextPage: false };
    }

    const queryLower = query.query.toLowerCase();
    const terms = queryLower.split(/\s+/).filter((t) => t.length > 0);

    // Collect candidate objects (tenant-scoped, type-matched, non-deleted)
    const candidates = Array.from(this._objects.values()).filter((obj) => {
      if (obj._tenantId !== ctx.tenantId) return false;
      if (obj._type !== type) return false;
      if (obj._deletedAt) return false;
      return true;
    });

    // Score and filter
    const scored: SearchHit[] = [];
    for (const obj of candidates) {
      // Determine which fields to search
      const searchFields = query.fields
        ? query.fields
        : Object.keys(obj).filter((k) => !k.startsWith('_') && typeof obj[k] === 'string');

      // Count occurrences of query terms across matching fields
      let score = 0;
      // Keyed by field name, so a Map: a property named like an
      // Object.prototype member (constructor) must not reach the prototype.
      const highlights = new Map<string, string[]>();

      for (const field of searchFields) {
        const val = Object.hasOwn(obj, field) ? obj[field] : undefined;
        if (typeof val !== 'string') continue;
        const valLower = val.toLowerCase();

        for (const term of terms) {
          let idx = 0;
          let count = 0;
          while ((idx = valLower.indexOf(term, idx)) !== -1) {
            count++;
            idx += term.length;
          }
          if (count > 0) {
            score += count;
            const list = highlights.get(field) ?? [];
            list.push(val);
            highlights.set(field, list);
          }
        }
      }

      if (score === 0) continue;

      // Apply additional filter if present
      if (query.filter && !evaluateFilter(obj as Record<string, unknown>, query.filter)) {
        continue;
      }

      scored.push({
        object: clone(obj),
        score,
        highlights: highlights.size > 0 ? Object.fromEntries(highlights) : undefined,
      });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const totalCount = scored.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? scored.length;
    const hits = scored.slice(offset, offset + limit);

    return {
      hits,
      totalCount,
      hasNextPage: offset + limit < totalCount,
    };
  }

  async bulkMutate(ctx: RequestContext, request: BulkMutationRequest): Promise<BulkMutationResult> {
    // Idempotency check — scoped by tenant to prevent cross-tenant cache hits
    const cacheKey = `${ctx.tenantId}:${request.idempotencyKey}`;
    const cached = this._idempotencyCache.get(cacheKey);
    if (cached) return clone(cached);

    let accepted = 0;
    let failed = 0;
    const errors: BulkMutationResult['errors'] = [];

    for (let i = 0; i < request.operations.length; i++) {
      const op = request.operations[i]!;
      try {
        switch (op.type) {
          case 'createObject':
            this._doCreateObject(ctx, op.objectType, op.properties);
            break;
          case 'updateObject':
            this._doUpdateObject(ctx, op.objectType, op.id, op.properties);
            break;
          case 'deleteObject':
            if (op.mode === 'soft') {
              this._doSoftDeleteObject(ctx, op.objectType, op.id);
            } else {
              this._doHardDeleteObject(ctx, op.objectType, op.id);
            }
            break;
        }
        accepted++;
      } catch (err) {
        failed++;
        errors.push({
          operationIndex: i,
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const result: BulkMutationResult = { accepted, failed, errors };
    this._idempotencyCache.set(cacheKey, result);
    return clone(result);
  }

  // ─── Links ───

  async createLink(
    ctx: RequestContext,
    type: string,
    fromId: string,
    toId: string,
    properties?: Record<string, unknown>,
  ): Promise<OntologyLink> {
    this._guardLink(type);
    return clone(this._doCreateLink(ctx, type, fromId, toId, properties));
  }

  async getLink(ctx: RequestContext, type: string, linkId: string): Promise<OntologyLink | null> {
    this._guardLink(type);
    const link = this._getLinkInternal(ctx, type, linkId);
    if (!link) return null;
    if (link._deletedAt) return null;
    return clone(link);
  }

  async updateLink(ctx: RequestContext, type: string, linkId: string, properties: Record<string, unknown>, expectedVersion?: number): Promise<OntologyLink> {
    this._guardLink(type);
    return clone(this._doUpdateLink(ctx, type, linkId, properties, expectedVersion));
  }

  async deleteLink(ctx: RequestContext, type: string, linkId: string): Promise<void> {
    this._guardLink(type);
    this._doDeleteLink(ctx, type, linkId);
  }

  /** An object of this tenant that exists and, unless deleted ones are wanted, is not soft-deleted. */
  private _visibleObject(
    ctx: RequestContext,
    type: string,
    id: string,
    includeDeleted: boolean,
  ): OntologyObject | undefined {
    // A link made with no schema applied records its endpoint types as
    // 'unknown': find such an endpoint by tenant and ID.
    const obj =
      type === UNKNOWN_ENDPOINT_TYPE
        ? [...this._objects.values()].find((o) => o._id === id && o._tenantId === ctx.tenantId)
        : this._objects.get(`${type}:${id}`);
    if (!obj || obj._tenantId !== ctx.tenantId) return undefined;
    if (!includeDeleted && obj._deletedAt) return undefined;
    return obj;
  }

  /**
   * Links of one type from or to an object, oldest first (creation time, then
   * ID), as on Postgres. By default soft-deleted links, and links whose other
   * end (or this end) is soft-deleted or gone, are left out (spec §3.3 rule
   * 3); includeDeleted returns them all. Default page size 100, at most 1000.
   */
  async getLinks(
    ctx: RequestContext,
    objectId: string,
    linkType: string,
    direction: 'inbound' | 'outbound',
    options?: QueryOptions,
  ): Promise<LinkPage> {
    this._guardLink(linkType);
    const includeDeleted = options?.includeDeleted ?? false;
    let items = Array.from(this._links.values()).filter((link) => {
      if (link._tenantId !== ctx.tenantId) return false;
      if (link._type !== linkType) return false;
      if (direction === 'outbound' ? link._fromId !== objectId : link._toId !== objectId) return false;
      if (includeDeleted) return true;
      if (link._deletedAt) return false;
      return (
        this._visibleObject(ctx, link._fromType, link._fromId, false) !== undefined &&
        this._visibleObject(ctx, link._toType, link._toId, false) !== undefined
      );
    });
    const order = (xt: string, xid: string, yt: string, yid: string): number =>
      xt < yt ? -1 : xt > yt ? 1 : xid < yid ? -1 : xid > yid ? 1 : 0;
    items.sort((x, y) => order(x._createdAt, x._id, y._createdAt, y._id));

    const totalCount = items.length;
    const limit = Math.min(options?.limit ?? 100, 1000);
    assertCursorOrOffset(options);
    let hasNextPage: boolean;
    if (options?.after !== undefined) {
      // Keyset: the links after the cursor's position.
      const after = decodeLinkCursor(options.after);
      // This provider's cursors carry the link's ISO timestamp.
      const at = new Date(after.t);
      if (Number.isNaN(at.getTime()) || at.toISOString() !== after.t) {
        throw new SchemaGuardError('VALIDATION_ERROR', 'Malformed link cursor');
      }
      const rest = items.filter((l) => order(l._createdAt, l._id, after.t, after.id) > 0);
      items = rest.slice(0, limit);
      hasNextPage = rest.length > limit;
    } else {
      const offset = options?.offset ?? 0;
      items = items.slice(offset, offset + limit);
      hasNextPage = offset + limit < totalCount;
    }
    const last = items[items.length - 1];

    return {
      items: items.map((i) => clone(i)),
      totalCount,
      hasNextPage,
      ...(last ? { cursor: encodeLinkCursor({ t: last._createdAt, id: last._id }) } : {}),
    };
  }

  /**
   * Walk the path from startId, one step per hop. Each step follows links of
   * its type in its direction from the current frontier, keeps the targets
   * that are visible and pass the step's filter, and records an edge only
   * for a target it keeps. Nodes and the frontier are keyed by type and ID.
   * By default soft-deleted links and objects are not traversed, the start
   * object included (spec §3.3 rule 3). Returns the last step's nodes, in
   * the order first reached, paginated (default 100), and every recorded
   * edge.
   */
  async traverse(
    ctx: RequestContext,
    startId: string,
    path: TraversalPath,
    options?: TraversalOptions,
  ): Promise<TraversalResult> {
    this._guardPath(path);
    // Match Postgres traversal safety limits (PERF-03)
    const MAX_TRAVERSAL_DEPTH = 10;
    const MAX_TRAVERSAL_NODES = 10_000;

    if (path.steps.length > MAX_TRAVERSAL_DEPTH) {
      throw new Error(`Traversal depth ${path.steps.length} exceeds maximum of ${MAX_TRAVERSAL_DEPTH}`);
    }

    const includeDeleted = options?.includeDeleted ?? false;
    const collectedEdges = new Map<string, OntologyLink>();
    let totalNodesSeen = 0;
    let frontier: Array<{ type: string | undefined; id: string }> = [{ type: undefined, id: startId }];
    let stepNodes = new Map<string, OntologyObject>();

    for (const step of path.steps) {
      if (frontier.length === 0) break;
      const nextNodes = new Map<string, OntologyObject>();
      for (const { type, id } of frontier) {
        for (const link of this._links.values()) {
          if (totalNodesSeen >= MAX_TRAVERSAL_NODES) break;
          if (link._tenantId !== ctx.tenantId || link._type !== step.linkType) continue;
          if (!includeDeleted && link._deletedAt) continue;
          const outbound = step.direction === 'outbound';
          const srcType = outbound ? link._fromType : link._toType;
          const srcId = outbound ? link._fromId : link._toId;
          if (srcId !== id || (type !== undefined && srcType !== type)) continue;
          // The start object is checked here, by the type its links give it.
          if (!this._visibleObject(ctx, srcType, srcId, includeDeleted)) continue;
          const tgtType = outbound ? link._toType : link._fromType;
          const tgtId = outbound ? link._toId : link._fromId;
          const target = this._visibleObject(ctx, tgtType, tgtId, includeDeleted);
          if (!target) continue;
          if (step.filter && !evaluateFilter(target as Record<string, unknown>, step.filter)) continue;
          collectedEdges.set(`${link._type}:${link._id}`, link);
          const nodeKey = `${tgtType}:${tgtId}`;
          if (!nextNodes.has(nodeKey)) {
            nextNodes.set(nodeKey, target);
            totalNodesSeen++;
          }
        }
      }
      stepNodes = nextNodes;
      frontier = Array.from(nextNodes.values()).map((n) => ({ type: n._type, id: n._id }));
    }

    // nodes = only the final step's results; edges = all traversed edges
    const nodes = Array.from(stepNodes.values()).map((n) => clone(n));
    const edges = Array.from(collectedEdges.values()).map((e) => clone(e));

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    const paginatedNodes = nodes.slice(offset, offset + limit);

    return {
      nodes: paginatedNodes,
      edges,
      totalCount: nodes.length,
    };
  }

  // ─── Schema guards (unknown type / filter field) ───

  private _guardSchema(): OntologySchema | undefined {
    return this._currentSchemaVersion > 0 ? this._schemas.get(this._currentSchemaVersion) : undefined;
  }

  /** @internal Throws TYPE_NOT_FOUND for an undeclared object type. */
  _guardObject(type: string): void {
    assertObjectType(this._guardSchema(), type);
  }

  /** @internal Throws TYPE_NOT_FOUND for an undeclared link type. */
  _guardLink(type: string): void {
    assertLinkType(this._guardSchema(), type);
  }

  /** @internal Throws INVALID_FILTER for a filter naming an undeclared field. */
  _guardFilter(kind: 'object' | 'link', type: string, filter: FilterExpression | undefined): void {
    assertFilterFields(this._guardSchema(), kind, type, filter);
  }

  /** Each step's link type, and its filter against the step's target type. */
  private _guardPath(path: TraversalPath): void {
    const schema = this._guardSchema();
    for (const step of path.steps) {
      assertLinkType(schema, step.linkType);
      const def = schema?.linkTypes.find((t) => t.name === step.linkType);
      if (def && step.filter) {
        assertFilterFields(schema, 'object', step.direction === 'outbound' ? def.toType : def.fromType, step.filter);
      }
    }
  }

  // ─── Transactions ───

  async beginTransaction(ctx: RequestContext): Promise<Transaction> {
    return new MemoryTransaction(this, ctx);
  }

  // ─── Versioning ───

  async getObjectAtVersion(ctx: RequestContext, type: string, id: string, version: number): Promise<OntologyObject | null> {
    this._guardObject(type);
    const key = `${type}:${id}`;
    const history = this._versionHistory.get(key);
    if (!history) return null;
    const snapshot = history.find((h) => h._version === version && h._tenantId === ctx.tenantId);
    return snapshot ? clone(snapshot) : null;
  }

  async getObjectAtTime(ctx: RequestContext, type: string, id: string, timestamp: DateTime): Promise<OntologyObject | null> {
    this._guardObject(type);
    const key = `${type}:${id}`;
    const history = this._versionHistory.get(key);
    if (!history) return null;

    const ts = new Date(timestamp).getTime();
    // Find the latest version whose _updatedAt <= timestamp
    let best: OntologyObject | null = null;
    for (const snapshot of history) {
      if (snapshot._tenantId !== ctx.tenantId) continue;
      const snapshotTime = new Date(snapshot._updatedAt).getTime();
      if (snapshotTime <= ts) {
        best = snapshot;
      }
    }
    return best ? clone(best) : null;
  }

  // ─── Indices ───

  async ensureIndex(_ctx: RequestContext, _type: string, _index: IndexDefinition): Promise<void> {
    // No-op for in-memory provider; indices don't affect correctness
  }

  async dropIndex(_ctx: RequestContext, _type: string, _field: string): Promise<void> {
    // No-op for in-memory provider
  }

  async listIndexes(_ctx: RequestContext, _type: string): Promise<IndexDefinition[]> {
    return [];
  }

  // ─── Health ───

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: true,
      provider: 'memory',
      latencyMs: 0,
    };
  }

  capabilities(): StorageCapabilities {
    return {
      supportsTransactions: true,
      supportsTemporalQueries: true,
      supportsFullTextSearch: true,
      supportsGeoQueries: false,
      supportsGraphTraversal: true,
      supportsBulkMutations: true,
      maxTraversalDepth: 10,
      replicationSupport: 'NONE',
    };
  }
}
