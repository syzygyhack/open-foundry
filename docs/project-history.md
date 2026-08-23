# Project history

How Open Foundry was built. Kept out of the README so the landing page stays
focused on using the platform; preserved here because the provenance of the
code is worth being candid about.

## How this was built

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

