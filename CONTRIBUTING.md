# Contributing to Open Foundry

Thanks for considering a contribution. This guide covers the setup, the
conventions that are easy to miss, and how to get a change reviewed quickly.

## Getting set up

**Prerequisites:** Node.js >= 20, pnpm 9.15+, Docker with Compose v2, and Go 1.25+
(only if you build `packages/cel-evaluator` outside Docker).

```bash
pnpm install
pnpm run build
pnpm run test          # unit tests, no Docker required
```

Integration tests need the stack running:

```bash
cd deploy && cp .env.example .env && cd ..
docker compose -f deploy/docker-compose.yaml -f deploy/docker-compose.test.yaml up -d --wait
pnpm run test:integration
```

The `docker-compose.test.yaml` override mounts a fixtures pack and sets
`SEED_TENANT=default` so seeded reference data is readable through the API.

### The enforcement E2E suites

Three suites exercise behaviour the default stack cannot show, because dev mode
runs allow-all stubs. Each **owns the Docker lifecycle** — it tears the stack
down and reboots it in a non-default mode on the same ports — so run them one at
a time, never alongside the standard suite:

```bash
SECURITY_E2E=1       pnpm --filter @openfoundry/integration-tests exec vitest run security-enforcement
CAPABILITY_E2E=1     pnpm --filter @openfoundry/integration-tests exec vitest run capability-gating
CONSENT_VOCAB_E2E=1  pnpm --filter @openfoundry/integration-tests exec vitest run open-consent-vocab
```

They leave the stack **down**; bring the dev stack back up before running
anything else. CI runs all three in a dedicated `enforcement-e2e` job.

## Conventions worth knowing

These are the ones reviewers actually raise.

**Fail closed.** Security-relevant configuration is opt-in, never defaulted to a
permissive value. If an environment variable is unset, the platform should refuse
or deny rather than pick a convenient default. For example `OIDC_DEFAULT_TENANT`
is passed through unset so a token without a tenant claim is rejected, rather
than defaulting every claimless token into a shared tenant. A change that makes
something permissive by default will be asked to invert.

**Blank env vars are unset.** Compose and Helm pass unset knobs through as empty
strings, so `process.env.X ?? 'default'` does *not* catch them. Use
`process.env.X?.trim() || 'default'` when a fallback is intended.

**Domain pack permission overrides replace the whole type block.** A pack's
`permissions/*.fga` does not merge relation-by-relation, so an override must
re-declare every relation the runtime checks — chiefly `viewer` on each object
type and `can_<verb>` for each action. Boot validation enforces this: a missing
`viewer` stops production startup. See
[`docs/external-domain-packs.md`](docs/external-domain-packs.md#what-every-type-must-declare).

**Don't hardcode counts in docs.** Test counts and line counts decay silently.
Describe coverage qualitatively.

**No NHS-specific defaults in platform code.** Healthcare behaviour is opt-in
through domain packs, capabilities, and deployment policy env vars. Platform
defaults stay generic.

## Making a change

1. Branch from `main`.
2. Keep commits focused; the body should explain *why*, not restate the diff.
3. Add or update tests. A bug fix should include a test that fails without it —
   say so in the PR, since it is the strongest signal a fix is real.
4. Update docs in the same PR when behaviour or configuration changes.

Before pushing:

```bash
pnpm run build && pnpm run typecheck && pnpm run test
```

`typecheck` covers test files that `build` excludes, so run both.

### Commit messages

Conventional-commit style: `fix(api):`, `feat(odl):`, `docs(packs):`,
`test(integration):`, `chore(deps):`. Please don't add `Co-Authored-By` or other
attribution trailers.

## Reporting bugs

Open an issue using the template. The three fields that most often decide whether
a report is actionable are **`NODE_ENV`**, the **loaded `DOMAIN_PACKS`**, and the
**gateway boot log** — dev mode disables enforcement entirely, so a behaviour that
looks like a bug in one mode is often expected in the other.

For security vulnerabilities, do **not** open a public issue — see
[`SECURITY.md`](SECURITY.md).

## Review

Maintainers aim to respond within a week. Expect questions about fail-closed
behaviour and test coverage on anything touching auth, authorisation, or consent;
that scrutiny is the point of the project, not a reflection on the contribution.

By contributing you agree your work is licensed under Apache 2.0.
