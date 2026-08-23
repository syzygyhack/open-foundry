# Open Foundry

**An open-source ontology platform for building operational digital twins.**

Open Foundry provides the semantic, kinetic, and security layers needed to turn commodity data infrastructure into a coherent, queryable, actionable model of a real-world system. The platform is domain-neutral -- domain-specific functionality is delivered through composable **Domain Packs**.

> Apache 2.0 licensed. No proprietary dependencies. Schema-driven. Storage-agnostic.

---

## Architecture

```
+---------------------------------------------------------+
|                    Query & API Layer                    |
|              (GraphQL, REST, FHIR R4, SDKs)             |
+---------------------------------------------------------+
|                    Action Framework                     |
|        (action types, CEL execution, side-effects)      |
+------------------------+--------------------------------+
|   Security Layer       |        Sync Engine             |
|  (OpenFGA ReBAC,       |  (JDBC connectors, Debezium    |
|   consent, audit)      |   CDC, conflict resolution)    |
+------------------------+--------------------------------+
|                    Ontology Engine                      |
|    (schema registry, object store, relationship index)  |
+---------------------------------------------------------+
|               Storage Provider Interface                |
|               (PostgreSQL+AGE | Memory)                 |
+---------------------------------------------------------+
```

Each layer communicates only with adjacent layers through defined interfaces. No layer bypasses the security stack.

---

## Features

### Query & API

- **GraphQL API** -- Auto-generated from ODL schema via Apollo Server 4. Includes queries, mutations, subscriptions, filtering, pagination, and aggregation.
- **REST API** -- Per-object-type read endpoints (list, get, `/links`, `/history`, `/aggregate`), governed actions via `POST /api/v1/actions/{Name}`, and object-set CRUD, all with consistent error shapes. The platform is action-oriented: objects are created and mutated through governed actions, not generic per-type create/update/delete.
- **FHIR R4** *(opt-in)* -- Read-only Patient/Encounter endpoints with a `GET /fhir/metadata` CapabilityStatement. Mounted only when a loaded domain pack declares the `fhir` capability, so a deployment without one does not expose these routes.
- **Common-data-model projection** *(opt-in)* -- Read-only view (REST `/api/v1/cdm/*` and GraphQL `cdmMetadata`/`cdmRecord`/`cdmRecords`/`cdmEncounters`) that maps the operational ontology onto an external canonical model, preserving per-record provenance and publishing a gap register. Gated on the `cdm` capability. The shipped profile targets the NHS Federated Data Platform (see [`docs/nhs/cdm-mapping-profile.md`](docs/nhs/cdm-mapping-profile.md)).
- **API contract artifacts** -- OpenAPI 3.0.3, GraphQL SDL, and AsyncAPI 2.6.0 generated from the merged schema (`pnpm --filter @openfoundry/api spec:all`); OpenAPI served live at `/api/v1/openapi.json` and all three attached to tagged releases. See [`docs/api-spec.md`](docs/api-spec.md).
- **WebSocket subscriptions** -- Real-time object change events via graphql-ws with per-connection limits (50 max).
- **Query complexity gate** -- Rejects expensive queries before execution (depth 10, breadth 50, cost 1000).
- **Introspection disabled in production** -- Schema exploration available only in development mode.

### Ontology Engine

- **ODL (Ontology Definition Language)** -- Extension of GraphQL SDL with semantic directives. A single schema defines object types, link types, actions, and permissions. The compiler generates GraphQL APIs, REST endpoints, OpenFGA models, and TypeScript SDKs.
- **Object & link lifecycle** -- CRUD with version history, soft deletes, temporal queries, and lineage tracking.
- **Graph traversal** -- Apache AGE-backed relationship traversal with depth (10) and node (10,000) guards.
- **Full-text search** -- PostgreSQL `tsvector`-backed search across indexed fields.
- **Object sets** -- Named, persistent collections of objects for batch operations.
- **Versioned schema registry** -- Monotonic schema versions with automatic diff classification (SAFE / BREAKING) and breaking-change gating behind an approved migration plan. In-memory and PostgreSQL-backed (`PostgresSchemaRegistry`, advisory-lock serialised) implementations.
- **Bootstrap seeds** -- Declarative `seed:` reference data in `pack.yaml`, applied idempotently at boot via the object/link managers (outside the action pipeline) under a configurable `SEED_TENANT`.

### Action Framework

- **Transactional mutations** -- Actions defined in YAML manifests with CEL preconditions and effects, executed in a single SPI transaction.
- **Pipeline** -- validate, authorise, consent, preconditions, execute, side-effects, audit, emit.
- **Compensating transactions** -- `ROLLBACK_ALL` strategy restores prior object and link state on failure.
- **Side-effect executor** -- HTTP webhooks and event bus notifications triggered post-commit.
- **CEL sidecar** -- Go gRPC service for expression evaluation, isolated from the Node.js runtime.

### Security

- **OIDC authentication** -- Token validation with JWKS auto-rotation, timeout (5s), and cooldown (30s).
- **OpenFGA ReBAC** -- Relationship-based access control with per-type and per-field permission checks.
- **Consent management** -- Multi-tenant consent store with a deployment-defined purpose vocabulary (`CONSENT_PURPOSES`) and an optional legitimate-relationship exemption, off by default. PostgreSQL-backed in production, in-memory for development.
- **Field-level redaction** -- Sensitive fields stripped from responses based on viewer permissions.
- **Audit trail** -- Immutable, append-only audit log for every mutation. PostgreSQL-backed in production.

### Governance & Resilience

- **Rate limiting** -- Four tiers: IP (300/min), tenant (1000/min), principal (200/min), client app (500/min). Redis-backed distributed limiter when `REDIS_URL` is set; in-memory fallback per pod.
- **Event bus** -- Redpanda/Kafka-backed when `REDPANDA_BROKERS` is set, with dead-letter queue for failed publishes. In-memory fallback for single-pod deployments.
- **Idempotency cache** -- Deduplicates bulk mutations with 5-minute TTL and periodic eviction.
- **Connection resilience** -- PostgreSQL pool timeouts (connect 5s, idle 30s, statement 30s), Redis fail-open on connection loss.
- **Graceful shutdown** -- Ordered teardown of subscriptions, Apollo, gRPC, event bus, Redis, PostgreSQL, and OpenTelemetry spans on SIGTERM/SIGINT.

### Observability

- **OpenTelemetry** -- SDK-Node with OTLP HTTP trace export. All services instrumented.
- **Prometheus metrics** -- Request duration, throughput, and storage health gauges at `/metrics` (protected from external access).
- **Structured logging** -- JSON-formatted pino output across all services. Human-readable in development, machine-parseable in production.
- **Monitoring templates** -- Helm-integrated ServiceMonitor and PrometheusRule for Kubernetes deployments.

### Deployment

- **Helm chart** -- HPA (2-5 replicas), PodDisruptionBudgets, pod anti-affinity, readiness/liveness probes, security contexts, and resource limits.
- **Non-root containers** -- All 6 Dockerfiles run as unprivileged users with read-only root filesystems and dropped capabilities.
- **Network policies** -- Default-deny with explicit allow rules for inter-service, ingress, and infrastructure traffic.
- **Secrets management** -- All credentials loaded from pre-created Kubernetes Secrets. Helm fails fast with clear errors if secrets are missing.

---

## Domain Packs

Domain Packs are composable schema and configuration modules that specialise the platform for a particular domain.

New to the platform? [**Build your first domain pack**](docs/first-domain-pack.md) walks through a complete one in about twenty minutes.

| Pack | Namespace | Object Types | Actions | Connectors |
|------|-----------|-------------|---------|------------|
| **NHS Acute** | `nhs.acute` | Patient, Ward, Bed, Consultant, DischargeRecord, Transfer, Staff | AdmitPatient, DischargePatient, TransferWard, CleanBed, RegisterPatient | PAS (JDBC + CDC) |
| **AML** | `aml` | Customer, Transaction, Alert, Case, Account, SuspiciousActivityReport | AssignAlertToCase, FlagTransaction, FreezeAccount, OpenCase, FileReport, SubmitReport | TMS (JDBC) |
| **Supply Chain** | `supply.chain` | Product, Supplier, Shipment, Facility, InventoryRecord, PurchaseOrder | ShipOrder, ReceiveShipment, CreateOrder, CancelOrder | ERP (JDBC + CDC) |

Each pack includes ODL schemas, action manifests, OpenFGA permission models, and optional sync connectors.

### External Domain Packs

Domain packs can live outside the monorepo and be loaded at runtime via the `DOMAIN_PACKS_EXTRA_DIRS` environment variable or the `extraDirs` parameter to `loadDomainPacks()`.

```bash
# Load packs from one or more external directories (colon-separated on POSIX, semicolon on Windows)
export DOMAIN_PACKS_EXTRA_DIRS="/opt/my-org/domain-packs:/opt/partner/custom-pack"
```

Each entry may be:
- A **parent directory** containing pack subdirectories (scanned like `domain-packs/`)
- A **direct path** to a single pack directory (must contain `pack.yaml`)

Primary (monorepo) packs take precedence on name conflicts. Malformed or missing packs are skipped with a warning — they do not abort loading of other packs.

### NHS Acute Pilot

The NHS Acute pack is the primary vertical slice, targeting patient flow through wards, beds, and consultants at an acute trust. The demo positions Open Foundry as an **FDP-compatible, trust-controlled ontology runtime** — not an NHS FDP instance or a PET replacement — that can ingest read-only source data, map a bounded operational ontology to a version-pinned FDP/CDM subset, and evidence flows under ReBAC, consent, and audit.

- Live ontology modelling patients, wards, beds, and consultants
- Data ingestion from a PAS (Patient Administration System) via JDBC/CDC (read-only)
- Clinician actions (admit, discharge, transfer) through GraphQL and REST
- ReBAC-enforced permissions with ward-scoped visibility
- Immutable audit trail for every operation
- FHIR R4 read endpoints plus an FDP/CDM-shaped projection (`/api/v1/cdm/*`) for interoperability

**Reference app — Nightingale.** A working precursor to the FDP plan's S1.4 Bed
Management app runs as a separate project (`../nightingale`): a real-time 3D bed
board operating in **Pilot Mode B** (synthetic data, real governed actions)
against the deployed stack. Every admit / discharge / transfer / clean is a
genuine governed action through the api-gateway (authorize → consent → CEL →
effects → audit), with a Direct-link panel demonstrating ReBAC denial, consent
denial, and audited success. It uses only the public action API — no SPI
shortcuts.

Stage plan and conformance boundary: [`docs/nhs/fdp-plan.md`](docs/nhs/fdp-plan.md). Production deployment, OIDC/CIS2 claims, and action-pipeline footguns: [`deploy/README.md`](deploy/README.md).

---

## ODL Schema Example

```graphql
type Asset @objectType {
  id: ID! @primary
  serialNumber: String @unique @indexed
  name: String!
  status: AssetStatus!
  category: AssetCategory
}

link LocatedAt @linkType(from: "Asset", to: "Facility", cardinality: MANY_TO_ONE)

action TransferAsset @actionType {
  assetId: ID! @param
  facilityId: ID! @param
}
```

The ODL compiler generates a complete GraphQL API, REST endpoints, OpenFGA authorization model, and TypeScript SDK from this schema.

---

## Packages

The monorepo is organised across four workspace roots:

### Core Platform (`packages/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/spi` | Storage Provider Interface -- core type definitions |
| `@openfoundry/odl` | ODL parser, validator, code generator, CLI |
| `@openfoundry/engine` | Object lifecycle, links, computed fields, events, lineage |
| `@openfoundry/actions` | Action execution pipeline, CEL integration, side-effects, tool registry |
| `@openfoundry/api` | GraphQL (Apollo), REST, FHIR R4, WebSocket subscriptions, governance |
| `@openfoundry/security` | OIDC auth, OpenFGA ReBAC, consent manager, audit trail |
| `@openfoundry/storage-memory` | In-memory SPI implementation (tests and development) |
| `@openfoundry/storage-postgres` | PostgreSQL 17 + Apache AGE SPI implementation |
| `@openfoundry/sync` | JDBC connectors, Debezium CDC, overlay mode, conflict resolution |
| `@openfoundry/observability` | OpenTelemetry traces, metrics, and structured logging |
| `@openfoundry/sdk` | Auto-generated TypeScript client SDK |
| `cel-evaluator` | Go gRPC sidecar for CEL expression evaluation |

### Domain Packs (`domain-packs/`)

| Pack | Namespace | Contents |
|------|-----------|----------|
| `@openfoundry/domain-pack-core` | `openfoundry.core` | Base interfaces and custom scalars |
| `@openfoundry/domain-pack-nhs-acute` | `nhs.acute` | ODL schema, actions, PAS connector, permissions |
| `@openfoundry/domain-pack-aml` | `aml` | ODL schema, actions, TMS connector, permissions |
| `@openfoundry/domain-pack-supply-chain` | `supply.chain` | ODL schema, actions, ERP connector, permissions |

### Tests (`tests/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/spi-conformance` | Reusable SPI conformance suite (10 categories) |
| `@openfoundry/pilot-scenarios` | NHS pilot scenario tests |
| `@openfoundry/integration-tests` | Full Docker Compose stack integration — governed action pipeline over REST/GraphQL/FHIR, plus env-gated production-mode security, capability-gating, and consent-vocabulary E2E specs |

### Tools (`tools/`)

| Package | Purpose |
|---------|---------|
| `@openfoundry/seed-nhs-acute` | Synthetic NHS data generator (CLI, JSON, SQL output) |

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- pnpm 9.15+
- Docker & Docker Compose (for integration tests and local deployment)
- Go 1.25+ (only when building `packages/cel-evaluator` outside Docker)

### Install and Build

```bash
pnpm install
pnpm run build
```

### Run Tests

```bash
# Unit tests (all packages except integration)
pnpm run test

# Integration tests (requires Docker Compose stack)
pnpm run test:integration

# All tests
pnpm run test:all
```

### Local Development Stack

```bash
cd deploy
cp .env.example .env
docker compose up -d
./init-services.sh
```

This starts PostgreSQL+AGE, Redpanda (Kafka), Redis, Debezium CDC, Keycloak (OIDC), OpenFGA (ReBAC), OpenTelemetry Collector, and all Open Foundry services. See [`deploy/README.md`](deploy/README.md) for the full service table.

> [!IMPORTANT]
> **The default stack runs with governance enforcement disabled.** The shipped
> Compose file sets `NODE_ENV=development`, which replaces OpenFGA and CEL with
> allow-all stubs and gives unauthenticated requests a synthetic admin user with
> every role. It exists for fast local iteration — it is **not** a secured
> deployment, and must never be exposed to an untrusted network.
>
> Nothing you observe in this mode demonstrates ReBAC, CEL preconditions,
> consent, or field redaction actually working. To exercise real enforcement, run
> in production mode — see
> [Development Mode vs Production Mode](deploy/README.md#development-mode-vs-production-mode).

### Try the API

Once the stack is running:

- **GraphQL Playground:** http://localhost:4000/graphql
- **REST API:** http://localhost:4000/api/v1/
- **FHIR R4:** http://localhost:4000/fhir/
- **Prometheus Metrics:** http://localhost:4000/metrics (pod-local only)

### Kubernetes Deployment

```bash
helm install openfoundry deploy/helm/openfoundry \
  --namespace openfoundry \
  --create-namespace
```

Required Kubernetes prerequisites:
- Pre-created Secrets for PostgreSQL, OIDC, and PAS credentials
- metrics-server (if HPA is enabled)
- Prometheus Operator (if ServiceMonitor/PrometheusRule are enabled)

---

## Storage Provider Interface

All persistence goes through a pluggable SPI. The platform ships two implementations:

| Provider | Use Case | Conformance |
|----------|----------|-------------|
| PostgreSQL 17 + Apache AGE | Production | Live integration suite + SPI conformance |
| In-memory | Tests and development | SPI conformance suite (10 categories) |

### PostgreSQL Capabilities

| Capability | Status |
|-----------|--------|
| Full-text search | Supported |
| Graph traversal (AGE) | Supported (max depth 10, max nodes 10,000) |
| Transactions | Supported (configurable isolation level) |
| Temporal queries | Supported |
| Bulk mutations | Supported (with idempotency cache) |
| Multi-tenancy | Supported (tenant isolation on all operations) |
| Soft deletes | Supported (with `includeDeleted` query option) |

---

## Test Coverage

Tests run at every layer:

| Layer | Coverage | When it runs |
|-------|----------|--------------|
| Unit tests | Per-package behaviour across all packages | Always |
| SPI conformance suite | Storage-provider contract (10 categories), shared by the in-memory and Postgres providers | Always (in-memory); with `PG_TEST_URL` (Postgres) |
| Postgres integration | Live PostgreSQL + Apache AGE provider — DDL, graph traversal, multi-tenancy | When `PG_TEST_URL` is set |
| Docker-stack integration | Full Compose stack — governed action pipeline, REST/GraphQL/FHIR, subscriptions | Against a running stack |
| Enforcement E2E | Production-mode security (real OIDC + OpenFGA), capability gating, and consent-vocabulary validation | Env-gated (`SECURITY_E2E` / `CAPABILITY_E2E` / `CONSENT_VOCAB_E2E`); a dedicated CI job |

The enforcement E2E specs boot the stack in non-default modes (production mode, a
distinct pack set, or a custom consent vocabulary) on the shared ports, so they
self-manage the Docker lifecycle and are gated behind env flags rather than run
in the standard suite. CI exercises them in a dedicated `enforcement-e2e` job so
real authentication, authorization, capability gating, and consent-vocabulary
enforcement are verified on every push and pull request.

---

## Versioning and Releases

Open Foundry follows [Semantic Versioning](https://semver.org/). While the project
is **pre-1.0**, minor versions may contain breaking changes — these are always
called out under **Breaking changes** in [`CHANGELOG.md`](CHANGELOG.md).

- **Depend on a tagged release, not `main`.** `main` is where development lands;
  releases are what get changelog entries and published contract artifacts.
- Each tagged release attaches its OpenAPI, GraphQL SDL, and AsyncAPI artifacts.
- Only the most recent release receives security fixes while pre-1.0. See
  [`SECURITY.md`](SECURITY.md).

This is a prerelease platform: suitable for evaluation, prototyping, and
controlled pilots, and not yet independently audited or validated for regulated
production workloads.

---

## Design Principles

1. **Open source** -- Apache 2.0 licence. No proprietary dependencies.
2. **Composable** -- every layer is independently replaceable via defined interfaces.
3. **Storage-agnostic** -- all persistence goes through the SPI. No hardcoded database.
4. **Standards-native** -- GraphQL, CloudEvents, OpenTelemetry, OIDC, FHIR.
5. **Federation-first** -- multi-instance, multi-tenant from day one.
6. **Schema-driven** -- the ontology schema is the single source of truth.
7. **Observable** -- structured traces, metrics, and logs via OpenTelemetry and Prometheus.

---

## Roadmap

| Item | Description |
|------|-------------|
| Schema Registry persistence | PostgreSQL-backed registry shipped (`PostgresSchemaRegistry`) and wired into server boot; git-backed storage still pending |
| FDP/CDM full coverage | Extend the S1.0 starter profile — dataset export, terminology validation, structured-name decomposition, first-class Transfer (GraphQL CDM view done) |
| FHIR write operations | Mutation support for FHIR resources (currently read-only) |
| Application framework | Embeddable UI components for common ontology operations |
| Federation protocol | Multi-instance synchronisation across organisational boundaries (spec-only today) |
| Additional storage providers | TypeDB, Neo4j, and other graph-capable backends |

---

## Documentation

Start at [`docs/`](docs/) for the documentation index.

**Platform**

| Document | Description |
|----------|-------------|
| [`docs/first-domain-pack.md`](docs/first-domain-pack.md) | **Tutorial** — build your first domain pack, with a worked non-healthcare example |
| [`docs/external-domain-packs.md`](docs/external-domain-packs.md) | Domain-pack reference — connectors, capabilities, configuration, troubleshooting |
| [`docs/open-foundry-spec-v2.md`](docs/open-foundry-spec-v2.md) | Full technical specification |
| [`docs/api-spec.md`](docs/api-spec.md) | API contract artifacts (OpenAPI / GraphQL / AsyncAPI) and codegen |
| [`deploy/README.md`](deploy/README.md) | Deployment, development vs production mode, OIDC integration, operational footguns |

**Project**

| Document | Description |
|----------|-------------|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, enforcement E2E suites, conventions |
| [`SECURITY.md`](SECURITY.md) | Vulnerability reporting, supported versions, security posture |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history and breaking changes |

**Domain verticals** — reference implementations, not part of the platform contract

| Document | Description |
|----------|-------------|
| [`docs/nhs/`](docs/nhs/) | NHS / healthcare: pilot design, FDP integration plan, and the FDP/CDM mapping profile |

---

## How This Was Built

Open Foundry was built in two phases -- an automated scaffold phase followed by human-agent collaboration for expansion and hardening.

### Phase 1: Cardinal

Cardinal, a task planning and execution system, decomposed the technical specification into ~120 discrete tasks across 20 packages, ordered by dependency graph. Claude Opus 4.6, operating in parallel Avril sessions, implemented each task autonomously: source code, tests, deployment configuration, and documentation. Cardinal managed dependencies between tasks, tracked progress, and ran 8 automated review passes to resolve consistency and type-safety issues.

### Phase 2: Human-Agent Collaboration

A human engineer took over direction -- reviewing the codebase, revising the specification, expanding domain coverage, and driving iterative hardening:

- **Spec refinement** -- Three rounds of spec review addressing gaps in directives, resilience, lifecycle, and federation contracts.
- **Domain expansion** -- Two new domain packs (AML, Supply Chain) with full schemas, actions, connectors, and permission models.
- **Feature additions** -- Aggregation queries, full-text search, object sets, connector plugin architecture, distributed rate limiting, persistent event bus, and OTEL instrumentation.
- **Security hardening** -- Multiple review rounds (including cross-model Codex reviews) identified and fixed 200+ issues across auth pipelines, SQL injection, field-level redaction, system-field mapping, error message sanitization, CORS fail-closed, proxy-aware rate limiting, advisory lock safety, and schema migration integrity.
- **Production hardening** -- Structured logging, query complexity gates, idempotency caching, connection timeouts, graceful shutdown, non-root containers, Helm PDBs, and network policies.
- **Postgres integration** -- Idempotent DDL generation (AGE graph/labels), link table schema alignment, traversal behavior parity with the memory provider, and an integration suite against a live PostgreSQL+AGE instance.

---

## License

Apache 2.0
