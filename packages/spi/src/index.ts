/**
 * @openfoundry/spi - Storage Provider Interface
 *
 * Core type definitions for the Open Foundry platform.
 * This package defines the contracts that all storage providers,
 * consent managers, and platform components implement.
 */

// Scalar types
export type { DateTime, Duration } from './scalars.js';

// Error model (Section 8.8)
export type { ErrorCategory, ErrorCode, PlatformError } from './errors.js';

// Core ontology types (Section 3.2)
export type {
  OntologyObject,
  OntologyLink,
  FilterExpression,
  FieldPredicate,
  LogicalPredicate,
  TraversalPath,
  TraversalStep,
  TraversalOptions,
  QueryOptions,
  RequestContext,
  BulkMutationRequest,
  BulkOperation,
  BulkMutationResult,
  BulkMutationError,
  ObjectPage,
  LinkPage,
  TraversalResult,
  OntologySchema,
  ObjectTypeDefinition,
  LinkTypeDefinition,
  PropertyDefinition,
  IndexDefinition,
  IndexType,
  MigrationResult,
  HealthStatus,
  ReplicationCapability,
  StorageCapabilities,
  AggregateFunction,
  AggregateField,
  AggregateQuery,
  AggregateGroup,
  AggregateResult,
  SearchQuery,
  SearchHit,
  SearchResult,
} from './ontology.js';

// Transaction (Section 3.4)
export type { Transaction } from './transaction.js';

// Storage Provider (Section 3.1)
export type { StorageProvider } from './storage-provider.js';

// CloudEvents (Section 4.2)
export type { CloudEvent, CloudEventType } from './events.js';

// Audit (Section 7.2)
export type {
  AuditRecord,
  AuditActor,
  AuditOperation,
  AuditDetail,
  AuditStore,
  AuditFilter,
  AuditQueryOptions,
  AuditPage,
} from './audit.js';

// Field provenance (Section 4.6)
export type { FieldProvenance, ProvenanceSource } from './provenance.js';

// Consent (Section 7.3)
export { DataPurpose, STANDARD_DATA_PURPOSES } from './consent.js';
export type {
  ConsentDecision,
  ConsentManager,
  ConsentRecord,
  FieldRestriction,
  RevocationResult,
} from './consent.js';

// Backup/Restore (Section 3.9)
export type {
  BackupCapability,
  BackupOptions,
  BackupFilter,
  BackupHandle,
  RestoreOptions,
  RestoreResult,
} from './backup.js';

// Object Sets (Section 8.3)
export type {
  ObjectSetDefinition,
  ObjectSetStore,
} from './object-set.js';

// Schema guards shared by storage providers (unknown type / filter field)
export {
  SchemaGuardError,
  SYSTEM_FILTER_FIELDS,
  systemFilterKey,
  assertObjectType,
  assertLinkType,
  assertFilterFields,
  filterFields,
} from './schema-guards.js';
