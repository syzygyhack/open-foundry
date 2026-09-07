# API Specification Artifacts

Open Foundry publishes three machine-readable API contracts. These are generated
from the merged schema at build time and attached to every GitHub release,
alongside a CycloneDX SBOM and a build provenance attestation (see
[`SECURITY.md`](../SECURITY.md#supply-chain)).

## Artifacts

| File | Format | Covers |
|------|--------|--------|
| `openapi.yaml` | OpenAPI 3.0.3 | REST endpoints — CRUD, actions, filters, pagination |
| `schema.graphql` | GraphQL SDL | Full GraphQL API — queries, mutations, subscriptions |
| `asyncapi.yaml` | AsyncAPI 2.6.0 | WebSocket subscription channels and event payloads |

## Where to Find Them

- **Release assets** — attached to every `v*` tagged release on GitHub. The
  release also carries `sbom.cyclonedx.json`; artifacts are attested, so
  `gh attestation verify <file> --repo syzygyhack/open-foundry` confirms they
  were built by the release workflow from that tag.
- **Local generation** — `pnpm --filter @openfoundry/api spec:all` writes all three to `packages/api/spec/`
- **Live endpoint** — `GET /api/v1/openapi.json` returns the OpenAPI spec from the running server

## Generating Specs Locally

```bash
# Build first (CLIs run from dist/)
pnpm run build

# Generate all three
pnpm --filter @openfoundry/api spec:all

# Or individually
pnpm --filter @openfoundry/api spec:openapi spec/openapi.yaml
pnpm --filter @openfoundry/api spec:graphql spec/schema.graphql
pnpm --filter @openfoundry/api spec:asyncapi spec/asyncapi.yaml
```

The specs reflect whichever domain packs are configured via `DOMAIN_PACKS_DIR`,
`DOMAIN_PACKS`, and `DOMAIN_PACKS_EXTRA_DIRS`. To generate for a specific pack
combination:

```bash
DOMAIN_PACKS=core,nhs-acute pnpm --filter @openfoundry/api spec:all
```

## Pack Composition

The generated specs cover **all loaded packs**. If you load packs `core` +
`nhs-acute` + `my-custom-pack`, the OpenAPI spec will contain routes for every
object type and action across all three.

To generate a spec for a subset of packs, set `DOMAIN_PACKS` before running the
dump CLI.

## Consuming from Other Languages

### Python (openapi-generator)

```bash
openapi-generator-cli generate \
  -i openapi.yaml \
  -g python \
  -o ./generated/python \
  --additional-properties=packageName=openfoundry
```

### Rust (progenitor / openapi-generator)

```bash
# Using openapi-generator
openapi-generator-cli generate \
  -i openapi.yaml \
  -g rust \
  -o ./generated/rust

# Or using progenitor (Oxide's Rust-native generator)
# Add to build.rs — see Phase 1 of the SDK plan
```

### TypeScript (graphql-codegen)

```bash
npx graphql-codegen \
  --schema schema.graphql \
  --generates ./generated/types.ts
```

### AsyncAPI (any language)

```bash
npx @asyncapi/generator asyncapi.yaml @asyncapi/typescript-template -o ./generated/events
```

## Versioning

Released spec metadata is stamped with the platform version from the root
`package.json`; it does not have an independent version track. API compatibility
therefore follows the platform's SemVer policy. While the platform is pre-1.0,
breaking contract changes require a minor release and compatible fixes use a
patch release.

## Validation

The spec round-trip test (`src/__tests__/spec-roundtrip.test.ts`) validates:

- All OpenAPI `$ref` pointers resolve to defined component schemas
- Every path operation has at least one response defined
- GraphQL SDL parses without errors and contains Query, Mutation, Subscription roots
- AsyncAPI channels have valid payloads with required ChangeEvent fields
- All three specs cover the same set of object types (cross-spec consistency)

Run the validation:

```bash
pnpm --filter @openfoundry/api test spec-roundtrip
```

## Release Workflow

The `.github/workflows/release.yml` workflow runs on every `v*` tag push:

1. Require the full `CI` workflow to have succeeded for the exact tagged commit
   as a `main` branch push.
2. Verify the tag, package, Helm chart, default image tag, changelog, and install
   example all name the same version, and that the commit remains on `main`.
3. Install frozen dependencies, build, and generate the API contracts via
   `spec:all`.
4. Build and push the service images and versioned Helm chart, then generate the
   image-digest list and CycloneDX SBOM.
5. Attach the contracts, chart, digests, and SBOM to a draft GitHub release,
   attest their provenance, and only then publish the release.

Tests are not rerun in the release job; the exact-SHA CI gate is authoritative
and includes the complete test, integration, Helm, image-build, and security
matrix. The maintainer checklist is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#cutting-a-release-maintainers).
