# Open Foundry

**An open-source ontology platform for building operational digital twins.**

[![CI](https://github.com/syzygyhack/open-foundry/actions/workflows/ci.yml/badge.svg)](https://github.com/syzygyhack/open-foundry/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/syzygyhack/open-foundry?sort=semver)](https://github.com/syzygyhack/open-foundry/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Security policy](https://img.shields.io/badge/security-policy-informational)](SECURITY.md)

Define your domain once, in a schema. Open Foundry compiles it into a governed
system: GraphQL and REST APIs, an authorization model, a transactional action
pipeline, version history, and an audit trail — with the enforcement built in
rather than bolted on.

The platform is **domain-neutral**. It ships no business concepts of its own;
everything domain-specific arrives through composable **domain packs**.

> **Maturity:** pre-1.0. Well tested and CI-gated, suitable for evaluation,
> prototyping and controlled pilots. It has not had an independent security
> audit or regulatory validation — see [`SECURITY.md`](SECURITY.md) before using
> it with sensitive data.

---

## The 60-second version

You declare an object type and an action that may change it:

```graphql
type Book @objectType {
  id: ID! @primary
  title: String! @indexed @searchable(weight: 2.0)
  status: BookStatus!
  borrower: Member @link(type: "BorrowedBy", direction: OUTBOUND)
}

type BorrowedBy @linkType(from: "Book", to: "Member", cardinality: MANY_TO_ONE) {
  id: ID! @primary
  borrowedAt: DateTime!
}

type BorrowBook @actionType(permission: "can_borrow") {
  book: Book! @param
  member: Member! @param
}
```

…plus a manifest saying when the action is allowed and what it does:

```yaml
action: BorrowBook
preconditions:
  - expr: "book.status == 'AVAILABLE'"
    error: "That book is not available to borrow"
effects:
  - type: updateObject
    target: "book"
    set: { status: "ON_LOAN" }
  - type: createLink
    linkType: "BorrowedBy"
    from: "book"
    to: "member"
```

From that, the platform generates the API surface and governs every write:

```bash
curl -X POST localhost:4000/api/v1/actions/BorrowBook \
  -H 'content-type: application/json' \
  -d '{"book":"<id>","member":"<id>"}'
# → success, book UPDATED, BorrowedBy CREATED

curl -X POST localhost:4000/api/v1/actions/BorrowBook ...   # again
# → PRECONDITION_FAILED: That book is not available to borrow
```

The book is now queryable over REST and GraphQL, its version history is at
`/api/v1/books/<id>/history`, and the change emitted an event. **There is no
generic create/update/delete path** — every mutation goes through an action,
which is what makes preconditions, authorization and audit unavoidable.

That example is real and runnable: it is
[`examples/library-pack/`](examples/library-pack/).

---

## Start here

| If you want to… | Go to |
|---|---|
| **Model your own domain** | [Build your first domain pack](docs/first-domain-pack.md) — a complete worked example in ~20 minutes |
| **Evaluate the platform** | [Run the stack](#run-the-stack) below, then the [deployment guide](deploy/README.md) |
| **Contribute** | [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, conventions, and the enforcement test suites |

### Run the stack

```bash
cd deploy
cp .env.example .env          # set POSTGRES_PASSWORD and KEYCLOAK_ADMIN_PASSWORD
docker compose up -d --wait
./init-services.sh
```

GraphQL playground at `http://localhost:4000/graphql`, REST at
`http://localhost:4000/api/v1/`.

> [!IMPORTANT]
> **The default stack runs with governance enforcement disabled.** It sets
> `NODE_ENV=development`, which replaces OpenFGA and CEL with allow-all stubs and
> gives unauthenticated requests a synthetic admin user holding every role. It is
> for local iteration only — never expose it to an untrusted network.
>
> Nothing you observe in this mode demonstrates authorization, consent or
> redaction actually working. To exercise real enforcement, run in production
> mode — see [development vs production](deploy/README.md#development-mode-vs-production-mode).

---

## What you get

- **Model a domain once.** ODL is GraphQL SDL plus semantic directives. One
  schema defines object types, links, actions and permissions.
- **Generated API surface.** GraphQL (queries, mutations, subscriptions,
  filtering, aggregation) and REST, both derived from the schema, with OpenAPI,
  GraphQL SDL and AsyncAPI contracts published on every release.
- **Every write is a governed action.** Validate → authorize → consent →
  preconditions → execute in one transaction → side effects → audit → emit.
  Compensating transactions undo committed effects when a side effect fails.
- **Relationship-based authorization.** OpenFGA models derived from your schema,
  checked per object; field-level redaction driven by per-role field policies.
- **History, audit and provenance.** Version history and temporal queries on
  every object; an append-only audit record for every governed action.
- **Connect existing systems.** JDBC connectors and Debezium CDC, with overlay
  mode, conflict resolution and reconciliation.
- **Swap the storage.** Everything persists through a storage SPI; PostgreSQL +
  Apache AGE for production, in-memory for tests, both passing the same
  conformance suite.
- **Standard operational surface.** OpenTelemetry traces, Prometheus metrics,
  structured logs, a Helm chart with HPA, PDBs and network policies, and
  non-root containers.

Full detail lives in the [specification](docs/open-foundry-spec-v2.md); what is
in each package is in the [repository map](docs/repository-map.md).

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

Each layer talks only to adjacent layers through defined interfaces. Runtime
writes go through the action pipeline; the one deliberate exception is
bootstrap seed data, which is applied at boot by the object and link managers
and therefore skips authorization, consent and audit.

---

## Domain packs

A domain pack is a directory of schema, action manifests, permissions and seed
data. Packs compose: a deployment loads only what it declares, and the platform
adds nothing of its own.

| Pack | Namespace | Models |
|------|-----------|--------|
| **AML** | `aml` | Customer, Transaction, Alert, Case, Account, SuspiciousActivityReport |
| **Supply Chain** | `supply.chain` | Product, Supplier, Shipment, Facility, InventoryRecord, PurchaseOrder |
| **NHS Acute** | `nhs.acute` | Patient, Ward, Bed, Consultant, DischargeRecord, Transfer, Staff |
| **Library** *(example)* | `example.library` | Book, Member — the [tutorial's](docs/first-domain-pack.md) worked example |

Packs may live outside this repository and be mounted at deploy time; see
[external domain packs](docs/external-domain-packs.md).

Two facades are **capability-gated** and off unless a loaded pack opts in: FHIR
R4 (`/fhir/*`) and a common-data-model projection (`/api/v1/cdm/*`). The shipped
CDM profile targets the NHS Federated Data Platform — that vertical's design
notes, integration plan and mapping profile are in [`docs/nhs/`](docs/nhs/).

---

## Production and security posture

The platform fails closed: production boot validates required configuration and
the authorization model, and exits rather than starting without them.

Two things worth knowing before you rely on the defaults:

- **Field redaction is policy-driven.** Marking a field `@sensitive` records
  intent; redaction engages for an object type only once a
  `permissions/field-permissions.yaml` lists it — after which every unlisted
  field is hidden, link fields included.
- **Audit covers governed actions**, plus relationship grants and consent
  records. Bootstrap seeds run outside that pipeline and are not audited.

Supply chain: releases carry a CycloneDX SBOM and a build provenance
attestation; GitHub Actions are pinned to commit SHAs; CI fails on
HIGH/CRITICAL container vulnerabilities and a scheduled scan tracks drift.
Details and reporting process in [`SECURITY.md`](SECURITY.md).

---

## Releases

Semantic versioning. While pre-1.0, minor versions may contain breaking changes
— always called out under **Breaking changes** in
[`CHANGELOG.md`](CHANGELOG.md).

**Depend on a tagged release, not `main`.** Each release attaches its OpenAPI,
GraphQL SDL and AsyncAPI artifacts alongside the SBOM. Only the most recent
release receives security fixes while pre-1.0.

---

## Roadmap

| Item | Description |
|------|-------------|
| Backup and restore | `BackupCapability` is specified but not yet implemented by a storage provider |
| Performance baselines | Published benchmarks and a regression gate |
| Schema registry persistence | PostgreSQL-backed registry shipped; git-backed storage pending |
| FHIR write operations | Mutation support (currently read-only) |
| Application framework | Embeddable UI components for common ontology operations |
| Federation protocol | Multi-instance synchronisation across organisational boundaries (spec-only today) |
| Additional storage providers | TypeDB, Neo4j, and other graph-capable backends |

---

## Documentation

Start at [`docs/`](docs/) for the full index.

| Document | Description |
|----------|-------------|
| [Build your first domain pack](docs/first-domain-pack.md) | Tutorial — a complete worked example |
| [`docs/external-domain-packs.md`](docs/external-domain-packs.md) | Domain-pack reference |
| [`docs/open-foundry-spec-v2.md`](docs/open-foundry-spec-v2.md) | Full technical specification |
| [`docs/api-spec.md`](docs/api-spec.md) | API contract artifacts and codegen |
| [`docs/repository-map.md`](docs/repository-map.md) | Packages, storage providers, test layers |
| [`deploy/README.md`](deploy/README.md) | Deployment, production mode, operational footguns |
| [`docs/nhs/`](docs/nhs/) | NHS vertical — reference implementation |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`SECURITY.md`](SECURITY.md) · [`CHANGELOG.md`](CHANGELOG.md) | Contributing, security policy, release history |

## Design principles

Open source · composable · storage-agnostic · standards-native ·
federation-first · schema-driven · observable. Each layer is independently
replaceable through a defined interface.

Open Foundry was scaffolded by an agent pipeline and hardened through human-led
review — see [project history](docs/project-history.md).

## License

Apache 2.0
