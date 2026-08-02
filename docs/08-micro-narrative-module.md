# Micro-Narrative Module ("MyStory") — Design

> Naming (decision D-16): micro-narrative protocols are presented to participants as **MyStory**, visually and verbally separated from the **MyThoughts** questionnaire experience. The separation is not cosmetic — it reinforces the platform rule that model-mediated interaction remains distinguishable from the canonical survey engine.

> **Source audit complete (2026-08-02).** The codebase (`Code_010726.zip`) was received and audited in full — see §8. It is the KCL **Micro-narratives** application (Skeggs et al., CHI 2025), distributed under an academic non-commercial licence with citation requirements. The audit confirmed the design below and sharpened it in several places (staged records map cleanly onto the app's existing conversational stages; its quality-control tracing and persona-based generation are scientifically load-bearing and are carried forward as first-class protocol features).

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

## 8. Existing implementation audit (KCL Micro-narratives app)

**Provenance.** The supplied code is the *micro-narratives* application from the KCL/Stanford/Cambridge collaboration — Skeggs, Mehta, Yap, Ibrahim, Rhodes, Gross, Munson, Klasnja, Orben & Slovak, *Micro-narratives: A Scalable Method for Eliciting Stories of People's Lived Experience*, CHI 2025, https://doi.org/10.1145/3706598.3713999. Licence: **academic/non-commercial only**, citation required in publications, derivative works must remain non-commercial, safety improvements to be contributed back; commercial/extended-use permissions via petr.slovak@kcl.ac.uk. **Governance action:** cite the paper in MySelf outputs; because MySelf *generalises* the method rather than embedding this code (see recommendation below), contact the authors to confirm they are happy with a reimplementation that credits the method — good practice even where the licence text would not strictly require it for a clean-room reimplementation.

### 8.1 What it is and how it works

- **Stack:** Python 3.12 · Streamlit single-page app · LangChain + `langchain-openai` (OpenAI only, default `gpt-4o`) · optional LangSmith tracing (off by default) · optional AWS DynamoDB persistence (boto3) · deployed via Streamlit Community Cloud or AWS Elastic Beanstalk. No frontend/backend separation: the LLM is called synchronously from the UI process, and the OpenAI key lives with the app runtime.
- **Configuration:** one TOML file per study — consent text, participant-ID policy, a *collector persona*, guided-interview `questions[]`, `language_type`, `topic_restriction`, extraction `summaries.questions` (key→question map), exactly three *summariser personas*, a one-shot example (conversation + scenario), model name, `quality_control_flagging` flag. Four example configs show real research uses: difficult social-media experiences, a follow-up protocol that pipes in the participant's **previous final scenario** from DynamoDB, an alexithymia/emotion-exploration variant, and a parent–child connection variant.
- **User journey (state machine in `app.py: stateAgent`):** `consent → identify (participant ID via form or ?pid= URL) → collect (LLM-guided Q&A chat until the model emits "FINISHED") → [quality gate] → scenario generation (extraction chain summarises answers to JSON keys; then three persona-voiced "scenario" candidates generated in parallel) → review (pick one of three) → rate (0–10 slider) → adapt (if <10: direct text editing and/or AI-assisted adaptation chat with accept/reject/reset) → save (DynamoDB put) → completion page`.
- **Prompt construction:** four templates assembled in `llm_config.py` — (1) interviewer prompt (persona + numbered questions + language style + topic restriction + "FINISHED" sentinel + raw history string); (2) extraction prompt ("expert extraction algorithm… use only words the text contains… null if unknown" → JSON with configured keys); (3) scenario prompt (persona + one-shot + Q&A slots → JSON `output_scenario`); (4) adaptation prompt (scenario + user request → JSON `new_scenario`). Temperatures: 0.3 chat, 0.1 extraction.
- **Data captured (single DynamoDB item per session):** session/participant IDs, completion time (wall clock string), completion status, chosen scenario + 0–10 rating, final scenario, extracted `summary_answers`, all three scenarios with any feedback, full chat history (two formats), quality-control traces and aggregates, flagged status.
- **Quality control (`quality_control.py` + `chat_input_component.py`):** a custom chat input smuggles a typing trace (timestamped length samples encoded in zero-width characters) plus paste detection; per-message metrics (median instant typing speed >15 chars/s, paste, length>250/multiline) are aggregated; if >30 % of messages trip any signal the session stops before generation and saves a partial record. This is a genuinely novel anti-bot/data-quality mechanism aimed at crowdsourced adult samples.
- **Safety controls:** `check.py:review_for_safety` is a **stub that always returns True**, with a placeholder holding page. Topic restriction is prompt-level only. No moderation API, no safeguarding routing, no minor-specific handling.
- **Error handling:** scenario-generation failures degrade to an apology string *stored in place of the scenario*; adaptation failures return an apology string into the chat; DynamoDB write failures are logged and **the data are lost** (no retry, no local persistence); a browser refresh loses Streamlit session state mid-interaction.
- **Tests: none.** No test directory, no CI. **Offline: none** — every step after consent requires live OpenAI access, and persistence requires live AWS access.

### 8.2 Scientific assumptions embedded in the code (to preserve deliberately)

1. **Guided elicitation, not free composition** — a fixed researcher-authored question list administered conversationally, one at a time, with topic restriction; the participant's words are the substrate.
2. **Extraction fidelity** — the summariser is instructed to reuse only the participant's own words; unanswered aspects stay null rather than being invented.
3. **Persona-mediated retelling with participant choice** — three voiced candidate narratives; the *participant* selects, rates and can correct; a 10/10 rating short-circuits adaptation. Choice + rating + adaptation history are data, not UX sugar.
4. **Longitudinal narrative piping** — a later protocol can re-present the participant's previous final scenario.
5. **Typing-dynamics quality signals** for low-trust settings.

These map directly onto MySelf's staged-record design: collect stages 1–5, extraction = stage 6–8, personas/selection/rating/adaptation = stages 9–12, and the previous-scenario pipe becomes a governed protocol variable.

### 8.3 Technical debt and risks in the current implementation

UI/logic/LLM/storage all interleaved in Streamlit session state; no separation of definition from execution (prompts partially hard-coded in Python, e.g. the adaptation prompt, intro/outro strings, "three personas" fixed); JSON outputs parsed without schema validation (`SimpleJsonOutputParser` + ad-hoc key checks); no provenance capture (no model snapshot ID, token counts, latencies, retries, resolved prompts); raw model responses not stored, only parsed strings; participant original words recoverable only from the chat log, with the final scenario stored beside it (acceptable) but quality-failed sessions discard scenario context; DynamoDB scan-by-filter for previous scenarios (won't scale, no index); wall-clock timestamps only; secrets handled via Streamlit secrets (fine) but the client process holds the OpenAI key; the "FINISHED" sentinel can be spoofed by participant text ("FINISHED" in a user message echoed by the model ends collection) — a real prompt-injection surface; no idempotency (double-submit can double-write); English-only assumptions in template assembly.

### 8.4 Retain / refactor recommendation

**Retain (as designed behaviour, re-expressed in the MySelf protocol schema):** the five scientific assumptions above; the four-template prompt architecture (interviewer / extractor / persona-scenario / adaptation) as the default *protocol shape*; the TOML-config philosophy (already "configuration over code" — it becomes the versioned narrative-protocol object, with the fixed three-persona limit and hard-coded transitional strings promoted to configurable fields); the typing-trace quality-control design (reimplemented in the PWA input layer, feeding MySelf's data-quality flags); the example configs as seed protocols in the library.

**Do not retain (with documented reasons):** the Streamlit runtime (no offline capability, no session recovery, unsuitable for iPad-managed collection — this is the brief's core requirement, not fashion); client-side LLM calls with provider keys (moves to the server gateway); DynamoDB single-item storage (replaced by append-only staged records with provenance); unvalidated JSON parsing (replaced by schema-constrained outputs); the "FINISHED" sentinel (replaced by structured completion signalling in the model-output schema, which also closes the injection hole); the stubbed safety check (replaced by the configured safeguarding pipeline — and per the licence's community commitment, this safety design can be shared back to the micro-narratives community); the apology-string failure mode (replaced by declared fallbacks that never overwrite data slots).

**Net effect:** MySelf's `np.*` protocol family is a faithful generalisation of the CHI 2025 method — same interaction science, new engine. The YBM `np.future_self` protocol is simpler than the full method (single elicitation + optional follow-up); a full `np.micro_narrative` protocol replicating the collect→extract→personas→select→rate→adapt journey is specified as the module's second seed protocol so existing research designs port over directly.
