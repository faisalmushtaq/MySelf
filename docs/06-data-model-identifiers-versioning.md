# MySelf — Data Model, Identifier System, Versioning Rules

## 1. Identifier system

**Principle: every entity carries (a) an immutable machine ID and (b) a stable human-readable key; releases and manifests additionally carry a content hash.**

- **Machine IDs: ULIDs** (`01J…`), generated wherever the row is born — including offline on devices. Why ULID over UUIDv4: lexicographically time-sortable (natural event ordering), collision-safe without coordination (offline-first requirement), compact. Why not serial integers: unusable offline, leak volume.
- **Human keys:** lowercase snake/kebab slugs, permanent once assigned (`sdq25_s`, `ybm_gaming`, `np.future_self`). Renames create aliases, never mutate keys.
- **Content hashes:** SHA-256 over the canonicalised (JCS) release manifest and over each definition artefact; the release hash is the citation-grade fingerprint that appears in every export row group and codebook.

Concrete examples (from this survey):

| Entity | Human key | Example full reference |
|---|---|---|
| Study programme / study | `ybm` / `ybm-nd2026` | — |
| Instrument / version / form | `sdq25_s` | `sdq25_s@1.0/en-GB/self` and the as-administered variant `sdq25_s@1.0-ybm-asadmin/en-GB/self` |
| Item / item revision | `sdq25_s.q13` | `sdq25_s.q13#r1` |
| Response scale / version | `scale.sdq_3pt` | `scale.sdq_3pt@1.0` |
| Scoring definition | `score.sdq25_s` | `score.sdq25_s@1.0` (inputs pinned to item versions) |
| Assessment (draft) / release | `ybm-nd2026-standard` | Release: `ybm-nd2026-standard r1.0.0`, hash `sha256:…`, short URL slug `/a/ybm26r1` |
| Narrative protocol / prompt version | `np.future_self` | `np.future_self@1.0`, prompt `pt.future_self.reflect@1.0` |
| Model config | `mc.anthropic.sonnet5.t07` | frozen inside the release |
| Session / event | ULIDs | `ses_01J…`, `evt_01J…` |
| Participant (research side) | team-issued code | `NDC042` (never a name-derived code) |

## 2. Variable-naming convention (exports)

`{instrument}_{item}` in lowercase snake_case, stable across presentation order, sections and waves:

- Items: `sdq25_q13`, `rcads25_q18`, `ehi_sf_writing`, `swemwbs_q4`, `bisbas12_bis1`
- Bespoke module items: `{module-short}_{concept}`: `sm_account_privacy`, `sm_time_school_day`, `gaming_hours_week`, `sleep_importance`, `future_self_message`
- Multi-select: one column per option `sm_functions__news` (double underscore = option axis), plus a packed list column in long format
- Derived/scores: `score_` prefix: `score_sdq25_total`, `score_sdq25_emotional`, `score_swemwbs_metric` — never overwrite raw
- Paradata: `meta_` prefix: `meta_session_id`, `meta_release_hash`, `meta_item_rt_ms`
- Wave in wide exports as a suffix `sdq25_q13_w1` (long format carries `wave` as a column — the canonical form)
- Legacy Qualtrics view: original names (`Acount_privacy`, `SM_weekend/holiday`, …) emitted verbatim from the crosswalk, with unsafe characters only in that view's header row (CSV-quoted); canonical never inherits them.

Checked against: R (`make.names`-safe, no leading digits), Python/pandas (identifier-safe), Stata (≤32 chars — enforced by a linter in the publish gate), SPSS (no spaces/slashes), tidy principles (long format canonical; wide is a derived convenience). Item version is **not** in the variable name (names must survive versions); the codebook + long format carry `item_version` explicitly.

## 3. Versioning model and adapted semver

Distinct versioned things (per the brief): instrument concept → instrument version → language form → reading-level/age form → item → item revision → response scale → scoring definition → draft assessment → published release → narrative protocol → prompt template version → model config → session → software release.

**Adapted semantic versioning for instruments/forms/items (`MAJOR.MINOR.PATCH`):**
- **MAJOR** — anything that can change what a participant reads, selects, or how a response is coded/scored: item wording, response options/labels/order, item set, scoring algorithm, recall window. *Psychometric rule: if two versions' data cannot be pooled without a comparability argument, it's MAJOR.*
- **MINOR** — additions that leave existing data meaning intact: new language form, new reading-level form, new subscale definition computed from existing items, new metadata (citations, time estimates), new missing-data rule *option*.
- **PATCH** — corrections invisible to both participants and analysts: researcher notes, typo in an internal description, licence-status update.
- **Hard rule:** participant-visible wording is never PATCH — even a one-character typo fix is MAJOR on the form it touches (this is exactly the SDQ "Clearly/Certainly true" lesson). Conventional software instinct ("typo = patch") is explicitly rejected for psychometric artefacts.
- Releases: `rMAJOR.MINOR.PATCH` where MAJOR = any change to what any participant could experience or how data are coded; MINOR = additions that don't touch existing paths (e.g. adding an optional language); PATCH = metadata-only (release notes). In practice most republishes are MAJOR.

Draft assessments are mutable with a full audit trail (who/what/when/diff); publishing freezes a release; **nothing about a release is ever edited** — corrections mean a new release, and the old one remains inspectable and replayable forever.

## 4. Core data model (server; local mirrors a subset)

```
identity schema (separate DB role; app research role has NO access)
  participants_pii(pii_id, names?, dob?, contact?, created…)         # only if study requires
  linkage(pii_id, participant_code, study_id, created_by, …)         # narrow, audited service

research schema
  studies(study_id, key, title, programme, ethics_ref, status, …)
  waves(wave_id, study_id, key, label, window)
  instruments(instrument_id, key, name, construct, citation, licence_status,
              modifiable, owner, approval_status, …)
  instrument_versions(iv_id, instrument_id, semver, changelog, approved_by, …)
  forms(form_id, iv_id, language, reading_level, informant, label)   # e.g. -ybm-asadmin
  items(item_id, instrument_id, key, …)
  item_revisions(ir_id, item_id, rev, stem, media_ref, scale_ver_id,
                 a11y_text, presentation_hints, …)
  response_scales(scale_id, key) / scale_versions(sv_id, options[{code,label,order}],
                 direction, …)
  scoring_definitions(sd_id, key, semver, definition_jsonb, input_pins, …)
  modules(...same shape as instruments, owner=study)                  # bespoke question sets
  narrative_protocols(np_id, key) / protocol_versions(pv_id, semver, config_jsonb,
                 prompt_version_ids, model_config_id, safety_config, fallback, approval…)
  prompt_templates(pt_id, key) / prompt_versions(pv, semver, template, variables[], …)
  model_configs(mc_id, provider, model_id, params_jsonb, schema_ver, retention_flags, …)
  assessments(assessment_id, study_id, key, draft_jsonb, edited_by/at… audit)
  releases(release_id, assessment_id, semver, manifest_jsonb, manifest_sha256,
           engine_version, published_by/at, url_slug)                # immutable rows
  devices(device_id, kind{managed|participant}, enrolment_cert, escrowed_dek, status, …)
  sessions(session_id ULID, release_id, participant_code, wave_id, device_id,
           state, started/completed/synced_at, checksum, quarantine_reason?, …)
  events(event_id ULID, session_id, seq, type, item_ref{item_id, ir_rev},
         payload_jsonb, t_wall, t_mono, sync_batch_id)               # append-only
  narrative_records(nr_id, session_id, protocol_pv_id, stage, content, source
         {participant|model|researcher|system|reviewer}, parent_nr_id, ts…) # append-only
  model_calls(call_id, nr_id, study_id, release_id, pv_id, prompt_version, resolved_prompt_ref,
         system_instructions_ref, provider, requested_model, provider_reported_model,
         params{temp, max_tokens, seed?, …}, schema_version, safety_config,
         req_ts, resp_ts, latency_ms, retry_n, provider_request_id,
         raw_response_ref, parsed_response_ref, validation_outcome, fallback_used,
         app_version, server_version)
  safeguarding_flags(flag_id, session_id, rule_id, kind{auto|manual}, status
         {open|reviewed|escalated|closed}, reviewer, notes, …)        # permission-gated
  sync_batches(batch_id, device_id, receipt, ack_hash, state, …)
  exports(export_id, release_ids, format, requested_by, includes_pii bool,
          manifest_sha256, created_at)                                # export audit
  audit_log(append-only)
```

**Paradata captured per event/session** (from the brief's list): study/assessment/release/participant/session/wave IDs, instrument+version, item+revision, presentation order as experienced, randomisation condition, response value + label, per-item response time (monotonic), skips/declines/not-presented/not-reached, back-navigation and changed-answer chains, device class + viewport bucket (coarse, privacy-preserving — no fingerprinting), offline/sync status, language, accessibility settings in effect, app version.

**Response-status taxonomy (exclusive, explicit):**
`answered · skipped · declined · not_presented_branching · not_reached_ended · invalid · lost_technical · pending_sync`
Long exports carry `status` beside `value`; wide exports emit NA plus a companion status column set (and optional SPSS-style numeric sentinels, off by default).

## 5. Export bundle

Every export is a zip: data (CSV/Parquet, long + wide + optional legacy view) + `codebook.html/csv` + `data_dictionary.json` + instrument/item metadata + scoring definitions and generated R/Python scoring syntax + `release-manifest.json` (+hash) + `migration-crosswalk.json` (where legacy view included) + audit slip (who exported, when, filters, PII flag) + LLM provenance file (model_calls subset) where narrative data included. Sufficient to reconstruct exactly what each participant saw and how every value was coded — depositable in a repository alongside the data.
