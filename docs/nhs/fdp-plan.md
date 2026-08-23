# Open Foundry → NHS FDP Integration Plan

**Status.** This is v3, incorporating the v2 audit-hardening corrections: pinned repo baseline, sharper CDM conformance method, explicit PET non-claim boundary, supplier/deployer clinical-safety responsibility split, named hosting-topology decision record, service-management/incident artefacts, a pilot-mode matrix that separates real-data-read-only from synthetic-action operation, and explicit non-goals. The strategic frame and component structure are unchanged from v2; this revision is about audit precision rather than scope.

---

## Conformance boundary (read this first)

Stage 1 does not claim to be an NHS FDP instance, a PET replacement, or a production clinical system. It claims to be an **FDP-compatible, trust-controlled Open Foundry runtime** that can: ingest one source read-only; map a bounded operational ontology to a version-pinned FDP/CDM subset; register and evidence data flows; enforce ReBAC, markings, consent, audit-on-read, and export controls; support sandboxed operational actions without write-back to the clinical system of record; and produce the assurance evidence needed for IG, Caldicott, and clinical-safety review.

Everything below sits inside that boundary.

---

## Stage 1 non-goals (explicit)

To make the pilot approvable, the following are out of scope for Stage 1:

- No production clinical decision support.
- No write-back to PAS / EPR / clinical system of record.
- No autonomous AI action; no AI-initiated write to the ontology without human approval.
- No integration with the NHS England national FDP instance.
- No claim of being an NHS-PET replacement or NHS-PET certified service.
- No multi-trust federation.
- No real-time operational dependency in live bed management — the trust's existing systems remain the operational source of truth during the pilot.
- No reliance on tagged Open Foundry releases that do not yet exist.

These non-goals are visible in the IG submission, not hidden in a backlog.

---

## Section 0 — Repo baseline, pinned

This plan is grounded against a specific commit of `syzygyhack/open-foundry`. The OF team should fill in the SHA and verification date before submission to the pilot trust.

```text
Baseline source:           github.com/syzygyhack/open-foundry
Commit SHA:                <fill in: full SHA>
Verification date:         <fill in: YYYY-MM-DD>
Release state:             no tagged release at verification date
Branch:                    main
License:                   Apache 2.0
```

**Repo-claimed posture (from README at verification date)**

| Claim | Source |
| --- | --- |
| 20 packages across core platform, domain packs, tests, tools | README |
| ~26,000 lines TypeScript, ~1,900 lines Go (CEL sidecar) | README |
| Unit tests + Postgres integration tests *(locally verified 2026-05-25 — see "Locally verified posture" below)* | README |
| ODL compiler generating GraphQL / REST / OpenFGA / TypeScript SDK | README |
| OIDC + OpenFGA ReBAC + consent + audit + field-level redaction | README |
| Postgres + Apache AGE storage SPI; in-memory SPI for tests | README |
| JDBC + Debezium CDC sync, with reconciliation and conflict resolution | README |
| FHIR R4 **read-only** Patient/Encounter endpoints | README |
| GraphQL subscriptions, query complexity gate, idempotency cache, persistent event bus with DLQ, distributed rate limiter | README |
| Helm chart with HPA, PDB, NetworkPolicy, non-root containers, secrets | README |
| OpenTelemetry + Prometheus + structured pino logging | README |
| NHS Acute domain pack (Patient/Ward/Bed/Consultant/DischargeRecord + Admit/Discharge/Transfer + PAS JDBC+CDC connector) | README |
| Repo-stated roadmap: schema registry persistence, FHIR write, application framework, federation, additional storage providers | README |

**Locally verified posture (to be filled in by the OF team running tests locally)**

```text
Verification commands:
  pnpm install
  pnpm run build
  pnpm run test
  pnpm run test:integration   # requires Docker Compose stack

Local results (verified 2026-05-25):
  Build:                     PASS — 15/15 turbo tasks, 0 errors
  Unit tests:                PASS (PG integration excluded)
  SPI conformance:           PASS (tests/spi-conformance, 10 categories)
  Postgres integration:      PASS — against apache/age:release_PG17_1.6.0 with the
                             documented init (CREATE EXTENSION age +
                             create_graph('openfoundry')) and PG_TEST_URL set.
                             The earlier 28 ad-hoc failures were (1) a missing AGE
                             graph and (2) two test fixtures that under-modelled the
                             ODL link 'id' column — both fixed; not product bugs.
  Docker-stack integration:  PASS — full compose stack (14 services) comes up
                             healthy via `docker compose up --wait`; the whole
                             integration suite passes against the live
                             stack (apache/age PG17), idempotent across fresh
                             reruns. Run with the test override:
                             `docker compose -f deploy/docker-compose.yaml
                             -f deploy/docker-compose.test.yaml up -d --wait`
                             then `pnpm run test:integration`. The override
                             loads a test-only reference-data seed pack
                             (tests/integration/fixtures/seed-pack) via
                             DOMAIN_PACKS_EXTRA_DIRS + SEED_TENANT=default. The
                             legacy suites were reworked from assumed CRUD
                             mutations onto the governed action API.
  Container build success:   PASS — all 6 images build clean via
                             `docker compose build`. Slimmed: cel-evaluator Go
                             454MB->49MB (build grpc-health-probe in the builder,
                             copy only static binaries — was copying the whole Go
                             toolchain into the runtime layer); the 5 TS images
                             ~237-239MB->215-216MB (committed 22MB Go binary
                             excluded from the image context via .dockerignore).
  Helm chart lint:           PASS — `helm lint --strict` (helm 3.16) 0 failures;
                             42 K8s resources render with required values set.
                             Only note: "icon is recommended" (cosmetic).
  Critical CVEs in deps:     PASS — `trivy image` HIGH+CRITICAL CLEAN on all 6
                             images (0 findings). Remediated: protobufjs CRITICAL
                             (CEL proto loader) ->7.6.4, axios ->1.17,
                             @grpc/grpc-js ->1.14.4, path-to-regexp ->0.1.13 (pnpm
                             overrides); cel-evaluator grpc CRITICAL ->v1.79.3 +
                             Go stdlib ->1.25.11 (builder pin); alpine openssl
                             libcrypto3/libssl3 ->3.5.7-r0 (apk upgrade); build
                             tooling (npm + corepack pnpm cache) removed from
                             runtime images (cleared tar/glob/minimatch/
                             cross-spawn/pnpm); OTEL stack 0.57->0.219 / 1.30->2.8
                             (cleared the last residual, exporter-prometheus
                             CVE-2026-44902).
  Commit SHA / release tag:  No tagged release yet. Pin the SHA of the release
                             commit (release.yml attaches spec artifacts on v* tags).
```

> **Pre-Stage-1 gate.** The code baseline is green (build + 1,883 unit + 287
> conformance + **238 storage-postgres incl. all 110 PG integration tests** +
> **47/47 full Docker-stack integration** + **all 6 container images build
> clean** + **helm lint pass** + **trivy HIGH/CRITICAL clean on all 6 images
> (0 findings)**). These gates are now CI-enforced on every push/PR via
> `.github/workflows/ci.yml`. Remaining before a trust submission: cut the
> first `v*` release tag from the verified HEAD.

Separating repo-claimed from locally-verified is mandatory because the IG and clinical safety reviewers will treat unpinned `main` as marketing rather than evidence.

**Classification of v1 line items against this baseline**

| v1 item | Status |
| --- | --- |
| Ontology Engine (S1.1 base) | Present |
| Actions / admit / discharge / transfer | Present (in `domain-pack-nhs-acute`) |
| ReBAC + audit + consent + redaction | Present |
| JDBC + CDC connector | Present; needs hardening for real PAS |
| FHIR R4 read | Present |
| Helm + single-instance deploy | Present; S1.8 hardens |
| NHS Acute domain pack starter | Present; S1.0 and S2.2 extend |
| HL7v2 MLLP connector | Missing |
| FHIR write | Missing (in repo roadmap) |
| Listener / webhook connector | Missing |
| Ontology Manager UI | Missing |
| Object Views generator | Missing |
| Bed Management app (real) | Present (precursor) — **Nightingale** (`../nightingale`) runs as the S1.4 reference app in Pilot Mode B against the real governed stack; productionisation edge cases remain (see S1.4) |
| Markings framework | Missing |
| AIP trio (gateway / logic / MCP) | Missing |
| CIS2 / smartcard | Missing |
| Schema registry persistence | Missing (in repo roadmap) |
| Instance lifecycle / upgrade / backup tooling | Partial |
| FDP/CDM compatibility profile *(assessor add)* | Missing |
| Data-flow registry + treatment-policy SPI *(assessor add)* | Missing |
| NHS assurance pack *(assessor add)* | Missing |

Stage 1 is built around what is missing in this table.

---

## Stage 1 — FDP-compatible single-trust pilot

### Goal

A named acute trust can deploy Open Foundry in a non-production environment, ingest **read-only** real data from at least one source system, model the relevant slice in the ontology **mapped to a version-pinned FDP/CDM subset**, allow CIS2-authenticated clinicians to perform operational actions inside Open Foundry (with **no write-back to clinical systems of record**), see those actions audited under registered data flows with PET-compatible treatment policies, and have the trust's IG lead, Caldicott Guardian, and Clinical Safety Officer sign off the supporting DPIA, manufacturer-side DCB0129 evidence, and DSPT-aligned assurance pack.

The bar is **"credible FDP-compatible pilot at one trust, defensible to a Caldicott Guardian"** — not "production-ready across England" and not "rebuilds FDP from scratch."

### Stage 1 hosting topology — decision record

The Open Foundry team and the pilot trust must jointly decide and document one of:

```text
Option A — Trust-controlled cloud tenant
  UK region, private networking, trust IAM control
  Controller: trust
  Processor: cloud provider; OF team only as deployment support
  Pros: clear controller boundary, fast provisioning
  Cons: cloud-cost approval cycle, FinOps overhead

Option B — Trust on-prem / private cloud
  Kubernetes on trust-managed infrastructure
  Controller: trust
  Processor: trust IT
  Pros: maximum data residency clarity, no third-party processor
  Cons: slower provisioning, depends on trust k8s maturity

Option C — Supplier-managed pilot environment
  Open Foundry team hosts; trust governs as controller via contracted processor model
  Controller: trust
  Processor: Open Foundry team / hosting partner
  Pros: fastest path to demo
  Cons: weakens "trust-controlled" claim; needs explicit processor agreement and DPIA covering it
```

For FDP integration the topology is not incidental: it sets controller/processor roles, DPIA shape, DSA terms, cyber review boundaries, backup arrangements, support boundaries, and whether "trust-controlled" is substantively true. This decision must be recorded as an ADR in the repository before the pilot DPIA is drafted.

### Pilot mode matrix

To prevent the ambiguity reviewers will otherwise raise about "real data + clinical actions," the pilot operates explicitly in one or more of the following modes, with the boundary visible in audit:

```text
Mode A — Real source data, read-only
  Inputs:    real PAS/EPR data via ingestion
  Actions:   disabled
  Users:     analysts, IG reviewers
  Purpose:   prove ingestion, mapping, lineage, marking enforcement
  Approval:  IG lead

Mode B — Synthetic mirrored data, actions enabled
  Inputs:    synthetic data generated from the @openfoundry/seed-nhs-acute tool, shaped to mirror trust workflows
  Actions:   enabled (admit, discharge, transfer, break-glass)
  Users:     named clinicians, bed managers, site managers
  Purpose:   prove the operational workflow, clinical-safety review, app usability
  Approval:  CSO + IG lead

Mode C — De-identified or pseudonymised data, actions enabled
  Inputs:    real data passed through the treatment-policy SPI to pseudonymise or de-identify
  Actions:   enabled only if explicitly approved
  Users:     named clinicians under documented purpose
  Purpose:   bridge between Mode A and Mode B if the trust IG team approves
  Approval:  Caldicott Guardian + IG lead + CSO; usually a Stage 1b, not initial Stage 1
```

Clinicians never "admit" real patients inside Open Foundry in Stage 1 unless the trust separately approves a Mode C extension. The audit log carries the active mode label on every record.

### Stage 1 component plan

#### S1.0 — FDP/CDM compatibility profile

**Scope.** Make Open Foundry's ODL ontology demonstrably mappable to the NHS FDP Canonical Data Model for the operational subset in scope: Patient, Ward, Bed, Admission, Discharge, Transfer, Staff, Encounter. The CDM is the single most important interoperability artefact in FDP and is currently a draft-in-progress NHS England standard (DAPB4121) intended to standardise data structures across NHS England; the FDP CDM is the form used inside FDP today. Without an explicit mapping profile, Open Foundry cannot present as FDP-integrable.

**Status — starter slice implemented.** A first vertical slice ships now:

- Declarative mapping profile: `packages/api/src/cdm/profile.ts` (`@openfoundry/api`).
- Provenance-preserving projection: `packages/api/src/cdm/mappers.ts` — every record carries a `_provenance` envelope (source type/version/timestamp + lossy fields).
- Read API at `/api/v1/cdm/*`: public `metadata` (profile + compatibility matrix + gap register), authenticated per-resource list/by-id projections, and Encounter-by-patient (via `AdmittedTo`). Reuses the FHIR/GraphQL auth + redaction + consent pipeline.
- Human-readable canonical mapping document: `docs/cdm-mapping-profile.md`.
- Tests: `packages/api/src/__tests__/cdm.test.ts` — profile completeness, projection, enum remaps, provenance, gap register, GraphQL CDM resolvers incl. Encounter, NDJSON/CSV export, truncation signalling, and Staff/structured-name projection.

The GraphQL CDM view is implemented (`cdmMetadata` / `cdmRecord` / `cdmRecords` /
`cdmEncounters` queries, reusing the same handlers as the REST router;
capability-gated alongside the REST mount). v0.2.0 also closed the remaining
S1.0 items: dataset export (`/api/v1/cdm/{Resource}/export?format=ndjson|csv`),
structured-name decomposition (Patient `family`/`given`), first-class Transfer
object, and broader Staff→Practitioner coverage. **Terminology validation**
(SNOMED/dm+d/ODS) is the only S1.0 item still open — deferred to the connector
layer (§S1.2) and full CDM coverage (§S2.2).

**Deliverables.**

- ODL ↔ FDP/CDM mapping profile for the Stage 1 operational subset, expressed as ODL directives plus a separate human-readable canonical mapping document. *(Done — declarative profile + `docs/cdm-mapping-profile.md`.)*
- Provenance-preserving transform pipeline: source system → Open Foundry ontology → CDM-shaped export view, with lineage retained end-to-end. *(Done — projection preserves `_provenance`.)*
- A read API that emits ontology contents in the CDM shape (initially as a GraphQL view + REST projection; later a dataset export). *(Done — REST projection + GraphQL view + NDJSON/CSV dataset export, all capability-gated.)*
- A versioned **CDM compatibility matrix**: which OF version targets which CDM revision, including the DAPB4121 status at the time of cut. *(Done — in profile + mapping doc.)*
- Documented gap register: where ODL semantics and CDM semantics differ, where mappings are lossy, what the safe fallback is. *(Done — 5 entries.)*

**Conformance test method (sharpened).**

```text
Conformance test inputs:
  - Version-pinned public CDM schema / OpenAPI / glossary artefacts where available
    (DAPB4121 NHS England standard page; FDP CDM public artefacts as they are published)
  - Synthetic patient / ward / bed / admission records generated from @openfoundry/seed-nhs-acute
    and any pilot-specific extension fixtures
  - Local extension fixtures for trust-specific fields that fall outside the canonical subset
  - Negative fixtures: lossy mappings, invalid terminology, missing provenance, malformed identifiers
```

Where the public CDM artefact is unstable (DAPB4121 is currently draft in progress), the compatibility matrix records the snapshot used and the dates of revalidation. The patient data is synthetic; the CDM target is not invented.

**Edge cases.**

- CDM evolves while OF is being built; the profile is versioned with a re-validation cadence (default quarterly during Stage 1).
- Lossy mappings are flagged in lineage so an analyst can see what was dropped on export.
- Local extensions: trusts customise data heavily; the profile allows per-trust extensions without breaking the canonical export.
- Terminology: SNOMED CT, dm+d, ODS codes — the mapping validates against terminology services, not free strings.
- Identity: NHS Number resolution against PDS where available; local-number-only patients flagged provisional.

**Why first.** This single deliverable converts the project from "another open-source Foundry clone" to "FDP-compatible runtime." It is the cheapest correction to ship early and the largest strategic gain.

---

#### S1.1 — Ontology Manager UI (`@openfoundry/ontology-manager`)

**Scope.** Read-mostly UI: tree/graph view of object and link types, field-level directive display, workspace diff, schema version history.

**Updates vs v2.**

- Renders CDM-mapping annotations from S1.0 alongside ODL directives.
- Renders marking annotations from S1.5.
- React + Vite + TypeScript, generated from the schema registry endpoint, no separate UI data model.
- Re-uses OIDC + ReBAC for authorisation; no new auth surface.

**Edge cases.**

- Virtualisation for UK Core depth (hundreds of resources).
- Cyclic-link rendering without infinite loops (Patient → AdmittedTo → Ward → BedAssignment → Patient).
- Ephemeral workspace previews — graceful handling of GC'd previews.
- Markings on schema elements must be visible so stewards see PHI status before federating.

---

#### S1.2 — Read-only production connector library

**Scope.** Stage 1 ingests **read-only**. Bidirectional write-back to EPR/PAS is explicitly deferred to a later, separately-gated stage. NHS England's own framing is that FDP is not integrated into the clinical system of record; OF's first pilot honours that boundary.

| Connector | Status | Stage 1 mode |
| --- | --- | --- |
| `connectors/jdbc-cdc` | Present; harden | Read-only |
| `connectors/fhir-r4` | New (HAPI FHIR) | Read-only; FHIR-write is post-Stage-1 |
| `connectors/hl7v2-mllp` | New (HAPI HL7, Java sidecar matching the CEL sidecar pattern) | Read-only ADT ingestion |
| `connectors/listener` | New (HTTP webhooks) | Read-only |

**Required behaviours.** All connectors implement the existing `Connector` SPI (`packages/sync/src/connectors/connector.ts`, registered via `ConnectorRegistry`/`ConnectorPlugin`); expose an OTel sync-lag gauge; run scheduled source-vs-ontology reconciliation surfacing discrepancies as quality events; detect schema drift, quarantine affected records, and emit drift events; support resumable initial extracts with progress events; allow per-deployment HL7 dialect profiles; validate FHIR against UK Core, not generic R4; handle NHS Number quirks (leading zeros, formatting, Modulus 11 check) as transform-DSL built-ins; handle patient merges (HL7v2 A40, FHIR merge bundle) propagated through the ontology with audit preserving both pre-merge identities; fall back gracefully where PDS is unavailable, flagging local-number-only patients as provisional; persist MLLP messages between receiver and Sync Engine with at-least-once semantics.

**Write-back lockout.** Any connector that *could* be used to write back must have write-back paths physically disabled in Stage 1 — config flag locked off, ideally separated at the package boundary — so the IG lead can verify by inspection rather than by trust. This is referenced explicitly in the DPIA evidence under S1.9.

---

#### S1.3 — Object Views generator (`@openfoundry/object-views`)

**Scope.** Generated default UI per ObjectType, configurable via `*.view.yaml`, rendered through the existing web console.

**Updates.**

- Renders marking chrome (banner / colour band) from S1.5.
- Renders redaction state explicitly (the `_redactedFields` envelope is shown, not silently hidden).
- Lineage tab shows CDM-mapping provenance — whether a field arrived via JDBC, FHIR, HL7v2, or Listener — which matters for clinical-safety review.
- Consent-restricted state rendered as a structured "consent restricted" view, not silent emptiness.

---

#### S1.4 — Bed Management reference app (`@openfoundry/app-bed-manager`)

**Status — precursor built (Nightingale, `../nightingale`).** A working reference
app exists and runs in **Pilot Mode B** (synthetic data, real governed actions)
against the deployed stack — no in-process simulation. Reads are an operational
projection over the live PostgreSQL+AGE ontology; every write (admit / discharge /
transfer / clean) is a genuine governed action through the production api-gateway
(real authorize → consent → CEL → effects → audit → CloudEvents). It ships a
real-time 3D bed board, an ED queue, an activity feed, a collapsible immutable
audit trail, a server-side autopilot that issues governed actions on a jittered
interval, and a **Direct-link** panel proving governance in the substrate
(porter discharge → ReBAC denial; unconsented admit → consent denial; authorised
admit → audited success). The `CleanBed` action was driven and verified live
end-to-end here. This realises the core of S1.4; the items below are the
remaining productionisation gaps, not greenfield.

**Scope (remaining productionisation).** Promote the Nightingale precursor toward
a trust-usable app: tablet form-factor hardening, drag/tap interactions, and the
edge cases below.

**Updates.**

- All actions write to Open Foundry's ontology and audit only. **No write-back to PAS/EPR.**
- A "source of truth" banner: the clinical system of record remains the trust's PAS/EPR; Open Foundry shows a coordinated operational view.
- Re-uses the Object Views generator for non-bed-specific inspection (patient detail, ward detail).
- All actions go through the existing Action API — no shortcuts to the SPI.

**Edge cases.** Surge volumes (list-mode fallback when 3D doesn't scale visually); conflicting concurrent admits handled by the existing optimistic concurrency, with a clean UI recovery flow; richer bed-cleaning state model (cleaning, deep-clean, closed-for-maintenance); corridor / outlier patients accommodated without distortion; cross-ward visibility under a documented site-manager role; Caldicott break-glass with mandatory justification, surfaced specially in audit.

---

#### S1.5 — FDP-style IG layer: markings + data-flow registry + treatment-policy SPI

This is the v2 expansion that v3 keeps intact, plus a **PET non-claim boundary** added below.

**Components.**

- **Marking framework (minimal but real).** PHI, Caldicott Principle 4 (need-to-know), GDPR Article 9 special category. Markings declared in schema via `@marking`, enforced in the Ontology Engine, propagated through links and aggregations, composable with ReBAC, visible in UI chrome.
- **Data-flow registry.** Every flow `source → ontology → product/app/action/export` is a first-class ontology object with declared purpose of use, lawful basis (Article 6 + Article 9 where applicable), data minimisation justification, retention period, controller, processor, recipients, and lifecycle (proposed → reviewed → active → suspended → retired). The IG lead can browse and export the registry.
- **Treatment-policy SPI.** A pluggable interface so PET-style transformations (pseudonymisation, k-anonymity, suppression, aggregation thresholds) can be inserted into flows. Stage 1 ships a reference pseudonymisation policy.
- **DPIA evidence bundle generator.** Given a data-flow registry, generate a DPIA template populated with the registered facts.
- **Marking-aware export blocking.** Extraction attempts of marked data are logged and may require approval (the approval is action-shaped).
- **Audit-on-read** for marked objects, not only on write — Caldicott Principle 4 requires evidence of need-to-know, which means read access must itself be audited.

**PET non-claim boundary (sharpened).**

```text
Open Foundry's Stage 1 IG layer does NOT claim:
  - to be NHS-PET
  - to be an NHS-PET certified service
  - to be a drop-in PET replacement

Open Foundry's Stage 1 IG layer DOES claim:
  - PET-compatible architecture:
      * data-flow registration as a first-class object
      * treatment-policy hooks behind a documented SPI
      * de-identification / pseudonymisation policy evidence per flow
      * exportable records for IG / Caldicott review
  - Stage 2 acceptance target:
      * formal NHS-PET interoperability where its public interfaces allow,
        and explicit non-interoperability documentation where they do not
```

**OF-aligned design decisions.** Data-flow objects live in the ontology under `governance.`, edited via actions, governed by the same ReBAC and audit as anything else. Markings are schema directives, not column tags — storage stays dumb, the Ontology Engine enforces. The TreatmentPolicy SPI mirrors the storage SPI pattern, with conformance tests.

**Edge cases.** Joint markings combine, not overwrite (PHI + research stays PHI ∧ research). Marking downgrade is an Action requiring two-person approval. Link-level markings (consent links) carry their own. Aggregation cell-size minima are enforced in the aggregation API, not retrofitted in UI. SAR fulfilment uses the data-flow registry to enumerate flows touching a given subject; right-to-erasure preserves the *fact* of an action while removing payload.

---

#### S1.6 — Sandboxed AI layer (`@openfoundry/aip-*`)

**Scope.** Tightly bounded sandbox, **read-only by default**. The differentiator narrative remains, but AI is no longer the gating risk for IG sign-off.

**Components.**

- `aip-gateway`: provider-agnostic LLM access. Default Anthropic Claude via AWS Bedrock UK region (data residency); self-hosted vLLM with open-weights for air-gap; Azure OpenAI UK for compatibility. Audit-integrated, per-tenant token budgets, structured output via JSON Schema, prompt/response logging with PHI redaction.
- `aip-logic`: LLM functions declared in ODL. Stage 1 reference functions are **read-only summarisation / extraction**: `SummariseAdmissionHistory`, `ExtractFreeTextDiagnosisCodes` (validated against terminology service), `TriageNotesToStructured`.
- `aip-mcp`: MCP server exposing the ontology to external agent frameworks. Stage 1 ships **read-only tools only**. Any write action exposed via MCP requires `policyGuard: true` plus human approval and is shipped as a documented sandbox demo, not a production-enabled path.
- `aip-evals` (minimal): regression suite for the three reference functions; LLM-as-judge plus structural checks plus terminology-validity checks; CI-integrated.

**Clinical-safety alignment.** Each AI function gets a hazard log entry under the manufacturer DCB0129 evidence (S1.9). No AI function ships without one. Terminology validation (SNOMED, ICD-10, dm+d) is mandatory; hallucinated codes are caught before they reach the ontology. Prompt-injection from free-text clinical notes is treated as a known threat; outputs are schema-validated, never trusted as instructions.

**Deferred to Stage 2.** Autonomous write actions via AI; AIP Agents (native in-platform agent runtime); Document Intelligence (PDF → entity extraction); conversational analyst; full evals framework with synthetic data generation and drift detection.

---

#### S1.7 — CIS2 / OpenFGA / break-glass hardening

**Scope.** Bring existing OIDC + OpenFGA + Keycloak stack up to NHS Care Identity Service 2 (CIS2) interoperability.

**Components.** CIS2 OIDC integration (configuration + role-mapping, not new code). CIS2 role-code → OpenFGA relation mapping, version-controlled. Activity-based access: clinician role → permitted activities → permitted actions. Smartcard session handling aligned with NHS workstation policy (shared workstations, fast user switching, removal-mid-action behaviour). Break-glass as an Action with mandatory `justification: String!` and a separately-flagged audit category. 2FA enforcement for break-glass and write-class actions. CIS2-outage handling via the existing circuit-breaker pattern.

**Edge cases.** Smartcard removed mid-action — action completes or rolls back cleanly with audit reflecting both. Shared workstations — fast user switching must not leak previous-user view state. CIS2 outage — fail closed for authentication, degrade gracefully. Role changes mid-shift — OpenFGA cache TTL short enough to propagate quickly.

---

#### S1.8 — Single-instance lifecycle, backup, DR, and service operations

**Scope.** Production-grade install / upgrade / backup / restore / DR / service-management for one trust instance. The Helm chart exists; this hardens it and adds operational runbooks.

**Components (technical).** One-command install with pre-flight (Kubernetes version, storage class, secrets, OIDC connectivity). Versioned upgrades with schema-migration check and generated rollback plan. Backup/restore via the existing `BackupCapability` interface. DR runbook with measured RTO/RPO targets. Air-gap install path — single signed tarball, no internet during install. Storage-growth pre-flight (AGE graph + audit + lineage grow non-trivially at NHS depth). Trust-firewall diagnostic tooling.

**Components (service management — new vs v2).**

```text
Incident response:
  - severity model (P1–P4)
  - escalation path with named roles
  - on-call model for the pilot period

Vulnerability management:
  - coordinated vulnerability disclosure policy
  - patching SLAs by severity
  - dependency-scan cadence (snyk / trivy / equivalent)

Audit log:
  - retention policy
  - retrieval SLA for IG / regulator requests
  - immutability evidence (hash chain or equivalent)

Change control:
  - DPIA / IG change-control process for schema changes
  - DPIA / IG change-control process for new connectors
  - clinical-safety re-review trigger for AI function changes

Breach handling:
  - data breach notification workflow aligned with UK GDPR
  - 72-hour ICO notification path
  - patient notification decision framework
```

These items are unglamorous, but they are routinely where trust approval stalls.

---

#### S1.9 — NHS Assurance Pack (supplier / deployer split sharpened)

Cross-cutting throughout Stage 1, not at the end. Reviewed continuously by the pilot trust's IG lead, Caldicott Guardian, and Clinical Safety Officer.

**Open Foundry produces (supplier / manufacturer side).**

- DCB0129 clinical safety case report.
- Manufacturer hazard log (including hazards introduced by each AI function in S1.6).
- Safety case evidence pack (architecture, controls, test results, change-control process).
- DCB0160 deployment hazard guidance — material the trust can use as input to its own DCB0160 work, not a substitute for it.
- DTAC response pack — covering clinical safety, data protection, technical security, interoperability, usability/accessibility.
- DPIA template populated from the S1.5 data-flow registry.
- RoPA / data-flow register exported from S1.5.
- DSPT evidence mapping — controls mapped to DSPT requirements.
- Penetration-test plan and remediation pathway.
- Accessibility statement for the Bed Management app and the Ontology Manager UI.
- Cyber / service monitoring evidence sourced from the existing OTel + Prometheus stack.

**Pilot trust owns (deployer side).**

- DCB0160 deployment safety case for the trust's environment.
- Local hazard review (combining OF's manufacturer hazards with trust-specific deployment hazards).
- Operational acceptance of the platform within the trust.
- Clinical Safety Officer sign-off.
- DPIA approval by the trust's IG lead and Data Protection Officer.
- Caldicott Guardian approval where direct-care or research access is involved.

The artefact list is hardened along this split so reviewers see clearly which party is responsible for which evidence. The supplier never signs the deployer's DCB0160; the deployer never signs the supplier's DCB0129.

---

### Stage 1 exit criteria (revised, fully traceable)

The pilot trust signs off on **all** of the following:

1. IG lead has reviewed the DPIA, data-flow register, marking enforcement, audit, and ReBAC for non-production data, and is satisfied.
2. Caldicott Guardian has reviewed the need-to-know controls (markings + ReBAC + audit-on-read) and is satisfied for the declared purposes.
3. Clinical Safety Officer has signed off the trust's DCB0160 deployment safety case, with Open Foundry's DCB0129 manufacturer evidence pack as input.
4. One source system is ingested **read-only** with reconciliation, lag metrics, and patient-merge handling validated.
5. The ontology subset (Patient, Ward, Bed, Admission, Discharge, Transfer, Staff, Encounter) is demonstrably mapped to the FDP/CDM subset at the version pinned in the S1.0 compatibility matrix, with the gap register reviewed.
6. Named users authenticate via CIS2 sandbox (or trust OIDC equivalent if CIS2 access is delayed).
7. At least three clinical actions (admit, discharge, transfer) are routinely performed by named clinicians in **Mode B** (synthetic mirrored data with actions enabled).
8. **No write-back to the clinical system of record occurs.** Connectors with write paths have those paths physically disabled, verifiable by inspection. This is referenced in the DPIA.
9. The Bed Management app is used in a simulated bed-meeting exercise and judged usable by ward managers / bed managers / site managers.
10. Break-glass with justification capture, and export approval, are demonstrated end-to-end with audit evidence.
11. A DR exercise demonstrates RPO ≤ 1 hour and RTO ≤ 4 hours, measured.
12. The AI demo is read-only summarisation/extraction, plus one approval-gated write action in sandbox with full audit and a corresponding hazard log entry. No autonomous AI writes occur.
13. The NHS Assurance Pack (DTAC, DCB0129, DCB0160 input, DPIA, DSPT mapping, RoPA, accessibility statement, pen-test plan, incident-response runbook, vulnerability-disclosure process, breach-notification workflow) is complete and reviewed.
14. The deployment topology (Option A / B / C) is documented in an ADR, with controller/processor roles recorded in the DPIA.

---

### Stage 1 effort estimate

| Component | Compressed engineer-years | Wall-clock months |
| --- | --- | --- |
| S1.0 FDP/CDM compatibility profile | 1.5 | 1.0 |
| S1.1 Ontology Manager UI | 1.0 | 0.5 |
| S1.2 Connectors (read-only, 3 new + harden 1) | 3.0 | 1.5 |
| S1.3 Object Views generator | 1.2 | 0.6 |
| S1.4 Bed Management app | 1.5 | 0.7 (UX iteration) |
| S1.5 IG layer (markings + flow registry + treatment-policy SPI) | 2.5 | 1.2 |
| S1.6 Sandboxed AI trio | 2.5 | 1.2 |
| S1.7 CIS2 hardening | 1.0 | 0.6 (CIS2 sandbox access) |
| S1.8 Lifecycle / backup / DR / service ops | 1.2 | 0.6 |
| S1.9 NHS assurance pack | 2.0 | runs across, 3+ months wall-clock |
| Cross-cutting (test, security review, IG iteration) | 2.5 | runs across |
| **Stage 1 total** | **~19 engineer-years compressed** | (see ranges below) |

**Realistic wall-clock ranges.**

- Engineering alpha (working software, internal demo): **6–9 months.**
- Trust-integrated pilot readiness (real source connected, real users on synthetic data, draft assurance pack): **9–15 months.**
- Stage 1 with signed-off trust IG + CSO + Caldicott approval: **12–18 months.**

The difference between these ranges is not code — it is CIS2 sandbox access timing, trust firewall and N3/HSCN onboarding, source-system access negotiation, EPR vendor cooperation, IG review cycles, and CSO sign-off, all of which are serialised and resist parallelisation.

---

## Stage 2 — FDP-scale interoperability and successor readiness

### Goal

Open Foundry credibly competes for FDP successor opportunities. Multi-trust federation works under signed DSAs. The full AI surface is competitive with AIP. Non-developers can build apps. The platform is operable at significant scale by an entity other than the original author.

### Ordering (corrected from v1, retained from v2)

| Order | Component | Why |
| --- | --- | --- |
| S2.1 | Federation / DSA / cross-instance audit | The defining FDP property |
| S2.2 | NHS Domain Pack v2 + full CDM coverage | The interoperability surface |
| S2.3 | Full governance: complete markings, full PET treatment-policy library, approval workflows, SAR / erasure | The IG surface at scale |
| S2.4 | Pipeline Engine / dataset layer | Analytics + product builder substrate |
| S2.5 | Workshop-equivalent app builder | Non-developer reach |
| S2.6 | Full AI layer (agents, document intelligence, full evals, analyst) | The differentiator at scale |
| S2.7 | Multi-instance control plane | Operability at scale |
| S2.8 | Durable workflow orchestrator | Long-running cross-system processes |

### S2.1 — Federation / DSA / cross-instance audit

DSA framework with cryptographic signing (PKI; optional CIS2-issued certificates). Federation protocol extending GraphQL federation with `@key`. DSA registry and lifecycle (propose → sign → activate → expire → revoke). Cross-instance object resolution with preserved lineage. Federation-aware ReBAC. Cross-instance consent. Cross-instance audit with tamper-evident reconciliation. Circuit breakers between instances. Federation health dashboard.

Edge cases: DSA revocation mid-query; trust withdrawal preserving historical audit; patient inter-trust moves; clock skew (UTC + NTP discipline); asymmetric versioning; joint Caldicott Guardian approval for cross-trust queries; national-service partners (Spine, NHS England analytics, NHS Research SDE) modelled with elevated trust and explicit scope limits; marking propagation across federation boundaries defaulting over-restrictive.

### S2.2 — NHS Domain Pack v2 + full CDM coverage

Full FHIR R4 UK Core as ODL. NHS Spine connectors (PDS, SDS, e-RS, SCR, NRL). EPR vendor mappings (Cerner Oracle Health, Epic, System C, TPP SystmOne, EMIS). Pre-built apps for the published FDP use cases (care coordination, elective recovery, vaccination and immunisation, population health, supply chain). DSPT-aligned permission model with CIS2 role mapping. Caldicott principles encoded as approval workflows. Pre-built LLM functions for common clinical extraction tasks, paired with evals. **Full FDP/CDM coverage** completing the S1.0 mapping profile.

Edge cases: EPR vendor cooperation variance (cooperative ↔ non-cooperative paths); trust-specific customisation as templates not forks; regional vs national flows without privileging any geography; specialty extensions that grow gracefully.

### S2.3 — Full governance and PET-compatible treatment policies

Complete marking taxonomy with composition rules. Full propagation through pipelines, federation, and aggregation. Approval workflows for high-risk operations. Global Branching extension across all artifact types. Full DSPT alignment with auditor reports. Caldicott workflows. SAR automation. Right-to-erasure with marking-aware retention. **Full PET-style treatment-policy library** building on the S1.5 SPI: pseudonymisation, k-anonymity, differential privacy, suppression, aggregation thresholds. Stage 2 acceptance target includes formal NHS-PET interoperability work where the public interfaces allow.

### S2.4 — Pipeline Engine

Transform DSL (TypeScript + Python). Executor SPI with local / Spark / Flink / Arrow reference implementations. Visual Pipeline Builder generating canonical TypeScript. Compute Modules (container-as-pipeline-step). Dataset-level lineage flowing into the existing ontology lineage system. Iceberg reference dataset format with branching, time travel, schema evolution. Scheduled, incremental, and streaming pipelines.

### S2.5 — Application framework (Workshop-equivalent)

Visual app builder. Widget primitives (object set, action, form, chart, table, map, timeline, embed). Custom widget registry via module federation. App permissions inherited from ontology permissions. App versioning + branching. Publishing and discovery within and across trusts. App templates and starter library.

### S2.6 — Full AI layer

AIP Agents (native in-platform agent runtime). Document Intelligence (PDF → entity extraction → ontology objects, marking-aware end-to-end). Full evals framework with synthetic data generation, drift detection, A/B testing, judge ensembles. Conversational analyst. Agent observability (traces, costs, decisions, tool-use audit). Agent simulation harness for safety testing.

### S2.7 — Multi-instance control plane

Instance registry with capability declarations. Git-backed configuration management. Coordinated rollouts (canary / progressive / full). Air-gap artifact transport. Domain Pack registry with signing. Cross-instance observability rollup. Coordinated DR.

### S2.8 — Workflow orchestrator

Durable workflow engine (Temporal-style). Workflow DSL. Scheduling and triggers (cron / event / manual). Compensation and saga patterns. Human-in-the-loop steps with timeout policies. Workflow observability (visual flow + history).

### Stage 2 effort estimate

| Component | Compressed engineer-years | Wall-clock months |
| --- | --- | --- |
| S2.1 Federation | 6 | 2.5 (security-critical) |
| S2.2 Domain Pack v2 + full CDM | 8 | 3.5 (vendor coordination) |
| S2.3 Full governance + PET library | 4 | 1.5 |
| S2.4 Pipeline Engine | 8 | 3.0 |
| S2.5 App framework | 6 | 2.5 |
| S2.6 Full AI layer | 5 | 2.0 |
| S2.7 Multi-instance control plane | 4 | 1.5 |
| S2.8 Workflow orchestrator | 3 | 1.2 |
| Cross-cutting | 4 | 2.0 |
| **Stage 2 total** | **~48 engineer-years compressed** | **~20 months active velocity** |

### Combined timeline

| | Compressed engineer-years | Active-velocity wall-clock |
| --- | --- | --- |
| Stage 1 | ~19 | engineering alpha 6–9 months; trust-signed pilot 12–18 months |
| Stage 2 | ~48 | ~20 months |
| **Combined** | **~67** | **~32–38 months end-to-end** |

A project starting now plausibly reaches production-credible Stage 2 by mid-2028 to late-2029, *provided* trust engagement begins immediately in parallel with engineering.

---

## What does not compress

Three constraints set wall-clock floors independent of engineering velocity:

1. **Trust user iteration.** Clinicians, bed managers, IG leads, CSOs, Caldicott Guardians review at human speed. Stage 1's upper bound is mostly these loops, not code.
2. **Security and governance review.** Every federation boundary, every marking propagation, every LLM tool grant requires competent human security review. This scales with platform surface area, not engineering capacity, and is the largest non-compressible Stage 2 cost.
3. **EPR vendor relationships.** Cooperation varies by vendor; reverse-engineering non-cooperative mappings is wall-clock-unpredictable.

The corollary: engineering and pilot engagement must run in lockstep. Pilot-trust engagement starts before Stage 1 code is complete. CIS2 sandbox access is requested at kickoff. DSA design needs IG-lawyer input that can't be parallelised with code. Trust firewall and HSCN onboarding have their own queue.

---

## Strategic positioning summary

| Dimension | Final framing |
| --- | --- |
| Product narrative | FDP-compatible, trust-controlled ontology runtime — not an FDP clone |
| Stage 1 data direction | Read-only ingestion; no clinical-system write-back |
| Stage 1 AI role | Sandboxed, read-only by default, with clinical-safety hazard logs per function |
| Governance primitive | Markings + audit + data-flow registry + treatment-policy SPI + NHS Assurance Pack |
| FDP integration method | Explicit CDM mapping profile from S1.0, version-pinned conformance against public NHS England CDM artefacts where available, with synthetic patient data |
| PET claim | PET-compatible architecture, not PET replacement; formal NHS-PET interoperability is a Stage 2 acceptance target |
| Clinical safety responsibility | OF supplies DCB0129 manufacturer evidence; trust owns DCB0160 deployment safety case |
| Deployment topology | Chosen ADR (Option A / B / C) before pilot DPIA |
| Stage 2 ordering | Federation + full CDM first, then governance, then platform completion |
| Realistic timeline | 12–18 months for trust-signed Stage 1; ~32–38 months end-to-end |

The plan is positioned as **the credible open, trust-controlled, FDP-interoperable ontology runtime that exists today and can compete for successor work tomorrow** — leveraging the substantial baseline already in `syzygyhack/open-foundry`, with the precision needed to be defensible to an IG lead, a Caldicott Guardian, and a Clinical Safety Officer.

---

## Appendix A — Items the Open Foundry team must fill in before submission

```text
1. Commit SHA and verification date for Section 0.
2. Locally verified test counts and build results.
3. Hosting topology ADR (Option A / B / C) for Stage 1.
4. Named pilot trust and its IG lead, Caldicott Guardian, Clinical Safety Officer.
5. CIS2 sandbox access request status.
6. Source system targeted for Stage 1 ingestion (PAS via JDBC+CDC,
   EPR via FHIR-R4-read, or EPR via HL7v2 MLLP).
7. Cloud provider region or on-prem datacentre for the deployment.
8. LLM provider configuration for S1.6 (Bedrock UK / Azure UK / vLLM air-gap).
9. Pilot mode at launch: Mode A only, or Mode A + Mode B.
10. Pilot duration and named end-of-pilot review date.
```