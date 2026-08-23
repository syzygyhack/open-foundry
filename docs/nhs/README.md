# NHS / healthcare vertical

This directory holds documentation for Open Foundry applied to **NHS acute
healthcare**. It is a reference vertical, not part of the platform contract.

Nothing here is required to run or build on Open Foundry. The platform is
domain-neutral: healthcare behaviour arrives through the `nhs-acute` domain pack
and is opt-in at every level —

- **The FHIR and FDP/CDM facades only mount when a loaded pack declares the
  capability** (`capabilities: [fhir, cdm]` in `pack.yaml`). A deployment without
  such a pack returns 404 on those routes and omits the `cdm*` GraphQL fields.
- **Governance roles default to generic** (`admin`), not clinical roles.
- **The consent purpose vocabulary is deployment policy** (`CONSENT_PURPOSES`);
  the NHS preset is a default, not a requirement.
- **The direct-care consent exemption is off by default**.

## Documents

| Document | What it covers | Status |
|----------|----------------|--------|
| [`fdp-plan.md`](fdp-plan.md) | NHS Federated Data Platform integration plan, conformance boundary, and stage roadmap. | Current as of v0.2.0 |
| [`cdm-mapping-profile.md`](cdm-mapping-profile.md) | FDP/CDM compatibility profile (S1.0) and the published gap register. | Current as of v0.2.0 |
| [`mvp-nhs-pilot.md`](mvp-nhs-pilot.md) | Original NHS pilot design document. | **Historical.** Predates capability gating, the open consent vocabulary, and the v0.2.0 CDM work — read it as design background, not as a description of current behaviour. |

## Building a different vertical

If you are modelling a non-healthcare domain, ignore this directory entirely and
start from
[`../external-domain-packs.md`](../external-domain-packs.md). The `nhs-acute`
pack under [`../../domain-packs/nhs-acute/`](../../domain-packs/nhs-acute/) is
useful as a worked example — it exercises most platform features — alongside the
smaller `aml` and `supply-chain` packs.
