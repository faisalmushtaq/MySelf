# MySelf — Design Package (v0.1, pre-implementation)

Produced 2026-08-02 from the Qualtrics Word export, then updated the same day after receipt of the **QSF export** and the **micro-narrative codebase** (KCL Micro-narratives app, CHI 2025). All three source artefacts are audited; copies live in `source-materials/`.
**Status: source audits complete — awaiting researcher feedback and the Phase 0 decisions (docs/09 §4) before implementation begins.**

Implementation has since landed; for the code as it stands, start with the [maintainer's guide](16-maintainers-guide.md).

| Doc | Contents (maps to brief items) |
|---|---|
| [01-qualtrics-inventory.md](01-qualtrics-inventory.md) | Structured survey inventory: flow, blocks, questions, variables, codes, logic, piping, media, sensitive fields (brief item 1) |
| [02-anomaly-report.md](02-anomaly-report.md) | 42 classified anomalies C1–C4 + reconstruction gaps (item 3) |
| [03-instrument-library.md](03-instrument-library.md) | Initial library: validated instruments (with licensing verification), bespoke modules (items 4, part of 1) |
| [04-vision-journeys-requirements.md](04-vision-journeys-requirements.md) | Vision, journeys, prioritised MVP/next/later requirements, information architecture, screen designs (items 5–8, 13) |
| [05-architecture.md](05-architecture.md) | Stack, definition layer, offline-first iPad architecture, session state machine, sync protocol, encryption/keys, LLM gateway, security/governance, testing (items 9, 15-partial; offline-annex items 1–10) |
| [06-data-model-identifiers-versioning.md](06-data-model-identifiers-versioning.md) | Data model, identifier system, variable naming, adapted semver, paradata, missingness taxonomy, export bundle (items 10–11) |
| [07-migration-strategy.md](07-migration-strategy.md) | Qualtrics→MySelf pipeline, dispositions, crosswalk, safer identifier/linkage design, regression fixture (item 12) |
| [08-micro-narrative-module.md](08-micro-narrative-module.md) | Narrative module design + **full audit of the KCL Micro-narratives codebase** with retain/refactor recommendation (items 2, 14) |
| [09-risks-plan-decisions.md](09-risks-plan-decisions.md) | Risks & mitigations, staged plan with acceptance criteria, smallest useful prototype, decisions required (items 15–18) |
| [10-qsf-findings.md](10-qsf-findings.md) | QSF machine-level resolution: flow nesting, all dropdown code maps, validation settings, custom JS, image assets, Trash block, new anomalies A-43/A-44 |
| [11-style-guide.md](11-style-guide.md) | Visual and interaction style guide, binding for every MySelf surface (D-17) |
| [12-server-deployment.md](12-server-deployment.md) | Standing up the self-hosted server (Postgres and `apps/api`) — superseded by Firebase, still in the repository (D-36) |
| [13-firebase.md](13-firebase.md) | MySelf on Firebase: the two projects, rules, functions, setting up and deploying (D-39) |
| [14-readiness-audit.md](14-readiness-audit.md) | Research-readiness audit of 2026-09-26, and what changed after it (§8 onwards) |
| [15-fielding-runbook.md](15-fielding-runbook.md) | Fielding a survey on several iPads: the morning, handover, getting the data out |
| [16-maintainers-guide.md](16-maintainers-guide.md) | For whoever maintains the code: what is where, how a question becomes data, changing questions, scales and the schema, cutting a release, tests, deploying |
