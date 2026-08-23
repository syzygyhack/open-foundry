# Open Foundry — Technical Specification v2.0

**Status:** Draft
**Date:** February 2026

---

## 1. Overview

Open Foundry is an open-source ontology platform for building operational digital twins. It provides the semantic, kinetic, and security layers needed to turn commodity data infrastructure into a coherent, queryable, actionable model of a real-world system.

The platform is domain-neutral. Domain-specific functionality is delivered through **Domain Packs** — composable schema and connector bundles. The first Domain Pack targets NHS acute healthcare.

### 1.1 What This Document Is

This is an engineering specification. It defines the components, interfaces, data models, protocols, and contracts needed to build Open Foundry. It does not cover funding, staffing, timelines, or business strategy.

### 1.2 Design Principles

1. **Open source** — Apache 2.0 licence. No proprietary dependencies.
2. **Composable** — every layer is independently replaceable via defined interfaces.
3. **Storage-agnostic** — all persistence goes through a Storage Provider Interface (SPI). No hardcoded database.
4. **Standards-native** — GraphQL, CloudEvents, OpenTelemetry, OIDC, FHIR where applicable.
5. **Federation-first** — multi-instance, multi-tenant from day one. Not bolted on later.
6. **Schema-driven** — the ontology schema is the single source of truth. APIs, permissions, SDKs, and UIs are generated from it.
7. **Observable** — every layer emits structured traces, metrics, and logs via OpenTelemetry. Instrumentation is specified alongside interfaces, not added after the fact.

### 1.3 Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                   Application Framework                  │
│            (widgets, dashboards, app builder)             │
├─────────────────────────────────────────────────────────┤
│                    Query & API Layer                      │
│              (GraphQL, REST, FHIR, SDKs)                 │
├─────────────────────────────────────────────────────────┤
│                    Action Framework                       │
│        (action types, execution, side-effects)           │
├──────────────────────┬──────────────────────────────────┤
│   Security Layer     │        Sync Engine                │
│  (ReBAC, audit,      │  (CDC, connectors, mapping,      │
│   consent)           │   conflict resolution)            │
├──────────────────────┴──────────────────────────────────┤
│                    Ontology Engine                        │
│    (schema registry, object store, relationship index)   │
├─────────────────────────────────────────────────────────┤
│               Storage Provider Interface                 │
│          (TypeDB | Neo4j | PostgreSQL+AGE | …)           │
└─────────────────────────────────────────────────────────┘
```

Each layer communicates only with adjacent layers through defined interfaces. No layer MAY bypass the stack — in particular, no application or API MAY bypass the Security Layer to reach the Ontology Engine directly.

### 1.4 Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHALL NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` in this document are to be interpreted as described in RFC 2119 and RFC 8174.

Unless a section explicitly says otherwise, code snippets and examples are informative (non-normative).

---

## 2. Ontology Definition Language (ODL)

ODL is the schema language for Open Foundry. It is an **extension of GraphQL SDL** — any valid ODL schema is parseable by standard GraphQL tooling, with Open Foundry-specific semantics expressed through directives.

This decision means: developers already know the syntax, existing GraphQL tooling (linters, formatters, IDE plugins) works out of the box, and the API layer can generate a GraphQL API directly from the schema with minimal transformation.

### 2.1 Core Types

ODL adds the following semantic concepts on top of GraphQL SDL via directives.

#### 2.1.1 Object Types

An ObjectType models a real-world entity or event. It is declared as a standard GraphQL `type` with the `@objectType` directive.

```graphql
type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String!
  dateOfBirth: Date!
  status: PatientStatus!
  triageCategory: TriageCategory
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
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
```

Every ObjectType MUST have exactly one field marked `@primary`. This is the globally unique identifier for instances of this type.

#### 2.1.2 Interfaces

Interfaces define shared shapes that ObjectTypes can implement. They work exactly as in GraphQL.

```graphql
interface Identifiable {
  id: ID! @primary
}

interface Locatable {
  location: GeoPoint
  address: String
}

interface Auditable {
  createdAt: DateTime! @readonly
  createdBy: String! @readonly
  updatedAt: DateTime! @readonly
  updatedBy: String! @readonly
}

type Ward implements Identifiable & Locatable & Auditable @objectType {
  id: ID! @primary
  name: String!
  specialty: String!
  capacity: Int!
  currentOccupancy: Int @computed(fn: "countLinks", args: { type: "AdmittedTo" })
  location: GeoPoint
  address: String
  createdAt: DateTime! @readonly
  createdBy: String! @readonly
  updatedAt: DateTime! @readonly
  updatedBy: String! @readonly
}
```

#### 2.1.3 Link Types

Links are first-class relationships between ObjectTypes. They are declared as GraphQL types with the `@linkType` directive.

```graphql
type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  admissionDate: DateTime!
  expectedDischarge: DateTime
  admittingConsultant: Consultant @link(type: "REFERRED_BY")
  reason: String
}
```

Every LinkType MUST have an `id` field of type `ID!` marked `@primary`. This is REQUIRED because the same pair of objects can be linked multiple times by the same LinkType (e.g., a patient readmitted to the same ward). The link `id` disambiguates these cases and is required for targeted deletion and history queries.

**Link ID generation:** The Ontology Engine is responsible for generating link IDs before passing them to the SPI. The SPI receives a fully-formed `OntologyLink` (including `_id`) and stores it as-is. The Engine generates IDs using a UUIDv7 strategy (time-ordered, globally unique). SPI providers MUST NOT generate or override link IDs.

Links can carry their own properties (unlike simple GraphQL field references). Cardinality options: `ONE_TO_ONE`, `ONE_TO_MANY`, `MANY_TO_ONE`, `MANY_TO_MANY`. Note that cardinality constrains the number of *active* links at any point in time — historical (terminated) links do not count against cardinality limits.

On ObjectTypes, links are referenced via the `@link` field directive:

```graphql
type Patient @objectType {
  # ...
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
  admissions: [AdmittedTo!]! @link(type: "AdmittedTo", direction: OUTBOUND, history: true)
}

type Ward @objectType {
  # ...
  patients: [Patient!]! @link(type: "AdmittedTo", direction: INBOUND)
}
```

The `history: true` flag returns all links (including terminated ones), not just the currently active link.

**Directive disambiguation:** The `@linkType` directive (on a `type` declaration) defines a new LinkType in the schema. The `@link` directive (on a field within an ObjectType) creates a traversal reference to an existing LinkType. These are distinct directives with different signatures and cannot be confused.

#### 2.1.4 Action Types

ActionTypes define validated, auditable mutations. They are declared with `@actionType`.

```graphql
type DischargePatient @actionType {
  """The patient to discharge"""
  patient: Patient! @param
  """Where the patient is going"""
  destination: DischargeDestination! @param
  """Clinical notes for the discharge"""
  notes: String @param
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}
```

Action behaviour (preconditions, effects, side-effects) is defined in a companion YAML manifest. See Section 5.

#### 2.1.5 Functions

Functions are named computations over the ontology. They are declared with `@function` and implemented in code (TypeScript or Python).

```graphql
type WaitingListRisk @function(
  runtime: "typescript"
  entry: "src/functions/waitingListRisk.ts"
) {
  patient: Patient! @param
  riskScore: Float!
  riskFactors: [String!]!
  recommendedAction: String
}
```

Functions execute in a sandboxed runtime with read-only access to the ontology. They cannot mutate state — all mutations go through Actions.

Function sandbox requirements:

1. Runtime isolation MUST use either WASM isolation (preferred) or V8 isolates with syscall/network restrictions enforced by policy.
2. Functions MUST run with no ambient filesystem access and no outbound network access unless explicitly allowlisted per function.
3. CPU, memory, and execution-time limits MUST be enforced per invocation (timeouts are reported as `TIMEOUT` errors).
4. Dependency loading MUST be deterministic and pinned (hash-locked package set per Domain Pack version).
5. Function logs MUST inherit request trace context and automatically redact fields marked `@sensitive`.

### 2.2 Scalar Types

ODL extends GraphQL's built-in scalars with types commonly needed in operational systems.

| Scalar | Description | Example |
|--------|-------------|---------|
| `ID` | Global unique identifier | `"patient-abc-123"` |
| `String` | UTF-8 text | `"John Smith"` |
| `Int` | 32-bit signed integer | `42` |
| `Float` | IEEE 754 double | `98.6` |
| `Boolean` | True/false | `true` |
| `Date` | ISO 8601 date | `"2026-02-06"` |
| `DateTime` | ISO 8601 datetime with timezone | `"2026-02-06T14:30:00Z"` |
| `Duration` | ISO 8601 duration | `"P18W"` (18 weeks) |
| `GeoPoint` | Latitude/longitude pair | `{ lat: 51.5074, lon: -0.1278 }` |
| `JSON` | Arbitrary JSON blob | `{ "key": "value" }` |
| `URI` | RFC 3986 URI | `"https://fhir.nhs.uk/Patient/123"` |

Domain Packs MAY register additional scalars.

#### 2.2.1 CodeableConcept

`CodeableConcept` is a structured type (not a scalar) representing a terminology-bound code. It is defined as a GraphQL type so that its constituent fields are individually queryable and filterable.

```graphql
type CodeableConcept {
  system: URI!
  code: String!
  display: String!
}

input CodeableConceptInput {
  system: URI!
  code: String!
  display: String!
}

input CodeableConceptFilter {
  system: URIFilter
  code: StringFilter
  display: StringFilter
}
```

This design allows queries like "all patients with a SNOMED code starting with `7321`" without needing to deserialise an opaque scalar. Fields using `CodeableConcept` are declared normally:

```graphql
type Diagnosis @objectType {
  id: ID! @primary
  code: CodeableConcept! @terminology(system: "http://snomed.info/sct")
  patient: Patient! @link(type: "DiagnosedWith", direction: OUTBOUND)
}
```

### 2.3 Directives Reference

| Directive | Applies To | Description |
|-----------|-----------|-------------|
| `@objectType` | type | Marks a type as an ontology ObjectType |
| `@linkType(from, to, cardinality)` | type | Marks a type as a LinkType |
| `@link(type, direction, history?)` | field | References a link from an ObjectType field |
| `@actionType` | type | Marks a type as an ActionType |
| `@function(runtime, entry)` | type | Marks a type as a Function |
| `@primary` | field | Marks the primary identifier field |
| `@unique` | field | Enforces uniqueness across all instances |
| `@indexed` | field | Creates a storage-level index for fast lookup |
| `@readonly` | field | Field cannot be set by users; managed by the engine |
| `@computed(fn, args?, cache?, ttl?)` | field | Field value derived from a function or aggregation. See Section 4.4. |
| `@deprecated(reason)` | any | Marks schema element as deprecated |
| `@param` | field (on @actionType or @function) | Marks a field as an input parameter |
| `@constraint(expr)` | field, type | Validation expression. Field-level: `value` refers to the field (e.g., `"value >= 0"`). Type-level: `this` refers to the object (e.g., `"this.endDate > this.startDate"`). See Section 2.3.2. |
| `@default(value)` | field | Default value for optional fields |
| `@immutable` | field | Field value cannot be changed after object creation. See Section 2.3.3. |
| `@sensitive` | field | Marks field as containing sensitive data (affects logging, access) |
| `@terminology(system)` | field | Binds a CodeableConcept field to a terminology system |
| `@searchable(weight?, analyzer?)` | field | Includes field in full-text index when supported |

#### 2.3.1 `@searchable` Directive Semantics

The `@searchable` directive controls full-text index inclusion and is distinct from `@indexed` (which creates structured/exact-match indices for filter predicates).

```graphql
type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed          # Exact-match index only
  name: String! @searchable(weight: 2.0)      # Full-text indexed, boosted
  clinicalNotes: String @searchable(analyzer: "english")  # Full-text with language analyzer
  dateOfBirth: Date!                          # Not indexed at all
}
```

Behaviour:

1. `@searchable` fields are included in the full-text index used by `searchFoos`, `searchAll`, and `typeahead` queries.
2. `weight` (default `1.0`) controls relevance boosting. Higher weight means matches on this field rank higher.
3. `analyzer` (default `"standard"`) selects the text analysis pipeline (tokenisation, stemming, stop words). Common values: `"standard"`, `"english"`, `"keyword"` (no analysis).
4. `@searchable` is only effective when the storage provider reports `supportsFullTextSearch: true`. When `false`, the directive is accepted by the compiler but has no runtime effect.
5. A field MAY have both `@indexed` and `@searchable` — they create independent indices for different query paths.

#### 2.3.2 `@constraint` Directive Semantics

The `@constraint` directive validates values using CEL expressions. It can be applied at two levels:

**Field-level constraints** validate a single field's value. The implicit variable `value` refers to the proposed field value:

```graphql
type Ward @objectType {
  id: ID! @primary
  capacity: Int! @constraint(expr: "value > 0")
  name: String! @constraint(expr: "value.size() >= 2 && value.size() <= 100")
}
```

**Type-level constraints** validate cross-field invariants. The implicit variable `this` refers to the full proposed object state:

```graphql
type TheatreSlot @objectType @constraint(expr: "this.endTime > this.startTime") {
  id: ID! @primary
  startTime: DateTime!
  endTime: DateTime!
  procedure: String
}
```

Multiple constraints can be stacked. Each is evaluated independently; all must pass.

```graphql
type WaitingListEntry @objectType
  @constraint(expr: "this.targetDate > this.referralDate")
  @constraint(expr: "this.priority >= 1 && this.priority <= 4")
{
  id: ID! @primary
  referralDate: DateTime!
  targetDate: DateTime!
  priority: Int!
}
```

Constraint evaluation rules:

1. Field-level constraints are evaluated first, then type-level constraints. If a field-level constraint fails, type-level constraints are skipped (the object state may be invalid).
2. `value` (field-level) and `this` (type-level) are the only implicit variables. Constraints cannot reference other objects or links — use data quality rules (Section 4.7) for cross-object validation.
3. On `updateObject`, field-level constraints evaluate only for fields included in the update. Type-level constraints always evaluate against the full merged state (existing values + proposed changes).
4. Constraint expressions use CEL and are type-checked at schema compilation time against the ODL type system (Section 5.2.3).
5. Constraint failures produce `CONSTRAINT_VIOLATION` errors with the failing expression and the field(s) involved.

#### 2.3.3 `@immutable` Directive Semantics

The `@immutable` directive prevents a field's value from being changed after object creation. The field MUST be set during `createObject` (if required) and is rejected on any subsequent `updateObject` that includes the field.

```graphql
type DischargeRecord @objectType {
  id: ID! @primary
  patient: Patient! @link(type: "DischargedPatient", direction: OUTBOUND) @immutable
  dischargeDate: DateTime! @immutable
  destination: DischargeDestination! @immutable
  notes: String                    # Mutable — can be amended after discharge
}
```

Behaviour:

1. `@immutable` fields are writable during `createObject` and read-only on all subsequent `updateObject` calls. Any update that includes an immutable field returns an `IMMUTABLE_FIELD` error.
2. `@immutable` is distinct from `@readonly`. `@readonly` fields (like `_createdAt`) are managed by the engine and cannot be set by users at all. `@immutable` fields are set by the user at creation time and frozen thereafter.
3. `@immutable` MAY be combined with `@constraint` — the constraint is evaluated at creation time only.
4. Soft-delete and hard-delete are not affected by `@immutable` — the directive constrains field-level updates, not object lifecycle operations.
5. The ODL compiler rejects `@immutable` on `@computed` fields (they are engine-managed) and on `@primary` fields (already immutable by definition).

### 2.4 Namespaces

Schemas are organised into namespaces to avoid collisions across Domain Packs and instances.

```graphql
# schema: nhs.acute
# version: 1.4.0
# depends: openfoundry.core >= 1.0.0

extend schema @namespace(name: "nhs.acute", version: "1.4.0")

type Patient @objectType {
  # ...
}
```

Namespaces are dot-separated. The `openfoundry.core` namespace is always available and provides base interfaces (`Identifiable`, `Auditable`, `Locatable`, `Temporal`).

### 2.5 Schema Lifecycle

1. **Author** — write or modify `.odl` files (which are valid `.graphql` files).
2. **Validate** — the ODL compiler checks type consistency, directive correctness, link cardinality coherence, and constraint expressions.
3. **Diff** — the compiler produces a migration diff showing additions, modifications, and removals. The diff tool also supports generating a **reverse diff** for rollback purposes.
4. **Classify** — changes are classified as safe (additive), compatible (backward-compatible modification), or breaking (requires migration).
5. **Apply** — safe and compatible changes are auto-applied. Breaking changes require an explicit migration plan.
6. **Version** — the applied schema is stored in the schema registry as an immutable, versioned snapshot.

Schema versions are monotonic. Clients MAY query the ontology at any historical schema version.

#### 2.5.1 Schema Rollback

Schema versions are forward-only — there is no "undo" operation. To roll back a problematic schema change, the operator generates a reverse diff from the failed version and applies it as a new, higher-numbered version. The ODL compiler provides a command for this:

```bash
odl rollback --from-version 15 --to-version 14 --output rollback-migration.yaml
odl apply --migration rollback-migration.yaml
# This creates version 16, which has the same effective schema as version 14
```

The reverse diff is subject to the same classify step as any other migration. If the original change was additive (e.g., adding an ObjectType), the rollback is a removal, which is a breaking change and requires an explicit migration plan that addresses any data created under the schema being rolled back.

#### 2.5.2 Data Migration Plans

Breaking schema changes that require data reshaping MUST include a machine-readable data migration plan. The plan is executed by the migration runner before the new schema version is activated for writes.

```yaml
# migrations/2026-02-ward-specialty-split.yaml
migration:
  id: "mig-2026-02-ward-specialty-split"
  fromSchemaVersion: 21
  toSchemaVersion: 22
  mode: ONLINE               # ONLINE | MAINTENANCE
  dryRunSupported: true

  prechecks:
    - expr: "count('Ward', specialty != null) > 0"
      error: "No wards with specialty found"

  transforms:
    - objectType: Ward
      set:
        specialtyCode: "mapSpecialtyCode(specialty)"
        specialtyDisplay: "specialty"

  verification:
    - expr: "count('Ward', specialtyCode == null) == 0"
      error: "specialtyCode backfill incomplete"

  rollback:
    strategy: REVERSE_TRANSFORM
    window: "PT2H"
```

**Migration expression language:** All expressions in migration `prechecks`, `transforms`, and `verification` blocks use **CEL** — the same expression language used by the Action Framework (Section 5.2). Transform `set` values are CEL expressions evaluated against the current object state. Custom functions (like `mapSpecialtyCode` in the example above) are registered as CEL extension functions via a migration function registry, which is a map of `name → (args) → value` callables loaded from the Domain Pack's `functions/` directory. This ensures a single expression language across the platform.

Migration execution contract:

1. `dry-run` MUST produce a row/object impact report before execution.
2. Transform steps are idempotent and resumable.
3. Verification checks are REQUIRED; failed verification aborts activation.
4. Every migration run emits an immutable run record with status, duration, and failed-object sample.
5. The ODL toolchain MUST ship a **JSON Schema** (`migration-manifest.schema.json`) that validates migration YAML structure. The `odl validate` command MUST validate migration manifests against this schema before execution. CI pipelines SHOULD include schema validation as a pre-merge gate.

### 2.6 Schema Workspaces

Ontology development supports isolated workspaces to allow branching and validation before production apply.

```typescript
interface SchemaWorkspace {
  id: string;
  name: string;
  baseSchemaVersion: number;
  headSchemaVersion?: number;
  owner: string;
  createdAt: DateTime;
  status: 'ACTIVE' | 'MERGED' | 'ABANDONED';
}
```

Workspace lifecycle:

1. **Fork** — create workspace from a base schema version.
2. **Develop** — apply schema and migration drafts in workspace scope.
3. **Preview** — deploy ephemeral API sandbox for contract and UI testing.
4. **Validate** — run schema, migration, and conformance checks.
5. **Merge** — produce a reviewed migration package for production.

Workspaces MUST be isolated by default and MUST NOT affect production reads/writes until merge.

---

## 3. Storage Provider Interface (SPI)

The SPI defines the contract between the Ontology Engine and the persistence backend. Any database that implements the SPI MAY serve as the storage layer.

### 3.1 SPI Operations

The SPI is defined as an interface (TypeScript shown; equivalent definitions in Java, Python, Go).

```typescript
interface StorageProvider {
  // ─── Schema ───
  applySchema(schema: OntologySchema): Promise<MigrationResult>;
  getSchema(version?: number): Promise<OntologySchema>;

  // ─── Objects ───
  createObject(type: string, properties: Record<string, any>): Promise<OntologyObject>;
  getObject(type: string, id: string): Promise<OntologyObject | null>;
  updateObject(type: string, id: string, properties: Record<string, any>, expectedVersion?: number): Promise<OntologyObject>;
  deleteObject(type: string, id: string, mode: 'soft' | 'hard'): Promise<void>;
  queryObjects(type: string, filter: FilterExpression, options?: QueryOptions): Promise<ObjectPage>;
  bulkMutate(request: BulkMutationRequest): Promise<BulkMutationResult>;

  // ─── Links ───
  createLink(type: string, fromId: string, toId: string, properties?: Record<string, any>): Promise<OntologyLink>;
  getLink(type: string, linkId: string): Promise<OntologyLink | null>;
  updateLink(type: string, linkId: string, properties: Record<string, any>, expectedVersion?: number): Promise<OntologyLink>;
  deleteLink(type: string, linkId: string): Promise<void>;
  getLinks(objectId: string, linkType: string, direction: 'inbound' | 'outbound', options?: QueryOptions): Promise<LinkPage>;
  traverse(startId: string, path: TraversalPath, options?: TraversalOptions): Promise<TraversalResult>;

  // ─── Transactions ───
  beginTransaction(): Promise<Transaction>;
  
  // ─── Versioning ───
  getObjectAtVersion(type: string, id: string, version: number): Promise<OntologyObject | null>;
  getObjectAtTime(type: string, id: string, timestamp: DateTime): Promise<OntologyObject | null>;

  // ─── Indices ───
  ensureIndex(type: string, index: IndexDefinition): Promise<void>;
  dropIndex(type: string, field: string): Promise<void>;
  listIndexes(type: string): Promise<IndexDefinition[]>;

  // ─── Health ───
  healthCheck(): Promise<HealthStatus>;
  capabilities(): StorageCapabilities;
}
```

### 3.2 Key Types

```typescript
interface OntologyObject {
  _tenantId: string;         // Tenant boundary key
  _type: string;            // ObjectType name
  _id: string;              // Primary identifier
  _version: number;         // Monotonic version counter
  _createdAt: DateTime;
  _updatedAt: DateTime;
  _deletedAt?: DateTime;    // Soft-delete marker
  [key: string]: any;       // Property values
}

interface OntologyLink {
  _tenantId: string;         // Tenant boundary key
  _type: string;            // LinkType name
  _id: string;              // Link's own unique identifier
  _fromType: string;
  _fromId: string;
  _toType: string;
  _toId: string;
  _version: number;         // Monotonic version counter for link properties
  _createdAt: DateTime;
  _updatedAt: DateTime;
  _deletedAt?: DateTime;    // Soft-delete marker (terminated link)
  [key: string]: any;       // Link property values
}

type FilterExpression = FieldPredicate | LogicalPredicate;

interface FieldPredicate {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'startsWith' | 'exists';
  value?: any; // Required for all operators except 'exists'
}

interface LogicalPredicate {
  and?: FilterExpression[];
  or?: FilterExpression[];
  not?: FilterExpression;
}

interface TraversalPath {
  steps: TraversalStep[];
}

interface TraversalStep {
  linkType: string;
  direction: 'inbound' | 'outbound';
  filter?: FilterExpression;  // Filter objects at this step
  maxDepth?: number;
}

interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  includeDeleted?: boolean;
  asOfVersion?: number;
  asOfTime?: DateTime;
}

interface RequestContext {
  tenantId: string;
  actorId?: string;
  traceId?: string;
}

interface StorageCapabilities {
  supportsTransactions: boolean;
  supportsTemporalQueries: boolean;
  supportsFullTextSearch: boolean;
  supportsGeoQueries: boolean;
  supportsGraphTraversal: boolean;
  supportsBulkMutations: boolean;
  maxTraversalDepth: number;
  replicationSupport: ReplicationCapability;
}

type ReplicationCapability = 
  | 'NONE'                    // No replication (e.g., in-memory provider)
  | 'STREAMING_REPLICATION'   // WAL shipping or streaming replication to standby
  | 'POINT_IN_TIME_RECOVERY'  // Continuous archival with PITR capability
  | 'BOTH';                   // Supports both streaming and PITR

interface BulkMutationRequest {
  idempotencyKey: string;
  operations: BulkOperation[];
}

type BulkOperation =
  | { type: 'createObject'; objectType: string; properties: Record<string, any> }
  | { type: 'updateObject'; objectType: string; id: string; properties: Record<string, any> }
  | { type: 'deleteObject'; objectType: string; id: string; mode: 'soft' | 'hard' };

interface BulkMutationResult {
  accepted: number;
  failed: number;
  errors: BulkMutationError[];
}

interface BulkMutationError {
  operationIndex: number;
  code: string;
  message: string;
}

type IndexType = 'BTREE' | 'HASH' | 'GIN' | 'GIST' | 'FULLTEXT';

interface IndexDefinition {
  field: string;
  indexType: IndexType;
  unique?: boolean;          // When true, enforces uniqueness. Default: false.
}
```

All SPI operations execute in a tenant-scoped `RequestContext`. Signatures omit `ctx: RequestContext` for readability, but provider implementations MUST require it and enforce tenant isolation.

Filter validity rules:

1. A `FieldPredicate` MUST include `field` and `operator`. `value` is required unless `operator` is `exists`.
2. A `LogicalPredicate` MUST include exactly one of `and`, `or`, or `not`.
3. `and`/`or` arrays MUST be non-empty.
4. Mixed nodes (e.g., both `field` and `and`) are invalid and MUST be rejected at validation time.

### 3.3 Soft-Delete Semantics

Soft-deleted objects (those with a non-null `_deletedAt`) follow these rules:

1. `queryObjects` **excludes** soft-deleted objects by default. Set `includeDeleted: true` in `QueryOptions` to include them.
2. `getObject` returns soft-deleted objects with the `_deletedAt` field populated. Callers MUST check this field if they need to distinguish live from deleted objects.
3. **Links to/from soft-deleted objects** remain in the store but are excluded from traversal and `getLinks` results by default. Setting `includeDeleted: true` includes them. Active links to/from a soft-deleted object are NOT automatically soft-deleted — they remain active but unreachable through default queries. This preserves link history for audit and lineage purposes while preventing traversal to deleted nodes.
4. **Link cardinality** is evaluated against active (non-deleted) links only. A soft-deleted link does not count against cardinality limits. An active link pointing to a soft-deleted object does not count against cardinality limits either, since the target is not a valid endpoint.
5. **New links to soft-deleted objects** are rejected. The `createLink` operation MUST verify that both `fromId` and `toId` reference non-deleted objects (i.e., `_deletedAt` is null). Attempting to link to or from a soft-deleted object returns a `REFERENTIAL_INTEGRITY` error.
6. **Hard-delete** physically removes the object and all its inbound and outbound links from the store. This is irreversible and SHOULD be restricted to data retention compliance workflows.
7. **Soft-delete TTL and auto-purge:** ObjectTypes MAY declare a soft-delete retention period via schema configuration. When configured, the Ontology Engine schedules automatic hard-deletion of soft-deleted objects after the TTL expires.

```yaml
# Schema-level soft-delete retention policy (per ObjectType)
retention:
  Patient:
    softDeleteTTL: "P7Y"        # 7 years (NHS records retention)
    purgeStrategy: HARD_DELETE   # HARD_DELETE | ARCHIVE
  DischargeRecord:
    softDeleteTTL: "P10Y"       # 10 years
    purgeStrategy: ARCHIVE       # Move to cold storage before deletion
```

TTL auto-purge rules:

- The purge job runs on a configurable schedule (default: daily). It queries for soft-deleted objects where `_deletedAt + softDeleteTTL < now`.
- `HARD_DELETE` permanently removes the object and its links via the existing hard-delete path (rule 6).
- `ARCHIVE` exports the object (including links and lineage) to a configured archive store (e.g., object storage) before hard-deleting. The archive record includes sufficient metadata for regulatory retrieval.
- Purge operations are audited. Each purge run emits an `openfoundry.retention.purge` event with counts per ObjectType.
- When no `softDeleteTTL` is configured for an ObjectType, soft-deleted objects are retained indefinitely (current default behaviour).

### 3.4 Transaction Semantics

The SPI requires ACID transactions for all write operations. A single Action execution maps to a single transaction — all effects either commit together or roll back.

```typescript
interface Transaction {
  createObject(type: string, properties: Record<string, any>): Promise<OntologyObject>;
  updateObject(type: string, id: string, properties: Record<string, any>, expectedVersion?: number): Promise<OntologyObject>;
  deleteObject(type: string, id: string, mode: 'soft' | 'hard'): Promise<void>;
  createLink(type: string, fromId: string, toId: string, properties?: Record<string, any>): Promise<OntologyLink>;
  updateLink(type: string, linkId: string, properties: Record<string, any>, expectedVersion?: number): Promise<OntologyLink>;
  deleteLink(type: string, linkId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

### 3.5 Optimistic Concurrency

The SPI supports optimistic concurrency control via the `expectedVersion` parameter on `updateObject` and `updateLink`.

1. When `expectedVersion` is provided, the SPI MUST compare it against the object's current `_version`. If they do not match, the operation MUST fail with a `VERSION_CONFLICT` error containing the current version.
2. When `expectedVersion` is omitted, the update proceeds unconditionally (last-write-wins).
3. The Ontology Engine SHOULD pass `expectedVersion` for all Action-initiated updates to prevent concurrent action executions from silently overwriting each other's effects.
4. The API layer exposes optimistic concurrency via:
   - **GraphQL:** An optional `expectedVersion: Int` field on mutation inputs.
   - **REST:** The `If-Match` header, where the ETag value is the object's `_version`.
5. `VERSION_CONFLICT` errors are retryable. The caller SHOULD re-read the object, resolve the conflict, and retry.

### 3.6 Replication Requirements

Storage providers used in production deployments MUST support data replication sufficient to meet the RPO target of < 1 hour defined in Section 13.4. Acceptable replication methods:

- **Streaming replication** — WAL shipping or streaming replication to a standby (`STREAMING_REPLICATION` or `BOTH`).
- **Point-in-time recovery** — continuous archival with PITR capability at intervals no greater than 1 hour (`POINT_IN_TIME_RECOVERY` or `BOTH`).

Providers declare their replication capability via `StorageCapabilities.replicationSupport`. The deployment tooling will warn if a provider reporting `NONE` is used in a production configuration. Either `STREAMING_REPLICATION` or `POINT_IN_TIME_RECOVERY` (or `BOTH`) satisfies the production requirement.

### 3.7 Provider Implementations

The project maintains reference implementations for the following backends. Third parties MAY implement additional providers.

| Provider | Status | Notes |
|----------|--------|-------|
| TypeDB | Reference | Best ontological fit. Native polymorphism, rule inference, strong typing. |
| Neo4j | Reference | Mature graph DB. Needs schema enforcement wrapper. Community edition for OSS. |
| PostgreSQL + Apache AGE | Reference | Lowest barrier to entry. Graph queries via AGE extension. Best for teams already on PostgreSQL. |
| In-Memory | Testing | For unit/integration tests. Not for production. |

Each provider MUST pass the SPI conformance test suite (see Section 11).

### 3.8 Bulk Mutation Contract

User-initiated bulk operations MUST execute through SPI bulk primitives so that validation, audit, and idempotency are consistent across providers.

Bulk mutation requirements:

1. Providers that advertise `supportsBulkMutations: true` MUST implement server-side chunking and resumable execution.
2. Bulk operations MUST support idempotency keys for safe retries.
3. Per-item failures are reported without dropping successful items unless the caller requests `allOrNothing`.
4. Bulk execution MUST emit structured progress events and final result summaries.
5. Bulk operations remain tenant-scoped and MUST never cross tenant boundaries inside a single request.

### 3.9 Backup and Restore Contract

Storage providers used in production MUST expose backup and restore capabilities to meet the RPO/RTO targets in Section 13.4.

```typescript
interface BackupCapability {
  // Initiate a backup. Returns a handle for tracking.
  createBackup(options: BackupOptions): Promise<BackupHandle>;

  // List available backups.
  listBackups(filter?: BackupFilter): Promise<BackupHandle[]>;

  // Restore from a backup. The provider enters read-only mode during restore.
  restoreFromBackup(backupId: string, options?: RestoreOptions): Promise<RestoreResult>;

  // Point-in-time restore (when replicationSupport includes POINT_IN_TIME_RECOVERY).
  restoreToPointInTime(timestamp: DateTime, options?: RestoreOptions): Promise<RestoreResult>;
}

interface BackupOptions {
  label?: string;              // Human-readable label
  includeAuditLog?: boolean;   // Default: true. Audit log is in a separate schema.
  tenantScope?: string;        // Tenant-scoped backup (when supported). Null = all tenants.
}

interface BackupHandle {
  id: string;
  label?: string;
  createdAt: DateTime;
  sizeBytes: number;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  tenantScope?: string;
  includesAuditLog: boolean;
}

interface RestoreOptions {
  dryRun?: boolean;            // Validate backup integrity without restoring
  targetTenant?: string;       // Restore into a specific tenant (cross-tenant restore)
}

interface RestoreResult {
  backupId: string;
  restoredAt: DateTime;
  objectsRestored: number;
  linksRestored: number;
  auditRecordsRestored: number;
  warnings: string[];
}
```

Backup/restore requirements:

1. Providers MUST support `createBackup` and `restoreFromBackup` at minimum. PITR restore is capability-gated by `POINT_IN_TIME_RECOVERY`.
2. `restoreFromBackup` MUST place the provider in read-only mode during the restore operation. The Ontology Engine returns `SERVICE_DEGRADED` for write requests during this window.
3. `dryRun: true` validates the backup's integrity (checksums, schema compatibility) without modifying state.
4. Backup handles are retained until explicitly deleted. Operators configure retention policies externally (e.g., S3 lifecycle rules).
5. The `BackupCapability` interface is optional on `StorageProvider`. Providers that do not implement it MUST declare `replicationSupport: 'NONE'` and the deployment tooling will warn when used in production.

---

## 4. Ontology Engine

The Ontology Engine sits above the SPI and provides schema-aware operations. It is the core service that all other layers interact with.

### 4.1 Responsibilities

1. **Schema registry** — stores, versions, and serves ontology schemas. Validates schema changes and computes migrations (including reverse diffs for rollback).
2. **Object lifecycle** — creates, reads, updates, and (soft-)deletes objects through the SPI, enforcing schema validation, constraints, and computed fields.
3. **Relationship management** — manages links between objects, enforcing cardinality and referential integrity. Links are identified by their own primary ID, not solely by the (type, from, to) tuple.
4. **Computed fields** — evaluates `@computed` fields according to the configured evaluation strategy (see Section 4.4).
5. **Event emission** — publishes CloudEvents for every state change (object created, updated, deleted; link created, updated, deleted).
6. **Temporal queries** — supports point-in-time queries via the SPI's versioning capabilities.
7. **Lineage capture** — records field-level provenance for every mutation source (see Section 4.6).
8. **Data quality evaluation** — evaluates cross-object and temporal quality rules (see Section 4.7).

### 4.2 Event Format

All state changes produce CloudEvents published to the event bus.

```json
{
  "specversion": "1.0",
  "id": "evt-abc-123",
  "source": "openfoundry://instance-1/ontology",
  "type": "openfoundry.object.updated",
  "subject": "Patient/patient-abc-123",
  "time": "2026-02-06T14:30:00Z",
  "datacontenttype": "application/json",
  "data": {
    "objectType": "Patient",
    "objectId": "patient-abc-123",
    "version": 42,
    "changes": {
      "status": { "old": "ACTIVE", "new": "DISCHARGED" }
    },
    "causedBy": {
      "actionType": "DischargePatient",
      "actionId": "action-xyz-789",
      "actor": "user:dr.smith@nhs.net"
    }
  }
}
```

Event types:

| Type | Trigger |
|------|---------|
| `openfoundry.object.created` | New object instantiated |
| `openfoundry.object.updated` | Object properties changed |
| `openfoundry.object.deleted` | Object soft- or hard-deleted |
| `openfoundry.link.created` | New link established |
| `openfoundry.link.updated` | Link properties changed |
| `openfoundry.link.deleted` | Link removed |
| `openfoundry.action.submitted` | Action submitted (before execution) |
| `openfoundry.action.completed` | Action executed successfully |
| `openfoundry.action.failed` | Action execution failed |
| `openfoundry.schema.updated` | Schema version applied |

#### 4.2.1 Event Ordering Guarantees

Events are partitioned and ordered as follows:

1. **Partition key:** Events are partitioned by `(tenantId, objectType, objectId)` for object events and `(tenantId, linkType, linkId)` for link events. Action-level events are partitioned by `(tenantId, actionId)`.
2. **Per-partition ordering:** Within a partition, events are strictly ordered by the object's `_version`. Consumers processing a single partition are guaranteed to see events in causal order.
3. **Cross-partition ordering:** No global ordering is guaranteed across partitions. Consumers that need cross-object consistency MUST use the `causedBy.actionId` field to correlate events from the same action transaction.
4. **Action atomicity:** All events produced by a single action execution share the same `causedBy.actionId`. The event bus publishes these events atomically (all or none) when the action's transaction commits. Consumers SHOULD NOT observe partial action event sets.
5. **Idempotency:** Each event has a unique `id`. Consumers MUST handle duplicate delivery (at-least-once semantics). The `(objectId, version)` pair is a natural deduplication key for object events.

### 4.3 Validation Pipeline

Every write operation passes through:

1. **Schema validation** — field types, required fields, enum values.
2. **Constraint evaluation** — `@constraint` expressions evaluated against the proposed state.
3. **Uniqueness check** — `@unique` fields checked across all instances of the type.
4. **Cardinality check** — link operations validated against declared cardinality (counting active links only). Cardinality enforcement MUST be serializable: when two concurrent transactions attempt to create links that would violate cardinality constraints (e.g., two `MANY_TO_ONE` links from the same object), at most one transaction succeeds. Providers MUST implement this via row-level locking, serializable isolation, or equivalent mechanism to prevent race conditions.
5. **Referential integrity** — link targets MUST exist (or be created in the same transaction). Soft-deleted targets are not valid link targets.

Validation failures return structured errors with the specific constraint that failed.

### 4.4 Computed Field Cache Invalidation

Computed fields (declared with `@computed`) have an evaluation strategy specified by the `cache` argument:

```graphql
type Ward @objectType {
  # Eager: recomputed on every write that could affect it
  currentOccupancy: Int @computed(
    fn: "countLinks",
    args: { type: "AdmittedTo" },
    cache: EAGER
  )

  # Lazy: recomputed on every read (default)
  bedUtilisationRate: Float @computed(
    fn: "bedUtilisation",
    cache: LAZY
  )

  # TTL: cached with time-based expiry
  riskScore: Float @computed(
    fn: "wardRiskScore",
    cache: TTL,
    ttl: "PT5M"
  )
}
```

#### 4.4.1 Evaluation Strategies

| Strategy | Behaviour | Trade-off |
|----------|-----------|-----------|
| `LAZY` | Evaluated on every read. No caching. | Default. Simplest. Adds read latency proportional to computation cost. |
| `EAGER` | Re-evaluated on every write to the source object or any object/link that the function reads. Stored as a materialised value. | Guarantees fresh reads. Adds write latency. Requires dependency tracking. |
| `TTL` | Cached for the specified duration. Stale reads possible within the TTL window. | Good for expensive computations where slight staleness is acceptable. |

#### 4.4.2 Dependency Tracking for EAGER Fields

When a computed field uses `cache: EAGER`, the Ontology Engine MUST track which objects and links affect the computation. The engine does this by:

1. On first evaluation, recording which SPI reads the function makes (object gets, link queries).
2. Registering those read paths as **invalidation triggers**.
3. When any write matches an invalidation trigger, re-evaluating the computed field and storing the updated value.

The dependency tracker is an internal component of the Ontology Engine. It is not exposed via the SPI. Functions that use non-deterministic inputs (e.g., `now`) cannot use `EAGER` caching and the compiler will reject this combination.

**Static dependency analysis:** For built-in computed functions (`countLinks`, `sumField`, etc.), the ODL compiler SHOULD perform static dependency analysis at schema compilation time rather than relying solely on runtime observation. The compiler knows that `countLinks(args: { type: "AdmittedTo" })` on `Ward` depends on `AdmittedTo` link creation/deletion events targeting that ward. Static analysis produces a deterministic dependency graph that:

1. Catches missing invalidation triggers before deployment (e.g., a function that reads `Patient.status` but is not triggered by `Patient.updated` events).
2. Enables the compiler to emit a `dependencyGraph` artifact alongside the compiled schema, documenting which writes trigger which recomputations.
3. For custom functions (user-defined TypeScript), static analysis is best-effort. The compiler emits a warning if it cannot determine dependencies statically, and the function falls back to runtime observation on first evaluation.

#### 4.4.3 Cache Interface

```typescript
interface ComputedFieldCache {
  get(objectType: string, objectId: string, fieldName: string): Promise<CachedValue | null>;
  set(objectType: string, objectId: string, fieldName: string, value: any, ttl?: Duration): Promise<void>;
  invalidate(objectType: string, objectId: string, fieldName: string): Promise<void>;
  invalidateByTrigger(trigger: InvalidationTrigger): Promise<void>;
}

interface InvalidationTrigger {
  // Which write event caused this invalidation
  eventType: 'object.created' | 'object.updated' | 'object.deleted' | 'link.created' | 'link.updated' | 'link.deleted';
  objectType?: string;
  objectId?: string;
  linkType?: string;
  linkId?: string;
}
```

### 4.5 Observability

The Ontology Engine emits OpenTelemetry traces and metrics for all operations.

#### 4.5.1 Traces

Every operation creates a span. Span naming follows the convention `openfoundry.<layer>.<operation>`.

| Span Name | Attributes | Notes |
|-----------|-----------|-------|
| `openfoundry.engine.getObject` | `object.type`, `object.id` | Includes child spans for SPI call and computed field evaluation |
| `openfoundry.engine.queryObjects` | `object.type`, `filter.summary`, `result.count` | |
| `openfoundry.engine.createObject` | `object.type`, `object.id` | Includes validation pipeline spans |
| `openfoundry.engine.traverse` | `start.id`, `path.depth`, `result.count` | |
| `openfoundry.action.execute` | `action.type`, `action.id`, `actor` | Parent span for the full action pipeline |
| `openfoundry.action.preconditions` | `action.type`, `result` | Child of action.execute |
| `openfoundry.action.effects` | `action.type`, `effect.count` | Child of action.execute |
| `openfoundry.action.sideeffects` | `action.type`, `sideeffect.name` | Async, linked to parent via trace context |
| `openfoundry.security.check` | `actor`, `resource`, `permission`, `result` | |
| `openfoundry.security.consent` | `subject`, `purpose`, `result` | |
| `openfoundry.sync.extract` | `connector`, `table`, `record.count` | |
| `openfoundry.sync.map` | `connector`, `object.type`, `record.count` | |
| `openfoundry.federation.query` | `source.instance`, `target.instance`, `dsa.id` | |

#### 4.5.2 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `openfoundry.engine.operations` | Counter | `operation`, `object_type`, `result` |
| `openfoundry.engine.latency` | Histogram | `operation`, `object_type` |
| `openfoundry.action.executions` | Counter | `action_type`, `result` |
| `openfoundry.action.duration` | Histogram | `action_type` |
| `openfoundry.security.checks` | Counter | `permission`, `result` |
| `openfoundry.security.check_latency` | Histogram | `permission` |
| `openfoundry.sync.records_processed` | Counter | `connector`, `operation` |
| `openfoundry.sync.lag_seconds` | Gauge | `connector` |
| `openfoundry.sync.conflicts` | Counter | `connector`, `resolution` |
| `openfoundry.computed.evaluations` | Counter | `field`, `strategy`, `cache_hit` |
| `openfoundry.federation.queries` | Counter | `source`, `target`, `result` |
| `openfoundry.federation.latency` | Histogram | `source`, `target` |

All metrics MUST be exported via the OpenTelemetry SDK and MAY be scraped by Prometheus or pushed to any OTLP-compatible backend.

### 4.6 Lineage and Provenance

Open Foundry tracks value provenance so operators can answer: where did this value come from, when, and through which transformation path.

```typescript
interface FieldProvenance {
  tenantId: string;
  objectType: string;
  objectId: string;
  field: string;
  valueHash: string;
  producedAt: DateTime;
  source:
    | { kind: 'ACTION'; actionType: string; actionId: string; actor: string }
    | { kind: 'SYNC'; connector: string; sourceSystem: string; syncRunId: string; mappingVersion: string; sourcePointer: string }
    | { kind: 'FUNCTION'; functionName: string; functionVersion: string; inputRefs: string[] };
}
```

Lineage requirements:

1. Every write to a non-system field MUST produce a provenance record.
2. Query APIs MUST support opt-in lineage expansion (`includeLineage: true`) for authorised users.
3. Provenance records are immutable and retained on the same policy as audit logs unless stricter regulation applies.
4. Federation responses MUST preserve lineage origin metadata (source instance + provenance reference) for shared fields.

### 4.7 Data Quality Rules

Beyond schema validation, deployments MAY register cross-object and temporal data quality rules.

```yaml
# quality/rules/ward-occupancy.yaml
rule: ward_occupancy_over_capacity
severity: HIGH
scope: Ward
window: "PT4H"
expr: "ward.currentOccupancy > ward.capacity * 1.2"
action:
  type: alert
  channel: ops_oncall
```

Quality rule requirements:

1. Rules MAY reference related objects and time windows.
2. Violations generate `openfoundry.quality.violation` events with severity and evidence.
3. Rule evaluation MUST NOT block primary write paths by default; blocking mode is opt-in per rule.
4. Rule packs MUST be versioned and MAY be enabled/disabled per tenant.

---

## 5. Action Framework

The Action Framework is the kinetic layer. It defines how the ontology changes in response to operational decisions.

### 5.1 Action Manifest

Each ActionType declared in ODL has a companion YAML manifest that defines its behaviour.

```yaml
# actions/discharge-patient.yaml
action: DischargePatient
version: 1

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "patient.currentWard != null"
    error: "Patient is not currently admitted"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"
    error: "Only clinicians or nurses in charge can discharge patients"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "DISCHARGED"

  # Reset bed status (effects use immutable snapshot, so patient.currentBed
  # still resolves to the pre-effect bed)
  - type: updateObject
    target: "patient.currentBed"
    condition: "patient.currentBed != null"
    set:
      status: "CLEANING"

  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      to: "patient.currentWard"
      active: true
    # When filter matches multiple links, `expect: ONE` (default) fails the action.
    # Use `expect: ALL` to delete all matching links.
    expect: ONE

  - type: createObject
    objectType: "DischargeRecord"
    properties:
      patient: "patient"
      ward: "patient.currentWard"
      destination: "params.destination"
      dischargeDate: "now"
      notes: "params.notes"

sideEffects:
  - name: notifyDestination
    type: webhook
    config:
      url: "https://integration.nhs.uk/discharge-notifications"
      method: POST
      body:
        patientId: "patient.id"
        destination: "params.destination"
        expectedArrival: "now + duration('PT2H')"
    retries: 3
    retryDelay: "PT5M"

  - name: emitDischargeEvent
    type: event
    config:
      type: "nhs.acute.patient.discharged"
      data:
        patientId: "patient.id"
        ward: "patient.currentWard.name"
        destination: "params.destination"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
  # Options: LOG_AND_CONTINUE | RETRY_INDEFINITELY | ROLLBACK_ALL
```

#### 5.1.1 Action Versioning

Each action manifest declares a `version` (integer). Versioning rules:

1. **Single active version:** At any point in time, exactly one version of an ActionType is active per tenant. The Action Framework resolves the active version when an action is submitted.
2. **Deployment:** When a new manifest version is deployed (via `odl apply` or Domain Pack update), it replaces the previous version. The previous manifest is archived but not deleted — it is retained for audit trail interpretation and undo operations.
3. **In-flight actions:** Actions that are already executing when a new version is deployed continue with the version they started. Version resolution is captured in the action's audit record.
4. **API stability:** The ActionType's GraphQL/REST signature is derived from the `@actionType` ODL declaration, not the YAML manifest. Manifest version changes that only modify preconditions, effects, or side-effects do not change the API surface. Changes that require new `@param` fields require an ODL schema migration (Section 2.5).
5. **Version history:** The Action Framework MUST retain all deployed manifest versions. The `ToolDescriptor` (Section 5.7) always reflects the currently active version.

### 5.2 Expression Language

Preconditions and effect expressions use **CEL (Common Expression Language)**, Google's open-source expression language designed for exactly this use case: evaluating security policies and business rules in a safe, sandboxed, performant manner.

CEL is chosen because it is well-specified with a formal grammar, type-checked at schema compilation time (not just at runtime), fast to evaluate (microsecond-scale), safe by design (no loops, no I/O, no side-effects, guaranteed termination), and has production-quality implementations in Go, Java, and C++.

#### 5.2.1 CEL Environment

Actions execute CEL expressions within a defined environment. The following variables and functions are available.

**Variables:**

| Variable | Type | Description |
|----------|------|-------------|
| `params` | dynamic | The action's input parameters |
| `actor` | Actor | The user or system executing the action |
| `now` | `google.protobuf.Timestamp` | Current UTC timestamp. This is a variable, not a function — use `now`, not `now()`. |

**Parameter variables:** each `@param` field on the ActionType is also available as a top-level variable. For example, `patient` refers to the fully-resolved `Patient` object passed as a parameter, not just the ID. These variables are immutable snapshots resolved at action start.

**Functions:**

| Function | Signature | Description |
|----------|-----------|-------------|
| `has_link` | `(object, linkType: string) -> bool` | Whether the object has at least one active link of the given type |
| `count_links` | `(object, linkType: string) -> int` | Count of active links of the given type |
| `actor.hasRole` | `(role: string) -> bool` | Whether the actor has the specified role |
| `actor.hasPermission` | `(permission: string, resource: string) -> bool` | Whether the actor has the specified permission on the resource |
| `duration` | `(iso8601: string) -> google.protobuf.Duration` | Parses an ISO 8601 duration string into a Duration value |

**Duration arithmetic:** CEL supports timestamp + duration and timestamp - duration natively via `google.protobuf.Timestamp` and `google.protobuf.Duration`. Use the `duration()` function to construct durations:

```yaml
# Correct: use duration() to create a Duration value
expectedArrival: "now + duration('PT2H')"

# Wrong: CEL does not support bare literals like "2h"
expectedArrival: "now + 2h"      # INVALID
expectedArrival: "now() + 2h"    # INVALID — now is a variable, not a function
```

#### 5.2.2 Null Propagation

CEL uses explicit null checking. Accessing a property on a null value is a runtime error, not null propagation. Action authors MUST guard against nulls explicitly:

```yaml
# WRONG — will error if currentWard is null
- expr: "patient.currentWard.name == 'Ward A'"

# CORRECT — guard the null case
- expr: "patient.currentWard != null && patient.currentWard.name == 'Ward A'"

# ALSO CORRECT — use has() macro
- expr: "has(patient.currentWard) && patient.currentWard.name == 'Ward A'"
```

The ODL compiler validates CEL expressions at schema compilation time and warns about potential null-access paths based on the schema's optionality declarations.

#### 5.2.3 Type System

CEL expressions are type-checked against the ODL schema. The compiler maps ODL types to CEL types:

| ODL Type | CEL Type |
|----------|----------|
| `String` | `string` |
| `Int` | `int` |
| `Float` | `double` |
| `Boolean` | `bool` |
| `DateTime` | `google.protobuf.Timestamp` |
| `Duration` | `google.protobuf.Duration` |
| `Date` | `string` (ISO 8601) |
| ObjectTypes | `map` (property access via dot notation) |
| Enums | `string` (compared by enum value name) |

#### 5.2.4 CEL Runtime Strategy

The platform core MAY be implemented in TypeScript, but CEL evaluation MUST use a canonical evaluator with compatibility guarantees:

1. Preferred: WASM-compiled CEL engine derived from a reference implementation.
2. Allowed alternative: sidecar evaluator service (Go/Rust) with gRPC contract and deterministic test vectors.
3. Pure TypeScript CEL implementations MAY be used only for tooling/linting, not as authoritative runtime evaluators.
4. Runtime conformance tests MUST verify parity across compilation, precondition execution, and effect expression execution.

### 5.3 Execution Pipeline

```
     ┌──────────┐
     │  Submit   │  User or system calls API with action type + parameters
     └────┬─────┘
          │
     ┌────▼──────┐
     │  Validate  │  Schema validation of parameters
     └────┬──────┘
          │
     ┌────▼──────┐
     │ Authorise  │  Security layer checks actor permissions (ReBAC)
     └────┬──────┘
          │
     ┌────▼──────┐
     │  Consent   │  Consent layer checks data access consent (if active)
     └────┬──────┘
          │
     ┌────▼──────────┐
     │  Preconditions │  Evaluate all CEL precondition expressions
     └────┬──────────┘
          │
     ┌────▼──────┐
     │  Execute   │  Apply effects in a single SPI transaction
     └────┬──────┘
          │
     ┌────▼────────┐
     │ Side-effects │  Orchestrated via workflow engine (async)
     └────┬────────┘
          │
     ┌────▼──────┐
     │   Audit    │  Write immutable audit record
     └────┬──────┘
          │
     ┌────▼──────┐
     │   Emit     │  Publish CloudEvents
     └──────────┘
```

**Pipeline ordering rationale:** Authorise and Consent run *before* Preconditions. This is a security requirement: precondition expressions read object state (e.g., `patient.status == 'ACTIVE'`), and their error messages can leak protected information. If preconditions ran first, an unauthorised user could probe object state by submitting actions and observing which precondition failed. Running authorisation first ensures that only users with permission to access the target objects can trigger precondition evaluation.

**Effect evaluation semantics:** Effect execution is deterministic and ordered:

1. Effects run strictly in manifest order, inside one transaction.
2. CEL expressions inside effects are evaluated against the immutable action context (`params`, resolved parameter variables, `actor`, `now`) captured before the first effect.
3. Effects do not implicitly re-bind parameter variables to post-effect database state.
4. If any effect fails, the transaction is rolled back and no effects are committed.

**`deleteLink` filter resolution:** When an effect specifies `type: deleteLink` with a `filter` (rather than a direct link ID), the Action Executor resolves the filter to concrete link IDs before issuing the SPI `deleteLink(type, linkId)` call. Resolution steps:

1. The executor calls `getLinks(fromId, linkType, 'outbound')` within the transaction to find matching active links.
2. It applies the filter predicates (`from`, `to`, `active`) to the returned set.
3. If `expect: ONE` (default) and the matched set contains != 1 link, the action fails with `LINK_RESOLUTION_AMBIGUOUS` or `LINK_NOT_FOUND`.
4. If `expect: ALL`, all matched links are deleted.
5. The resolved link IDs are recorded in the audit trail for traceability.

The **Consent** step is REQUIRED when the Security Layer's consent manager is active (i.e., when a Domain Pack enables it). It runs after authorisation because a user can be authorised to perform an action in general but the specific data subject might have withheld consent for the relevant purpose. Consent failures produce a structured error distinct from authorisation failures:

```json
{
  "code": "CONSENT_DENIED",
  "message": "Data subject has not consented to CARE_PLANNING purpose",
  "subject": "patient-abc-123",
  "purpose": "CARE_PLANNING"
}
```

If the Execute step fails, nothing is committed. If a side-effect fails, behaviour depends on the `rollback.onSideEffectFailure` policy.

### 5.4 Action API

```graphql
# Auto-generated mutation from the DischargePatient ActionType
type Mutation {
  dischargePatient(input: DischargePatientInput!): DischargePatientResult!
}

input DischargePatientInput {
  patient: ID!
  destination: DischargeDestination!
  notes: String
}

type DischargePatientResult {
  success: Boolean!
  actionId: ID!
  errors: [ActionError!]
  affectedObjects: [AffectedObject!]
}

type ActionError {
  code: String!
  message: String!
  field: String
}

type AffectedObject {
  type: String!
  id: ID!
  changeType: ChangeType!
}

enum ChangeType {
  CREATED
  UPDATED
  DELETED
  LINK_CREATED
  LINK_UPDATED
  LINK_DELETED
}
```

`ActionError` entries use the platform-wide error code taxonomy defined in Section 8.8.

### 5.5 Bulk Action Execution

Bulk user operations execute through the same validation/authorisation/consent/audit pipeline as single actions.

```graphql
type Mutation {
  submitBulkAction(input: BulkActionInput!): BulkActionJob!
}

input BulkActionInput {
  actionType: String!
  items: [JSON!]!
  idempotencyKey: String!
  allOrNothing: Boolean = false
  dryRun: Boolean = false
}

type BulkActionJob {
  id: ID!
  status: BulkJobStatus!
  submittedAt: DateTime!
  completedAt: DateTime
  progress: BulkProgress!
  summary: BulkSummary
  errors: [BulkItemError!]
}
```

Execution contract:

1. Each item is validated and authorised independently.
2. `dryRun: true` performs validation/authorisation/consent checks and returns impact without mutation.
3. `allOrNothing: true` runs items in a single transaction scope where supported; otherwise request is rejected.
4. Results include per-item status, error code, and correlation IDs for audit/lineage lookup.
5. Bulk jobs emit `openfoundry.bulk.progress`, `openfoundry.bulk.completed`, and `openfoundry.bulk.failed` events.
6. If `supportsBulkMutations` is `false`, the action executor MAY emulate bulk execution via chunked single-item transactions, but MUST preserve idempotency and per-item reporting semantics.

**Relationship to SPI bulk mutations:** `submitBulkAction` and `SPI.bulkMutate` operate at different layers. `submitBulkAction` is an API-layer operation that runs N action instances through the full pipeline (validation, auth, consent, preconditions, effects, audit). Each action instance produces one or more SPI mutations. When `allOrNothing: true` and the SPI advertises `supportsBulkMutations: true`, the Action Executor batches the SPI-level mutations from all items into a single `bulkMutate` call for atomicity. When `allOrNothing: false` (default), each action item executes in its own SPI transaction independently. The SPI's `bulkMutate` is never exposed directly to API consumers — it is an internal optimisation path only.

### 5.6 Action Undo

The Action Framework supports reversible actions via auto-generated reverse manifests.

#### 5.6.1 Reversibility Declaration

Each action manifest declares its reversibility:

```yaml
action: DischargePatient
version: 1
reversible: true   # Default: false

# ... preconditions, effects, sideEffects as before

undo:
  # Auto-generated from effects (createObject → deleteObject, updateObject → restore previous, deleteLink → createLink)
  # Override specific effects when auto-generation is insufficient:
  overrides:
    - effect: 0                    # Index into effects array
      undoEffect:
        type: updateObject
        target: "patient"
        set:
          status: "ACTIVE"

  # Side-effects triggered on undo
  sideEffects:
    - name: notifyUndoDischarge
      type: event
      config:
        type: "nhs.acute.patient.discharge_reversed"
        data:
          patientId: "patient.id"

  # Time window within which undo is permitted
  window: "PT4H"
```

#### 5.6.2 Undo Semantics

1. When `reversible: true`, the Action Executor captures a snapshot of all affected objects and links *before* applying effects. This snapshot is stored alongside the audit record.
2. The undo operation is itself an Action that passes through the full execution pipeline (validate, authorise, consent, execute, audit, emit). The actor requesting undo MUST have permission to execute the undo.
3. Auto-generated undo effects invert the original effects in reverse order: `createObject` becomes `deleteObject(soft)`, `updateObject` restores the pre-effect field values from the snapshot, `deleteLink` becomes `createLink` with the original properties.
4. The `window` field limits how long after execution an undo is permitted. After the window expires, undo requests are rejected with `UNDO_WINDOW_EXPIRED`.
5. Undo is not recursive — undoing an undo is not supported. To re-apply, the original action must be submitted again.
6. Actions with non-reversible side-effects (e.g., sent emails, external API calls) SHOULD set `reversible: false` or document that undo reverses only ontology state, not external side-effects.

### 5.7 AI-Ready Action Envelope

Actions and Functions are designed to be invocable as tools by external AI agents (LLMs, workflow orchestrators). The platform exposes a machine-readable tool registry.

#### 5.7.1 Tool Discovery Endpoint

```graphql
type Query {
  """Returns all ActionTypes and Functions as tool descriptions."""
  availableTools(filter: ToolFilter): [ToolDescriptor!]!
}

input ToolFilter {
  kind: ToolKind           # ACTION, FUNCTION, or both
  tags: [String!]          # Domain Pack tags
}

type ToolDescriptor {
  name: String!
  kind: ToolKind!
  description: String!
  parameters: JSON!          # JSON Schema for input parameters
  returnType: JSON!          # JSON Schema for output
  requiredPermissions: [String!]!
  dryRunSupported: Boolean!
  reversible: Boolean!
  tags: [String!]!
}

enum ToolKind { ACTION FUNCTION }
```

#### 5.7.2 Agent Execution Mode

When an external agent invokes an action, it uses the standard action API with an additional `agentContext` header:

```json
{
  "agentId": "agent-scheduling-bot",
  "conversationId": "conv-xyz",
  "dryRun": true,
  "policyGuard": true
}
```

Agent execution semantics:

1. `dryRun: true` validates the action, evaluates preconditions, and returns the projected effects *without* committing. This allows the agent to preview consequences before applying.
2. `policyGuard: true` (default for agent context) requires explicit human approval for actions tagged as `highRisk` in the manifest. The action is held in `PENDING_APPROVAL` state until a human confirms or rejects.
3. All agent-initiated actions are tagged in the audit trail with the `agentId` and `conversationId` for traceability.
4. The `ToolDescriptor.parameters` field exports a JSON Schema that is directly compatible with OpenAI function-calling, Anthropic tool-use, and similar LLM tool interfaces.

---

## 6. Sync Engine

The Sync Engine keeps the ontology in sync with external source systems.

### 6.1 Connector Interface

```typescript
interface Connector {
  // Identity
  name: string;
  version: string;

  // Lifecycle
  initialize(config: ConnectorConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  // Discovery
  discoverSchema(): Promise<SourceSchema>;

  // Extraction
  fullExtract(table: string, options?: ExtractOptions): AsyncIterable<SourceRecord>;
  incrementalExtract(table: string, since: Checkpoint): AsyncIterable<SourceRecord>;

  // Backpressure
  pause(): Promise<void>;
  resume(): Promise<void>;

  // Writeback (optional)
  write?(record: WritebackRecord): Promise<WritebackResult>;
}

interface SourceRecord {
  table: string;
  key: Record<string, any>;
  data: Record<string, any>;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  timestamp: DateTime;
  checkpoint: Checkpoint;
}

interface ExtractOptions {
  batchSize?: number;           // Max records per batch. Default: 1000.
  maxRecordsPerSecond?: number; // Rate limit. Default: unlimited.
}
```

### 6.2 Backpressure and Flow Control

The Sync Engine implements backpressure to prevent overwhelming the Ontology Engine during high-throughput ingestion (e.g., initial full extracts or batch reconciliation from busy source systems).

#### 6.2.1 Pull-Based Consumption

The `AsyncIterable` pattern in the connector interface is inherently pull-based — the Sync Engine requests the next batch only when it has capacity. Connectors MUST NOT push records faster than the engine pulls them.

#### 6.2.2 Rate Limiting

Each datasource binding MAY configure a rate limit:

```yaml
sync:
  mode: CDC
  rateLimit:
    maxRecordsPerSecond: 500    # Max throughput from this connector
    maxConcurrentBatches: 4     # Max batches being mapped/written concurrently
    burstSize: 2000             # Allow short bursts up to this size
```

#### 6.2.3 Circuit Breaker

The Sync Engine monitors the Ontology Engine's response latency and error rate. If the engine becomes overloaded, the Sync Engine:

1. Pauses all connectors via `pause()`.
2. Waits for the engine to recover (latency returns below threshold).
3. Resumes connectors via `resume()`.

This prevents cascade failures during load spikes.

#### 6.2.4 Initial Full Extract

The CDC sync latency target of < 30 seconds (Section 13.1) applies to **steady-state incremental sync only**. Initial full extracts are not subject to this target and are expected to take significantly longer depending on source data volume. Full extracts run at the configured `rateLimit` and produce progress events (`openfoundry.sync.fullextract.progress`) reporting records processed and estimated time remaining.

### 6.3 Datasource Mapping

Each Datasource binding maps source records to ontology objects. Mappings are declared in YAML.

```yaml
# datasources/pas-patients.yaml
datasource: PAS_Patients
connector: jdbc
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"

  properties:
    nhsNumber:
      source: "nhs_no"
    name:
      source: "surname"
      transform: "concat(title, ' ', forename, ' ', surname)"
    dateOfBirth:
      source: "dob"
      transform: "parseDate('dd/MM/yyyy')"
    status:
      source: "discharge_date"
      transform: "ifPresent('DISCHARGED', 'ACTIVE')"

  links:
    - linkType: AdmittedTo
      toType: Ward
      toKey:
        source: "ward_code"
        target: "id"
        transform: "prefix('ward-')"
      properties:
        admissionDate:
          source: "admission_datetime"

sync:
  mode: CDC           # CDC | POLLING | BATCH
  interval: null      # Only for POLLING/BATCH
  conflictResolution: SOURCE_PRIORITY
  rateLimit:
    maxRecordsPerSecond: 500
```

### 6.4 Overlay Ingestion Mode

Open Foundry supports an **overlay** (read-through) ingestion mode that maps existing source system schemas to ODL types without requiring a full data migration. This reduces time-to-value by allowing the ontology to query source data in place.

```yaml
# datasources/pas-patients-overlay.yaml
datasource: PAS_Patients_Overlay
connector: jdbc
connection:
  url: "jdbc:postgresql://pas-db:5432/pas"
  table: "patients"

mapping:
  objectType: Patient
  primaryKey:
    source: "patient_id"
    target: "id"
    transform: "prefix('patient-')"
  properties:
    nhsNumber: { source: "nhs_no" }
    name: { source: "surname", transform: "concat(title, ' ', forename, ' ', surname)" }
    dateOfBirth: { source: "dob", transform: "parseDate('dd/MM/yyyy')" }
    status: { source: "discharge_date", transform: "ifPresent('DISCHARGED', 'ACTIVE')" }

sync:
  mode: OVERLAY          # New mode: read-through, no local copy
  cacheStrategy: TTL
  cacheTTL: "PT5M"       # Cache reads for 5 minutes
  writeback: false        # Read-only projection
```

#### 6.4.1 Overlay Semantics

1. In `OVERLAY` mode, the Sync Engine does **not** extract and store objects in the ontology store. Instead, when the Ontology Engine receives a query for the mapped ObjectType, it delegates to the connector in real time, applies the mapping transforms, and returns the result as if it were a native ontology object.
2. Overlay results are cached locally (using the specified `cacheStrategy` and `cacheTTL`) to avoid redundant source queries. Cache invalidation is time-based only — CDC is not used in overlay mode.
3. Overlay objects are **read-only**. Mutations (Actions) that target overlay objects are rejected with `OVERLAY_READ_ONLY` unless the datasource binding sets `writeback: true` and the connector implements the `write` method.
4. Overlay objects participate in the security pipeline (ReBAC checks, field redaction, consent) identically to native objects. The source system is not aware of Open Foundry's permission model.
5. Overlay objects do **not** have version histories or lineage records. Lineage is reported as `{ kind: 'OVERLAY', connector, sourceSystem, sourcePointer }`.
6. A datasource MAY be migrated from `OVERLAY` to `CDC`/`POLLING`/`BATCH` mode without changing the ODL schema. The migration triggers a full extract that populates the ontology store, after which the overlay cache is disabled.

This mode enables a phased rollout: connect, demonstrate value via queries and dashboards, then migrate to full ingestion when ready.

### 6.5 Transform Functions

Mapping transforms are composable functions.

| Function | Description | Example |
|----------|-------------|---------|
| `concat(...)` | Concatenate strings | `concat(first, ' ', last)` |
| `prefix(str)` | Prepend a string | `prefix('patient-')` |
| `suffix(str)` | Append a string | |
| `parseDate(fmt)` | Parse date with format | `parseDate('dd/MM/yyyy')` |
| `parseDateTime(fmt)` | Parse datetime with format | |
| `toUpper()` | Uppercase | |
| `toLower()` | Lowercase | |
| `trim()` | Strip whitespace | |
| `ifPresent(thenVal, elseVal)` | If the source field is non-null, return `thenVal`; otherwise return `elseVal` | `ifPresent('DISCHARGED', 'ACTIVE')` |
| `coalesce(fallback)` | Return the source value if non-null, otherwise return the fallback | `coalesce('UNKNOWN')` |
| `map(mapping)` | Value mapping | `map({ 'M': 'MALE', 'F': 'FEMALE' })` |
| `lookup(datasource, key)` | Cross-reference another datasource | `lookup('wards', 'ward_code')` |
| `hash(algorithm)` | Hash for pseudonymisation | `hash('sha256')` |
| `custom(fn)` | Call a registered custom function | `custom('nhsNumberChecksum')` |

### 6.6 Conflict Resolution

When multiple sources provide conflicting data for the same object.

| Strategy | Behaviour |
|----------|-----------|
| `LAST_WRITE_WINS` | Most recent timestamp wins. Default. |
| `SOURCE_PRIORITY` | Configurable priority ordering of sources. Highest-priority source wins. |
| `MERGE` | Non-conflicting fields merged. Conflicting fields flagged for manual resolution. |
| `CUSTOM` | Delegated to a registered conflict resolution function. |

Conflicts are logged as events (`openfoundry.sync.conflict`) with full details of both values and the resolution applied.

### 6.7 Reference Connectors

| Connector | Protocol | Notes |
|-----------|----------|-------|
| `jdbc` | JDBC (any SQL DB) | CDC via Debezium. Polling fallback. Requires Debezium connector configuration tuned for the < 30s CDC target (e.g., `poll.interval.ms` ≤ 1000). |
| `fhir` | FHIR R4 REST | Maps FHIR Resources to ObjectTypes natively. |
| `hl7v2` | MLLP / TCP | Parses ADT, ORM, ORU message types. |
| `csv` | File system | For manual imports. Watches a directory. |
| `rest` | HTTP REST | Generic REST API connector with configurable auth. |
| `kafka` | Kafka consumer | Consume events from an existing Kafka topic. |
| `nhs-spine` | NHS Spine SMSP | PDS (demographics), SDS (directory), e-RS (referrals). Part of Healthcare Domain Pack. |

---

## 7. Security and Governance

### 7.1 Access Control Model

Open Foundry uses Relationship-Based Access Control (ReBAC), implemented via the OpenFGA model (Google Zanzibar). Permissions are derived from the ontology graph itself — not from static role tables.

#### 7.1.1 Authorisation Model

The authorisation model is defined in OpenFGA DSL and auto-generated from the ODL schema.

```
model
  schema 1.1

type user

type ward
  relations
    define assigned: [user]
    define viewer: assigned
    define editor: assigned

type patient
  relations
    define admitted_to: [ward]
    define viewer: viewer from admitted_to
    define editor: editor from admitted_to
    define clinician: [user]
    define can_discharge: clinician
```

This model encodes: a user assigned to a ward can view and edit patients admitted to that ward. A user designated as a patient's clinician can discharge that patient. Permissions traverse the graph — when a patient moves wards, their visibility changes automatically.

#### 7.1.2 Permission Levels

| Level | Scope | Examples |
|-------|-------|---------|
| Schema-level | Which ObjectTypes/Properties a role can access | "Analysts can read Patient but not the `name` field" |
| Object-level | Which specific instances, derived from graph relationships | "Nurse Alice can see patients on her ward" |
| Action-level | Which ActionTypes a role can execute on which objects | "Only Consultants can execute ScheduleSurgery" |
| Field-level | Which properties are visible/editable per role | "Receptionists can see demographics but not clinical notes" |

#### 7.1.3 Field-Level Security Behaviour

Returning `null` for a non-null (`!`) field would trigger GraphQL's null-bubbling behaviour, which propagates the null up to the nearest nullable parent and can destroy entire response subtrees. Because Open Foundry always supports field-level redaction, the generated GraphQL API wraps non-primary ObjectType fields in a nullable envelope in all deployments.

**Schema transformation:** The ODL compiler generates the *public* GraphQL schema with all non-primary ObjectType fields as nullable, regardless of their ODL nullability. The ODL-declared nullability (`!`) is enforced at the Ontology Engine level (writes are rejected if a required field is missing), not at the GraphQL transport level. This means:

- ODL: `name: String!` → Generated GraphQL: `name: String` (nullable in transport)
- ODL: `id: ID! @primary` → Generated GraphQL: `id: ID!` (primary keys are never redacted)

Fields marked `@primary` are always non-null in the generated schema because they are never redacted — you cannot see an object at all if you lack permission for its identifier.

When a user requests an object but lacks permission for specific fields, the API returns the object with **unpermitted fields set to `null`** and a `_redactedFields` metadata array listing which fields were withheld:

```json
{
  "data": {
    "patient": {
      "id": "patient-abc-123",
      "nhsNumber": "1234567890",
      "name": null,
      "clinicalNotes": null,
      "_redactedFields": ["name", "clinicalNotes"]
    }
  }
}
```

Every generated ObjectType includes `_redactedFields: [String!]` and `_consentRestricted: Boolean` (see Section 7.3.1). Clients MAY inspect `_redactedFields` to distinguish "null because the value is null" from "null because you lack permission".

In the TypeScript SDK, redacted fields are typed as `T | null | Redacted`, where `Redacted` is a sentinel value distinct from both `null` and `undefined`:

#### 7.1.4 Permission Evaluation

Every API request:

1. Authenticates the caller (via OIDC token).
2. Resolves the caller's identity to a `user` in the authorisation model.
3. For each requested object/field/action, evaluates the OpenFGA check: `check(user:X, viewer, patient:Y)`.
4. Filters the response to include only permitted objects; redacts impermissible fields per Section 7.1.3.

Check latency target: < 5ms per check (OpenFGA is designed for this).

#### 7.1.5 Permission Check Batching

List queries can generate a large number of permission checks (N objects x M fields). To meet latency targets, the Security Layer MUST implement batching and pre-filtering strategies:

1. **Batch checks:** The Security Layer MUST use OpenFGA's `ListObjects` API to pre-compute the set of accessible object IDs for the requesting user and object type, then intersect this set with query results. This replaces per-object `Check` calls with a single `ListObjects` call per query.
2. **Field-level caching:** Field-level permission results are cached per (user, role-set, object-type) tuple for the duration of a request. Within a single request, if a user can see `Patient.name` on one patient, they can see it on all patients (field permissions are schema-level, not instance-level).
3. **Warm cache:** For frequently-accessed role/type combinations, the Security Layer SHOULD maintain a short-lived (TTL: 30s) local cache of `ListObjects` results to avoid redundant OpenFGA calls across concurrent requests from the same user.
4. **Consent pre-filter:** When the consent manager is active, the Query Layer SHOULD issue a batch consent check for all data-subject IDs in the result set before assembling the response, rather than checking consent per-object sequentially.

#### 7.1.6 Security Layer Circuit Breaker

The Security Layer MUST implement circuit breaker logic for its external dependencies (OpenFGA, consent store, OIDC provider) to prevent cascade failures when a dependency becomes unavailable or degraded.

Circuit breaker states:

1. **Closed** (normal): Requests flow to the dependency. The breaker monitors error rate and latency.
2. **Open** (tripped): The dependency has exceeded the failure threshold. All requests fail immediately with a structured error (`AUTH_SERVICE_UNAVAILABLE`, `CONSENT_SERVICE_UNAVAILABLE`) rather than waiting for timeouts. The breaker enters this state when the error rate exceeds a configurable threshold (default: 50% over a 30-second window).
3. **Half-open** (probing): After a configurable cooldown (default: 15 seconds), the breaker allows a single probe request. If it succeeds, the breaker returns to Closed. If it fails, the breaker returns to Open.

Fail-closed policy:

- When the OpenFGA circuit is open, all permission checks return **denied**. The system does not degrade to "allow all" — it fails closed.
- When the consent circuit is open, consent-protected operations return `CONSENT_SERVICE_UNAVAILABLE` unless an emergency override policy is enabled (see Section 12.4 degraded mode).
- Circuit breaker state transitions emit `openfoundry.security.circuit_breaker` events and are visible in the health endpoint (Section 3.1).

### 7.2 Audit Trail

Every operation produces an immutable audit record.

```typescript
interface AuditRecord {
  id: string;
  timestamp: DateTime;
  traceId: string;          // OpenTelemetry trace ID for correlation
  actor: {
    type: 'user' | 'system' | 'connector';
    id: string;
    roles: string[];
    ip?: string;
  };
  operation: {
    type: 'read' | 'create' | 'update' | 'delete' | 'action' | 'query' | 'link' | 'unlink';
    objectType?: string;
    objectId?: string;
    actionType?: string;
    actionId?: string;
  };
  detail: {
    before?: Record<string, any>;  // Previous state (for mutations)
    after?: Record<string, any>;   // New state (for mutations)
    query?: string;                // Query text (for reads)
    result?: 'success' | 'denied' | 'error';
    denialReason?: string;
    consentDecision?: 'granted' | 'denied' | 'not_required';
  };
}
```

Audit records are stored in an append-only log, separate from the ontology store. They are not modifiable or deletable. Retention is configurable per deployment.

Audit records MUST include the OpenTelemetry `traceId` so that they can be correlated with distributed traces for debugging.

#### 7.2.1 Audit Query API

The platform MUST expose a query interface for audit records. Audit queries are themselves audited.

```typescript
interface AuditStore {
  queryAuditRecords(filter: AuditFilter, options?: AuditQueryOptions): Promise<AuditPage>;
  getAuditRecord(id: string): Promise<AuditRecord | null>;
  getAuditTrail(objectType: string, objectId: string, options?: AuditQueryOptions): Promise<AuditPage>;
}

interface AuditFilter {
  actorId?: string;
  actorType?: 'user' | 'system' | 'connector';
  operationType?: ('read' | 'create' | 'update' | 'delete' | 'action' | 'query' | 'link' | 'unlink')[];
  objectType?: string;
  objectId?: string;
  actionType?: string;
  result?: 'success' | 'denied' | 'error';
  timeRange?: { from: DateTime; to: DateTime };
  traceId?: string;
}

interface AuditQueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: { field: 'timestamp'; direction: 'asc' | 'desc' };
}

interface AuditPage {
  records: AuditRecord[];
  totalCount: number;
  hasMore: boolean;
}
```

The GraphQL API exposes audit queries as:

```graphql
type Query {
  auditRecords(filter: AuditFilterInput, first: Int, after: String): AuditRecordConnection!
  auditTrail(objectType: String!, objectId: ID!, first: Int, after: String): AuditRecordConnection!
}
```

Audit query access MUST be restricted to users with the `audit:read` permission. Field-level redaction applies to the `detail.before` and `detail.after` snapshots — auditors see only the fields they are permitted to view on the underlying object type.

### 7.3 Consent Management

The consent layer is **integrated into the Action and Query execution pipelines** (not a standalone bolt-on). When activated by a Domain Pack, consent checks run as part of every data access operation.

```typescript
interface ConsentManager {
  // Single-subject operations
  checkConsent(subjectId: string, purpose: DataPurpose, requestor: string): Promise<ConsentDecision>;
  recordConsent(subjectId: string, purpose: DataPurpose, decision: 'GRANT' | 'DENY', evidence?: string): Promise<void>;
  revokeConsent(subjectId: string, purpose: DataPurpose, reason: string): Promise<RevocationResult>;
  getConsentRecord(subjectId: string): Promise<ConsentRecord[]>;

  // Batch operations (for list query pre-filtering)
  checkConsentBatch(subjectIds: string[], purpose: DataPurpose, requestor: string): Promise<Map<string, ConsentDecision>>;
}

interface ConsentDecision {
  allowed: boolean;
  purpose: DataPurpose;
  basis: 'explicit_consent' | 'legitimate_interest' | 'legal_obligation' | 'vital_interest';
  restrictions?: FieldRestriction[];  // Fields that MUST be redacted even if consent is granted
}

// DataPurpose is an OPEN string type — a deployment defines its own consent
// vocabulary (e.g. an AML deployment uses KYC / AML_MONITORING). The platform
// treats it opaquely (stored + matched as a string, never switched on). The
// values below are the standard NHS/UK-IG preset shipped for convenience and
// used as the back-compat default vocabulary, not the closed universe.
type DataPurpose = string;

const STANDARD_DATA_PURPOSES = [
  'DIRECT_CARE', 'CARE_PLANNING', 'SERVICE_MANAGEMENT', 'RESEARCH', 'NATIONAL_REPORTING',
];
```

The recordable vocabulary, the default purpose for access checks, and the object
type(s) that act as an action's consent subject are all deployment policy
(`CONSENT_PURPOSES`, `DEFAULT_CONSENT_PURPOSE`, `CONSENT_SUBJECT_TYPES`); the
defaults preserve the NHS preset and `Patient` subject.

#### 7.3.1 Consent in the Query Pipeline

For read operations, the consent check runs **after** the ReBAC permission check and **before** the response is assembled:

1. ReBAC check determines which objects the user can access.
2. For each accessible object that represents a data subject (e.g., Patient), the consent manager checks whether the data subject has consented to the stated purpose.
3. If consent is denied, the object is either excluded from results (for list queries) or returned with all fields redacted except the identifier (for single-object queries), with `_consentRestricted: true`. This field is part of the generated schema (see Section 8.1.1).

#### 7.3.2 Consent in the Action Pipeline

For write operations, the consent check is a dedicated step in the execution pipeline (see Section 5.3). A consent denial prevents the action from executing and returns a `CONSENT_DENIED` error.

#### 7.3.3 Legitimate-Relationship Exemption (NHS Direct Care)

The consent manager supports a configurable **legitimate-relationship exemption**: when the stated purpose matches the configured exemption purpose and the actor has a legitimate relationship with the subject (verified via ReBAC), consent is presumed. The exemption is **off by default** and enabled per-deployment (`CONSENT_DIRECT_CARE_EXEMPTION`), with a configurable purpose (`CONSENT_EXEMPTION_PURPOSE`, default `DIRECT_CARE`). The NHS instance of this is the direct-care exemption under Section 251 of the NHS Act 2006 (purpose `DIRECT_CARE`); the mechanism itself is purpose-agnostic. It MAY be overridden by subject-level opt-outs (e.g. the NHS National Data Opt-Out service).

#### 7.3.4 Consent Revocation

When consent is revoked via `revokeConsent`, the system MUST ensure the revocation takes effect promptly and consistently:

```typescript
interface RevocationResult {
  subjectId: string;
  purpose: DataPurpose;
  revokedAt: DateTime;
  activeSessions: number;    // Count of in-flight requests that may still use prior consent
  subscriptionsTerminated: number;  // Active subscriptions closed due to revocation
}
```

Revocation semantics:

1. **Cache invalidation:** `revokeConsent` MUST immediately invalidate any cached consent decisions for the subject and purpose. The consent manager's internal cache (if any) and the Security Layer's request-scoped cache (Section 7.1.5) MUST both be purged.
2. **In-flight requests:** Requests that have already passed the consent check but are still assembling a response are NOT retroactively aborted. Revocation takes effect on the next request boundary.
3. **Active subscriptions:** Any WebSocket subscriptions delivering data about the revoked subject for the revoked purpose MUST be terminated with a `CONSENT_REVOKED` close reason. The subscriber receives a final message indicating the subscription was closed due to consent change.
4. **Audit:** Revocation produces an audit record with `operation.type: 'consent_revoked'`, including the previous consent state, the revocation reason, and a count of affected subscriptions.
5. **Event emission:** A `openfoundry.consent.revoked` event is published, enabling downstream consumers to react (e.g., purging cached query results).
6. **Idempotency:** Revoking consent that was not previously granted is a no-op and returns a `RevocationResult` with `activeSessions: 0`.

### 7.4 Authentication

Open Foundry does not manage credentials. It delegates to external identity providers via:

| Protocol | Use Case |
|----------|----------|
| OIDC (OpenID Connect) | Web and API authentication. Primary method. |
| SAML 2.0 | Enterprise SSO federation. |
| mTLS | Service-to-service authentication (inter-instance, connectors). |
| API Key | System integrations where OIDC is impractical. Scoped and rotatable. |

The platform extracts user identity, roles, and group memberships from the OIDC token and maps them to the authorisation model.

### 7.5 Multi-Tenancy Model

Open Foundry uses a **shared control plane + logically isolated tenant data planes** model.

Tenant model contract:

1. Every request MUST carry a required `tenantId` resolved from auth context or API key scope.
2. SPI reads/writes are tenant-scoped and MUST reject missing/invalid tenant context.
3. Security tuples (OpenFGA) are isolated per tenant (separate store or strict tenant prefixing with isolation guarantees).
4. Event topics/streams include tenant partition keys; consumers MUST subscribe within tenant scope only.
5. Audit and lineage records include `tenantId` and are queryable only within tenant boundary.
6. Federation is instance-to-instance and tenant-scoped; cross-tenant federation within the same instance is forbidden unless explicitly bridged by an admin-controlled export workflow.
7. Quotas and rate limits are enforced at tenant and principal levels (see Section 8.7).

Deployment profiles:

- **Shared cluster** — multiple tenants in one cluster with strict logical isolation.
- **Dedicated tenant cluster** — one tenant per cluster for stronger isolation/compliance.

Both profiles MUST expose the same API and security semantics.

---

## 8. Query and API Layer

### 8.1 Auto-Generated GraphQL API

The ODL schema is compiled into a full GraphQL API. The compilation is deterministic for a given ODL schema and capability profile (from `StorageCapabilities`) — the same inputs produce the same GraphQL API.

#### 8.1.1 Generated Query Types

For each ObjectType `Foo`, the compiler generates:

```graphql
type Query {
  # Single object by ID
  foo(id: ID!): Foo

  # Filtered list with pagination
  foos(
    filter: FooFilter
    orderBy: FooOrderBy
    first: Int
    after: String
    last: Int
    before: String
  ): FooConnection!

  # Full-text search across all indexed fields
  # Generated only when supportsFullTextSearch = true
  searchFoos(query: String!, first: Int): FooConnection!

  # Cross-type discovery search
  # Generated only when supportsFullTextSearch = true
  searchAll(query: String!, types: [String!], first: Int): SearchResultConnection!

  # Low-latency typeahead
  # Generated only when supportsFullTextSearch = true
  typeahead(query: String!, types: [String!], limit: Int = 10): [TypeaheadHit!]!
}

# Relay-style pagination
type FooConnection {
  edges: [FooEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type FooEdge {
  node: Foo!
  cursor: String!
}

type SearchResultConnection {
  edges: [SearchResultEdge!]!
  pageInfo: PageInfo!
}

type SearchResultEdge {
  node: SearchResult!
  score: Float!
  cursor: String!
}

union SearchResult = Foo

type TypeaheadHit {
  type: String!
  id: ID!
  label: String!
}

# Auto-generated filter input
input FooFilter {
  id: IDFilter
  # ... one filter field per property
  AND: [FooFilter!]
  OR: [FooFilter!]
  NOT: FooFilter
}
```

If `supportsFullTextSearch` is `false`, `searchFoos` is omitted from the generated schema for that deployment.

Every generated ObjectType includes `_redactedFields: [String!]` and `_consentRestricted: Boolean` for security and consent transparency (see Sections 7.1.3 and 7.3.1).

#### 8.1.2 Generated Mutation Types

For each ActionType, the compiler generates a mutation (as shown in Section 5.4).

#### 8.1.3 FHIR Mapping for Mutations

When a loaded pack declares the `fhir` capability (Section 10.2) and a FHIR `POST`, `PUT`, or `DELETE` request is received for a resource type that maps to an ObjectType, the FHIR API facade translates the request into the appropriate Action:

1. The facade identifies which ActionType corresponds to the FHIR operation and HTTP method (configured in the Domain Pack's FHIR mapping — see `fhir.mutations` in Section 10.2).
2. It extracts the Action parameters from the FHIR resource payload (for POST/PUT) or the resource identifier (for DELETE).
3. It submits the Action through the normal Action execution pipeline.
4. It translates the Action result back into a FHIR OperationOutcome.

This ensures that all mutations — including those arriving via FHIR — pass through the full Action pipeline (validation, authorisation, consent, preconditions, audit). Every FHIR write method (POST, PUT, DELETE) MUST have a corresponding ActionType mapping in the Domain Pack; unmapped methods return `405 Method Not Allowed`. There MUST be no direct FHIR write bypass around the Action pipeline.

#### 8.1.4 Generated Subscription Types

```graphql
type Subscription {
  # Subscribe to changes on a specific object
  fooChanged(id: ID!): FooChangeEvent!

  # Subscribe to all changes on a type (with optional filter)
  foosChanged(filter: FooFilter): FooChangeEvent!
}

type FooChangeEvent {
  changeType: ChangeType!
  object: Foo!
  previousValues: JSON
  causedBy: ActionReference
  timestamp: DateTime!
}
```

Subscriptions are delivered via WebSocket (GraphQL Subscriptions protocol) or Server-Sent Events.

Subscription filtering and delivery:

1. **Server-side filter evaluation:** The `filter` argument on `foosChanged` is evaluated server-side against each change event before delivery. Only events matching the filter are sent to the subscriber. This prevents bandwidth waste and information leakage — clients never receive events they would discard.
2. **Security filtering:** Subscription events pass through the same ReBAC and consent checks as query responses. If a permission or consent change causes an object to become invisible to the subscriber, no further events for that object are delivered. The subscription remains open for other matching objects.
3. **Change type filtering:** Subscribers MAY include a `changeTypes: [ChangeType!]` argument to receive only specific change types (e.g., `[UPDATED, DELETED]` but not `CREATED`).
4. **Backpressure:** If a subscriber cannot consume events fast enough, the server buffers up to a configurable limit (default: 1000 events). If the buffer overflows, the subscription is terminated with an `OVERFLOW` close reason and the client must reconnect.
5. **Reconnection:** Subscriptions support a `resumeAfter: DateTime` argument for reconnection. On reconnect, the server replays events that occurred after the given timestamp (subject to event retention, default: 1 hour). Events older than the retention window are lost; the client should perform a full query to catch up.

#### 8.1.5 Search and Discovery

Search is capability-gated and security-aware.

If `supportsFullTextSearch = true`, the API MUST expose:

1. Per-type full-text search (`searchFoos`).
2. Cross-type search (`searchAll`) with typed result unions.
3. Typeahead endpoints for low-latency prefix/fuzzy matching.

Search contract:

1. Ranking SHOULD default to BM25-style relevance with optional recency boost.
2. Authorisation and consent filters are applied before result delivery; non-visible matches MUST NOT leak through counts, snippets, or score distributions.
3. `@indexed` controls exact/structured index creation; a separate `@searchable` directive (or equivalent config) controls full-text inclusion.
4. Search responses MUST include stable cursors and MAY include highlight snippets when permitted.

### 8.2 REST API

A REST API is auto-generated alongside GraphQL for clients that prefer it. It follows standard conventions:

```
GET    /api/v1/{objectType}              # List (with query params for filtering)
GET    /api/v1/{objectType}/{id}         # Get by ID
POST   /api/v1/actions/{actionType}      # Execute action
GET    /api/v1/{objectType}/{id}/links/{linkType}  # Get linked objects
GET    /api/v1/{objectType}/{id}/history  # Version history
GET    /health                            # Aggregate health (see below)
```

#### 8.2.1 Aggregate Health Endpoint

The platform exposes a single `/health` endpoint that aggregates health status from all subsystems. This is intended for load balancer probes, monitoring dashboards, and ops runbooks.

```json
GET /health

{
  "status": "DEGRADED",
  "timestamp": "2026-02-06T14:30:00Z",
  "subsystems": {
    "storage":       { "status": "HEALTHY", "latencyMs": 2 },
    "openfga":       { "status": "HEALTHY", "latencyMs": 3 },
    "eventBus":      { "status": "HEALTHY", "latencyMs": 5 },
    "celEvaluator":  { "status": "HEALTHY", "latencyMs": 1 },
    "consentStore":  { "status": "DEGRADED", "latencyMs": 450, "message": "Elevated latency" },
    "syncEngine":    { "status": "HEALTHY", "connectors": { "healthy": 1, "unhealthy": 0 } },
    "auditStore":    { "status": "HEALTHY", "latencyMs": 4 }
  },
  "circuitBreakers": {
    "openfga": "CLOSED",
    "consentStore": "HALF_OPEN"
  }
}
```

Health endpoint contract:

1. **Aggregate status** is the worst status across all subsystems: `HEALTHY` if all are healthy, `DEGRADED` if any subsystem is degraded, `UNHEALTHY` if any critical subsystem (storage, openfga) is down.
2. The endpoint MUST respond within 5 seconds. Subsystem health checks that do not respond within 3 seconds are reported as `TIMEOUT`.
3. The endpoint is unauthenticated (for load balancer probes) but returns only status information, never data. A separate authenticated `/health/detail` endpoint MAY expose additional diagnostics (connection pool stats, queue depths).
4. Circuit breaker states (Section 7.1.6) are included for operational visibility.
5. HTTP status codes: `200` for HEALTHY, `200` for DEGRADED (service is still accepting requests), `503` for UNHEALTHY.

### 8.3 FHIR R4 API

When a loaded domain pack declares the `fhir` capability (Section 10.2), ObjectTypes that map to FHIR Resources are additionally available via a FHIR R4-compliant API. The facade is **capability-gated**: a deployment whose loaded packs do not declare `fhir` does not mount `/fhir/*` and those routes return `404`.

```
GET    /fhir/Patient/{id}
GET    /fhir/Patient?identifier=https://fhir.nhs.uk/Id/nhs-number|1234567890
POST   /fhir/Patient
GET    /fhir/Encounter?patient=Patient/123
```

The FHIR API is generated from FHIR StructureDefinition profiles linked to ObjectTypes via the Domain Pack. It supports FHIR search parameters, `_include`, `_revinclude`, and pagination.

All FHIR write operations (POST, PUT, DELETE) are routed through the Action pipeline as described in Section 8.1.3. There MUST be no direct write path from the FHIR API to the Ontology Engine. Every FHIR write method MUST have a corresponding ActionType mapping in the Domain Pack's `fhir.mutations` configuration (see Section 10.2); unmapped methods return `405 Method Not Allowed`.

**FDP/CDM projection API.** A second read-only projection facade exposes ObjectTypes under a Common Data Model profile, gated by the `cdm` capability (Section 10.2). When a loaded pack declares `cdm`:

```
GET /api/v1/cdm/metadata               # public: profile, compatibility matrix, gap register
GET /api/v1/cdm/{ResourceType}/{id}    # authenticated per-resource projection
GET /api/v1/cdm/{ResourceType}/export  # dataset export (NDJSON | CSV)
```

The equivalent GraphQL queries (`cdmMetadata`, `cdmRecord`, `cdmRecords`, `cdmEncounters`) are generated alongside the REST mount and gated identically — the `cdm*` fields are omitted from the generated schema when no loaded pack declares the capability. Every projected record carries a `_provenance` envelope (source type/version/timestamp plus the list of lossy fields), and reads reuse the same authorization, field-level redaction, and consent pipeline as the native API. The reference profile and gap register are documented in `docs/nhs/cdm-mapping-profile.md`. As with FHIR, a deployment whose packs do not declare `cdm` returns `404` on `/api/v1/cdm/*`.

### 8.4 Client SDKs

Auto-generated typed SDKs are produced from the ODL schema.

```typescript
// TypeScript SDK — auto-generated
import { OpenFoundry, Redacted } from '@openfoundry/sdk';

const of = new OpenFoundry({ endpoint: 'https://trust-1.openfoundry.nhs.uk' });

// Typed queries
const patient = await of.Patient.get('patient-abc-123');
const ward = await patient.currentWard();
const patients = await ward.patients({ filter: { status: { eq: 'ACTIVE' } } });

// Field-level security: redacted fields are typed distinctly
if (patient.name === Redacted) {
  console.log('Name field is redacted due to permissions');
} else {
  console.log(`Patient name: ${patient.name}`);
}

// Actions
const result = await of.actions.dischargePatient({
  patient: 'patient-abc-123',
  destination: 'HOME',
  notes: 'Recovered well. Follow-up in 2 weeks.'
});

// Subscriptions
of.Patient.onChange('patient-abc-123', (event) => {
  console.log(`Patient updated: ${event.changeType}`, event.previousValues);
});
```

SDK targets: TypeScript/JavaScript (primary), Python, Java, Go.

### 8.5 Application Framework

The Application Framework provides the operational UI layer (widgets, dashboards, app builder) on top of ontology queries and actions.

```typescript
interface WidgetDefinition {
  id: string;
  type: 'TABLE' | 'KANBAN' | 'FORM' | 'CHART' | 'TIMELINE' | 'CUSTOM';
  query: QueryBinding;
  props: Record<string, any>;
  actions?: UIActionBinding[];
}

interface QueryBinding {
  query: string;               // GraphQL document or named query reference
  variables?: Record<string, any>;
  refresh: 'MANUAL' | 'POLL' | 'SUBSCRIPTION';
}

interface UIActionBinding {
  trigger: 'CLICK' | 'SUBMIT' | 'ROW_SELECT' | 'SCHEDULE';
  actionType: string;
  inputMapping: Record<string, string>;
}
```

Application framework requirements:

1. Layouts are declarative and versioned (dashboard/page definitions stored as configuration objects).
2. Data bindings are type-checked against generated API schema.
3. UI-triggered actions execute through the standard Action pipeline (no bypass path).
4. Builder mode supports non-developer composition with permission-aware component palettes.
5. Every rendered query/action in the UI carries trace/audit correlation metadata.

### 8.6 Webhook Integrations

External systems MAY subscribe to platform events without operating a Kafka consumer.

```yaml
# webhooks/discharge-events.yaml
name: discharge_webhook
tenantId: trust-leeds
eventTypes:
  - openfoundry.action.completed
filter: "data.causedBy.actionType == 'DischargePatient'"
endpoint: "https://example.org/hooks/discharge"
signing:
  algorithm: HMAC_SHA256
  secretRef: "vault://webhooks/discharge"
retry:
  maxAttempts: 8
  backoff: EXPONENTIAL
deadLetter: "kafka://integration.deadletter"
```

Webhook requirements:

1. Delivery is at-least-once with idempotency keys.
2. Payloads are signed; receivers verify signature and timestamp.
3. Failures use retry + dead-letter routing.
4. Registrations are tenant-scoped and permission-controlled.
5. **Signing key rotation:** The platform MUST support zero-downtime signing key rotation. During rotation, both the old and new keys are valid for a configurable overlap window (default: 24 hours). The webhook payload includes a `X-OpenFoundry-Key-Id` header identifying which key was used to sign, allowing receivers to select the correct verification key. After the overlap window expires, the old key is deactivated and deliveries use only the new key. Key rotation events are audited.

### 8.7 API Governance and Quotas

API governance applies across GraphQL, REST, FHIR, and federation ingress.

Required controls:

1. Rate limiting by tenant, principal, and client app.
2. Request quotas (daily/monthly) with budget exhaustion signals.
3. GraphQL depth, breadth, and complexity limits with configurable cost weights.
4. Server-side execution timeouts and response size caps.
5. CORS policy (allowed origins/methods/headers) and strict CSP for hosted UI surfaces.
6. Federation-specific caller quotas per remote instance and DSA.

Governance denials return structured `RATE_LIMITED` or `QUOTA_EXCEEDED` errors (Section 8.8).

### 8.8 Unified Error Model

All APIs return a consistent machine-readable error envelope.

```json
{
  "error": {
    "code": "CONSENT_DENIED",
    "category": "consent",
    "message": "Data subject has not consented to CARE_PLANNING purpose",
    "retryable": false,
    "details": { "subject": "patient-abc-123", "purpose": "CARE_PLANNING" },
    "traceId": "8f19b56a9f174f8e",
    "timestamp": "2026-02-06T14:31:00Z"
  }
}
```

Error categories:

- `validation`
- `authorization`
- `consent`
- `conflict`
- `rate_limit`
- `quota`
- `not_found`
- `system`
- `timeout`

Transport mapping:

1. GraphQL: error envelope appears in `errors[].extensions.openfoundry`.
2. REST/FHIR: envelope is returned in response body with HTTP status mapping.
3. SDKs: typed exceptions are generated from `code` + `category`.

### 8.9 API Versioning Strategy

Schema versioning and API versioning are related but distinct.

Versioning rules:

1. GraphQL MUST follow additive evolution by default; removals require deprecation period and major API release.
2. REST uses explicit path versioning (`/api/v1`, `/api/v2`) with compatibility guarantees per major version.
3. FHIR version remains R4 at protocol layer; Domain Pack mappings are versioned independently.
4. SDK major versions align with API major versions; generated clients encode minimum compatible schema range.
5. Every release publishes a machine-readable compatibility manifest (added/changed/removed operations and types).

---

## 9. Federation Protocol

### 9.1 Instance Identity

Each Open Foundry instance has:

- A globally unique **instance ID** (UUID).
- A human-readable **instance name** (e.g., `nhs-trust-leeds`).
- A **federation endpoint** URL for inter-instance communication.
- A **public key** for mutual authentication (mTLS or JWT).

Instances register with each other explicitly. There is no automatic discovery.

### 9.2 Data Sharing Agreements

Cross-instance data sharing requires a machine-readable Data Sharing Agreement (DSA) signed by both instances.

```yaml
# dsa/leeds-to-bradford.yaml
agreement:
  id: "dsa-001"
  tenantScope:
    providerTenant: "acute-leeds"
    consumerTenant: "acute-bradford"
  parties:
    - instance: "nhs-trust-leeds"
      role: PROVIDER
    - instance: "nhs-trust-bradford"
      role: CONSUMER
  
  purposes:
    - DIRECT_CARE  # Patient transfers between the two trusts
  
  scope:
    objectTypes:
      - Patient:
          fields: [id, nhsNumber, name, dateOfBirth, status]
          filter: "status == 'ACTIVE'"
      - AdmittedTo:
          fields: [admissionDate, expectedDischarge]
  
  accessControl:
    # Authorisation conditions — failure returns 403
    - type: authorisation
      expr: "consumer.actor.hasRole('clinician')"
      error: "Only clinicians can access cross-trust patient data"
  
  consentConditions:
    # Consent conditions — failure returns partial/redacted results
    - type: consent
      expr: "patient.hasConsent(DIRECT_CARE) || purpose == DIRECT_CARE"
      onDenial: REDACT  # Options: REDACT | EXCLUDE | REJECT
  
  pagination:
    maxPageSize: 100
    defaultPageSize: 20
  
  audit: BOTH_PARTIES
  expires: "2027-02-06"
```

The `accessControl` and `consentConditions` sections are evaluated separately with different failure modes: authorisation failures return HTTP 403; consent failures return partial results (with redacted or excluded objects) depending on the `onDenial` policy.

### 9.3 Cross-Instance Query

An authorised user at Instance A queries Instance B via the federation protocol.

```
┌──────────┐         ┌──────────────┐         ┌──────────┐
│Instance A│────1────▶│ Federation   │────2────▶│Instance B│
│ (caller) │         │   Gateway    │         │ (data)   │
│          │◀───5────│              │◀───3────│          │
└──────────┘         └──────────────┘         └──────────┘
                            │4
                     ┌──────▼──────┐
                     │  Audit Log  │
                     │ (both sides)│
                     └─────────────┘
```

1. User submits query through their local instance.
2. Local instance identifies that the query targets a remote instance. Checks DSA access control. Forwards request with the user's identity, tenant context, purpose, and pagination parameters.
3. Remote instance validates the DSA, checks access control conditions, evaluates consent conditions, applies field filtering (only DSA-scoped fields), and returns paginated results.
4. Both instances write audit records.
5. Results returned to the user.

Cross-instance queries are always synchronous request/response over mTLS. The federation gateway handles connection pooling, retries, and circuit breaking.

#### 9.3.1 Pagination

Cross-instance queries use cursor-based pagination to prevent unbounded result sets:

```graphql
# Federation query request
{
  patients(
    filter: { status: { eq: "ACTIVE" } }
    first: 20
    after: "cursor-abc"
  ) {
    edges {
      node { id, nhsNumber, name, dateOfBirth, status }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

The DSA's `pagination.maxPageSize` is enforced by the remote instance — requests for more records than the maximum are silently capped.

### 9.4 Federated Aggregation

For national/regional analytics where individual-level data SHOULD NOT leave the source instance.

```yaml
# Federated query: total waiting list by trust
query:
  type: AGGREGATE
  objectType: Patient
  filter:
    status: { eq: "ACTIVE" }
    has_link: { type: "WaitingListEntry" }
  aggregation:
    - function: COUNT
      groupBy: ["currentWard.trust"]
  
  privacy:
    method: DIFFERENTIAL_PRIVACY
    epsilon: 1.0
    minGroupSize: 10  # Suppress groups smaller than 10
```

Each instance evaluates the aggregation locally and returns only the aggregate result. The coordinating instance combines results. Privacy-enhancing techniques (differential privacy, k-anonymity, suppression of small groups) are applied at the source instance before results leave.

### 9.5 Object Handoff

When an entity moves between instances (e.g., patient transfer between trusts):

1. Source instance creates a **handoff record** containing the object state and relevant links.
2. Handoff is encrypted and sent to the destination instance.
3. Destination instance creates a local copy of the object and acknowledges receipt.
4. Source instance marks the object as `TRANSFERRED` and stores a reference to the destination instance.
5. Both instances audit the handoff.

The source instance retains its historical data. The destination instance starts a new version history. The handoff record links the two.

#### 9.5.1 Handoff Conflict Resolution

The destination instance MAY already have a local object with the same identity (e.g., a patient previously transferred away and now returning). The handoff protocol MUST handle this:

| Scenario | Resolution |
|----------|------------|
| No existing object at destination | Normal handoff: create new object with full state from source. |
| Existing object with status `TRANSFERRED` | **Return handoff:** Reactivate the existing object, merge the incoming state as a new version. The object's version history spans both instances. |
| Existing object with active status | **Conflict:** The handoff is rejected with `HANDOFF_CONFLICT`. Both instances are notified. An operator must resolve the conflict manually — either merge the objects (keeping one identity) or fork them (two distinct records). |
| Existing object that was hard-deleted | Normal handoff: create new object. The hard-deleted object's history is not recoverable. |

Conflict resolution requirements:

1. Handoff conflicts MUST NOT be auto-resolved — they produce a quarantine record at the destination instance, analogous to the sync identity conflict quarantine (Section 6.6).
2. Both instances emit `openfoundry.federation.handoff_conflict` events with the conflicting object states.
3. The source instance does NOT mark the object as `TRANSFERRED` until the destination acknowledges successful receipt. On conflict, the source object remains in its current state.

---

## 10. Domain Packs

### 10.1 Structure

A Domain Pack is a distributable bundle containing:

```
nhs-acute/
├── schema/
│   ├── patient.odl          # ObjectType definitions
│   ├── ward.odl
│   ├── theatre.odl
│   ├── waiting-list.odl
│   └── links.odl            # LinkType definitions
├── actions/
│   ├── discharge-patient.yaml
│   ├── schedule-surgery.yaml
│   ├── transfer-ward.yaml
│   └── admit-patient.yaml
├── connectors/
│   ├── nhs-spine.yaml        # Connector configurations
│   └── fhir-mapping.yaml     # FHIR resource → ObjectType + ActionType mapping
├── functions/
│   ├── src/
│   │   ├── waitingListRisk.ts
│   │   └── bedPressureScore.ts
│   └── package.json
├── permissions/
│   └── nhs-roles.fga         # OpenFGA model extensions
├── consent/
│   └── nhs-opt-out.yaml      # National opt-out integration config
├── quality/
│   └── rules.yaml            # Data quality rules
├── webhooks/
│   └── registrations.yaml    # Outbound webhook registrations
├── apps/                      # Reference applications (optional)
│   ├── waiting-list-manager/
│   └── discharge-planner/
├── pack.yaml                  # Pack metadata and dependencies
└── README.md
```

### 10.2 Pack Manifest

```yaml
# pack.yaml
name: nhs-acute
version: 1.0.0
description: "NHS acute healthcare domain pack for Open Foundry"
namespace: nhs.acute

dependencies:
  openfoundry.core: ">=1.0.0"

# Platform capabilities this pack opts into. The FHIR (/fhir/*) and FDP/CDM
# (/api/v1/cdm/*) projection facades — and their GraphQL equivalents — are
# mounted ONLY when a loaded pack declares the corresponding capability. A
# deployment whose loaded packs declare neither returns 404 on those routes and
# omits the cdm* GraphQL fields, keeping non-healthcare deployments free of the
# NHS-shaped surface.
capabilities:
  - fhir
  - cdm

provides:
  objectTypes: 14
  linkTypes: 12
  actionTypes: 8
  functions: 5
  connectors: 3
  widgets: 6
  qualityRules: 12

fhir:
  profiles:
    Patient: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient"
    Encounter: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Encounter"
  mutations:
    # Maps FHIR write operations (POST/PUT/DELETE) to ActionTypes
    Patient:
      create: AdmitPatient
      update: UpdatePatientDemographics
      delete: DeactivatePatient
    Encounter:
      create: RecordEncounter
      delete: VoidEncounter

terminology:
  - system: "http://snomed.info/sct"
    version: "2025-01"
  - system: "https://datadictionary.nhs.uk"
```

### 10.3 Core Domain Pack

The `openfoundry.core` pack ships with every installation and provides:

```graphql
# openfoundry.core — always available

interface Identifiable {
  id: ID! @primary
}

interface Auditable {
  createdAt: DateTime! @readonly
  createdBy: String! @readonly
  updatedAt: DateTime! @readonly
  updatedBy: String! @readonly
}

interface Locatable {
  location: GeoPoint
  address: String
}

interface Temporal {
  validFrom: DateTime
  validTo: DateTime
}

type CodeableConcept {
  system: URI!
  code: String!
  display: String!
}

scalar Date
scalar DateTime
scalar Duration
scalar GeoPoint
scalar JSON
scalar URI
```

### 10.4 Healthcare Domain Pack — Key Object Types

The initial `nhs-acute` pack includes the following ObjectTypes (non-exhaustive):

| ObjectType | Key Properties | Key Links |
|------------|---------------|-----------|
| `Patient` | nhsNumber, name, dateOfBirth, status, triageCategory | → Ward (AdmittedTo), → Consultant (Under) |
| `Ward` | name, specialty, capacity, currentOccupancy | → Trust (BelongsTo), ← Patient (AdmittedTo) |
| `Consultant` | gmcNumber, name, specialty | → Ward (WorksAt), ← Patient (Under) |
| `Theatre` | name, specialty, operatingHours | → Ward (LocatedIn) |
| `TheatreSlot` | startTime, endTime, status, procedure | → Theatre (In), → Patient (BookedFor) |
| `WaitingListEntry` | referralDate, pathway, clockStart, priority | → Patient (For), → Consultant (AssignedTo) |
| `Bed` | number, type, status | → Ward (In), → Patient (OccupiedBy) |
| `DischargeRecord` | dischargeDate, destination, notes | → Patient (For), → Ward (From) |
| `VaccinationRecord` | vaccineType, doseNumber, administeredDate | → Patient (For) |
| `Trust` | odsCode, name, region | ← Ward (BelongsTo) |

---

## 11. Testing and Conformance

### 11.1 SPI Conformance Suite

Every Storage Provider MUST pass a standardised conformance test suite covering:

| Category | Tests | Description |
|----------|-------|-------------|
| Schema | 25+ | Apply schemas, version schemas, validate migrations, handle breaking changes |
| CRUD | 40+ | Create, read, update, soft-delete, hard-delete for all scalar types |
| Links | 35+ | Create links, delete links by ID, update link properties, enforce cardinality, referential integrity, multiple links between same pair |
| Bulk | 20+ | Bulk mutation job lifecycle, idempotency, per-item results, `allOrNothing` handling (capability-gated by `supportsBulkMutations`) |
| Queries | 50+ | Filter predicates, logical composition (AND/OR/NOT), invalid mixed-node rejection, pagination, ordering, soft-delete exclusion/inclusion; full-text and geo query tests are capability-gated by `supportsFullTextSearch` and `supportsGeoQueries` |
| Traversal | 20+ | Multi-hop traversal, filtered traversal, depth limits, cycle handling, soft-delete exclusion (capability-gated by `supportsGraphTraversal`) |
| Transactions | 15+ | Atomic commits, rollbacks, concurrent writes, isolation |
| Temporal | 15+ | Point-in-time queries, version history, as-of queries (capability-gated by `supportsTemporalQueries`) |
| Multi-tenancy | 25+ | Tenant boundary enforcement, tenant-scoped indexing, event partitioning, isolation failure tests |
| Governance | 20+ | Rate limits, quotas, query complexity limits, CORS/CSP policy enforcement |
| Lineage | 20+ | Field provenance capture, lineage query expansion, immutability checks |
| Performance | 10+ | Latency benchmarks at defined data volumes (10K, 100K, 1M objects) |

A provider is **fully conformant** when it passes all REQUIRED categories (Schema, CRUD, Links, Queries, Transactions, Multi-tenancy, Governance, Lineage) and all capability-gated categories for capabilities it advertises as `true`.

A provider is **basic conformant** when it passes all REQUIRED categories and explicitly advertises one or more optional capabilities as `false` (`supportsGraphTraversal`, `supportsTemporalQueries`, `supportsFullTextSearch`, `supportsGeoQueries`, `supportsBulkMutations`). Capability-gated API surface MUST follow the advertised flags.

The conformance suite includes capability-consistency checks that verify advertised `StorageCapabilities` match runtime behaviour and generated API surface.

### 11.2 Integration Test Harness

An end-to-end test harness exercises the full stack from API to storage. It uses the Healthcare Domain Pack as its test fixture, deploying a complete instance with test data representing a synthetic NHS trust with 50,000 patients, 30 wards, and 200 consultants.

### 11.3 Action Conformance

Each ActionType's manifest is testable in isolation. The test framework:

1. Sets up an ontology state matching the action's preconditions.
2. Executes the action.
3. Asserts that all effects were applied.
4. Asserts that side-effects were triggered (via mock side-effect handlers).
5. Asserts that the audit record is correct (including consent decisions).
6. Tests each precondition violation individually.
7. Tests consent denial scenarios (when consent manager is active).
8. Verifies deterministic effect execution semantics (manifest order + immutable action context bindings).
9. Verifies `deleteLink` expectation modes (`expect: ONE` fails on multiple matches; `expect: ALL` removes all matches).

### 11.4 API and App Conformance

Cross-layer conformance tests validate API contracts and app-builder behaviour:

1. Unified error envelope presence and code/category mappings across GraphQL/REST/FHIR.
2. GraphQL complexity limit enforcement (depth/cost/time) and denial semantics.
3. Webhook registration, signature verification, retry, and dead-letter flows.
4. Search security guarantees (no leak via counts/snippets for inaccessible objects).
5. Application Framework bindings: widget query typing, UI action trigger mapping, permission-aware rendering.
6. Degraded mode behaviour matrix (auth outage, storage read-only, federation partial failure).

### 11.5 Governance Enforcement Conformance

A development deployment (`NODE_ENV != production`) runs **allow-all stubs** for fast local iteration: the OpenFGA client, CEL evaluator, and security layer all permit everything, and an absent `Authorization` header yields a synthetic admin user. Functional tests that run in this mode therefore **do not** exercise authentication, ReBAC authorization, field redaction, or consent enforcement — those layers are inert.

Conformance therefore REQUIRES a set of enforcement tests that run against `NODE_ENV=production` with real OIDC (token validation) and a real OpenFGA model loaded into a store. These verify the guarantees dev mode bypasses:

1. **Authentication** — requests with no token or an invalid token are rejected (`401`); a valid token is accepted.
2. **Authorization filtering** — an authenticated principal sees only objects it has a `viewer` path to: list endpoints filter via `listObjects` and direct reads `check`, so an object the principal cannot view is absent from lists and returns `403` on direct read. A grant written through the governed relationships API flips a previously-denied read to allowed.
3. **Capability gating** — a deployment whose loaded packs declare neither `fhir` nor `cdm` returns `404` on `/fhir/*` and `/api/v1/cdm/*` and omits the `cdm*` GraphQL fields.
4. **Open consent vocabulary** — the recordable consent purposes are deployment-configured (Section 7.3); a purpose outside the configured vocabulary is rejected, and a request omitting a purpose falls back to the configured default.

Because these boot the stack in non-default modes (production, a distinct pack set, or a custom consent vocabulary), they are environment-gated and run as a dedicated continuous-integration job, separate from the standard functional suite.

---

## 12. Deployment

### 12.1 Container Architecture

Open Foundry ships as a set of OCI-compliant container images.

| Service | Image | Scaling |
|---------|-------|---------|
| `ontology-engine` | Core engine, schema registry | Horizontal (stateless) |
| `api-gateway` | GraphQL/REST/FHIR API | Horizontal (stateless) |
| `action-executor` | Action validation and effect execution | Horizontal (stateless) |
| `sync-engine` | Connector runtime, CDC pipeline | Horizontal (per-connector) |
| `security-service` | OpenFGA integration, token validation, consent | Horizontal (stateless) |
| `audit-writer` | Append-only audit log writer | Horizontal (stateless) |
| `federation-gateway` | Cross-instance communication | Horizontal (stateless) |
| `event-bus` | Kafka/RedPanda (or external) | Per vendor guidance |
| `storage` | TypeDB/Neo4j/PostgreSQL (or external) | Per vendor guidance |

### 12.2 Kubernetes Deployment

A Helm chart provides production-grade deployment. Domain Pack versions are explicitly pinned:

```bash
helm install my-instance openfoundry/openfoundry \
  --set storage.provider=typedb \
  --set storage.typedb.host=typedb-cluster:1729 \
  --set eventBus.kafka.bootstrapServers=kafka:9092 \
  --set auth.oidc.issuer=https://login.microsoftonline.com/tenant \
  --set domainPacks[0].name=nhs-acute \
  --set domainPacks[0].version=1.0.0 \
  --set federation.enabled=true \
  --set federation.instanceId=nhs-trust-leeds \
  --set federation.endpoint=https://openfoundry.leeds.nhs.uk \
  --set observability.otlp.endpoint=https://otel-collector:4317
```

### 12.3 Minimal Development Deployment

For local development, a single Docker Compose file starts the entire stack with the in-memory storage provider:

```bash
docker compose up
# API available at http://localhost:4000/graphql
# Admin UI at http://localhost:4000/admin
```

### 12.4 Degraded Mode and Outage Behaviour

Deployments MUST define deterministic behaviour for dependency outages.

| Dependency Degraded | Required Behaviour |
|---------------------|--------------------|
| OIDC/SAML provider unavailable | Existing short-lived sessions continue until expiry; new login attempts fail closed with `AUTH_PROVIDER_UNAVAILABLE`. |
| Primary storage unavailable but read replica healthy | Read-only mode MAY be enabled for approved APIs; write/actions return `SERVICE_DEGRADED`. |
| Consent service unavailable | Consent-protected operations fail closed unless explicit emergency override policy is enabled and audited. |
| Federation target unavailable | Query returns partial federated result with per-target error entries; local instance remains available. |
| Event bus degraded | Writes continue only if audit + lineage durability guarantees are preserved; otherwise system enters controlled write-shed mode. |

Degraded mode requirements:

1. State transitions (`NORMAL`, `READ_ONLY`, `DEGRADED`, `MAINTENANCE`) are explicit and observable.
2. Every degraded response includes machine-readable mode metadata.
3. Emergency overrides require break-glass permissions and immutable audit records.

---

## 13. Non-Functional Requirements

### 13.1 Performance Targets

| Operation | Target (p99) | Notes |
|-----------|-------------|-------|
| Single object read | < 50ms | Includes LAZY computed field evaluation for simple fields |
| Filtered list (1000 results) | < 200ms | |
| 3-hop graph traversal (1M objects) | < 200ms | |
| Action execution (2 side-effects) | < 500ms | Excludes async side-effects |
| Bulk action validation (10K items, dry-run) | < 30 seconds | Includes per-item validation/auth/consent checks |
| CDC sync latency (source → ontology) | < 30 seconds | Steady-state incremental only. Does not apply during initial full extract. |
| Permission check | < 5ms | |
| Consent check | < 10ms | |
| GraphQL subscription delivery | < 100ms after state change | |

### 13.2 Scalability Targets

| Dimension | Target |
|-----------|--------|
| Objects per instance | 100M |
| Concurrent API users per instance | 1,000 |
| Federated instances | 250 |
| Cross-instance query latency | < 2 seconds |
| Connectors per instance | 50 |
| Events per second (sustained) | 10,000 |

### 13.3 Security Requirements

| Requirement | Specification |
|-------------|---------------|
| Encryption at rest | AES-256 |
| Encryption in transit | TLS 1.3 |
| Authentication | OIDC / SAML 2.0 / mTLS |
| Authorisation | ReBAC via OpenFGA |
| Consent | Integrated into query and action pipelines when Domain Pack activates it |
| API abuse protection | Rate limits, quotas, GraphQL complexity limits |
| Browser hardening | Explicit CORS allowlists and CSP for hosted UI surfaces |
| Function isolation | WASM or V8 isolate sandbox with resource/network restrictions |
| Secrets management | No plaintext secrets. Integrate with Vault/K8s Secrets. |
| Audit retention | Configurable. Default: indefinite. |
| Vulnerability scanning | All images scanned on build. No critical CVEs in release. |

### 13.4 Availability

| Metric | Target | Notes |
|--------|--------|-------|
| Uptime | 99.9% per instance | |
| Deployment | Zero-downtime rolling updates | |
| RPO | < 1 hour | Requires storage provider with streaming replication and/or point-in-time recovery capability (see Section 3.6) |
| RTO | < 4 hours | |

---

## 14. Open Technical Decisions

### 14.1 Remaining Open Decisions

| # | Decision | Options | Notes |
|---|----------|---------|-------|
| 1 | Tenant placement policy | Shared cluster, dedicated cluster, hybrid | Multi-tenancy model is fixed; deployment policy remains operator choice. |

### 14.2 Decisions Resolved in This Version

- **Expression language** — CEL (Common Expression Language). See Section 5.2.
- **Computed field evaluation** — Hybrid (LAZY/EAGER/TTL per field). See Section 4.4.
- **Multi-tenancy model** — shared control plane with logical tenant data-plane isolation. See Section 7.5.
- **CEL runtime strategy** — canonical evaluator via WASM or sidecar service, not pure TypeScript runtime. See Section 5.2.4.
- **Migration expression language** — CEL, same as Action Framework. See Section 2.5.2.
- **ODL compiler implementation language** — TypeScript. Aligns with GraphQL ecosystem tooling (parsers, formatters, IDE plugins). The compiler is not on the hot path; performance is not a concern here.
- **Side-effect orchestration** — Temporal.io. Most mature workflow engine with durable execution, retry semantics, and visibility tooling. In MVP, side-effects MAY be executed inline with retry via a lightweight wrapper; Temporal integration is required for production.
- **Federation transport** — gRPC with Protobuf payloads. Performance and strong typing outweigh the convenience of GraphQL Federation. The federation gateway exposes a gRPC service definition; the API layer translates federated GraphQL queries to gRPC calls internally.
- **Schema storage** — Git-backed (GitOps) as primary, with database-backed registry as runtime cache. ODL files live in Git repositories and are applied via CI/CD pipelines. The schema registry stores compiled snapshots for runtime access.
- **FHIR API implementation** — Custom TypeScript facade (sidecar). Avoids Java dependency (HAPI) while allowing rapid iteration. The facade translates between FHIR R4 and the GraphQL API, using Domain Pack FHIR mappings.
- **v1 storage provider** — PostgreSQL + Apache AGE as sole reference provider. Lowest barrier to entry, best operational familiarity for NHS infrastructure teams. TypeDB and Neo4j providers are deferred to post-v1. The SPI conformance suite ships with v1 to enable third-party providers.

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **ODL** | Ontology Definition Language. The GraphQL SDL-based schema language for Open Foundry. |
| **ObjectType** | A schema definition of a real-world entity or event (e.g., Patient, Ward). |
| **Object** | A single instance of an ObjectType. |
| **LinkType** | A schema definition of a relationship between two ObjectTypes, with optional properties. Links have their own identity (ID). |
| **ActionType** | A schema definition of a validated, auditable mutation with preconditions and side-effects. |
| **Function** | A named, sandboxed computation over ontology objects. Read-only. |
| **Domain Pack** | A distributable bundle of schemas, actions, connectors, functions, and apps for a specific domain. |
| **SPI** | Storage Provider Interface. The abstraction layer between the Ontology Engine and persistence. |
| **CDC** | Change Data Capture. Capturing row-level changes from source databases. |
| **CEL** | Common Expression Language. Google's safe, fast expression language used for preconditions and effects. |
| **ReBAC** | Relationship-Based Access Control. Permissions derived from graph relationships. |
| **DSA** | Data Sharing Agreement. Machine-readable contract governing cross-instance data access. |
| **CloudEvent** | CNCF standard envelope format for events. Used for all ontology state changes. |
| **Tenant** | An isolated security and data boundary within an Open Foundry instance. |
| **Schema Workspace** | An isolated branch-like environment for developing and validating schema/migration changes before merge. |
| **Provenance** | Metadata describing where a field value originated and how it was produced. |
| **Bulk Action Job** | An asynchronous execution record for batch action submissions with per-item outcomes. |
| **Digital Twin** | A live, continuously updated model of a real-world system. |
| **Federation** | Architecture pattern where multiple independent instances share data selectively. |
| **PET** | Privacy-Enhancing Technology (differential privacy, secure aggregation, etc.). |
| **Overlay Mode** | A Sync Engine mode where source data is queried in place via read-through mapping rather than extracted into the ontology store. |
| **Tool Descriptor** | A machine-readable description of an Action or Function, compatible with LLM tool-use interfaces. |
| **Reverse Action** | An auto-generated or manually specified undo operation for a reversible Action. |

## Appendix B: Event Type Registry

| Event Type | Trigger | Payload |
|------------|---------|---------|
| `openfoundry.object.created` | Object instantiated | Full object state |
| `openfoundry.object.updated` | Object properties changed | Changed fields with old/new values |
| `openfoundry.object.deleted` | Object soft/hard deleted | Object ID, deletion mode |
| `openfoundry.link.created` | Link established | Link ID, link type, from/to IDs, link properties |
| `openfoundry.link.updated` | Link properties changed | Link ID, changed fields with old/new values |
| `openfoundry.link.deleted` | Link removed | Link ID, link type, from/to IDs |
| `openfoundry.action.submitted` | Action submitted | Action type, parameters, actor |
| `openfoundry.action.completed` | Action succeeded | Action ID, affected objects |
| `openfoundry.action.failed` | Action failed | Action ID, error details |
| `openfoundry.schema.updated` | Schema version applied | Old version, new version, diff summary |
| `openfoundry.sync.completed` | Sync batch completed | Connector, records processed, errors |
| `openfoundry.sync.conflict` | Sync conflict detected | Object ID, conflicting values, resolution |
| `openfoundry.sync.fullextract.progress` | Full extract progress | Connector, records processed, estimated remaining |
| `openfoundry.bulk.progress` | Bulk job progress updated | Job ID, processed count, failed count |
| `openfoundry.bulk.completed` | Bulk job completed | Job ID, summary, duration |
| `openfoundry.bulk.failed` | Bulk job failed | Job ID, failure reason, failed item sample |
| `openfoundry.webhook.delivery_failed` | Webhook delivery exhausted retries | Registration ID, event ID, endpoint, dead-letter reference |
| `openfoundry.quality.violation` | Data quality rule violation detected | Rule ID, severity, object refs, evidence |
| `openfoundry.federation.query` | Cross-instance query executed | Source instance, target instance, query summary |
| `openfoundry.federation.handoff` | Object handed off between instances | Object type/ID, source, destination |
| `openfoundry.security.denied` | Access denied | Actor, resource, reason |
| `openfoundry.consent.denied` | Consent check failed | Subject, purpose, actor |

## Appendix C: Directive Quick Reference

| Directive | Target | Signature |
|-----------|--------|-----------|
| `@objectType` | type | `@objectType` |
| `@linkType` | type | `@linkType(from: String!, to: String!, cardinality: Cardinality!)` |
| `@link` | field | `@link(type: String!, direction: Direction!, history: Boolean)` |
| `@actionType` | type | `@actionType` |
| `@function` | type | `@function(runtime: String!, entry: String!)` |
| `@primary` | field | `@primary` |
| `@unique` | field | `@unique` |
| `@indexed` | field | `@indexed` |
| `@readonly` | field | `@readonly` |
| `@computed` | field | `@computed(fn: String!, args: JSON, cache: CacheStrategy, ttl: Duration)` |
| `@deprecated` | any | `@deprecated(reason: String!)` |
| `@param` | field | `@param` |
| `@constraint` | field, type | `@constraint(expr: String!)` |
| `@default` | field | `@default(value: Any!)` |
| `@immutable` | field | `@immutable` |
| `@sensitive` | field | `@sensitive` |
| `@terminology` | field | `@terminology(system: String!)` |
| `@searchable` | field | `@searchable(weight: Float, analyzer: String)` |
| `@namespace` | schema | `@namespace(name: String!, version: String!)` |

## Appendix D: Directory Structure

```
openfoundry/
├── packages/
│   ├── core/                    # Ontology Engine
│   │   ├── src/
│   │   │   ├── schema/          # ODL compiler, schema registry
│   │   │   ├── engine/          # Object lifecycle, validation, events
│   │   │   ├── computed/        # Computed field evaluation & caching
│   │   │   ├── spi/             # Storage Provider Interface definition
│   │   │   └── index.ts
│   │   └── package.json
│   ├── storage-typedb/          # TypeDB storage provider
│   ├── storage-neo4j/           # Neo4j storage provider
│   ├── storage-postgres/        # PostgreSQL+AGE storage provider
│   ├── storage-memory/          # In-memory provider (testing)
│   ├── sync/                    # Sync Engine
│   │   ├── src/
│   │   │   ├── connectors/      # Connector interface + built-in connectors
│   │   │   ├── mapping/         # Datasource mapping engine
│   │   │   ├── conflict/        # Conflict resolution
│   │   │   └── flow/            # Backpressure, rate limiting, circuit breaker
│   │   └── package.json
│   ├── actions/                 # Action Framework
│   │   ├── src/
│   │   │   ├── parser/          # Action manifest parser
│   │   │   ├── executor/        # Execution pipeline
│   │   │   ├── cel/             # CEL expression evaluator + ODL type integration
│   │   │   └── sideeffects/     # Side-effect orchestration
│   │   └── package.json
│   ├── security/                # Security Layer
│   │   ├── src/
│   │   │   ├── auth/            # OIDC/SAML integration
│   │   │   ├── authz/           # OpenFGA integration, model generation
│   │   │   ├── audit/           # Audit trail writer
│   │   │   └── consent/         # Consent management (pipeline-integrated)
│   │   └── package.json
│   ├── api/                     # Query & API Layer
│   │   ├── src/
│   │   │   ├── graphql/         # GraphQL schema compiler, resolvers
│   │   │   ├── rest/            # REST API generator
│   │   │   ├── fhir/            # FHIR R4 facade (optional)
│   │   │   └── subscriptions/   # WebSocket/SSE subscription manager
│   │   └── package.json
│   ├── app-framework/           # Widgets, dashboards, app-builder runtime
│   │   ├── src/
│   │   │   ├── widgets/
│   │   │   ├── layouts/
│   │   │   └── bindings/
│   │   └── package.json
│   ├── governance/              # Rate limits, quotas, query complexity controls
│   │   ├── src/
│   │   │   ├── limits/
│   │   │   ├── quotas/
│   │   │   └── policies/
│   │   └── package.json
│   ├── lineage/                 # Provenance capture and lineage query APIs
│   │   ├── src/
│   │   │   ├── capture/
│   │   │   └── query/
│   │   └── package.json
│   ├── webhooks/                # Declarative webhook registry + delivery worker
│   │   ├── src/
│   │   │   ├── registry/
│   │   │   └── delivery/
│   │   └── package.json
│   ├── federation/              # Federation Protocol
│   │   ├── src/
│   │   │   ├── gateway/         # Federation gateway service
│   │   │   ├── dsa/             # Data Sharing Agreement engine
│   │   │   ├── handoff/         # Object handoff protocol
│   │   │   └── aggregation/     # Federated aggregation with PETs
│   │   └── package.json
│   ├── observability/           # Shared OpenTelemetry instrumentation
│   │   ├── src/
│   │   │   ├── traces/          # Span definitions and context propagation
│   │   │   └── metrics/         # Metric definitions and exporters
│   │   └── package.json
│   ├── sdk-typescript/          # TypeScript client SDK (auto-generated)
│   ├── sdk-python/              # Python client SDK (auto-generated)
│   └── cli/                     # Command-line tool (includes odl rollback)
├── domain-packs/
│   ├── core/                    # openfoundry.core (always installed)
│   └── nhs-acute/               # NHS acute healthcare domain pack
├── deploy/
│   ├── helm/                    # Helm chart (with version-pinned domain packs)
│   ├── docker-compose.yaml      # Local development
│   └── terraform/               # Infrastructure examples
├── tests/
│   ├── spi-conformance/         # Storage provider conformance suite
│   ├── integration/             # End-to-end integration tests
│   ├── governance/              # Rate limit/quota/query-cost tests
│   ├── multitenancy/            # Tenant isolation and boundary tests
│   ├── lineage/                 # Provenance capture/query tests
│   └── performance/             # Load and latency benchmarks
└── docs/
    ├── spec/                    # This specification
    ├── guides/                  # Developer guides
    └── api/                     # Auto-generated API docs
```
