# External Domain Packs

> Building a pack for the first time? Start with the
> [tutorial](first-domain-pack.md), which walks through a complete worked
> example. This document is the reference.

Load domain packs from outside the Open Foundry monorepo — for proprietary schemas,
partner integrations, or tenant-specific ontologies that live in separate repositories.

## Overview

The schema loader discovers packs in two locations:

1. **Primary directory** — `domain-packs/` inside the monorepo (ships with `core`, `nhs-acute`, etc.)
2. **Extra directories** — any additional paths declared via `DOMAIN_PACKS_EXTRA_DIRS`

External packs use the same `pack.yaml` manifest format as built-in packs. They are
merged into a single unified schema at boot time.

## Pack Structure

A minimal external pack:

```
my-pack/
  pack.yaml                # Required — manifest
  schema/
    types.odl              # ODL schema files
    links.odl
    actions.odl
  actions/
    do-something.yaml      # Action manifests (CEL preconditions + effects)
  seed/
    bootstrap.yaml         # Bootstrap seed data (optional)
  connectors/
    source-jdbc.yaml       # Connector configs (optional)
  permissions/
    roles.fga              # OpenFGA DSL overrides (optional)
```

### pack.yaml

```yaml
name: my-pack
version: 0.1.0
namespace: com.example
description: "Example external domain pack"

dependencies:
  openfoundry.core: ">=1.0.0"

# Optional: platform capabilities this pack opts into. The FHIR facade (/fhir/*)
# and the FDP/CDM projection (/api/v1/cdm/*) are NHS-shaped and only mounted when
# a loaded pack declares them — so a deployment without an NHS-style pack does
# not expose these endpoints. Most packs omit this.
capabilities:
  - cdm
  - fhir

schema:
  - schema/types.odl
  - schema/links.odl
  - schema/actions.odl

actions:
  - actions/do-something.yaml

seed:
  - seed/bootstrap.yaml

connectors:
  - connectors/source-jdbc.yaml

permissions:
  - permissions/roles.fga
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique pack identifier (used in `DOMAIN_PACKS` filter) |
| `version` | Recommended | Semver version string (used in dependency checks and metrics) |
| `namespace` | Recommended | ODL namespace, dot-separated (used for dependency resolution) |
| `description` | No | Human-readable summary |
| `dependencies` | No | Map of `namespace: ">=X.Y.Z"` constraints |
| `capabilities` | No | Capability-gated facades this pack opts into (`cdm`, `fhir`). Omit unless the pack provides NHS/CDM-shaped data. |
| `schema` | Recommended | ODL files to compile (relative paths); omit for metadata-only packs |
| `actions` | No | Action manifest YAML files |
| `connectors` | No | Connector configuration YAML files |
| `permissions` | No | OpenFGA DSL files merged into the authorization model |
| `seed` | No | Seed data YAML files applied at boot (idempotent bootstrap) |

### ODL Schema Files

ODL files must declare their namespace:

```graphql
extend schema @namespace(name: "com.example", version: "0.1.0")

type Widget @objectType {
  id: ID! @primary
  serialNumber: String @unique @indexed
  name: String! @searchable
  status: WidgetStatus!
}

enum WidgetStatus {
  ACTIVE
  INACTIVE
  RETIRED
}

type BelongsTo @linkType(from: "Widget", to: "Widget", cardinality: MANY_TO_ONE) {
  id: ID! @primary
}

type ActivateWidget @actionType {
  widget: Widget! @param
  reason: String @param
}
```

Link types use `type ... @linkType(...)` syntax with a body containing at least `id: ID! @primary`.

### Action Manifests

```yaml
action: ActivateWidget
version: 1
reversible: false

preconditions:
  - expr: "widget.status == 'INACTIVE'"
    error: "Widget must be inactive to activate"

effects:
  - type: updateObject
    target: "widget"
    set:
      status: "ACTIVE"
```

Action names must match an `@actionType` declared in the pack's ODL schema.

### Connector Configs

```yaml
datasource: Widget_API
connector: rest              # Must match a registered ConnectorPlugin (rest, jdbc)
connection:
  url: "${WIDGET_API_URL}"
  table: "widgets"

mapping:
  objectType: Widget
  primaryKey:
    source: "widget_id"
    target: "id"
  properties:
    serialNumber: { source: "serial" }
    name: { source: "name" }
    status: { source: "state" }

sync:
  mode: OVERLAY
  cacheStrategy: TTL
  cacheTTL: "PT5M"
  writeback: false
```

The `connector` field must reference a plugin type registered in the `ConnectorRegistry`
(currently `jdbc` and `rest`). Invalid connector types are logged as warnings at boot.

### Seed Data (Bootstrap)

Seed manifests declare objects and links to create at startup. This solves the
bootstrap problem — packs that require initial data (e.g., a root Instance, default
Approach objects) before any action can run.

```yaml
# seed/bootstrap.yaml
objects:
  - type: Instance
    ref: default-instance     # Local label for link references
    fields:
      name: "Default Instance"
      status: ACTIVE

  - type: Approach
    ref: risk-based
    fields:
      name: "Risk-Based Approach"
      description: "Standard RBA methodology"

links:
  - type: EmploysApproach
    from: default-instance     # Resolves via ref map
    to: risk-based
```

**Seed format:**

| Field | Description |
|-------|-------------|
| `objects[].type` | Object type name (must exist in schema) |
| `objects[].ref` | Local label for linking — maps to the generated `_id` at runtime |
| `objects[].fields` | Field values (same as create mutation input) |
| `links[].type` | Link type name |
| `links[].from` | Source ref label or literal UUID |
| `links[].to` | Target ref label or literal UUID |
| `links[].fields` | Optional link properties |

**Idempotency:** On repeated boots, the loader checks for existing objects by `name`
field. Objects that already exist are skipped and their IDs are resolved into the ref
map so links still wire up correctly. Duplicate links (same from/to) are silently
skipped.

**Execution:** Seeds run through `ObjectManager` and `LinkManager` — full validation,
event emission, and audit trail apply. The boot context uses `actorId: 'boot'` and
`tenantId: $SEED_TENANT`, which defaults to `'system'`.

> **Seeds are invisible to API reads unless `SEED_TENANT` matches your request
> tenant.** `system` is deliberately isolated from ordinary request tenants, so
> with the default the objects are created and stored correctly but a query under
> another tenant returns `totalCount: 0`. Set `SEED_TENANT` to the tenant your
> requests use (e.g. `default`) when seeded reference data should be readable
> through the API. The gateway logs the seed tenant at boot and warns when
> `SEED_TENANT` is unset.
>
> Inspecting the database directly? Object data lives in the relational table
> `public.<snake_case_type>` (one column per property). The Apache AGE label table
> holds **id-only vertices** (`{id, tenant_id}`) for graph traversal, so its
> properties map looks empty for *every* object — seeded or runtime-created alike.

Add seeds to `pack.yaml`:

```yaml
seed:
  - seed/bootstrap.yaml
```

### Permission Overrides (OpenFGA DSL)

```
model
  schema 1.1

type user

type widget
  relations
    define owner: [user]
    define viewer: owner
    define can_activate: owner
```

Permission files are merged into the base OpenFGA model generated from the ODL schema.
Merging is type-level, last-wins — if the base model already defines a `widget` type,
the pack's definition **replaces it entirely**. The merged model is POSTed to the OpenFGA
store at boot.

#### What every type must declare

Because the override replaces the whole type block, it must re-declare every
relation the runtime checks — the generated `viewer`/`editor` are *not* merged back in:

| Relation | Required on | Checked by |
|----------|-------------|------------|
| `viewer` | **every ObjectType** | every read — `check` for a single object, `listObjects` for lists |
| `can_<verb>` | each ActionType's target type | the action pipeline before the action runs |

Omitting `viewer` does not restrict access — it **breaks reads entirely**. OpenFGA
rejects a check against an undefined relation with a `400 validation_error`, which
previously surfaced as a retryable `500` on every read while writes kept working.

This is now enforced rather than discovered at runtime:

- **Missing `viewer` is fatal in production** — the gateway refuses to boot and names
  the offending type. (Development only warns: it runs an allow-all stub with no model
  pushed, so the gap cannot break requests there.)
- **A missing `can_<verb>` logs a warning at boot** naming the action, which is denied
  until the relation exists.
- At runtime, an undefined relation is treated as a **deny** rather than an error, so a
  model gap degrades to no-access instead of an outage.

#### Naming the action permission relation

The `can_<verb>` name is derived from the ActionType name by stripping words that match
ObjectType names — a heuristic whose output depends on which types exist. Adding an
unrelated ObjectType can therefore rename an existing relation (`TransferWard` became
`can_transfer_ward` once a `Transfer` ObjectType was introduced).

Declare it explicitly whenever the derivation is ambiguous, and the schema becomes the
single source of truth for both the generated model and the runtime check:

```graphql
type TransferWard @actionType(permission: "can_transfer") {
  patient: Patient! @param
  toWard: Ward! @param
}
```

## Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DOMAIN_PACKS` | Comma-separated pack names to activate. Omit to load all discovered packs. `core` is always included. | `core,nhs-acute,my-pack` |
| `DOMAIN_PACKS_EXTRA_DIRS` | Path-separated directories to scan for external packs. Colon-separated on Linux, semicolon on Windows. Each entry is either a parent directory (subdirectories scanned) or a direct pack directory (containing `pack.yaml`). | `/external-packs:/opt/packs` |
| `DOMAIN_PACKS_HOST_DIR` | Docker Compose only — host path mounted at `/external-packs` in the container. | `../../my-pack` |
| `SEED_TENANT` | Tenant that `seed:` bootstrap data is written under. Default `system`, which is isolated from request tenants — seeds are stored but **not** readable by API queries in another tenant. Set to your request tenant to make seeded reference data visible. | `default` |

**Governance is deployment policy, not NHS-fixed.** A non-NHS deployment sets its
own consent vocabulary and grant roles rather than inheriting the NHS defaults:
`CONSENT_PURPOSES` (open `DataPurpose` vocabulary; default = NHS preset),
`DEFAULT_CONSENT_PURPOSE` (must be within `CONSENT_PURPOSES` when that is set —
the gateway fails fast otherwise), `CONSENT_SUBJECT_TYPES` (action
consent-subject types; default `Patient`; a single type when the exemption is
enabled), `CONSENT_DIRECT_CARE_EXEMPTION` (default off),
`CONSENT_EXEMPTION_PURPOSE`, `RELATIONSHIP_GRANTER_ROLES` /
`CONSENT_RECORDER_ROLES` (default `admin`). See `deploy/.env.example` and
`deploy/README.md`.

### Docker Compose

In `deploy/.env`:

```bash
# Activate specific packs (omit for all discovered)
DOMAIN_PACKS=core,nhs-acute,my-pack

# Host path to mount into the container
DOMAIN_PACKS_HOST_DIR=../../my-pack

# Container-side path (matches the volume mount)
DOMAIN_PACKS_EXTRA_DIRS=/external-packs
```

The `docker-compose.yaml` mounts `DOMAIN_PACKS_HOST_DIR` read-only at `/external-packs`:

```yaml
api-gateway:
  environment:
    DOMAIN_PACKS_EXTRA_DIRS: ${DOMAIN_PACKS_EXTRA_DIRS:-}
  volumes:
    - ${DOMAIN_PACKS_HOST_DIR:-./empty-packs}:/external-packs:ro
```

Restart after changes:

```bash
docker compose up -d api-gateway
```

### Helm / Kubernetes

Add entries to `domainPacksExtra.sources` in `values.yaml`:

```yaml
domainPacksExtra:
  sources:
    - name: my-pack
      mountPath: /external-packs/my-pack
      persistentVolumeClaim:
        claimName: my-pack-pvc
```

Each source creates a volume mount in the api-gateway pod. The `mountPath` values are
automatically joined into `DOMAIN_PACKS_EXTRA_DIRS` via the configmap.

Supported volume types:

| Type | Use Case |
|------|----------|
| `persistentVolumeClaim` | Pre-provisioned PVC with pack files |
| `configMap` | Small packs stored as ConfigMap data |
| `emptyDir` | Combined with an init container (e.g. git clone) |

Example with a git-sync init container:

```yaml
domainPacksExtra:
  sources:
    - name: partner-pack
      mountPath: /external-packs/partner
      emptyDir: {}

# Add to api-gateway pod spec:
apiGateway:
  initContainers:
    - name: git-sync
      image: k8s.gcr.io/git-sync/git-sync:v4.0.0
      args:
        - --repo=https://github.com/org/partner-pack.git
        - --root=/external-packs/partner
        - --one-time
      volumeMounts:
        - name: pack-partner-pack
          mountPath: /external-packs/partner
```

## Boot Sequence

When the api-gateway starts:

1. **Discovery** — Scans primary `domain-packs/` and all `DOMAIN_PACKS_EXTRA_DIRS` paths for `pack.yaml` files. Duplicate pack names are skipped with a warning (first-discovered wins).

2. **Filtering** — If `DOMAIN_PACKS` is set, only listed packs are loaded (`core` is always included).

3. **ODL Compilation** — All schema files from all packs are compiled into a unified `ParsedSchema`.

4. **SPI Conversion** — Parsed types are converted to `OntologySchema` for the storage layer.

5. **Action Manifests** — YAML manifests are loaded and cross-referenced against ODL action types.

6. **Permissions** — `.fga` files are collected as override strings for OpenFGA model merging.

7. **Connectors** — Connector YAML files are parsed and validated against registered plugins.

8. **Seeds** — Seed YAML files are loaded from each pack's `seed:` entries. Objects and links are created idempotently after schema application.

9. **Dependency Validation** — `dependencies` in each `pack.yaml` are checked against loaded pack versions. Missing or unsatisfied constraints log warnings.

10. **OpenFGA Sync** — The base authorization model (generated from ODL) is merged with permission overrides and POSTed to the OpenFGA store.

11. **Registration** — Each loaded pack is recorded in the `_domain_packs` Postgres table and exposed via Prometheus gauge `openfoundry_pack_loaded{name,version,origin}`.

12. **OpenAPI** — An OpenAPI 3.0.3 spec is generated from the merged schema and served at `/api/v1/openapi.json`.

## Introspection

### GET /admin/packs

Returns metadata about all loaded packs:

```bash
curl http://localhost:4000/admin/packs | jq .
```

```json
{
  "packs": [
    {
      "name": "core",
      "version": "1.0.0",
      "namespace": "openfoundry.core",
      "description": "Core domain pack ...",
      "external": false,
      "objectTypes": 0,
      "linkTypes": 0,
      "actionTypes": 0,
      "connectors": 0,
      "permissions": 0
    },
    {
      "name": "my-pack",
      "version": "0.1.0",
      "namespace": "com.example",
      "description": "Example external domain pack",
      "external": true,
      "objectTypes": 1,
      "linkTypes": 1,
      "actionTypes": 1,
      "connectors": 1,
      "permissions": 1
    }
  ],
  "totals": {
    "objectTypes": 1,
    "linkTypes": 1,
    "actionTypes": 1,
    "connectors": 1
  }
}
```

### GET /api/v1/openapi.json

Returns a full OpenAPI 3.0.3 specification for the REST API, auto-generated from the
merged schema. Includes all object type CRUD routes, action execution endpoints,
filter parameters, component schemas (with enums), and security definitions.

```bash
curl http://localhost:4000/api/v1/openapi.json | jq .info
```

Use this to generate client SDKs in any language via tools like
[openapi-generator](https://openapi-generator.tech/) or
[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen):

```bash
# Generate a Python client
openapi-generator-cli generate -i http://localhost:4000/api/v1/openapi.json -g python -o ./client-python

# Generate a Rust client
openapi-generator-cli generate -i http://localhost:4000/api/v1/openapi.json -g rust -o ./client-rust
```

### Prometheus Metrics

```
openfoundry_pack_loaded{name="core", version="1.0.0", origin="primary"} 1
openfoundry_pack_loaded{name="my-pack", version="0.1.0", origin="external"} 1
```

## Dependency Constraints

Packs can declare dependencies on other packs by namespace:

```yaml
dependencies:
  openfoundry.core: ">=1.0.0"
  nhs.acute: ">=0.2.0"
```

The constraint format is `>=X.Y.Z` (minimum version). At boot, the loader checks that
all declared dependencies are satisfied by loaded packs. Unsatisfied constraints produce
warnings but do not prevent startup (to support gradual rollout).

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Pack not discovered | `DOMAIN_PACKS_EXTRA_DIRS` not set or path doesn't exist | Check env var and mount paths |
| Pack discovered but not loaded | `DOMAIN_PACKS` filter doesn't include the pack name | Add pack name to `DOMAIN_PACKS` or remove the filter |
| "already discovered" warning | Two packs with the same `name` field | Rename one of them in `pack.yaml` |
| ODL parse error | Invalid ODL syntax in schema files | Check error log; common issues: `link` keyword (use `type ... @linkType(...)` instead) |
| Connector type warning | `connector` field doesn't match a registered plugin | Use `jdbc` or `rest`; custom plugins require code changes |
| Dependency warning | Required pack not loaded or version too low | Load the dependency pack and check its version |
| "pack.yaml: missing required 'name' field" | Malformed manifest | Ensure `name`, `version`, and `namespace` are present |
| Boot log says `Seed: created N object(s)` but API queries return `totalCount: 0` | Seeds were written under the default `system` tenant, which is isolated from request tenants | Set `SEED_TENANT` to the tenant your API requests use (e.g. `default`) and re-seed |
| Seeded objects look empty in the database | Inspecting the Apache AGE label table, whose vertices are id-only by design | Read the relational table `public.<snake_case_type>` — one column per property |
| Reads fail while writes succeed (`CHECK_FAILED` / `relation ... not found`) | The pack's `.fga` override replaced the generated type block without re-declaring `viewer` | Declare `viewer` on the type; production boot now refuses to start and names it |
| An action is always denied in production | The model declares a different `can_<verb>` than the runtime checks | Check the boot warning naming the action, then declare the name explicitly via `@actionType(permission: "...")` |

## Known Limitations

### Connectors are validated but not instantiated

Pack connector manifests are loaded and validated against the `ConnectorRegistry`
(must be `jdbc` or `rest`). However, connectors are **not instantiated** — the
sync-engine does not yet consume them at runtime. The `connectors:` section in
`pack.yaml` is effectively a declaration of intent: it ensures the pack's connector
config is well-formed and uses a known plugin type, but no data ingestion occurs.

### Permission overrides replace entire types

`mergeOpenFGAOverrides` operates at type-level granularity. If a pack's `.fga` file
defines a type that already exists in the auto-generated model, the pack's definition
**replaces the entire type**, including all relations generated from the ODL schema.

Overriding a generated type is the normal case (it is how a pack attaches its own
roles), so the rule is not "avoid it" — it is that the override must re-declare every
relation the runtime checks, chiefly `viewer` and each action's `can_<verb>`. See
[What every type must declare](#what-every-type-must-declare).

This is no longer silent: a missing `viewer` stops production boot with the offending
type named, a missing `can_<verb>` warns at boot, and an undefined relation is treated
as a deny at runtime rather than erroring. Relation-level merging was considered and
rejected — inheriting generated relations into a hand-written authorization model would
silently grant access paths the pack author never wrote.

### Semver constraints

Only `>=X.Y.Z` and exact-match constraints are supported in `pack.yaml` dependencies.
Range syntax (`^`, `~`, `<`, `<=`, `>`), pre-release tags, and build metadata are not
handled. Using unsupported syntax will produce incorrect constraint checks without a
warning.

## Testing

The API package includes CI fixture tests using a minimal external pack at
`packages/api/src/__tests__/fixtures/external-pack/`. These tests verify schema loading,
action manifest cross-referencing, permission override collection, connector parsing,
seed manifest loading, origin tracking, env var loading, and dependency validation —
without requiring any external repository.

A separate OpenAPI test verifies spec generation from the nhs-acute schema, covering
path generation, component schemas, enum definitions, filter parameters, and security
definitions.

Run fixture tests:

```bash
cd packages/api && pnpm vitest run -t "CI fixture"
```
