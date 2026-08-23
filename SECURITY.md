# Security Policy

Open Foundry handles authentication, authorisation, consent, and audit for the
systems built on it. We take security reports seriously and would rather hear
about a suspected issue than not.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/syzygyhack/open-foundry/security/advisories/new),
which is enabled on this repository. That creates a private advisory visible
only to maintainers.

Helpful details, roughly in order of usefulness:

- What an attacker can do (read another tenant's data, bypass an authorisation
  check, escalate a role, and so on).
- The affected version — a release tag or commit SHA.
- `NODE_ENV`, the loaded `DOMAIN_PACKS`, and whether OpenFGA/OIDC were wired.
- A minimal reproduction, plus the gateway boot log if it is relevant.

### What to expect

| Stage | Target |
|-------|--------|
| Acknowledgement | within 3 working days |
| Initial assessment (severity, affected versions) | within 10 working days |
| Fix or documented mitigation for confirmed HIGH/CRITICAL issues | within 30 days of confirmation |

We will keep you updated, credit you in the advisory unless you would rather stay
anonymous, and coordinate disclosure timing with you. This is a small project —
if a target slips we will say so rather than go quiet.

## Scope

**In scope:** the platform packages under `packages/`, the bundled domain packs,
the Helm chart and deployment manifests, and the CI workflow.

**Out of scope:**

- **The default `docker compose up` stack.** It ships `NODE_ENV=development`,
  which deliberately replaces OpenFGA and CEL with allow-all stubs and gives
  unauthenticated requests a synthetic admin user. This is documented in
  [`deploy/README.md`](deploy/README.md#development-mode-vs-production-mode) and
  is not a vulnerability — it is a local development mode that must never be
  exposed to an untrusted network. Reports against production mode
  (`NODE_ENV=production` with OIDC and OpenFGA configured) are in scope.
- Vulnerabilities in third-party dependencies with no exploitable path through
  Open Foundry. Our CI already fails on HIGH/CRITICAL container CVEs; if you can
  show an exploitable path, that is in scope.
- Findings that require an already-compromised host or database.

## Supported versions

Open Foundry is **pre-1.0**. Only the most recent release receives security
fixes; there are no long-term-support branches yet, and this policy will be
revised at 1.0.

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases / `main` | No — pin a release rather than tracking `main` |

## Supply chain

Each tagged release ships:

- **A CycloneDX SBOM** (`sbom.cyclonedx.json`), generated from the resolved
  workspace so it reflects what shipped rather than declared version ranges.
- **Build provenance attestation**, verifiable against this repository:

  ```bash
  gh attestation verify sbom.cyclonedx.json --repo syzygyhack/open-foundry
  ```

In the build pipeline:

- GitHub Actions are pinned to **commit SHAs**, not mutable tags, and kept
  current by Dependabot.
- The Trivy binary is verified against its published checksums before use.
- CI fails on HIGH/CRITICAL container vulnerabilities, and a scheduled daily scan
  files an issue when newly published CVEs affect unchanged dependencies.
- Secret scanning with push protection and Dependabot security updates are
  enabled on the repository.

## Security posture and its limits

Please read this before relying on the platform for sensitive data.

- The platform has **not** had an independent third-party security audit,
  penetration test, or clinical-safety assessment. Assurance to date is
  maintainer testing and review, including automated production-mode enforcement
  tests in CI.
- It has **no** information-governance validation and no documented production
  deployment handling real personal data.
- Production mode fails closed: required configuration is validated at boot and
  the gateway exits rather than starting without authorisation.

Treat it as a well-tested prerelease suitable for evaluation, prototyping, and
controlled pilots on synthetic or non-sensitive data — not yet as a
production-proven dependency for regulated workloads.
