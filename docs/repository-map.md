# Repository map

What lives where in the monorepo, the storage provider matrix, and how the
test suites are layered. Linked from the README rather than inlined so the
landing page stays focused on using the platform.

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

