# Open Foundry documentation

Open Foundry is a **domain-neutral** ontology platform. Everything in this
directory describes the platform itself; domain-specific material lives in its
own subdirectory so it stays clearly separable.

## Platform

| Document | What it covers |
|----------|----------------|
| [`open-foundry-spec-v2.md`](open-foundry-spec-v2.md) | Full technical specification — ODL, storage SPI, ontology engine, actions, security, sync, APIs, federation, deployment. Reference material rather than a starting point. |
| [`first-domain-pack.md`](first-domain-pack.md) | **Tutorial — build your first domain pack.** A worked, non-healthcare example (library lending) covering object types, links, governed actions, permissions and seeds. Start here. |
| [`external-domain-packs.md`](external-domain-packs.md) | Domain-pack reference — connectors, capabilities, configuration, and troubleshooting. Read after the tutorial. |
| [`api-spec.md`](api-spec.md) | API contract artifacts (OpenAPI, GraphQL SDL, AsyncAPI) and client codegen. |
| [`repository-map.md`](repository-map.md) | What lives in each package, the storage provider matrix, and how the test suites are layered. |
| [`project-history.md`](project-history.md) | How the codebase was built. |

Also useful, outside this directory:

- [`../README.md`](../README.md) — overview, features, and getting started
- [`../deploy/README.md`](../deploy/README.md) — running the stack, development
  vs production mode, OIDC integration, and the operational footguns worth
  knowing before a real deployment
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — development setup and conventions

## Domain verticals

Reference implementations of the platform applied to a specific domain. They are
illustrative, not required — the platform ships no domain assumptions, and a
deployment loads only the packs it declares.

| Vertical | Documents |
|----------|-----------|
| [NHS / healthcare](nhs/) | Pilot design, NHS Federated Data Platform integration plan, and the FDP/CDM mapping profile. |

The bundled `aml` (anti-money-laundering) and `supply-chain` packs have no
narrative documentation yet; read their `pack.yaml`, ODL schema, and action
manifests under [`../domain-packs/`](../domain-packs/) as worked examples.
