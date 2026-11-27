/**
 * Core ontology types (Section 3.2).
 */

import type { DateTime } from './scalars.js';

// ---------------------------------------------------------------------------
// Domain objects & links
// ---------------------------------------------------------------------------

/** A persisted ontology object with tenant isolation. */
export interface OntologyObject {
  _tenantId: string;
  _type: string;
  _id: string;
  _version: number;
  _createdAt: DateTime;
  _updatedAt: DateTime;
  _deletedAt?: DateTime;
  [key: string]: unknown;
}

/** A typed, directed relationship between two ontology objects. */
export interface OntologyLink {
  _tenantId: string;
  _type: string;
  _id: string;
  _fromType: string;
  _fromId: string;
  _toType: string;
  _toId: string;
  _version: number;
  _createdAt: DateTime;
  _updatedAt: DateTime;
  _deletedAt?: DateTime;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export type FilterExpression = FieldPredicate | LogicalPredicate;

export interface FieldPredicate {
  field: string;
  operator:
    | 'eq'
    | 'neq'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'in'
    | 'contains'
    | 'startsWith'
    | 'exists';
  value?: unknown;
}

export interface LogicalPredicate {
  and?: FilterExpression[];
  or?: FilterExpression[];
  not?: FilterExpression;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface TraversalPath {
  steps: TraversalStep[];
}

export interface TraversalStep {
  linkType: string;
  direction: 'inbound' | 'outbound';
  filter?: FilterExpression;
  maxDepth?: number;
}

export interface TraversalOptions {
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface QueryOptions {
  limit?: number;
  offset?: number;
  /**
   * getLinks only: continue after the link a previous page's `cursor` names,
   * in the same order (creation time, then ID). Unlike an offset, a cursor
   * does not shift when links before it are deleted. Not combined with a
   * non-zero offset. Opaque, and only valid with the provider that issued it.
   */
  after?: string;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  includeDeleted?: boolean;
  asOfVersion?: number;
  asOfTime?: DateTime;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** Tenant-scoped context passed to every SPI operation. */
export interface RequestContext {
  tenantId: string;
  actorId?: string;
  traceId?: string;
}

// ---------------------------------------------------------------------------
// Bulk mutations
// ---------------------------------------------------------------------------

export interface BulkMutationRequest {
  idempotencyKey: string;
  operations: BulkOperation[];
}

export type BulkOperation =
  | { type: 'createObject'; objectType: string; properties: Record<string, unknown> }
  | { type: 'updateObject'; objectType: string; id: string; properties: Record<string, unknown> }
  | { type: 'deleteObject'; objectType: string; id: string; mode: 'soft' | 'hard' };

export interface BulkMutationResult {
  accepted: number;
  failed: number;
  errors: BulkMutationError[];
}

export interface BulkMutationError {
  operationIndex: number;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Pagination result types
// ---------------------------------------------------------------------------

export interface ObjectPage {
  items: OntologyObject[];
  totalCount: number;
  hasNextPage: boolean;
  cursor?: string;
}

export interface LinkPage {
  items: OntologyLink[];
  totalCount: number;
  /**
   * Whether links follow this page, decided by the same read as the page, so
   * it is exact at that moment (totalCount may come from an earlier one).
   */
  hasNextPage: boolean;
  /** Where this page ends (set when it has items): pass it as `after`. */
  cursor?: string;
}

export interface TraversalResult {
  nodes: OntologyObject[];
  edges: OntologyLink[];
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Schema representation
// ---------------------------------------------------------------------------

/** Parsed representation of an ODL ontology schema (Section 2). */
export interface OntologySchema {
  version: number;
  objectTypes: ObjectTypeDefinition[];
  linkTypes: LinkTypeDefinition[];
}

export interface ObjectTypeDefinition {
  name: string;
  properties: PropertyDefinition[];
  indexes?: IndexDefinition[];
}

export interface LinkTypeDefinition {
  name: string;
  fromType: string;
  toType: string;
  cardinality: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE' | 'MANY_TO_MANY';
  properties?: PropertyDefinition[];
}

export interface PropertyDefinition {
  name: string;
  type: string;
  required?: boolean;
  defaultValue?: unknown;
  description?: string;
}

export interface IndexDefinition {
  field: string;
  indexType: IndexType;
  /** If true, a UNIQUE constraint is generated instead of a regular index. */
  unique?: boolean;
}

// ---------------------------------------------------------------------------
// Storage metadata types
// ---------------------------------------------------------------------------

export type IndexType = 'BTREE' | 'HASH' | 'GIN' | 'GIST' | 'FULLTEXT';

export interface MigrationResult {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  appliedAt: DateTime;
  details?: string;
}

export interface HealthStatus {
  healthy: boolean;
  provider: string;
  latencyMs: number;
  details?: Record<string, unknown>;
}

export type ReplicationCapability =
  | 'NONE'
  | 'STREAMING_REPLICATION'
  | 'POINT_IN_TIME_RECOVERY'
  | 'BOTH';

export interface StorageCapabilities {
  supportsTransactions: boolean;
  supportsTemporalQueries: boolean;
  supportsFullTextSearch: boolean;
  supportsGeoQueries: boolean;
  supportsGraphTraversal: boolean;
  supportsBulkMutations: boolean;
  maxTraversalDepth: number;
  replicationSupport: ReplicationCapability;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateField {
  field: string;          // Property name ('*' for count)
  fn: AggregateFunction;
  alias?: string;         // Optional result key alias
}

export interface AggregateQuery {
  fields: AggregateField[];
  groupBy?: string[];
  filter?: FilterExpression;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface AggregateGroup {
  keys: Record<string, unknown>;
  values: Record<string, number | null>;
}

export interface AggregateResult {
  groups: AggregateGroup[];
  totalGroups: number;
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  query: string;
  fields?: string[];
  filter?: FilterExpression;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  object: OntologyObject;
  score: number;
  highlights?: Record<string, string[]>;
}

export interface SearchResult {
  hits: SearchHit[];
  totalCount: number;
  hasNextPage: boolean;
}
