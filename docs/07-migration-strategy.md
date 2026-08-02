# Qualtrics → MySelf Migration & Compatibility Strategy

## 1. Pipeline

1. **Ingest** — parse the QSF (requested) as the machine source of truth; the Word export remains the human-readable cross-check. Where only the Word export exists, fields reconstructed from it are tagged `provenance: word-export` and anything ambiguous is `UNRESOLVED`, never guessed.
2. **Inventory** — automated extraction to a structured intermediate (`docs/01`), including every Qualtrics QID, export tag, choice recode, logic expression, pipe, validation flag.
3. **Audit** — anomaly detection + classification (`docs/02`); researcher decisions captured in a decisions file (`migration/decisions.yaml`) with who/when/rationale — this file is part of the release provenance.
4. **Map** — build library records: recognised scales → instrument versions (canonical *and* `-ybm-asadmin` forms where the administered form deviates); bespoke items → named modules; every mapping row carries a **disposition**:
   - `EXACT` — exact reproduction (validated wording, options, codes)
   - `PRESENT` — presentation-only modernisation (dropdown → wheel picker; matrix → stepped items; same wording, options, codes)
   - `SAFE-FIX` — C1 corrections (instruction typos, variable renames with aliases)
   - `APPROVED-FIX` — researcher-approved substantive corrections (A-1, A-2, A-3…), each linked to its decision record
   - `DEPART` — intentional departures (e.g. new consent decline path, identifier redesign)
   - `UNRESOLVED` — blocked pending QSF/assets/decisions; publish gate refuses releases containing these
5. **Compose & publish** — assemble `ybm-nd2026-standard`, validate, publish `r1.0.0`.
6. **Verify** — regression fixture: synthetic participants with known answer sets replayed through the engine; assert block structure, presented-item sets under each branch condition, response codes, scoring outputs, and export bytes are stable. The Qualtrics-legacy export of the fixture is diffed against a hand-built expected file.

## 2. Variable and code crosswalk

`migration-crosswalk.json` (shipped with every legacy export) maps, per variable:
`qualtrics_tag` (verbatim, incl. unsafe characters) · `qualtrics_qid` · `canonical_variable` · `disposition` · per-choice `code_map` (original ↔ canonical, e.g. SDQ 1/2/3 ↔ canonical 0/1/2; `SM_active_passive` 1/4/5 ↔ 1/2/3) · direction metadata · notes.

Rules:
- **No silent recoding.** Canonical exports use canonical codes; the legacy view re-emits original codes through the crosswalk; both are tested round-trip (`legacy → canonical → legacy` is the identity on the fixture).
- Where legacy codes are unknown (elided dropdowns, A-39) the crosswalk row stays `UNRESOLVED` and the legacy view refuses to emit that column rather than fabricate codes.
- Scoring always consumes canonical codes; scoring definitions document the transform from administered codes (e.g. `rcads25` administered 1–4 → canonical 0–3 → published norms).
- Legacy names that are ambiguous (duplicate `Introduction`) are exported with disambiguating suffixes in the legacy view **and flagged**, since exact reproduction is impossible without ambiguity.

## 3. Presentation modernisation defaults (all `PRESENT`, reversible per component)

| Qualtrics construct | MySelf default rendering |
|---|---|
| Matrix (validated scale) | Stepped single items with pinned scale header; instructions shown verbatim on an intro card. Simultaneous grid available where administration fidelity requires it (flag on the form record). |
| Dropdown | Native-feeling wheel/list picker with search where >10 options |
| Drag/group/rank | Touch drag with two-step fallback on small screens |
| Slider (SES ladders) | Ladder-styled discrete selector with the original image, tap-a-rung + keyboard support |
| Form fields | One field per screen unless grouped by the source instrument |
| Forced response | Explicit "required" with respectful decline option only where the protocol permits |

## 4. Unsupported/at-risk Qualtrics constructs

Custom JavaScript, loop & merge, quotas, timing questions, authenticator blocks and embedded-data-driven logic are **not silently absorbed**: the importer emits an "unsupported construct" report per survey; each entry must be resolved (re-modelled in MySelf logic, dropped by decision, or blocked). This survey shows none of these in the Word export, but confirmation requires the QSF (A-41).

## 5. Safer identifier & linkage design (replaces uncritical reproduction)

Current process collects `first_name`, `last_name`, `DoB`, self-constructed `ps_id` (quasi-identifiers) and team-issued `val_id` — all beside mental-health responses.

**Proposed design (decision A-26/A-27):**
1. **Primary key: team-issued participant code** (`val_id` pattern, e.g. `NDC042`), issued from a register held by the research team in the `identity` schema (or on paper in school settings). The participant app collects **only this code**.
2. Names/DoB, where genuinely needed (e.g. safeguarding duty, longitudinal re-contact), are captured **once, in the identity service** (researcher-mediated, not inside the questionnaire), never stored on collection devices, never in the research schema, never in default exports. Age band or school year replaces DoB in research data; if analysis needs finer age, compute age-at-session in the identity service and pass only the derived value across.
3. **Legacy compatibility:** for matching with existing Qualtrics waves, the `ps_id` construction rule is retained as a *derivation*: components are entered into a transient form, the code is derived client-side, only a salted hash + the derived code cross the wire to the linkage service, raw components are discarded. Historical `ps_id` values from Qualtrics data are matched via the same derived code inside the identity service.
4. Consent-withdrawal and deletion operate through the linkage table, so response data remain pseudonymous end-to-end.

This preserves longitudinal matching and backwards compatibility while removing names/DoB/quasi-identifier storage from the response pathway. Requires researcher + ethics sign-off.

## 6. Regression fixture (permanent)

`fixtures/ybm-nd2026/` contains: the frozen release manifest; synthetic participant scripts covering every branch combination (smartphone yes/no × social media yes/no × gamer/non-gamer × consent paths, skip/decline patterns, offline interruption points); expected canonical long export; expected legacy export; expected scoring outputs (hand-verified against published scoring rules once licences confirm wording). CI replays the scripts through `packages/engine` on every commit; any diff fails the build. This fixture also drives the offline/sync fault-injection suite.
