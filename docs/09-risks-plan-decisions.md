# MySelf — Risks, Staged Plan, Prototype, Decisions Required

## 1. Principal risks and mitigations

| Domain | Risk | Mitigation |
|---|---|---|
| Platform | iPadOS evicts PWA storage / quota surprises | Home-Screen install mandatory; `persist()`; lean bundles; sync ritual + unsynced banners; encrypted backup export; Capacitor wrapper as pre-abstracted fallback; **physical-iPad pilot before any real collection** |
| Platform | No background sync on iOS | Foreground sync on launch/connectivity/manual; researcher end-of-day procedure; never claim background behaviour |
| Data integrity | Loss between collection and sync | Append-only events, transactional writes, checksums, server-ack-before-purge, quarantine instead of merge/discard, backup export |
| Psychometric | Deviations already present in YBM (SDQ anchors/wording mix, KSS typo, EHI anchors, 0–10 ladders) contaminating future waves | As-administered forms preserved as explicit versions; canonical forms only adopted by researcher decision; MAJOR-version rule for any participant-visible change |
| Psychometric | Presentation change (matrix → stepped) altering measurement properties | Per-form fidelity flag forces grid where required; A/B comparability check in an early wave recommended before committing |
| Licensing | SDQ electronic administration unauthorised (**verified risk — youthinmind requires authorisation/fees**); SWEMWBS unregistered; STAI-5 status unclear; doomscrolling items unattributed; hair-chart image rights | Licence-status gate blocks publishing; contact youthinmind + Warwick registration + Mind Garden query before the YBM release is frozen |
| Ethics/safeguarding | Narrative disclosures (and RCADS item 18) without a defined route; risk of implying real-time monitoring | Tiered safeguarding config per protocol, ethics-approved wording, review-queue SLAs, explicit non-real-time disclosure to participants |
| Privacy | Identifiers beside responses (status quo) | Identity/research schema separation, team-issued codes, DoB removal (decision pending), PII-free exports by default, audited linkage service |
| LLM | Provider drift/retention/regional processing; prompt injection via participant text | Frozen model configs with provider-reported snapshot capture; retention/training flags recorded; minimisation; prompt-injection hardening (participant text always in data role, never system); provider-independent adapter keeps exit path |
| Delivery | Scope explosion (this brief is a multi-year platform) | Strict MVP vertical slice; deferred list; regression fixture keeps the core honest while features accrete |
| Ops | University-team maintainability | Boring, well-documented stack; Docker Compose dev; no exotic infra; runbooks for device loss/study closure/archiving |

## 2. Staged implementation plan (each phase gated by acceptance criteria)

**Phase 0 — Sources & decisions (blocked on inputs)**
Receive micro-narrative ZIP + QSF + ladder/hair images; researcher decisions on A-1…A-5, A-26/A-27, licensing contacts initiated; agree MVP protocol config.
*Accept:* decisions.yaml populated; unsupported-construct report empty or dispositioned; licences requested.

**Phase 1 — Definition layer & library (≈2–3 wks of focused work)**
`packages/schema` (all JSON Schemas), `packages/engine` core (state machine, logic AST, piping, validation), library encoding of YBM (all instruments incl. as-administered forms, modules, scales, scoring definitions), release manifest + hashing, publish gate CLI.
*Accept:* YBM composition validates; manifest hash reproducible; engine replays scripted fixtures headlessly with correct branching/codes; scoring matches hand-worked examples; unit coverage on engine ≥ 90 %.

**Phase 2 — Participant PWA offline (≈3–4 wks)**
Renderer for all YBM response types; autosave events; IndexedDB encrypted store; service worker + bundle provisioning + verification; session lifecycle + handover; status indicators; accessibility baseline; multi-session per device.
*Accept:* full YBM completion in airplane mode on a physical iPad incl. force-quit/restart recovery; axe-core clean; every brief §"Testing" offline case demonstrated on-device or explicitly documented as manual-protocol item.

**Phase 3 — Sync, Studio minimal, publish flow (≈2–3 wks)**
API + Postgres schemas; device enrolment; idempotent batch sync + acks + quarantine; Studio: library browser, composer, validation UI, publish + URL/QR, device provisioning, session monitor; auth + roles; audit log.
*Accept:* interrupted-sync/resume and duplicate-upload tests pass; two-device same-session quarantine works; publish produces immutable release reproducible from manifest; roles enforced in tests.

**Phase 4 — Exports & migration deliverables (≈1–2 wks)**
Long/wide/legacy exporters, codebook/dictionary generators, crosswalk, scoring syntax emitters, export audit; regression fixture finalised in CI.
*Accept:* fixture exports byte-stable; legacy round-trip identity test passes; export bundle reconstructs "what each participant saw" in a documented walkthrough.

**Phase 5 — Micro-narrative module (≈2–3 wks, after codebase audit)**
Protocol/prompt/model-config objects + composer integration; staged records; server LLM gateway + adapters + mock; queued offline generation; confirm/correct UI; safeguarding flags; full narrative test matrix.
*Accept:* `np.future_self@1.0` runs end-to-end online, offline-queued, and model-down; provenance rows complete per brief field list; original narrative provably immutable under reprocessing; researcher edits protocol config without code change → new version → new release required.

**Phase 6 — Hardening & iPad acceptance (≈1–2 wks)**
Physical-device protocol (install online → airplane-mode relaunch → full offline survey → force-quit recovery → device restart → consecutive participants → reconnect sync → interrupted sync → duplicate prevention → low storage → offline config-update attempt → version change between sessions → narrative queue resume → handover → backup export/restore), performance passes, dashboard flags v1, docs.
*Accept:* signed-off manual protocol on ≥2 physical iPads (one older model); all automated suites green; pilot-readiness review.

## 3. Smallest useful prototype (recommendation)

One iPad, one researcher, one afternoon: publish `ybm-nd2026-standard r1.0.0-rc` (with `np.future_self` in `continue_without_model` mode) → provision iPad in Studio device mode → airplane mode → three consecutive synthetic participants complete the full survey incl. narrative capture → reconnect → sync → export bundle → verify crosswalk + codebook + manifest + narrative provenance. This exercises every architectural risk (offline storage, handover, idempotent sync, immutable release, exports, narrative fallback) with the real survey — not a demo questionnaire.

## 4. Decisions that genuinely require your input before coding

> **✅ RESOLVED 2026-08-02.** All decisions were answered by the principal researcher and are recorded with dispositions in [`migration/decisions.yaml`](../migration/decisions.yaml) (D-01…D-15). Headlines: all five confirmed content/logic errors fixed in r1; RCADS/SDQ become soft-required honouring "you can skip it"; consent stays forced (off-platform decline handling); **canonical validated forms adopted in r1** (documented break; SDQ still licence-gated); identifier collection unchanged in-flow but stored via the separated identity schema; cloud hosting; **non-MDM team-controlled iPads** (app-layer encryption promoted to primary control); OpenAI adapter first behind the provider-independent gateway; **the full micro-narrative protocol is the MVP's narrative module** (no separate future_self protocol). Outstanding inputs (non-blocking for Phase 1): safeguarding protocol document, cloud account/IdP details, licence outcomes.
>
> The original question list is preserved below for provenance.

1. **Anomaly decisions:** A-1 (Abstaining_SM wording), A-2 (Twitch condition — confirmed live error), A-3 (inverted gaming logic — confirmed live error), A-5 (consent decline path), A-34 (bespoke typo fixes), **A-43** (age dropdowns missing "5"), **A-44** (RCADS/SDQ forced-response contradicts "you can skip it" — recommended: soft-required + explicit decline in r1, documented as an approved departure) — fix-in-r1 vs preserve, each recorded in `migration/decisions.yaml`.
2. **Identifier redesign approval** (A-26/A-27): drop names/DoB from the participant flow in favour of team-issued codes + identity-service capture? (Recommended.)
3. **Licensing:** confirm/initiate youthinmind authorisation (SDQ — blocking), Warwick SWEMWBS registration, STAI-5 position, doomscrolling-items source, hair-type chart image rights; **plus** contact the micro-narratives authors (petr.slovak@kcl.ac.uk) to confirm the reimplementation-with-citation plan for the narrative module (academic/non-commercial licence with community commitments — see docs/08 §8). Who owns these conversations?
4. **Comparability stance for r1:** administer the as-administered forms verbatim (typos included) for continuity with the current wave, or adopt corrected canonical forms now and accept a documented break? (Recommended: verbatim `-ybm-asadmin` forms in r1 alongside canonical forms in the library, switch by explicit decision at the next natural wave boundary.)
5. **Deployment target & IdP:** university VM vs cloud; which OIDC provider (Leeds Azure Entra?); NHS-adjacent requirements now or later?
6. **Safeguarding routes:** named reviewers, review cadence, escalation wording for RCADS-18 and narrative flags (needs ethics alignment; PSCETHS-1449 scope check).
7. **Managed-iPad posture:** are collection iPads MDM-managed with passcodes (assumed yes — required for the at-rest security story)?
8. **LLM provider + data-processing terms** for the first narrative study (provider, region, retention, training-use opt-out) consistent with consent and ethics. Note: the existing app is OpenAI-only; MySelf's gateway is provider-independent, so this is a study-level choice, not an architectural one.
9. **Second seed protocol scope:** should the MVP include the full `np.micro_narrative` protocol (collect→extract→three personas→select→rate→adapt, ported from the CHI 2025 app) alongside `np.future_self`, or is `np.future_self` alone sufficient for the vertical slice? (Recommended: specify both, implement `np.future_self` first, port the full protocol in Phase 5 as its acceptance test.)
