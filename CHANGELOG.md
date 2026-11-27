# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, minor versions may contain breaking changes; these
are called out under **Breaking changes**.

## [Unreleased]

### Security

- **Cleared CVE-2026-78661 (HIGH) from the CEL evaluator image.**
  `golang.org/x/net` v0.60.0 -> v0.62.0, with `x/text` and `x/sys` alongside it,
  in both the service module and the health probe's tools module; the build
  toolchain moves to Go 1.27.4. The advisory is a denial of service in
  `x/net/html`, which neither binary links (they take only the HTTP/2, hpack,
  httpguts, idna and trace packages, through gRPC), so this is scanner
  remediation rather than a fix for a reachable path. It had kept the scheduled
  scan red since 7 November and failed the image-scan gate on every open PR.

- **Kept `@graphql-tools/utils` on its patched release (CVE-2026-114604, HIGH).**
  `@apollo/server` 5.5.2 caps the package below 12.0.2 — the fixed version — so
  that npm installs on Node 20 avoid a transitive dependency requiring Node
  22.15. This project requires Node 24, so the cap protects nothing here; an
  override holds the package at `^12.0.3` and the gateway image ships only that.
  Without it, the routine `@apollo/server` update would have introduced the
  vulnerability.

- **Raised the `vite` and `qs` floors past six Dependabot advisories** (one high,
  four medium, one low). Vite is test tooling only, and reaches the tree as an
  auto-installed peer of Vitest. pnpm does not re-resolve a locked peer when an
  override changes, so the stale 7.3.6 entry was removed from the lockfile and
  re-resolved; 7.3.8 is now the only version.

- **Cleared eight HIGH CVEs** reported by the scheduled image scan.

  `axios` 1.18.1 -> 1.20.0 carries seven, including a security-control bypass
  via unapplied HTTP/2 settings. It is not declared by any workspace package —
  it arrives through `@openfga/sdk`, so it is the HTTP client behind every
  authorization check, and the one of the two worth treating as reachable.

  `@grpc/grpc-js` 1.14.4 -> 1.14.5 clears CVE-2026-101916. That advisory is
  server-side only: it concerns `getAuthContext` on servers created with
  `requireClientCertificate` disabled, and upstream states that clients need
  take no action. This platform uses the library solely as the client reaching
  the CEL evaluator and defines no gRPC server, so it was not exposed. The
  upgrade keeps the dependency patched and the images scanning clean rather than
  remediating a reachable flaw.

### Changed

- Routine updates: `@apollo/server` 5.5.2, `@grpc/grpc-js` 1.14.7 (override floor
  moved with it), `@openfga/sdk` 0.9.8, `graphql-subscriptions` 3.1.0,
  `graphql-ws` 6.4.3, `ws` 8.23.0 (override floor moved with it), `commander`
  15.1.0, `jose` 6.2.18, `turbo` 2.11.11, `vitest` 5.1.0, `pnpm/action-setup`
  6.1.1 and `azure/setup-helm` 5.1.0.

- `ioredis` 6.1.0. Its headline feature, maintenance-notification handoffs, is on
  by default but only negotiated over RESP3; the rate limiter's client pins RESP2,
  so the handshake is never sent and the connection behaves as on 6.0.

- **OpenTelemetry moves to the 3.x SDK** (`sdk-node` and the OTLP exporter
  0.301, `api` 1.10). The previous upgrade held the family on 2.x because the
  grouped proposal moved only the experimental half of the release train. This
  takes the whole train: one API, one core and one SDK line across the tree,
  including `@openfga/sdk`'s copy of the API, which now dedupes to the same 1.10.
  Production tracing is unchanged in shape: `initTelemetry` still builds a
  `NodeSDK` with the OTLP HTTP exporter, and against a live collector it exports
  parent and child spans with the parent kept across asynchronous boundaries.

  `sdk-trace-base` is retired upstream in favour of `sdk-trace`, where
  `BasicTracerProvider` is `TracerProvider` and span processors take an options
  object. Only the tests used those packages, so `sdk-trace` and `sdk-metrics`
  are now development dependencies rather than runtime ones. Passing the exporter
  positionally, as 2.x did, still compiles under the test runner, which strips
  types, but exports nothing; typecheck is what caught it.

- **The SPI conformance suite now runs against the Postgres provider too.** It
  previously ran only against the in-memory provider, so nothing held the
  production store to the contract it documents. CI's Postgres job now runs
  every case against `PostgresStorageProvider`, each test on its own data
  schema (about 30 seconds), and both providers pass all of them. The fixtures
  now use ODL scalar names (`String`, `Int`, ...) and give every link type the
  required `id` property that ODL requires. With the lowercase names, Postgres
  had made every declared property a `TEXT` column. A divergence that cannot be
  fixed at once can be declared with
  `runConformanceSuite(name, factory, { knownFailures })`, with a reason and
  the error it is expected to fail with. It still runs, and is reported as
  skipped only if it fails with that error. Any other failure fails the run, as
  does a declared case that starts passing. Registrations without
  `knownFailures`, including third-party providers, get no exemptions. The six
  divergences first declared are fixed (see Fixed).

### Fixed

- **Unknown types and filter fields are errors, the same on both providers.**
  An undeclared object or link type is now `TYPE_NOT_FOUND` (REST 404) and a
  filter naming an undeclared field `INVALID_FILTER` (REST 400, not retryable).
  Before, the memory provider returned null or an empty page, and Postgres
  threw a raw database error that the REST API reported as a retryable 500
  with the Postgres error code. A missing object of a declared type still
  reads as null. Where the API checks first, its answer comes first: a caller
  with field restrictions gets 403 for a field outside its visible set, and a
  caller who may see no objects of the type gets an empty 200. A filter or
  sort on a type's primary field (REST `filter[id]=...`, GraphQL
  `filter: {id: {eq: ...}}`, aggregate filters, saved object sets; list
  sorts) now reaches storage as `_id`; it used to match nothing, and with the
  new check would have been rejected. Field restrictions are still checked on
  the name the client sent, and now also on a saved object set's filter and
  sort when it is executed: that route checked none, so a caller could filter
  or sort through a saved set on a field hidden from them. The check also
  sees every branch of a filter node, whatever its shape, treats `_id` as the
  type's primary field, and exempts only the platform's system fields
  (`_createdAt`, `_deleted_at`, ...) rather than every name with a leading
  underscore, which let a primary field such as `_recordId` through on REST
  and GraphQL; REST also let named search fields with a leading underscore
  through, `_id` included. GraphQL refuses such a list, search or filter as
  `FORBIDDEN` (not retryable), as REST answers 403; it was a plain error,
  reported as a retryable `INTERNAL_ERROR`. A search that names no fields, by a
  caller with field restrictions, looks in the type's visible text properties
  only (it could name the primary field, which is not a column). An
  aggregate's `orderBy` is not renamed: it names
  output aliases and grouping keys, and a caller with field restrictions may
  now sort by an aggregate's own output (it was refused as a hidden field).
  On both providers an aggregate `orderBy` must name a `groupBy` field or an
  aggregate output, and two outputs may not share a name or be named
  `__proto__` (`VALIDATION_ERROR` otherwise); Postgres sorted by an
  alias such as `_total` or `totalCount` under a different name than it
  selected it by, failing or sorting by a table column, and returned its
  value as null. Nulls sort last in either direction on both providers
  (PostgreSQL put them first in a descending sort). Both providers accept
  system fields in
  filters spelled either way (`_deletedAt` or `_deleted_at`); names inherited
  from JavaScript objects (`constructor`, `__proto__`) are not fields.

- **Traversal and link reads follow the soft-delete rules, on both
  providers.** Postgres ignored a traversal step's `filter` entirely, and
  returned edges to targets it then dropped. Both providers traversed from a
  soft-deleted start object, and `getLinks` returned links to or from a
  soft-deleted object, which the spec (§3.3 rule 3) leaves out by default. Now
  a step filter narrows that step's targets, an edge is returned only with its
  target, and soft-deleted objects and their links are left out unless
  `includeDeleted` is set. The memory provider's `getLinks` and `traverse` now
  page like Postgres (oldest first, 100 by default, at most 1000 links). An
  action's `deleteLink` effect now reads every page of links: it read only the
  first, so on Postgres (and now on memory) a match past the first 100 links
  was missed, and `expect: ALL` left the rest. It pages over the view that
  includes soft-deleted links, so a soft delete during the scan cannot shift
  a page, skips those links itself (links to a soft-deleted object remain
  candidates, as before), and reads on after any full page (an exactly full
  last page within its 1000-page budget is not an error). A link
  hard-deleted during the scan can still move a later one between pages.

- **Filters treat unset fields the same on both providers.** On Postgres,
  `neq` and `not` silently dropped records whose field was unset (SQL compares
  NULL as unknown), and `eq null` matched nothing; the memory provider matched
  them. Postgres now follows the memory provider: `neq 'x'` and `not(eq 'x')`
  match an unset field, `eq null` (or `eq` with the value left out) matches
  exactly the unset ones, and `in` with a `null` member matches them too
  (SQL's `IN (NULL)` matched nothing).
  On the memory provider an absent field, such as `_deletedAt` on a live
  object, now counts as null, as an unset column does on Postgres.

- **Postgres: a property added to an existing type in a later schema version
  gets its column.** Object and link tables were created with `CREATE TABLE IF
  NOT EXISTS` and never altered, so writing a property that a later version
  added to an existing type failed with "column does not exist". Every
  `applySchema` now adds the columns of declared properties that are missing,
  including for versions applied before this release: on the object and its
  history table together (matched by the names the DDL gives them, cut to
  PostgreSQL's 63 bytes), in
  one READ COMMITTED transaction under the migration lock, and before the
  version's own DDL, whose indexes may name the new columns. A start-up with
  nothing to add takes no lock. Existing rows read the new
  property as its default, or null.

- **The memory provider returns unset properties as Postgres does.** A declared
  property that was never set now reads back as `null` (or, on objects, its
  default) instead of being absent, on create and after a schema version adds
  the property; Postgres, the production store, already did this. Memory links
  also get the `id` property Postgres fills in. A property named like a system
  field (`_tenantId`, `_id`, ...) can no longer overwrite it on create: the
  memory provider let a create in one tenant write the object into another.

- **Hard delete removes the object's links, as the spec requires.** Both
  storage providers removed the object (and its history) but left every link
  from or to it, with its properties: traversal from the deleted ID still
  worked, and a one-to-one or many-to-one link kept the surviving endpoint's
- **Postgres: catalog lookups use the names the tables were created with.**
  The DDL drops a leading underscore from a type's table name (`_Ward` is
  table `ward`) and PostgreSQL cuts names to 63 bytes, but search's column
  discovery and `listIndexes` looked tables up by the uncut, unchanged name
  and found nothing. `ensureIndex` names an index whose name would exceed 63
  bytes with a hash instead of letting PostgreSQL cut it (the cut name could
  be another index's, and the index was then silently not made), and
  `dropIndex` only drops an index that is on that table and column (it could
  drop the history table's lookup index). `applySchema` refuses a schema in
  which two tables would get one stored name: two types that differ only by a
  leading underscore, or a type name so long that its table and its history
  table are cut to the same name (every write to such a type failed). A
  version applied before this check keeps starting; only new versions are
  checked. A valid, complete index an earlier release made under a cut name
  is kept rather than duplicated. A search with an empty field list (what the GraphQL API
  sends when field restrictions leave nothing searchable) searched every text
  column on Postgres, hidden ones included; it now searches none, as on the
  memory provider.

  slot. Hard delete is meant for data-retention compliance, so the leftover
  links kept exactly the data it should remove. It now removes all of the
  object's links, live and soft-deleted, in the same transaction, and rolling
  that transaction back restores them (and, on the memory provider, the
  object's version history, which rollback used to lose). On Postgres a link
  being created to the object at the same moment can no longer slip in between:
  `createLink` holds a share lock on both endpoints until it commits. That
  needs the delete to read at READ COMMITTED (the default), so a hard delete
  inside a caller's transaction at a stricter isolation level is refused with
  `VALIDATION_ERROR`; outside a transaction it always works. Creating,
  updating and soft-deleting an object on Postgres now write the row and its
  history snapshot in one transaction too, so a hard delete can no longer
  slip between them and leave a history row of the deleted object behind. A
  write that Postgres aborts as a deadlock victim (or for a serialization
  failure) in its own transaction is rerun, up to three attempts, and a
  connection whose `ROLLBACK` fails is discarded rather than pooled. The memory
  provider now also refuses links to missing, soft-deleted or other tenants'
  objects, as Postgres did; links it holds from before a schema was applied
  are found by their endpoints' IDs, for reads and for the cascade.

- **Graph-mirror writes work on databases that do not preload Apache AGE.**
  Without `shared_preload_libraries = 'age'`, the first `cypher()` call in a
  fresh session fails, so each new pooled connection lost its first mirror
  write. Each write now loads AGE first by casting to an AGE type, which needs
  no privileges (unlike `LOAD`, which a non-superuser may not run even where
  AGE is preloaded).

- **Helm: the database init job runs before the services, and fails on a SQL
  error.** It was a post-install/post-upgrade hook, so it ran after the gateway
  had started and tried to migrate a database without the AGE extension or
  graph; and `psql` exited 0 after a failed statement, so the job reported
  success. It is now a pre-install/pre-upgrade hook and runs `psql` with
  `ON_ERROR_STOP`. `deploy/README.md` gains a "Database prerequisites" section
  (external PostgreSQL with AGE, a superuser role, preload recommended).
  `postgresql.enabled` is deprecated: it only ever created a volume claim, no
  server. Claims the release created are now kept: the chart keeps rendering
  each, under its own name, with `resource-policy: keep` while it exists, even
  after the value is turned off or the release renamed, so an upgrade from an
  earlier chart (whose claim had no such annotation) cannot delete it or its
  volume. Turning the value off and on again keeps the claim's bound fields.
  An upgrade finds claims by listing the namespace's, so the account running
  `helm upgrade` needs `list` on persistentvolumeclaims there, or sets
  `postgresql.retainExistingClaims=false` once its claims are annotated or
  gone (the claim the values ask for is still looked up by name, which
  patching it needs anyway). While the claim exists, rolling back or
  downgrading to an earlier
  chart with the value on fails (without deleting it);
  `deploy/README.md` says how claims are matched and how to drop one.

- **Point-in-time reads on Postgres return the version in force at the
  requested time.** `getObjectAtTime` compared the cutoff with the time the
  history row was written (the database clock, a few milliseconds after the
  version's own timestamp), so a read at a version's own timestamp returned the
  version before it, and any clock skew between gateway and database shifted
  every answer. It now compares the version's own `_updated_at`, as the memory
  provider does; existing history rows already carry it.

- **The Postgres provider no longer leaves pooled connections pointed at
  `ag_catalog`, or loses writes to a failed graph-mirror update.** The AGE graph
  setup DDL and the Cypher helpers ran a session-level
  `SET search_path = ag_catalog, ...`, which stayed on the pooled connection.
  When the helper was handed the pool, the `SET` and the `cypher()` call could
  also run on different connections, so the mirror write failed silently.
  Inside a transaction, a failed mirror write was worse: it aborted the
  transaction, and `COMMIT` then rolled back the caller's SQL write while
  reporting success. Changes:
  - The helpers now send `SET LOCAL` and the query as one message. Inside a
    transaction they run under a savepoint, queued per connection, and restore
    the caller's `search_path` afterwards.
  - Mirror writes load AGE into their session themselves, so they also work
    where AGE is not preloaded, as on many external databases (see below).
  - `commit()` now throws when the server answers `COMMIT` with `ROLLBACK`;
    after a failed commit, `rollback()` is a no-op, so cleanup cannot mask the
    error.
  - The migration connection resets its `search_path` before going back to the
    pool.

  The migration ledger (`_schema_migrations`) is now named in its data schema
  rather than resolved through `search_path`. On first use, in a data schema
  the old code migrated (one holding the provider's object or link tables), it
  adopts the history of the ledger the old name resolved to; any other data
  schema starts empty. With the compose and Helm
  defaults that ledger is `openfoundry._schema_migrations` (the AGE graph's
  schema, through `"$user"`), not `public`. Without the adoption, upgraded
  databases would have replayed their DDL and skipped the checksum drift check.

- **Discharged admissions no longer vanish on the in-memory store.** The memory
  storage provider hard-deleted links while the Postgres provider soft-deletes
  them. Link history therefore came back empty whenever the gateway ran without
  `POSTGRES_URL`, and in every test built on the memory provider. That covers
  FHIR and CDM Encounters for discharged admissions, GraphQL
  `@link(history: true)` fields such as `Patient.admissions`, and
  `includeDeleted` traversals.

  The memory provider now soft-deletes as Postgres does: it stamps `_deletedAt`
  and bumps the version, and rejects updating or re-deleting a deleted link. It
  also rejects a link ID that is already in use. Before, a reused ID silently
  replaced the existing record, including another tenant's link.

  The FHIR and CDM Encounter projections now read every page of a patient's
  admissions. History comes oldest first, so a full first page could leave out
  the current admission. Paging follows `hasNextPage` and de-duplicates by ID,
  so pages that shift between reads cannot cut it short. Postgres pages links
  by creation time and then ID, so links created in the same instant cannot
  shift between pages. The SPI conformance suite gains the cases that would
  have caught this.

- **Traces now reach the collector.** Every deployment pointed the services at
  the collector's gRPC port (4317), while the services export with the OTLP/HTTP
  exporter. HTTP/1.1 to a gRPC listener gets an HTTP/2 frame back, so every export
  failed with a parse error. The failure was non-fatal and logged only when
  `OTEL_LOG_LEVEL` is set, so it went unnoticed, and no span ever reached
  the collector. Compose and the Helm chart now point at the OTLP/HTTP receiver
  on 4318. The chart default also lacked a URL scheme, and the network policy only
  allowed egress to 4317; both are corrected. In the compose stack, the
  integration suite now produces spans at the collector (148 in one run, against
  0 before).

- **The drift issue no longer repeats itself or outlives the drift.** The scheduled
  scan commented the same findings on the tracking issue every day and never
  closed it, so it read as permanently on fire. It now fingerprints the findings
  and comments only when they change, and closes the issue on a clean scan.

- **The scheduled scan stopped reporting drift.** It embedded raw Trivy tables
  in the issue body, and Trivy's table format prepends a report summary listing
  every scanned target, clean ones included. For a service image that is a few
  hundred rows of npm packages, so one image's table measures around 150 KB
  against GitHub's 65536-character body limit; `gh issue create` was rejected and
  three consecutive red scans filed nothing. The body is now built from the
  scan's JSON as a summarised table of findings only, with a size guard as a
  backstop. The scan kept failing correctly throughout — only the notification
  was lost.

  This was latent rather than new: any finding in a Node service image would
  have hit it. The one issue this mechanism did file successfully affected only
  the CEL evaluator, an Alpine image with a handful of scan targets and so a
  table small enough to fit.

## [0.3.0] - 2026-09-07

### Breaking changes

- Raised the supported Node.js runtime from the end-of-life Node 20 line to
  Node 24 LTS across development, CI, and service images.

### Security

- Updated the CEL service and its health probe to gRPC-Go 1.83.2 so requests
  missing both authority headers are rejected rather than accepted.

### Fixed

- Corrected the domain-pack tutorial's field-redaction guidance: virtual link
  fields are authorized during traversal rather than configured as stored fields.

### Changed

- Migrated the API gateway and Apollo middleware to Express 5, including the
  named wildcard routes required by its path matcher.
- Updated the GraphQL WebSocket and subscription libraries to their supported
  major versions, with the corresponding server import and iterator APIs.
- Followed the official Prometheus JavaScript client package rename from
  `prom-client` to `@prometheus-io/client`.
- Added Redis connection-health and fail-open metrics, throttled repeated outage
  warnings, and pinned the Compose service to Redis 7.4.11.
- Updated CEL-Go through its final non-breaking release before the upstream
  module-path migration, including evaluator safety and performance fixes.
- Updated the TypeScript compiler, Vitest runner, and ODL CLI framework to their
  supported majors, and applied current JOSE and GraphQL schema patches.
- Expanded the npm dependency queue so independent major-version reviews do not
  prevent grouped routine updates from opening.
- Generated API contracts are now tracked for review; CI rejects drift from
  their source and the release checklist regenerates them after version changes.

## [0.2.4] - 2026-09-07

### Security

- Cleared the current production dependency advisories: denial-of-service
  flaws in `qs` and `protobufjs`, and a `body-parser` flaw that could disable
  request-size enforcement when given an invalid limit.

### Changed

- Upgraded to ioredis 6 while retaining RESP2 for Redis-compatible proxies and
  preserving the rate limiter's fast, fail-open behaviour during initial
  connection, reconnects, and outages.
- Aligned the shared logger on Pino 10 and the OpenTelemetry runtime and test
  packages on one coordinated release family.
- Moved the CEL evaluator build to the patched Go 1.27 toolchain while retaining
  Go 1.25 language compatibility, and refreshed the supported Node.js tooling.
- Grouped future OpenTelemetry updates together so runtime and test packages do
  not drift across coordinated upstream releases.

### Release process

- Releases now require successful `main`-branch CI for the exact tagged commit
  and reject tags that disagree with checked-in package, chart, image,
  changelog, or install-example versions. Release packaging no longer rewrites
  source metadata after checkout, and verifies the generated API contract
  versions before publishing.
- Corrected the API contract documentation: released specs use the platform
  version and the release job relies on the exact-SHA CI gate rather than
  rerunning only a subset of tests.

## [0.2.3] - 2026-08-28

### Security

- **Cleared CVE-2026-14456** (openssl denial of service via unbounded memory,
  HIGH) from the `cel-evaluator` image. `libcrypto3`/`libssl3` moved from
  3.5.7-r0 to 3.5.8-r0. Only this image was affected — it is the one built on a
  bare alpine base, while the other services use `node:20-alpine`.

  Bumping the alpine tag would not have fixed it: the `alpine:3.24` image
  itself still ships the vulnerable packages, because the fix is a package
  update rather than an alpine release and the tag is only rebuilt periodically.
  The runtime stage now upgrades against the current package index at build time,
  so the window between an upstream fix and a base-image rebuild is closed.

  **Anyone running `cel-evaluator:0.2.2` should upgrade** — that published
  image carries the vulnerable openssl.

## [0.2.2] - 2026-08-23

### Security

- **Migrated to Apollo Server v5.** v4 is end-of-life (26 January 2026), so the
  GraphQL layer was running on an unsupported runtime. v5 removes the
  `./express4` export, replaced with `@as-integrations/express4`; Express stays
  on 4.x, which is a separate upgrade.

### Added

- Releases now publish **installable artifacts**: container images per service
  and a versioned Helm chart, both to GHCR, plus an `image-digests.txt` asset so
  deployments can pin by digest. Chart `version`/`appVersion` and the image tag
  are set from the release tag, so a chart cannot advertise a version it does
  not deploy.

### Changed

- **Releases are gated on the full CI matrix for the exact tagged commit.** The
  previous gate ran build, typecheck, unit tests and image builds, but not the
  Postgres integration, stack integration, enforcement E2E, Helm lint or image
  scan — so a tag could publish from a commit where one of those had failed.
- **Provenance is attested before a release becomes visible.** Releases are
  created as drafts, attested, then published, so a failure never leaves a
  public release advertising assurance it does not have.
- Helm chart metadata corrected: it described the platform as a "clinical data
  platform" with `clinical`/`nhs` keywords, pointed `home` at a repository that
  does not exist, and defaulted to an unpullable `openfoundry` registry with a
  floating `0.2` tag.

### Documentation

- A [tutorial](docs/first-domain-pack.md) building a complete domain pack from
  scratch, with a runnable non-healthcare example under `examples/library-pack/`
  and tests that keep it from drifting.
- README rewritten around the reader (438 → ~275 lines), leading with a runnable
  example rather than an architecture diagram.
- Corrected three claims that were false or configuration-dependent: bootstrap
  seeds bypass the action pipeline, `ObjectManager` writes no audit records, and
  `@sensitive` does not redact without a field-permissions policy.


## [0.2.1] - 2026-08-23

Patch release. The source at `v0.2.0` cannot build its container images; nothing
else about that release is affected, and its published API contract artifacts
remain valid.

### Fixed

- **`cel-evaluator` image build failed.** The health-probe tools module chains
  several `go get` calls, which left `go.sum` without an entry for
  `golang.org/x/sys/unix` (reached through gRPC internals), so `go build` failed
  and `docker compose build` could not produce the image. The build now records
  the resolved sums.

### Security

- Test-toolchain advisories cleared (vitest and its transitive `vite`, `rollup`,
  `postcss`, `nanoid`, `picomatch` dependencies). These never shipped in the
  container images, but they execute in CI.
- Both CI workflows now verify the Trivy download against its published
  checksums instead of piping an unverified tarball into `tar` as root.

### Added

- Scheduled daily security scan that files an issue when newly published CVEs
  affect unchanged dependencies, so drift no longer surfaces as a failed build on
  an unrelated change.

## [0.2.0] - 2026-08-23

The theme of this release is **making the platform genuinely domain-neutral** and
**proving governance actually enforces**. NHS-specific behaviour became opt-in,
and a production-mode enforcement test suite was added that exercises real OIDC
and OpenFGA rather than the development stubs. That suite immediately found
several production-only defects, all fixed below.

### Breaking changes

- **NHS facades are now opt-in.** The FHIR (`/fhir/*`) and FDP/CDM
  (`/api/v1/cdm/*`) surfaces, and the GraphQL `cdm*` queries, only mount when a
  loaded domain pack declares the corresponding capability in `pack.yaml`
  (`capabilities: [fhir, cdm]`). Deployments without such a pack now return 404
  on those routes.
- **Governance roles default to generic.** `RELATIONSHIP_GRANTER_ROLES` and
  `CONSENT_RECORDER_ROLES` default to `admin` instead of NHS clinical roles.
  NHS deployments set them explicitly.
- **`DataPurpose` is an open string type.** The recordable consent vocabulary is
  deployment policy via `CONSENT_PURPOSES`; the NHS preset is no longer implied.
- **Action permission relations come from one derivation.** Some `can_*`
  relation names changed (for example `TransferWard` now resolves to
  `can_transfer`). Pin ambiguous names with `@actionType(permission: "...")`.

### Added

- **Relationship grant/revoke API** (REST and GraphQL) for the direct ReBAC
  tuples the action pipeline cannot mint, gated by granter roles and audited.
- **Consent-record API** (REST and GraphQL) replacing direct writes to the
  consent store, with role gating and an audit record per write and denial.
- **Keycloak realm auto-provisioning** — the bundled realm now imports with the
  audience, `tenant_id`, and flat `roles` protocol mappers the authenticator
  requires, plus test users.
- **Configurable consent model** — `CONSENT_PURPOSES`,
  `DEFAULT_CONSENT_PURPOSE`, `CONSENT_SUBJECT_TYPES`,
  `CONSENT_DIRECT_CARE_EXEMPTION`, and `CONSENT_EXEMPTION_PURPOSE`. The
  legitimate-relationship exemption is off by default.
- **`OIDC_DEFAULT_TENANT`** — opt-in fallback tenant for IdPs that do not emit a
  `tenant_id` claim. Unset keeps the fail-closed default. (Thanks
  [@wangmingzhou1986](https://github.com/wangmingzhou1986) — [#1], [#4].)
- **Boot-time authorization model validation** — the gateway verifies the merged
  OpenFGA model declares every relation the runtime checks, and refuses to start
  in production when a type is missing `viewer`.
- **Enforcement E2E suites** — production-mode security (real OIDC + OpenFGA),
  capability gating, and consent-vocabulary validation, run in a dedicated CI job.
- **CDM additions** — first-class `Transfer` object, structured name
  decomposition (`family`/`given`), dataset export (`NDJSON`/`CSV`), and broader
  `Staff` → Practitioner coverage.
- **`SEED_TENANT`** is wired through Compose and documented; the gateway logs the
  seed tenant and warns when it is unset.

### Fixed

- **GraphQL subscriptions were non-functional over WebSocket** — the resolver
  returned a bare async iterator, payloads were keyed by topic rather than field,
  and dev-mode WebSocket auth required a token the HTTP path did not.
- **Production authorization was entirely broken** — the NHS pack's OpenFGA model
  used `self`, a reserved keyword, so no model loaded and every check failed.
- **Reads failed with `CHECK_FAILED` (500) for custom packs** — a pack's
  `permissions/*.fga` replaces the whole generated type block, silently dropping
  `viewer`. Undefined relations now deny instead of raising a retryable 500, and
  boot validation catches the gap. ([#3])
- **`ROLLBACK_ALL` left created links dangling** — compensation mis-routed
  created links to `deleteObject` instead of `deleteLink`.
- **Action permission relations could be renamed by unrelated schema changes** —
  the runtime and the model generator derived names independently.
- **Seeded data appeared to vanish** — seeds land in the isolated `system` tenant
  unless `SEED_TENANT` is set; now logged, warned, and documented. ([#2])
- Served `/api/v1/openapi.json` is stamped with the real platform version, and
  the governance REST paths are published in the spec.
- Field visibility for `nurse_in_charge`, CDM export truncation signalling, and a
  pack-agnostic audit `objectType` for non-NHS consent subjects.
- HIGH-severity CVEs cleared across all six images (`form-data`, `ws`,
  `golang.org/x/net`, `golang.org/x/text`, `google.golang.org/grpc`, Go stdlib).

### Documentation

- `deploy/README.md` corrected: a missing `OPENFGA_STORE_ID` in production fails
  fast, it does not silently install an allow-all authorizer.
- The README now states plainly that the default Compose stack disables
  governance enforcement.
- `docs/external-domain-packs.md` documents the authorization-model contract
  every pack must satisfy.
- Added `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and issue/PR
  templates.

## [0.1.0-rc.3] - 2026-06-14

Initial public prerelease: ODL compiler, storage SPI with PostgreSQL+AGE and
in-memory providers, ontology engine, action framework, security layer
(OIDC/OpenFGA/consent/audit), sync engine, GraphQL/REST/FHIR APIs, Helm chart,
and the NHS Acute, AML, and Supply Chain domain packs.

[Unreleased]: https://github.com/syzygyhack/open-foundry/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/syzygyhack/open-foundry/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/syzygyhack/open-foundry/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/syzygyhack/open-foundry/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/syzygyhack/open-foundry/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/syzygyhack/open-foundry/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/syzygyhack/open-foundry/compare/v0.1.0-rc.3...v0.2.0
[0.1.0-rc.3]: https://github.com/syzygyhack/open-foundry/releases/tag/v0.1.0-rc.3
[#1]: https://github.com/syzygyhack/open-foundry/issues/1
[#2]: https://github.com/syzygyhack/open-foundry/issues/2
[#3]: https://github.com/syzygyhack/open-foundry/issues/3
[#4]: https://github.com/syzygyhack/open-foundry/pull/4
