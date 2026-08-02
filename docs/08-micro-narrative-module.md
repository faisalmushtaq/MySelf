# Micro-Narrative Module — Design

> **⚠️ Pending source audit.** The Dropbox codebase is unreachable from this environment (network policy blocks dropbox.com). The required audit of the existing implementation — user journey, architecture, prompt construction, provider use, storage, exports, safety controls, tests, retain/refactor recommendation — **cannot be produced until the code is supplied as a ZIP or committed to this repository.** Nothing below invents its contents; this document specifies the target module from the brief, with explicit integration points where the existing code will be evaluated for retention. Sections marked `[AWAITING CODEBASE]` will be completed after inspection.

## 1. Position in the platform

Micro-narratives are a **core research module**, not a conversational bolt-on. A narrative protocol is a first-class library object, selectable in the composer like any instrument, placeable before/between/after questionnaire modules, multiple instances allowed per assessment. Publishing freezes protocol version + prompt versions + model config + output schema + safety config + fallback behaviour into the release manifest.

## 2. Protocol object (versioned; abridged field list per the brief)

Identity & governance: key (`np.future_self`), name, construct/research question, intended use, owner, approval status, version history, consent + data-governance requirements.
Participant experience: age range, language, reading level, introduction, elicitation prompt, optional example/practice, min/max length, permitted modes (text now; audio later), required/optional follow-ups, explicit-response branching, researcher-authored transitions, confirmation/correction steps, debrief text, estimated time.
Model stage: system instructions, prompt template + permitted variables, provider, model ID + version requirements, sampling params, structured-output schema, validation rules, safety/moderation config, exclusion/flagging rules.
Operational: connectivity declaration, offline fallback (one of `queue_authorised` / `continue_without_model` / `predefined_fallback` / `pause_module`), retry policy.

## 3. Staged records (never a single conversation blob)

Each stage is an append-only `narrative_records` row with `source ∈ {researcher, participant, system, model, reviewer, analysis}`:

1. `request_shown` (system) → 2. `participant_original` → 3. `validation_result` (deterministic) → 4. `clarification_request` (system) → 5. `participant_clarification` → 6. `prompt_resolved` (exact text sent, content-addressed) → 7. `model_raw` → 8. `model_validated` (schema-checked) → 9. `model_shown` (participant-visible rendering) → 10. `participant_reaction` → 11. `participant_rating` → 12. `participant_correction` → 13. `derived_measure` (analysis, versioned).

Invariants enforced at the storage layer: `participant_original` is immutable and never superseded by model output; participant-confirmed interpretations are distinct records linked to what was confirmed; reprocessing appends, never overwrites; every record carries timestamps and ordering.

## 4. Prohibited model behaviours (enforced, not aspirational)

No fabricated participant responses (model output can never populate a response variable); no inferred answers for unanswered items (structurally impossible — model stages write only `narrative_records`); no diagnosis/therapy (system-instruction template + output-schema constraints + moderation config); no leading narratives (protocol review checklist + prompt approval workflow); no altering validated items (model layer has no write path to definitions); model text always rendered in the labelled "automatic" style; ambiguous narratives coded with uncertainty fields required in the output schema; no consequential decisions without human process (flags route to review queues only).

## 5. The MVP protocol: `np.future_self@1.0`

Derived from the YBM `Future Self` item ("Imagine yourself 10 years from now… one sentence for that future version of yourself"). MVP configuration (researcher-editable without code):
- Elicitation as administered (preserved verbatim for comparability) + optional model stage: one schema-constrained reflective follow-up question generated from the participant's sentence, plus a participant confirm/correct step on a model summary of their message's theme.
- Offline fallback: `continue_without_model` (participant text saved; follow-up skipped) — with `queue_authorised` selectable per study, executing post-sync only when the frozen consent config permits.
- Safety: moderation pass on participant text for researcher-defined flag rules (distress/self-harm lexicon + model-based classifier where online), producing auditable `safeguarding_flags` — explicitly **not** real-time monitoring, and participant-facing wording must say so.

## 6. Safeguarding configuration (per protocol, ethics-approved)

Distinct, configurable tiers: automated detection → data-quality flag → research-team notification → safeguarding review → emergency procedure (out-of-band, human). Each rule declares its tier, reviewers, notification route and participant-facing disclosure text. False-positive/negative rates surfaced per rule once data accumulate. Flags are auditable, permission-gated, and never silently become clinical judgements. Provider settings recorded: data retention, training-use flags, regional processing. No direct identifiers in any prompt (structural guarantee via identity separation).

## 7. Testing

DeterministicMock provider (seeded, schema-aware, fault-injectable) + the full test matrix from the brief: template resolution, missing variables, output validation, unsafe/malformed outputs, timeouts, rate limits, duplicate requests, interrupted connectivity, retry/idempotency, correction flows, prompt/model version recording, queued offline processing, withdrawal/deletion, safeguarding flags, provider substitution, reprocess-without-overwrite, and failure-without-loss-of-original.

## 8. `[AWAITING CODEBASE]` — existing implementation audit

To be completed on receipt: current journey; frontend/backend architecture; prompt construction; provider/API use; data captured; generation/transformation/summarisation behaviour; follow-ups; state; storage; exports; error handling; safety controls; tests; deployment assumptions; retain vs refactor recommendation; technical debt; embedded scientific assumptions. Working, scientifically-load-bearing behaviour will be preserved unless a documented reason exists; no rewrite-for-fashion.
