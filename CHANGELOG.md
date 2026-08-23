# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, minor versions may contain breaking changes; these
are called out under **Breaking changes**.

## [Unreleased]

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

[Unreleased]: https://github.com/syzygyhack/open-foundry/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/syzygyhack/open-foundry/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/syzygyhack/open-foundry/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/syzygyhack/open-foundry/compare/v0.1.0-rc.3...v0.2.0
[0.1.0-rc.3]: https://github.com/syzygyhack/open-foundry/releases/tag/v0.1.0-rc.3
[#1]: https://github.com/syzygyhack/open-foundry/issues/1
[#2]: https://github.com/syzygyhack/open-foundry/issues/2
[#3]: https://github.com/syzygyhack/open-foundry/issues/3
[#4]: https://github.com/syzygyhack/open-foundry/pull/4
