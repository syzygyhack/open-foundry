# Open Foundry — MVP Design: NHS Acute Pilot

**Status:** Draft
**Date:** February 2026
**Parent Spec:** open-foundry-spec-v2.md

---

## 1. Purpose

This document defines the minimum viable product (MVP) for Open Foundry — a vertical slice sufficient to onboard an NHS acute trust as a pilot customer. It identifies exactly what ships, what is deferred, and how the deferred items are stubbed so the architecture remains intact for later expansion.

The pilot must demonstrate:

1. A live ontology modelling patients, wards, beds, and consultants.
2. Real data flowing from a PAS (Patient Administration System) into the ontology.
3. Clinicians executing actions (admit, discharge, transfer) through a GraphQL API.
4. ReBAC-enforced permissions (ward-scoped visibility).
5. An immutable audit trail for every operation.
6. A FHIR R4 read endpoint for interoperability.

---

## 2. Scope Boundary

### 2.1 Must Ship

| # | Component | Spec Section | Scope |
|---|-----------|-------------|-------|
| 1 | **ODL Compiler** | 2 | Full ODL parser + validator + GraphQL API generator. TypeScript. Ships as `@openfoundry/odl` CLI and library. |
| 2 | **Schema Registry** | 2.5, 4.1 | Git-backed primary (ODL files in repo), database-backed runtime cache in PostgreSQL. Schema lifecycle per Section 2.5; registry is an Ontology Engine responsibility per Section 4.1. No schema workspaces yet. |
| 3 | **PostgreSQL+AGE Storage Provider** | 3 | Sole provider. Full SPI conformance for REQUIRED categories: Schema, CRUD, Links, Queries, Transactions, Multi-tenancy, Governance, Lineage. Temporal queries via object `_version` history table. |
| 4 | **In-Memory Storage Provider** | 3.7 | For unit/integration tests only. |
| 5 | **Ontology Engine** | 4 | Object lifecycle, link management, schema validation, constraint evaluation, uniqueness checks, cardinality enforcement, event emission (CloudEvents). Computed fields: LAZY only. |
| 6 | **Action Framework** | 5 | YAML manifest parsing, CEL preconditions + effects, full execution pipeline (validate → authorise → consent → preconditions → execute → audit → emit). Side-effects: inline webhook calls with retry (Temporal deferred). |
| 7 | **CEL Evaluator** | 5.2.4 | Go sidecar with gRPC interface. Ships as a container image. TypeScript CEL used only in ODL compiler for static type-checking. |
| 8 | **Security Layer** | 7 | OpenFGA integration for ReBAC. Schema-level + object-level permissions. Field-level redaction with `_redactedFields`. Permission batching via `ListObjects` (Section 7.1.5). OIDC authentication. |
| 9 | **Consent Manager** | 7.3 | Active for NHS Domain Pack. Direct care exemption. Consent check in action + query pipelines. Batch consent pre-filter for list queries. |
| 10 | **Audit Trail** | 7.2 | Append-only audit log in PostgreSQL (separate schema). Includes traceId correlation. |
| 11 | **GraphQL API** | 8.1 | Auto-generated queries, mutations (from ActionTypes), subscriptions (WebSocket). Relay-style pagination. Unified error model. |
| 12 | **REST API** | 8.2 | Auto-generated alongside GraphQL. Standard CRUD + action endpoints. |
| 13 | **FHIR R4 API** | 8.3 | **Read-only** facade for Patient, Encounter. Custom TypeScript sidecar. FHIR write routing via Actions deferred to post-MVP (see Section 2.2). |
| 14 | **Sync Engine** | 6 | JDBC connector (PostgreSQL PAS source) with CDC via Debezium. Overlay mode for initial demo. Migration path from overlay to CDC. |
| 15 | **TypeScript SDK** | 8.4 | Auto-generated typed client from ODL. Query, mutation, subscription support. |
| 16 | **Lineage** | 4.6 | Field-level provenance records for every write. Queryable via opt-in `includeLineage` flag. |
| 17 | **Observability** | 4.5 | OpenTelemetry traces + metrics for all operations. OTLP export. |
| 18 | **NHS Acute Domain Pack (core slice)** | 10 | 5 ObjectTypes, 4 LinkTypes, 3 ActionTypes, 1 connector, FHIR mappings. See Section 4 below. |
| 19 | **AI-Ready Tool Registry** | 5.7 | `availableTools` query endpoint. ToolDescriptor export (JSON Schema). Agent context header support with dry-run. |
| 20 | **SPI Conformance Suite** | 11.1 | Full test suite for REQUIRED categories. Ships as a reusable test package. |
| 21 | **Docker Compose dev deployment** | 12.3 | Single `docker compose up` for local development. |
| 22 | **Helm chart (basic)** | 12.2 | Production Kubernetes deployment with PostgreSQL, OpenFGA, Kafka (RedPanda), CEL sidecar. |

### 2.2 Deferred to Post-MVP

| Component | Reason |
|-----------|--------|
| TypeDB / Neo4j providers | Single provider strategy for v1. SPI conformance suite enables later addition. |
| EAGER / TTL computed fields | Dependency tracking complexity. LAZY covers all pilot use cases. |
| Schema workspaces | Development workflow nicety, not needed for single-team pilot. |
| Federated aggregation with differential privacy | Research-grade feature. Federation query + handoff ship; PETs deferred. |
| Application Framework (widgets, dashboards, app builder) | Not building a UI framework. Pilot uses GraphQL API + reference apps. |
| Python / Java / Go SDKs | TypeScript SDK is sufficient for pilot. Others generated from same ODL toolchain later. |
| Bulk action async job model | Synchronous chunked execution sufficient for pilot volumes. |
| Full-text search (`@searchable` runtime) | The `@searchable` directive is accepted by the ODL compiler and stored in the schema, but has no runtime effect in the MVP — the PostgreSQL provider reports `supportsFullTextSearch: false`. Structured queries via `@indexed` cover pilot needs. |
| Action undo | Specified in spec (Section 5.6) but deferred from first release. Audit snapshots are captured regardless, enabling future implementation. |
| Webhook dead-letter (Kafka) | Inline retry is sufficient for pilot. Dead-letter requires Kafka integration. |
| Federation protocol | Cross-instance queries deferred. Single-instance pilot. DSA model and gateway are specified but not built. |
| SAML 2.0 / mTLS auth | OIDC covers pilot identity provider (NHS Care Identity Service). |
| FHIR write routing | FHIR write operations (POST/PUT/DELETE) routed through Action pipeline deferred. FHIR is read-only in MVP. Mutations go through GraphQL/REST. |

### 2.3 Stubbed (Interface Present, Implementation Minimal)

| Component | Stub Behaviour |
|-----------|---------------|
| Side-effect orchestration | Inline execution with retry loop (3 attempts, exponential backoff). Temporal interface defined but implementation is a lightweight wrapper. |
| Webhook delivery | Synchronous HTTP POST with retry. No dead-letter queue. Failures logged. |
| Federation gateway | **Not built.** Specified in spec §9 only — there is no federation package, gRPC proto, gateway, or DSA parser in the codebase. Tracked as deferred in §2.3 above; listed here to correct earlier phrasing that implied a compiled stub. |
| Bulk actions | Synchronous chunked execution. No async job queue. Progress reported inline. |
| Data quality rules | Rule parser loads YAML. Evaluation runs on a cron schedule, not inline with writes. |
| Lineage / temporal queries | Field-level lineage is recorded and the SPI supports `getObjectAtTime`/`getObjectAtVersion`, but the only API surface is `GET /api/v1/{plural}/:id/history` (which uses `getObjectAtVersion` internally). There is no as-of-time or version-pinned **query** parameter on reads via REST/GraphQL — provenance/temporal querying needs resolver/route additions. |

---

## 3. Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language | TypeScript (Node.js 22) | All platform services except CEL evaluator. |
| CEL Evaluator | Go 1.23 | Reference CEL implementation. Deployed as gRPC sidecar container. |
| Storage | PostgreSQL 17 + Apache AGE 1.5 | Single database. Ontology objects in relational tables; graph traversal via AGE. |
| Auth | OpenFGA 1.8+ | ReBAC. Deployed as a container alongside the platform. |
| Identity | OIDC (Keycloak for dev; NHS CIS2 for production) | |
| Event Bus | RedPanda (Kafka-compatible) | Lightweight, single-binary. Used for CloudEvents. |
| CDC | Debezium 2.x | Captures PAS database changes. Feeds into Sync Engine via Kafka topic. |
| Observability | OpenTelemetry SDK → OTLP Collector | Traces + metrics. Collector configured per deployment. |
| Container Runtime | OCI (Docker) | All services ship as container images. |
| Orchestration | Kubernetes (Helm) | Production. Docker Compose for dev. |
| CI/CD | GitHub Actions | ODL compilation, SPI conformance tests, container builds. |

### 3.1 Monorepo Structure (MVP Scope)

```
openfoundry/
├── packages/
│   ├── odl/                      # ODL compiler, parser, validator, codegen
│   │   ├── src/
│   │   │   ├── parser/           # GraphQL SDL parser + directive extraction
│   │   │   ├── validator/        # Type checking, constraint validation, CEL static analysis
│   │   │   ├── codegen/          # GraphQL API schema generator, SDK generator, OpenFGA model generator
│   │   │   ├── diff/             # Schema diff, migration classifier, reverse diff
│   │   │   └── registry/         # Schema version storage (Git + DB cache)
│   │   ├── cli/                  # `odl` CLI (validate, diff, apply, rollback, generate)
│   │   └── package.json
│   ├── engine/                   # Ontology Engine
│   │   ├── src/
│   │   │   ├── objects/          # Object CRUD, validation pipeline, constraint evaluation
│   │   │   ├── links/            # Link management, cardinality enforcement
│   │   │   ├── computed/         # Computed field evaluation (LAZY only)
│   │   │   ├── events/           # CloudEvent emission
│   │   │   ├── lineage/          # Provenance capture
│   │   │   └── quality/          # Data quality rule loader + evaluator
│   │   └── package.json
│   ├── spi/                      # SPI interface definitions (TypeScript)
│   │   ├── src/
│   │   │   └── index.ts          # StorageProvider, OntologyObject, OntologyLink, etc.
│   │   └── package.json
│   ├── storage-postgres/         # PostgreSQL+AGE storage provider
│   │   ├── src/
│   │   │   ├── schema/           # DDL generation from ODL, AGE graph setup
│   │   │   ├── objects/          # Object CRUD implementation
│   │   │   ├── links/            # Link CRUD + AGE graph queries
│   │   │   ├── transactions/     # PG transaction wrapper
│   │   │   ├── temporal/         # Version history table, as-of queries
│   │   │   └── migrations/       # SPI-level DB migrations (internal schema)
│   │   └── package.json
│   ├── storage-memory/           # In-memory provider (testing)
│   │   └── package.json
│   ├── actions/                  # Action Framework
│   │   ├── src/
│   │   │   ├── parser/           # YAML manifest parser + validator
│   │   │   ├── executor/         # Execution pipeline orchestrator
│   │   │   ├── cel/              # CEL sidecar client (gRPC), static type checker
│   │   │   ├── sideeffects/      # Inline webhook executor with retry
│   │   │   └── tools/            # AI tool registry + ToolDescriptor generator
│   │   └── package.json
│   ├── security/                 # Security Layer
│   │   ├── src/
│   │   │   ├── auth/             # OIDC token validation, identity resolution
│   │   │   ├── authz/            # OpenFGA client, model generation, ListObjects batching
│   │   │   ├── consent/          # Consent manager, batch pre-filter, direct care exemption
│   │   │   └── audit/            # Audit record writer (PostgreSQL)
│   │   └── package.json
│   ├── sync/                     # Sync Engine
│   │   ├── src/
│   │   │   ├── connectors/       # Connector interface + JDBC connector
│   │   │   ├── overlay/          # Overlay mode read-through engine
│   │   │   ├── mapping/          # YAML mapping parser, transform functions
│   │   │   ├── cdc/              # Debezium consumer, change application
│   │   │   └── conflict/         # Conflict resolution (LAST_WRITE_WINS, SOURCE_PRIORITY)
│   │   └── package.json
│   ├── api/                      # Query & API Layer
│   │   ├── src/
│   │   │   ├── graphql/          # Schema stitching, resolvers (from codegen output)
│   │   │   ├── rest/             # REST route generator
│   │   │   ├── fhir/             # FHIR R4 facade (Patient, Encounter)
│   │   │   ├── subscriptions/    # WebSocket subscription manager
│   │   │   └── governance/       # Rate limits, query complexity, quotas
│   │   └── package.json
│   ├── observability/            # Shared OTel instrumentation
│   │   └── package.json
│   ├── sdk-typescript/           # Auto-generated TypeScript SDK
│   │   └── package.json
│   └── cel-evaluator/            # Go CEL sidecar (separate Go module)
│       ├── main.go
│       ├── proto/                # gRPC service definition
│       ├── evaluator/            # CEL environment setup, ODL type mapping
│       └── go.mod
├── domain-packs/
│   ├── core/                     # openfoundry.core (base interfaces + scalars)
│   └── nhs-acute/                # NHS acute pilot Domain Pack (see Section 4)
├── deploy/
│   ├── helm/                     # Helm chart
│   └── docker-compose.yaml       # Local dev deployment
├── tests/
│   ├── spi-conformance/          # SPI conformance test suite
│   ├── integration/              # End-to-end tests (against docker-compose stack)
│   └── pilot-scenarios/          # NHS-specific scenario tests (see Section 7)
└── tools/
    └── seed/                     # Synthetic NHS data generator
```

---

## 4. NHS Acute Domain Pack — Pilot Slice

### 4.1 ObjectTypes (5)

```graphql
# schema: nhs.acute
# version: 0.1.0
# depends: openfoundry.core >= 1.0.0

extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
  triageCategory: TriageCategory
  currentWard: Ward @link(type: "AdmittedTo", direction: OUTBOUND)
  currentBed: Bed @link(type: "OccupiesBed", direction: OUTBOUND)
  admissions: [AdmittedTo!]! @link(type: "AdmittedTo", direction: OUTBOUND, history: true)
  consultant: Consultant @link(type: "UnderCareOf", direction: OUTBOUND)
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
  currentOccupancy: Int @computed(fn: "countLinks", args: { type: "AdmittedTo" }, cache: LAZY)
  patients: [Patient!]! @link(type: "AdmittedTo", direction: INBOUND)
  beds: [Bed!]! @link(type: "BedInWard", direction: INBOUND)
}

type Bed @objectType {
  id: ID! @primary
  number: String! @indexed
  type: BedType!
  status: BedStatus!
  ward: Ward! @link(type: "BedInWard", direction: OUTBOUND)
  patient: Patient @link(type: "OccupiesBed", direction: INBOUND)
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
  patients: [Patient!]! @link(type: "UnderCareOf", direction: INBOUND)
}

type DischargeRecord @objectType {
  id: ID! @primary
  patient: Patient! @link(type: "DischargedPatient", direction: OUTBOUND)
  ward: Ward! @link(type: "DischargedFromWard", direction: OUTBOUND)
  destination: DischargeDestination!
  dischargeDate: DateTime!
  notes: String
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}
```

### 4.2 LinkTypes (6)

```graphql
type AdmittedTo @linkType(from: "Patient", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  admissionDate: DateTime!
  expectedDischarge: DateTime
  reason: String
}

type OccupiesBed @linkType(from: "Patient", to: "Bed", cardinality: ONE_TO_ONE) {
  id: ID! @primary
  assignedAt: DateTime!
}

type UnderCareOf @linkType(from: "Patient", to: "Consultant", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  assignedDate: DateTime!
  role: CareRole!
}

enum CareRole {
  PRIMARY
  SECONDARY
  ON_CALL
}

type BedInWard @linkType(from: "Bed", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type DischargedPatient @linkType(from: "DischargeRecord", to: "Patient", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type DischargedFromWard @linkType(from: "DischargeRecord", to: "Ward", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}
```

### 4.3 ActionTypes (3 core)

> The three actions below are the original MVP core slice. The pack has since
> gained two post-MVP actions for the S1.4 bed-management work — **CleanBed**
> (returns a bed `CLEANING → AVAILABLE`) and **RegisterPatient** (governed ED
> arrival + consent-on-register) — bringing the pack to 5 ActionTypes. See
> [`fdp-plan.md`](fdp-plan.md) (S1.4) and the pack manifests for those.

#### AdmitPatient

```graphql
type AdmitPatient @actionType {
  patient: Patient! @param
  ward: Ward! @param
  bed: Bed @param
  consultant: Consultant! @param
  reason: String @param
}
```

```yaml
# actions/admit-patient.yaml
action: AdmitPatient
version: 1
reversible: false

preconditions:
  - expr: "patient.currentWard == null"
    error: "Patient is already admitted to a ward"
  - expr: "bed == null || bed.status == 'AVAILABLE'"
    error: "Selected bed is not available"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge') || actor.hasRole('admin')"
    error: "Insufficient role for admission"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "ward"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  - type: createLink
    linkType: "UnderCareOf"
    from: "patient"
    to: "consultant"
    properties:
      assignedDate: "now"
      role: "'PRIMARY'"

  - type: updateObject
    target: "bed"
    condition: "bed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "bed"
    condition: "bed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitAdmissionEvent
    type: event
    config:
      type: "nhs.acute.patient.admitted"
      data:
        patientId: "patient.id"
        wardName: "ward.name"
        consultantName: "consultant.name"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
```

#### DischargePatient

```graphql
type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}
```

```yaml
# actions/discharge-patient.yaml
action: DischargePatient
version: 1
reversible: false

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

  # Reset bed status before deleting the link (effects use immutable snapshot,
  # so patient.currentBed still resolves to the pre-effect bed)
  - type: updateObject
    target: "patient.currentBed"
    condition: "patient.currentBed != null"
    set:
      status: "CLEANING"

  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: deleteLink
    linkType: "UnderCareOf"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: createObject
    objectType: "DischargeRecord"
    properties:
      patient: "patient"
      ward: "patient.currentWard"
      destination: "params.destination"
      dischargeDate: "now"
      notes: "params.notes"

sideEffects:
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
```

#### TransferWard

```graphql
type TransferWard @actionType {
  patient: Patient! @param
  toWard: Ward! @param
  toBed: Bed @param
  reason: String @param
}
```

```yaml
# actions/transfer-ward.yaml
action: TransferWard
version: 1
reversible: false

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"
  - expr: "patient.currentWard != null"
    error: "Patient is not currently admitted"
  - expr: "patient.currentWard.id != toWard.id"
    error: "Patient is already on the destination ward"
  - expr: "toBed == null || toBed.status == 'AVAILABLE'"
    error: "Selected bed is not available"
  - expr: "actor.hasRole('clinician') || actor.hasRole('nurse_in_charge')"
    error: "Insufficient role for ward transfer"

effects:
  # Reset old bed status (uses immutable snapshot, so patient.currentBed
  # still resolves to the pre-effect bed)
  - type: updateObject
    target: "patient.currentBed"
    condition: "patient.currentBed != null"
    set:
      status: "CLEANING"

  # Terminate current admission link
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  # Release current bed link
  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  # Create new admission link to destination ward
  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "toWard"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  # Assign new bed if specified
  - type: updateObject
    target: "toBed"
    condition: "toBed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "toBed"
    condition: "toBed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitTransferEvent
    type: event
    config:
      type: "nhs.acute.patient.transferred"
      data:
        patientId: "patient.id"
        fromWard: "patient.currentWard.name"
        toWard: "toWard.name"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
```

### 4.4 Connector Configuration

```yaml
# connectors/pas-jdbc.yaml
datasource: PAS_Patients
connector: jdbc
connection:
  url: "${PAS_DB_URL}"
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
  mode: OVERLAY          # Start with overlay for immediate demo
  cacheStrategy: TTL
  cacheTTL: "PT5M"
  writeback: false

# After pilot validation, switch to CDC:
# sync:
#   mode: CDC
#   conflictResolution: SOURCE_PRIORITY
#   rateLimit:
#     maxRecordsPerSecond: 500
```

#### 4.4.1 Source-of-Truth Policy

When both PAS (via CDC) and Actions (via GraphQL) can modify patient state, the Sync Engine must resolve conflicts. The MVP defines a **per-field source-of-truth policy**:

| Field | Authoritative Source | Policy |
|-------|---------------------|--------|
| `nhsNumber`, `name`, `dateOfBirth` | PAS (demographics) | `SOURCE_PRIORITY` — PAS always wins. Action-originated changes to these fields are rejected. |
| `status` | **Action** (clinical decision) | `ACTION_PRIORITY` — Actions (Admit, Discharge, Transfer) set status authoritatively. CDC updates to status-equivalent fields are mapped but do not override an Action-set value until the next full reconciliation window. |
| `triageCategory` | Action | `ACTION_PRIORITY` — clinical assessment, not PAS-sourced. |
| `currentWard`, `currentBed`, `consultant` (links) | Action | `ACTION_PRIORITY` — link state is managed by Actions. CDC link updates are logged as conflicts for review. |

Conflict resolution behaviour:

1. When a CDC update arrives for a field governed by `ACTION_PRIORITY` and the field was last modified by an Action (lineage `kind: ACTION`), the CDC value is **logged as a conflict** (`openfoundry.sync.conflict` event) but **not applied**.
2. A nightly **reconciliation job** compares PAS state and ontology state, producing a divergence report. Fields with persistent divergence are flagged for manual review.
3. Fields governed by `SOURCE_PRIORITY` are always overwritten by CDC, regardless of Action history.

#### 4.4.2 Identity Resolution

Real PAS data has missing or inconsistent identifiers. The MVP uses a deterministic identity strategy:

1. **Primary key:** `patient_id` from PAS, transformed to `prefix('patient-')`. This is the ontology `id` and is always present.
2. **NHS Number:** Used as a `@unique` secondary identifier. When present, it enables cross-system correlation.
3. **Missing NHS Number:** Objects are created with `nhsNumber: null`. A data quality rule flags these as `HIGH` severity violations for manual resolution.
4. **Duplicate detection:** On CDC insert, the Sync Engine checks for existing objects with the same `nhsNumber` (if non-null). If a match is found with a different `id`, the record is routed to a **quarantine queue** — a separate table of unresolved identity conflicts. Quarantined records emit `openfoundry.sync.identity_conflict` events and require manual merge or disambiguation.
5. **Merge policy:** Manual-only for MVP. An operator reviews quarantined records and decides whether to merge (update the existing object's `id` mapping) or create a new object (distinct patient). Automated merge is deferred to post-MVP.

### 4.5 OpenFGA Model

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
    define can_admit: [user]
    define can_discharge: clinician
    define can_transfer: clinician or editor

type bed
  relations
    define bed_in_ward: [ward]
    define viewer: viewer from bed_in_ward
    define editor: editor from bed_in_ward

type consultant
  relations
    define viewer: [user]
    define self: [user]
```

### 4.6 FHIR Mapping

```yaml
fhir:
  profiles:
    Patient: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient"
    Encounter: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Encounter"
  mutations:
    Patient:
      create: AdmitPatient
      delete: DischargePatient
    # Encounter mapping deferred — read-only for MVP
```

### 4.7 Pack Manifest

```yaml
# pack.yaml
name: nhs-acute
version: 0.1.0
description: "NHS acute healthcare domain pack — pilot slice"
namespace: nhs.acute

dependencies:
  openfoundry.core: ">=1.0.0"

provides:
  objectTypes: 5
  linkTypes: 6
  actionTypes: 3
  functions: 0
  connectors: 1
  widgets: 0
  qualityRules: 0
```

---

## 5. Deployment Architecture

### 5.1 Container Services (MVP)

| Service | Image | Port | Notes |
|---------|-------|------|-------|
| `api-gateway` | `openfoundry/api:0.1` | 4000 | GraphQL + REST + FHIR endpoints. Stateless. |
| `ontology-engine` | `openfoundry/engine:0.1` | 4001 (internal) | Core engine. Called by api-gateway. |
| `action-executor` | `openfoundry/actions:0.1` | 4002 (internal) | Action pipeline. Called by api-gateway on mutations. |
| `sync-engine` | `openfoundry/sync:0.1` | 4003 (internal) | CDC consumer + overlay query proxy. |
| `security-service` | `openfoundry/security:0.1` | 4004 (internal) | Auth + authz + consent + audit. |
| `cel-evaluator` | `openfoundry/cel:0.1` | 50051 (gRPC) | Go sidecar. CEL expression evaluation. |
| `openfga` | `openfga/openfga:latest` | 8280 | ReBAC engine. |
| `postgresql` | `postgres:17` | 5432 | Ontology store + audit log + OpenFGA store. |
| `redpanda` | `redpandadata/redpanda:latest` | 9092 | Event bus (Kafka-compatible). |
| `debezium` | `debezium/connect:2.x` | 8083 | CDC from PAS database. |
| `otel-collector` | `otel/opentelemetry-collector:latest` | 4317 | Trace + metric collection. |
| `keycloak` | `quay.io/keycloak/keycloak:latest` | 8180 | OIDC provider (dev only; replaced by NHS CIS2 in prod). |

### 5.2 Docker Compose (Development)

```bash
docker compose up
# GraphQL Playground:  http://localhost:4000/graphql
# REST API:            http://localhost:4000/api/v1/
# FHIR endpoint:       http://localhost:4000/fhir/
# Keycloak admin:      http://localhost:8180/admin
# OpenFGA playground:  http://localhost:8280/playground
```

### 5.3 Production (Kubernetes / Helm)

```bash
helm install nhs-pilot openfoundry/openfoundry \
  --set storage.provider=postgres \
  --set storage.postgres.host=pg-cluster.internal \
  --set eventBus.redpanda.bootstrapServers=redpanda.internal:9092 \
  --set auth.oidc.issuer=https://am.nhsidentity.spineservices.nhs.uk \
  --set auth.oidc.clientId=$CIS2_CLIENT_ID \
  --set domainPacks[0].name=nhs-acute \
  --set domainPacks[0].version=0.1.0 \
  --set observability.otlp.endpoint=otel-collector.internal:4317 \
  --set sync.pas.dbUrl=$PAS_DB_URL
```

---

## 6. Pilot Onboarding Workflow

This is the sequence for onboarding an NHS trust as a pilot.

### Phase 1: Connect (Week 1-2)

1. Deploy Open Foundry stack into trust's infrastructure (Kubernetes or Docker Compose for evaluation).
2. Configure OIDC integration with NHS CIS2 (or Keycloak for sandbox).
3. Deploy JDBC connector pointing at the trust's PAS database in **overlay mode**.
4. Run `odl validate` + `odl apply` to load the NHS Acute Domain Pack schema.
5. Load OpenFGA model with ward-to-user assignments based on existing staff rosters.
6. **Demo:** Query patients and ward occupancy via GraphQL. Data is live, read-through from PAS. No data migration has occurred.

### Phase 2: Activate (Week 3-4)

1. **CDC cutover dry-run:** Run a full extract from PAS into a staging ontology instance. Generate a reconciliation report comparing overlay reads vs. extracted objects. Validate: record counts match, identity resolution produced zero false merges, no data loss.
2. **Go/no-go gate:** Reconciliation report approved by trust data lead before switching production.
3. Switch PAS datasource from `OVERLAY` to `CDC` mode in production. This triggers a full extract followed by incremental CDC.
4. Seed bed and consultant data (either from additional datasources or via bulk import CSV connector).
5. Enable consent manager with direct care exemption.
6. **CIS2 auth validation:** Confirm end-to-end OIDC flow with NHS CIS2 (or Keycloak proxy). Verify CIS2 role claims map correctly to OpenFGA relations. Document any role mapping gaps.
7. **Demo:** Execute AdmitPatient, DischargePatient, TransferWard actions via GraphQL API. Show audit trail. Show ward-scoped visibility (Nurse A sees only her ward's patients).

### Phase 3: Integrate (Week 5-6)

1. Enable FHIR R4 read endpoint. Run FHIR Patient resources through [NHS Digital FHIR Validator](https://simplifier.net/validate) against trust-specific profiles with **real data** (not just synthetic). Fix any conformance issues.
2. Configure webhook for discharge notifications to trust's integration bus.
3. Generate TypeScript SDK. Build a thin reference UI (or connect to trust's existing portal via SDK).
4. **Demo:** End-to-end flow: patient admitted in PAS → appears in ontology via CDC → clinician queries via FHIR → clinician discharges via GraphQL action → discharge record created → webhook fires → audit trail complete.

### Phase 4: Validate (Week 7-8)

1. Run integration test suite against live stack with **real data snapshot** (not just synthetic).
2. Run SPI conformance suite against PostgreSQL provider.
3. Performance benchmarking at trust's data volume.
4. Security review: penetration test API surface, verify field redaction, verify audit completeness.
5. **Ops readiness checklist:**
   - PostgreSQL backup/restore procedure tested (PITR within RPO target).
   - Audit log retention policy configured and documented.
   - Alerting thresholds set: API error rate, CDC sync lag, OpenFGA latency, disk usage.
   - Rollback procedure documented: how to revert to overlay mode if CDC causes issues.
   - On-call runbook: common failure modes and recovery steps.
6. **Handoff:** Trust team has access to GraphQL Playground, SDK, deployment manifests, and ops runbook.

---

## 7. Pilot Scenario Tests

These are the end-to-end scenarios that must pass before the pilot is considered onboarded.

### 7.1 Patient Lifecycle

```
GIVEN a patient exists in PAS with status "not admitted"
WHEN  the PAS data syncs to the ontology (via CDC)
THEN  a Patient object exists with status DISCHARGED (or equivalent)

GIVEN a synced Patient object
WHEN  a clinician executes AdmitPatient with ward=Ward-A, bed=Bed-1, consultant=Dr-Smith
THEN  Patient.status == ACTIVE
  AND an AdmittedTo link exists from Patient to Ward-A
  AND an OccupiesBed link exists from Patient to Bed-1
  AND an UnderCareOf link exists from Patient to Dr-Smith
  AND Bed-1.status == OCCUPIED
  AND an audit record exists for the action
  AND a CloudEvent nhs.acute.patient.admitted was emitted

GIVEN an admitted patient on Ward-A with Bed-1
WHEN  a clinician executes TransferWard with toWard=Ward-B, toBed=Bed-5
THEN  the old AdmittedTo link to Ward-A is soft-deleted
  AND a new AdmittedTo link to Ward-B is created
  AND the old OccupiesBed link is soft-deleted
  AND a new OccupiesBed link to Bed-5 is created
  AND Bed-1.status == CLEANING (old bed released)
  AND Bed-5.status == OCCUPIED (new bed assigned)
  AND querying Patient.admissions with history:true returns both links

GIVEN an admitted patient with Bed-1
WHEN  a clinician executes DischargePatient with destination=HOME
THEN  Patient.status == DISCHARGED
  AND all active AdmittedTo links from Patient are soft-deleted
  AND all active OccupiesBed links from Patient are soft-deleted
  AND all active UnderCareOf links from Patient are soft-deleted
  AND Bed-1.status == CLEANING (bed released for cleaning)
  AND a DischargeRecord object is created
```

### 7.2 Permissions

```
GIVEN Nurse Alice is assigned to Ward-A
  AND Patient-1 is admitted to Ward-A
  AND Patient-2 is admitted to Ward-B
WHEN  Alice queries all patients
THEN  Alice sees Patient-1 but NOT Patient-2

GIVEN Nurse Alice is assigned to Ward-A
WHEN  Alice queries Patient-2 (on Ward-B) by ID
THEN  response is null (object not visible)

GIVEN Receptionist Bob has schema-level access to Patient but NOT the clinicalNotes field
WHEN  Bob queries Patient-1
THEN  Patient-1.name is visible
  AND Patient-1.clinicalNotes is null
  AND _redactedFields includes "clinicalNotes"
```

### 7.3 Consent

```
GIVEN consent manager is active with direct care exemption
  AND clinician Dr-Smith has a legitimate care relationship with Patient-1
WHEN  Dr-Smith queries Patient-1 for purpose DIRECT_CARE
THEN  all permitted fields are visible (direct care exemption applies)

GIVEN a researcher queries Patient-1 for purpose RESEARCH
  AND Patient-1 has not consented to RESEARCH
WHEN  the query executes
THEN  Patient-1 is returned with all fields redacted except id
  AND _consentRestricted == true

GIVEN a list query returns 50 patients
  AND 5 of those patients have not consented to the stated purpose
WHEN  the query executes
THEN  totalCount reflects only consent-visible patients (45, not 50)
  AND the 5 non-consented patients are excluded from edges (not returned as redacted stubs)
  AND ordering/cursor positions do not reveal the existence of excluded patients
```

**Consent leakage rules:** For list queries where consent is denied, the MVP uses `EXCLUDE` mode (not `REDACT`). This means:

- `totalCount` reflects only the patients the caller is permitted to see for the stated purpose.
- Excluded patients do not appear in result edges, cursors, or pagination metadata.
- Aggregate counts (e.g., ward occupancy) are computed **after** consent filtering.
- This prevents information leakage through counts, ordering gaps, or score distributions.

### 7.4 Audit

```
GIVEN any action or query executes
THEN  an AuditRecord exists with:
  - actor (type, id, roles)
  - operation (type, objectType, objectId or actionType)
  - detail (before/after for mutations, result)
  - traceId (correlates with OTel trace)
  - timestamp
```

### 7.5 FHIR

```
GIVEN Patient-1 exists in the ontology with nhsNumber=1234567890
WHEN  GET /fhir/Patient?identifier=https://fhir.nhs.uk/Id/nhs-number|1234567890
THEN  a FHIR Patient resource is returned with:
  - identifier[0].system == "https://fhir.nhs.uk/Id/nhs-number"
  - identifier[0].value == "1234567890"
  - name[0].family == Patient-1.name (mapped)
  - birthDate == Patient-1.dateOfBirth (mapped)
```

### 7.6 Sync

```
GIVEN a PAS datasource configured in CDC mode
WHEN  a patient record is updated in the PAS database
THEN  within 30 seconds, the corresponding Patient object in the ontology reflects the change
  AND a CloudEvent openfoundry.object.updated is emitted
  AND a lineage record is created with source kind SYNC
```

### 7.7 Sync Conflict Resolution

```
GIVEN Patient-1 was discharged via DischargePatient action (status set to DISCHARGED by Action)
WHEN  a CDC update arrives from PAS setting the status-equivalent field to "active"
THEN  the CDC update is NOT applied (status is ACTION_PRIORITY)
  AND an openfoundry.sync.conflict event is emitted with both values
  AND the conflict is logged for the nightly reconciliation report

GIVEN Patient-1.name was set by CDC from PAS
WHEN  an operator attempts to update Patient-1.name via a direct API call
THEN  the update is rejected (name is SOURCE_PRIORITY, PAS-owned)
  AND error code is SOURCE_OF_TRUTH_VIOLATION
```

### 7.8 Identity Resolution

```
GIVEN Patient-A exists in the ontology with nhsNumber=1234567890
WHEN  a CDC insert arrives from PAS with a different patient_id but nhsNumber=1234567890
THEN  the record is routed to the quarantine queue (not merged automatically)
  AND an openfoundry.sync.identity_conflict event is emitted
  AND the quarantine record contains both the existing and incoming patient data

GIVEN a CDC insert arrives with nhsNumber=null
WHEN  the record is processed
THEN  a Patient object is created with nhsNumber=null
  AND a data quality violation (HIGH severity) is logged
```

### 7.9 AI Tool Registry

```
WHEN  a client queries availableTools(filter: { kind: ACTION })
THEN  3 ToolDescriptors are returned (AdmitPatient, DischargePatient, TransferWard)
  AND each has a valid JSON Schema in parameters
  AND each has requiredPermissions listed
  AND each has dryRunSupported == true
```

---

## 8. Performance Targets (MVP)

These targets apply to the pilot data volume (single trust, ~10K patients, 30 wards, 200 beds, 50 consultants).

| Operation | Target (p99) |
|-----------|-------------|
| Single object read | < 50ms |
| Filtered list (100 results) | < 100ms |
| Graph traversal (2-hop) | < 100ms |
| Action execution (no side-effects) | < 300ms |
| CDC sync latency | < 30 seconds |
| Permission check (ListObjects batch) | < 20ms per query |
| FHIR Patient read | < 100ms |
| Overlay mode read-through | < 200ms |

---

## 9. What This Enables Next

The MVP is designed so that every deferred feature slots in without architectural changes:

| Deferred Feature | How it connects |
|-----------------|-----------------|
| TypeDB / Neo4j providers | Implement SPI interface, run conformance suite. Zero changes to engine or API. |
| EAGER / TTL computed fields | Add cache strategies to engine's computed field evaluator. ODL directive already supports the arguments. |
| Schema workspaces | Add workspace table to schema registry. ODL compiler already produces diffs. |
| Federation | Gateway stub becomes real service. gRPC proto is already compiled. DSA parser is functional. |
| Differential privacy aggregation | Extends federation aggregation endpoint. Local aggregation already works. |
| Application Framework | Builds on GraphQL subscriptions + action bindings. API surface is stable. |
| Additional SDKs | Generated from same ODL codegen pipeline as TypeScript SDK. |
| Action undo | Audit snapshots are already captured. Reverse manifest generation is mechanical. |
| Temporal side-effects | Replace inline webhook executor with Temporal client. Interface is identical. |
| Full-text search | Add search index to PostgreSQL provider (pg_trgm or external). `@searchable` directive already parsed. |
| Bulk action async jobs | Add job queue (Redis/PostgreSQL). API signature is unchanged. |
| Additional ObjectTypes | Add ODL files to Domain Pack. Run `odl diff` + `odl apply`. |

---

## 10. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | PostgreSQL+AGE graph traversal performance insufficient for complex queries | Medium | High | Benchmark early (week 1). Fallback: decompose traversals into iterative queries. AGE is sufficient for 2-3 hop traversals at pilot scale. |
| 2 | CEL Go sidecar adds latency to action pipeline | Low | Medium | gRPC round-trip adds ~1-2ms. Batch CEL evaluations per action (single call with multiple expressions). Measure in integration tests. |
| 3 | NHS CIS2 OIDC integration complexity | Medium | Medium | Use Keycloak as proxy/facade during pilot. CIS2 integration is an OIDC config change, not an architecture change. |
| 4 | PAS database schema varies between trusts | High | Medium | Overlay/CDC mappings are per-trust YAML configs. Schema variation is isolated to the mapping layer. Provide a mapping template + validation tool. |
| 5 | OpenFGA `ListObjects` performance at scale | Low | High | At pilot scale (30 wards, 1000 users), OpenFGA handles this easily. Monitor. Index tuning documented. |
| 6 | Debezium CDC setup complexity with legacy PAS databases | Medium | Medium | Provide setup guide. Fallback: POLLING mode with 60s interval (meets relaxed latency target). |
| 7 | **PAS/Action source-of-truth conflict** — CDC overwrites Action-set state or vice versa | High | High | Per-field source-of-truth policy (Section 4.4.1). ACTION_PRIORITY fields are not overwritten by CDC. Nightly reconciliation report flags persistent divergence. |
| 8 | **Identity resolution — duplicate or missing NHS numbers** in PAS data | High | Medium | Deterministic ID strategy + quarantine queue for ambiguous identities (Section 4.4.2). Manual merge only for MVP. Data quality rule flags missing NHS numbers. |
| 9 | **CIS2 roles do not map cleanly to OpenFGA model** — role claims from CIS2 tokens may not match the `clinician`/`nurse_in_charge`/`admin` roles used in action preconditions | Medium | High | Validate CIS2 role mapping during Phase 2 (Section 6). Document mapping table. Use Keycloak role-mapping middleware as shim if CIS2 role granularity is insufficient. |
| 10 | **Overlay → CDC cutover data loss or corruption** — the single riskiest operational event in the pilot | Medium | High | Mandatory dry-run on staging instance before production cutover (Phase 2, step 1). Reconciliation report must be approved before go-live. Rollback procedure to revert to overlay mode documented. |
| 11 | **Consent redaction leaks information through counts or ordering** | Low | High | EXCLUDE mode for list queries: non-consented patients are fully excluded from results, totalCount, cursors, and aggregates (Section 7.3 scenario tests). |
| 12 | **FHIR profile non-conformance with real data** — synthetic data passes validation but real PAS data has edge cases that fail NHS Digital FHIR profiles | Medium | Medium | Validate FHIR output against NHS validator with real data snapshot during Phase 3 (not just synthetic). Fix conformance issues before Phase 4. |
| 13 | **Operational readiness gaps** — deployment works but backup/restore, alerting, and retention are not configured | Medium | Medium | Explicit ops readiness checklist in Phase 4: backup/restore test, alerting thresholds, audit retention policy, rollback procedure, on-call runbook. |

---

## 11. Go / No-Go Gates

These gates must be passed **before** onboarding a trust into production use. Failure on any gate blocks progression.

| # | Gate | Phase | Pass Criteria |
|---|------|-------|---------------|
| 1 | **PAS overlay works** | Phase 1 | Overlay reads against real PAS schema return valid Patient objects with stable identity matching. Zero data corruption. |
| 2 | **CDC cutover dry-run** | Phase 2 | Full extract into staging succeeds. Reconciliation report: record counts match overlay, zero false merges, identity conflicts routed to quarantine. Approved by trust data lead. |
| 3 | **CIS2 auth end-to-end** | Phase 2 | OIDC flow with CIS2 (or Keycloak proxy) works. Role claims correctly map to OpenFGA relations. Ward-scoped visibility enforced. |
| 4 | **Scenario suite on real data** | Phase 4 | All scenario tests (Section 7) pass against a realistic data snapshot from the trust, not just synthetic data. |
| 5 | **FHIR validation on real data** | Phase 3 | FHIR Patient read passes NHS Digital FHIR validator against real trust data. |
| 6 | **Performance targets met** | Phase 4 | All targets in Section 8 met under representative dataset at trust's data volume. |
| 7 | **Ops readiness** | Phase 4 | Backup/restore tested, alerting configured, audit retention set, rollback plan documented, on-call runbook delivered. |

## 12. Success Criteria

The pilot is successful when:

1. All go/no-go gates in Section 11 have been passed.
2. A clinician can execute an admit-discharge-transfer workflow via the GraphQL API with correct permissions enforcement.
3. Every mutation has a corresponding audit record with actor, operation, and before/after state.
4. Source-of-truth conflicts between PAS and Actions are resolved per the policy in Section 4.4.1, with zero silent data loss.
5. Identity conflicts are quarantined and reviewable, not silently merged.
6. The trust's IT team can independently deploy and operate the stack using the Helm chart, documentation, and ops runbook.
7. The `availableTools` endpoint returns valid tool descriptors that can be consumed by an LLM agent framework.
