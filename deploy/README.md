# Open Foundry — Development Deployment

Local development environment via Docker Compose.

## Prerequisites

- Docker Engine 24+ with Compose v2
- `curl` (for init script — OpenFGA setup)

## Quick Start

```bash
# 1. Copy environment config and set passwords
cp .env.example .env
# Edit .env — at minimum, change POSTGRES_PASSWORD and KEYCLOAK_ADMIN_PASSWORD

# 2. Start all services (--build ensures images reflect latest source)
docker compose up -d --build

# 3. Wait for infrastructure, then initialize
./init-services.sh

# 4. Open GraphQL Playground
open http://localhost:4000/graphql
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| api-gateway | 4000 | GraphQL + REST + FHIR |
| ontology-engine | 4001 (internal) | Object lifecycle, validation |
| action-executor | 4002 (internal) | CEL-based action pipeline |
| sync-engine | 4003 (internal) | Overlay mode, CDC |
| security-service | 4004 (internal) | OIDC, OpenFGA authz, audit |
| cel-evaluator | 50051 | gRPC CEL runtime |
| openfga | 8280 | Authorization (ReBAC) |
| postgresql | 5432 | PostgreSQL 17 + Apache AGE |
| redis | 6379 | Rate limiter + cache store |
| redpanda | 19092 | Kafka-compatible streaming |
| debezium | 8083 | Change Data Capture |
| otel-collector | 4317 | OpenTelemetry traces/metrics |
| keycloak | 8180 | Identity provider (OIDC) |
| openfga-migrate | — | One-shot init container: applies the OpenFGA datastore migrations before `openfga` starts |

## Init Script

`init-services.sh` performs:

1. Waits for PostgreSQL readiness
2. Creates the Apache AGE extension and graph
3. Waits for OpenFGA readiness
4. Creates an OpenFGA store and loads the NHS authorization model
5. Creates domain pack registry tables (packs are registered by api-gateway at boot)

## Development Mode vs Production Mode

**The shipped `docker-compose.yaml` runs every app service with
`NODE_ENV=development`.** Dev mode exists for fast local iteration and
**disables all governance enforcement**. In dev mode the api-gateway
(`packages/api/src/server.ts`, where `isDev = NODE_ENV !== 'production'`):

- **OpenFGA → allow-all stub** — every `check` returns `true`, `listObjects`
  returns the `['*']` "all authorized" sentinel.
- **CEL evaluator → allow-all stub** — every action precondition evaluates `true`.
- **Security layer → allow-all** — and when no `Authorization` header is present,
  `extractUser` returns a **synthetic admin user** with every role.

**Consequence:** a default `docker compose up` demonstrates none of the
ReBAC / CEL / consent enforcement the platform is built for. To evaluate or
integrate against real governance, you **must** set `NODE_ENV=production` on the
app services (and satisfy the production requirements below).

### Boot ordering: create the OpenFGA store *before* api-gateway

In production the FGA client is only wired when `OPENFGA_STORE_ID` is non-empty
**at boot**. `init-services.sh` creates the store and writes that ID, but a plain
`docker compose up -d` starts api-gateway *before* the init script runs — so the
gateway would boot without a store ID.

It **fails closed**: `OPENFGA_STORE_ID` is one of the `REQUIRED_PROD_VARS`
(`packages/api/src/config.ts`), so with `NODE_ENV=production` the gateway logs
`FATAL: Production mode requires env vars: …` and exits rather than starting
without authorization. A production gateway therefore never silently degrades to
the allow-all stub — but it will crash-loop until the store ID is supplied, so the
ordering below still matters.

**Correct production order:**

```bash
# 1. Start dependencies only (not api-gateway)
docker compose up -d postgresql openfga keycloak redis redpanda

# 2. Create the OpenFGA store + write OPENFGA_STORE_ID, provision AGE
./init-services.sh

# 3. Start api-gateway last, now that the store ID is available
docker compose up -d api-gateway
```

### Schema-checksum drift on re-deploy with persisted volumes

Re-deploying after a domain-pack DDL change against an **existing** PostgreSQL
volume fails hard at boot:

```
Schema migration: version 1 already applied but DDL checksum differs.
Expected <a>, got <b>.
```

This is a safety check in `storage-postgres` `applySchema` — it refuses to
silently diverge from the persisted schema. Recovery options:

- **Bump the schema version** in your domain pack (preferred for real migrations).
- **Wipe the volume** for throwaway/dev data: `docker compose down -v`.

### Boot seeds land in the `system` tenant unless you set `SEED_TENANT`

Domain-pack boot seeds (`seed:` entries in `pack.yaml`) are written under the
tenant in `SEED_TENANT`, which defaults to **`system`** — deliberately isolated
from ordinary request tenants. Every object is created and persisted correctly,
but because reads are tenant-scoped, an API query running under a different
tenant returns `totalCount: 0`. The boot log says `Seed: created N object(s)`,
so this reads as "the seed worked but the data vanished".

Set it to the tenant your API requests actually use when the seeded reference
data is meant to be readable through the API:

```bash
SEED_TENANT=default   # deploy/.env — the integration stack uses this
```

The gateway logs the tenant it seeded under, and warns when `SEED_TENANT` is
unset, so check the boot log first if seeded data appears to be missing.

> Looking for the seeded rows directly? Object data lives in the relational
> table `public.<snake_case_type>` (a column per property). The Apache AGE label
> table holds **id-only vertices** (`{id, tenant_id}`) used for graph traversal —
> so inspecting the AGE properties map will always look empty, for seeded and
> runtime-created objects alike.

### Automated production-mode enforcement test

`deploy/docker-compose.prod-test.yaml` is an override that runs the api-gateway
in `NODE_ENV=production` with real OIDC + OpenFGA wired (it encodes the
issuer/JWKS host split and the `OPENFGA_STORE_ID` requirement above). The
integration suite uses it to exercise enforcement end-to-end without the
allow-all stubs:

- `tests/integration/src/security-enforcement.test.ts` (`SECURITY_E2E=1`) — boots
  the prod stack, creates the OpenFGA store, mints real Keycloak tokens, and
  asserts the full picture: unauthenticated/invalid tokens are rejected (401);
  an authenticated clinician performs a governed action; a created patient is
  **not** visible without a `viewer` tuple (filtered list + 403 direct read);
  and after an admin grants `ward.assigned` through the governed relationships
  API, the same read flips **403 → 200**.
- `tests/integration/src/capability-gating.test.ts` (`CAPABILITY_E2E=1`) and
  `tests/integration/src/open-consent-vocab.test.ts` (`CONSENT_VOCAB_E2E=1`) —
  boot the stack with a non-default pack set / consent vocabulary and assert the
  corresponding gating.

These specs are destructive (they own the Docker lifecycle and reboot the stack
in a non-default mode on the shared ports), so they are env-gated and run in a
dedicated `enforcement-e2e` CI job rather than the standard integration suite.

## Installing a released version

Releases publish container images and a versioned Helm chart, so a deployment
does not have to build from source:

```bash
# Images: ghcr.io/syzygyhack/open-foundry/<service>:<version>
helm install openfoundry \
  oci://ghcr.io/syzygyhack/open-foundry/charts/openfoundry --version 0.2.2
```

The chart's `version` and `appVersion` always match the platform release it
deploys, and image tags are pinned to that exact version rather than a floating
minor. For immutable deployments, override a service with its digest — every
release attaches `image-digests.txt` listing the digest for each image:

```bash
--set apiGateway.image.repository=ghcr.io/syzygyhack/open-foundry/api-gateway@sha256:<digest>
```

Release assets also include the OpenAPI, GraphQL and AsyncAPI contracts, a
CycloneDX SBOM, and a build provenance attestation verifiable with
`gh attestation verify <file> --repo syzygyhack/open-foundry`.

## Identity Provider (OIDC) Integration

Production auth requires OIDC access tokens that satisfy
`OidcAuthenticator` (`packages/security/src/auth/oidc-authenticator.ts`). Two
requirements are easy to miss — each fails with an opaque `401 UNAUTHENTICATED`:

1. **`aud` must equal the configured client id.** The authenticator sets
   `audience = clientId` (`OIDC_CLIENT_ID`) and validates it. Keycloak access
   tokens default to `aud: "account"` and will be **rejected**. Add an
   **audience protocol mapper** that includes your client in the `aud` claim.
2. **A `tenant_id` claim is mandatory (unless a default is opted in).**
   `extractUser` throws `MISSING_TENANT` when the tenant claim is absent and no
   default tenant is configured. Either add a mapper (hardcoded claim or per-user
   attribute) that emits `tenant_id`, or — for a single-tenant deployment — set
   `OIDC_DEFAULT_TENANT` to opt into a fallback tenant. Leaving it unset preserves
   the fail-closed default (claimless tokens are rejected); a real `tenant_id`
   claim always takes precedence when present.

Required token claims:

| Claim | Requirement |
|-------|-------------|
| `sub` | Subject — used as the actor/user id |
| `aud` | Must equal `OIDC_CLIENT_ID` |
| `tenant_id` | Mandatory unless `OIDC_DEFAULT_TENANT` opts into a fallback tenant — otherwise the request is rejected |
| `roles` | **Flat top-level array** — the authenticator reads `claims["roles"]` directly (`role-mapping.ts` `resolveRoles`, `DEFAULT_ROLE_MAPPING.claimName = "roles"`). It does **not** descend into Keycloak's nested `realm_access.roles`. Add a Keycloak realm-role mapper (`oidc-usermodel-realm-role-mapper`, `claim.name=roles`, multivalued) — otherwise the actor has no roles and CEL preconditions like `actor.hasRole('clinician')` fail with `PRECONDITION_FAILED` even after OpenFGA passes. |

### Issuer vs JWKS host split

A token minted from the host (`iss=http://localhost:8180/...`) cannot be verified
by the in-container gateway unless JWKS is fetched **in-network**
(`http://keycloak:8080/...`). The gateway supports this via two separate env vars
— set both when the external issuer URL differs from the in-cluster address:

```bash
OIDC_ISSUER=http://localhost:8180/realms/openfoundry      # must match token `iss`
OIDC_JWKS_URI=http://keycloak:8080/realms/openfoundry/protocol/openid-connect/certs
```

### Keycloak realm auto-provisioning  *(resolved in v0.2.0 — A3)*

Keycloak now boots `start-dev --import-realm` and imports
`deploy/keycloak/openfoundry-realm.json` on first start: the `openfoundry`
realm, the `openfoundry` client, the pilot realm roles, two test users
(`dr-test`, `admin-test`, password `test-password`), and the **three protocol
mappers the OIDC authenticator requires** — audience (`aud == openfoundry`),
`tenant_id` (from a user attribute), and a flat top-level `roles` array
(realm-role mapper, not nested `realm_access.roles`). A host-minted token
therefore carries `aud`/`tenant_id`/`roles` and passes token validation.

> The realm is persisted in PostgreSQL (`KC_DB=postgres`); re-import only
> happens on a fresh DB volume. To force re-import, `docker compose down -v`.
>
> For the full non-stub end-to-end (a minted token driving a governed action
> against `NODE_ENV=production`), set `OIDC_ISSUER` to match the token issuer —
> note the issuer includes the `/auth` relative path,
> e.g. `http://keycloak:8080/auth/realms/openfoundry`.

## Authorization Tuples for Actions

Action authorization (`packages/api/src/config.ts`, `createSecurityLayer`) checks
`can_<verb>` **directly on the target object** (e.g. `user:<sub>` →
`can_discharge` → `patient:<id>`). It does **not** derive contextual tuples from
roles. Per the NHS model, relations like `patient.can_discharge` resolve from
direct `[user]` relations on the patient object (`clinician`, `nurse_in_charge`).

**Footgun (mitigated in v0.2.0 — A1):** a freshly created object has no care-team
tuples, so `can_admit` / `can_discharge` / `can_transfer` are checked *before any
tuple exists* → denied for everyone. v0.2.0 adds a **governed tuple-write API**
so these no longer require out-of-band writes:

```
POST   /api/v1/relationships   { "user", "relation", "objectType", "objectId" }
DELETE /api/v1/relationships   { ... }            # + GraphQL grant/revokeRelationship
```

It grants only relations the merged FGA model declares directly-assignable to
`user` (`patient.{clinician,nurse_in_charge,admin}`, `ward.{assigned,porter}`);
computed/link relations like `can_admit`/`admitted_to` are rejected. The caller
must hold a granter role — the generic platform default is `admin` only. A
deployment broadens it via `RELATIONSHIP_GRANTER_ROLES`; consent recording is
gated likewise by `CONSENT_RECORDER_ROLES`. Both default to `admin` in the
shipped manifests — NHS deployments add the clinical roles in `.env`
(`admin,nurse_in_charge` and `admin,nurse_in_charge,clinician`; see
`.env.example`). Every grant/revoke/denial is audited. Example — grant the
acting clinician on admission:

```
POST /api/v1/relationships { "user":"<sub>", "relation":"clinician", "objectType":"Patient", "objectId":"<id>" }
```

Link-derived tuples (`admitted_to`, `bed_in_ward`) are still minted automatically
by the action pipeline (`syncLinkTuple`); the API covers the direct `[user]`
grants only.

## Driving an Action via REST (with auth)

Actions are exposed at `POST /api/v1/actions/{ActionType}`. End-to-end against a
production stack:

```bash
# 1. Get a token (client-credentials or password grant; must carry aud + tenant_id)
TOKEN=$(curl -s -X POST \
  "http://localhost:8180/realms/openfoundry/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=openfoundry \
  -d username=<user> -d password=<pass> | jq -r .access_token)

# 2. Call the action (body keys are the action's @param fields)
curl -X POST http://localhost:4000/api/v1/actions/AdmitPatient \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"patient":"<patient-id>","ward":"<ward-id>"}'

# 3. A 200 returns { success, data, warnings? }; a 403 usually means the
#    required can_<verb> tuple is missing (see "Authorization Tuples" above).
```

## Action Pipeline Footguns (end-to-end)

Surfaced driving a real `AdmitPatient` to success (authorize → consent → CEL →
effects → audit). These bite a production single-trust pilot specifically.

- **Two independent authz layers must both pass.** (1) OpenFGA `can_<verb>` at the
  authorize stage (needs the per-object care-team tuple above) → fails as
  `AUTHORIZATION_DENIED`. (2) CEL `actor.hasRole(...)` in the manifest
  preconditions (needs the flat `roles` claim, see OIDC table) → fails as
  `PRECONDITION_FAILED`. A clinician can satisfy (1) via a written tuple and still
  fail (2) for a missing roles claim — two separate root causes for the same
  "clinician can't act" symptom.

- **Consent blocks admission of a not-yet-admitted patient.** The
  legitimate-relationship exemption (`consent-service.ts`
  `evaluateDirectCareExemption`) is the NHS s251 direct-care case. It is OFF by
  the platform default and enabled per-deployment via
  `CONSENT_DIRECT_CARE_EXEMPTION=true` (this NHS reference compose sets it). When
  on, it checks a care relation that defaults to `viewer` (`careRelation ??
  "viewer"`). But `patient.viewer = viewer from admitted_to` — it derives from
  ward admission, so a freshly seeded/synced (un-admitted) patient has no
  `viewer`, the exemption returns null, and `AdmitPatient` fails `CONSENT_DENIED`.
  **v0.2.0 (A2) adds a consent-record API** (`POST /api/v1/consent` + GraphQL
  `recordConsent`, role-gated + audited) so consent no longer requires a direct
  `consent.consent_records` insert (decision enum is `"GRANT"`/`"DENY"`). The
  recordable purpose vocabulary is the open `DataPurpose` string type — default
  is the NHS preset, configurable via `CONSENT_PURPOSES` (Epic C); the exemption
  purpose is `CONSENT_EXEMPTION_PURPOSE` (default `DIRECT_CARE`). Which object
  type drives an action's consent check is `CONSENT_SUBJECT_TYPES` (default
  `Patient`) — a non-NHS deployment sets e.g. `Customer` to consent-gate actions
  on its own subject. This is an in-platform two-step flow (record consent →
  then admit).

- **Link-derived ReBAC tuples are now emitted by the pipeline.** On a `createLink`
  / `deleteLink` effect, the action executor writes/deletes the matching OpenFGA
  tuple `(toType:toId, <relation>, fromType:fromId)`, where `<relation> =
  snake_case(linkType)` — so `AdmittedTo` → `(ward:W, admitted_to, patient:P)` and
  `BedInWard` → `(ward:W, bed_in_ward, bed:B)`. This makes `... from <link>` rules
  (e.g. `patient.viewer = viewer from admitted_to`, `bed.can_clean = editor or
  porter from bed_in_ward`) resolve without out-of-band provisioning. The sync set
  is derived at boot from the merged OpenFGA model (only link types whose
  `snake(linkType)` relation exists are synced), and emission is post-commit +
  best-effort (a tuple failure never fails the committed action).
  - **Seeded links too:** boot-seed links bypass the action executor, so their
    tuples are backfilled at startup (after the model loads) using the same
    map — so a seeded `BedInWard` gets its `bed_in_ward` tuple without a script.
  - **Still provisioned out-of-band:** *role/direct* grants that aren't
    link-derived — ward `assigned` (`[user]`) and patient care-team
    `clinician`/`nurse_in_charge` (`[user]`). These have no originating ontology
    link, so the demo's `provision-authz.sh` still seeds them.
  - **ED (un-admitted) patients** have no `AdmittedTo` link → no ward-scoped
    `viewer`, so they aren't visible via ward-derived reads until admitted.

- **Denied actions ARE audited (authorize + consent).** Authorize and consent
  denials now write an audit record with `result: 'denied'`, `denialReason` (and
  `consentDecision: 'denied'` for consent), plus actor/roles/traceId — so the
  immutable trail carries refusal evidence (IG need-to-know). Note: **precondition
  failures** (`PRECONDITION_FAILED`, business-state) and **input validation**
  failures are not audited — only access denials are.

- **Boot-seed data lands under tenant `system`.** `server.ts` seeds with
  `bootCtx = { tenantId: 'system' }`. Object rows are tenant-scoped (`_tenant_id`)
  and `getObject` filters `WHERE _tenant_id = $1`, so pack `seed:` data is
  invisible to requests on any other tenant (symptom: the object resolves far
  enough to enter the pipeline, then fails a field-dependent CEL precondition with
  `no such key: <field>`). *Fix direction: make the seed tenant configurable or
  seed per-tenant; until then, clients must use the `system` tenant to read seeded
  reference data.*

## External Domain Packs

To load domain packs from outside the monorepo:

1. Set `DOMAIN_PACKS_HOST_DIR` in `.env` to the host path of your pack (or a parent directory containing multiple packs):
   ```bash
   DOMAIN_PACKS_HOST_DIR=../../silmaril-dp-rce
   DOMAIN_PACKS_EXTRA_DIRS=/external-packs
   ```

2. Add the pack name to `DOMAIN_PACKS` if you use an explicit pack list:
   ```bash
   DOMAIN_PACKS=core,nhs-acute,rce
   ```

3. Restart the api-gateway: `docker compose up -d --build api-gateway`

The host path is mounted read-only at `/external-packs` inside the container. The schema loader scans it for `pack.yaml` files using the same discovery logic as the primary `domain-packs/` directory.

### Capability-gated facades (FHIR / CDM)

The FHIR facade (`/fhir/*`) and the FDP/CDM projection (`/api/v1/cdm/*`) are
NHS-shaped and **only mounted when a loaded pack opts in** via `capabilities:` in
its `pack.yaml`:

```yaml
capabilities:
  - fhir
  - cdm
```

`nhs-acute` declares both. A deployment that loads only non-NHS packs (e.g.
`aml`, `supply-chain`) does **not** expose these endpoints — the REST routes
return 404 **and** the GraphQL `cdm*` queries (`cdmMetadata`/`cdmRecord`/
`cdmRecords`/`cdmEncounters`) are omitted from the schema entirely (no SDL
fields, no resolvers). Boot logs the resolved capabilities
(`Capabilities: cdm=… fhir=…`).

For full details (pack.yaml format, Helm config, permissions, connectors, troubleshooting), see [docs/external-domain-packs.md](../docs/external-domain-packs.md).

## Rebuilding After Updates

After pulling source changes, always pass `--build` to pick up code changes:

```bash
docker compose up -d --build
```

To stamp the git revision into image labels (visible via `docker inspect`):

```bash
GIT_REVISION=$(git rev-parse HEAD) docker compose up -d --build
```

Without `--build`, Docker Compose reuses locally cached images and will not
reflect source changes. This applies to both TypeScript services and the Go
CEL evaluator.

**Domain-pack changes need an api-gateway rebuild too.** New or changed actions
(ODL `@actionType` + manifest), permissions, or seeds are baked into the
api-gateway image. A stale image will **404 a newly added action** (e.g. a
`POST /api/v1/actions/CleanBed` against an image built before the action existed).
After changing a pack, rebuild: `docker compose up -d --build api-gateway`.

## Teardown

```bash
docker compose down        # Stop services (keep data)
docker compose down -v     # Stop and remove volumes
```
