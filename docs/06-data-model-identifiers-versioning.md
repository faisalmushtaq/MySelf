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

## 6. Implemented data layer (`@myself/store`, researcher view) — 2026-08-03

The abstract model above is now built for the survey side. What exists:

**The record is the event log.** Each iPad writes a handover file: its
append-only log, decrypted, unedited, in the order the events happened. The
dataset — `participants`, `sessions`, `responses`, `scores` — is *derived* from
those logs by `ingest()` and is never persisted anywhere. That is what makes a
rescoring or a fix in the reader a new build rather than a migration.

| Table | Grain | Notes |
|---|---|---|
| `participants` | one person | derived code, first/last seen, sitting count, sites |
| `sessions` | one sitting | wave, site, release hash, durations, answered/skipped/too-fast/revisited counts, review edits |
| `responses` | one variable per sitting | status, value, text, label, dwell, visits, `tooFast`, `changed` |
| `scores` | one derived output per sitting | scoring key + version, valid count, warnings |

**Longitudinal linkage.** `deriveParticipantCode()` builds the code from the
four components (mother's initials, house digit, birth month, postcode
letters). A sitting whose code is incomplete is **held back**, never guessed
at, and shown as such in the researcher view: a wrong join merges two
children's data invisibly. Waves are numbered per participant in the order the
sittings actually happened, continuing across imports and across releases.

**Releases.** Sittings are grouped by release hash and read back through the
manifest they were collected under. Reading a 2026 session through a 2028
manifest is how a renamed option code becomes a silently wrong answer.

**Researcher view** (`apps/researcher`, published at `/researcher/`): summary
global measures, a wide table with one row per sitting and a filter on **every**
column (range for numbers, value list for categories, substring for text —
derived from the column's kind, so new variables are filterable without code),
a per-participant drawer showing every wave and the change between them, and
CSV of exactly what is on screen. Wave-by-wave means use the returning sample
only.

**BIDS-style export** (`buildBidsExport` + `buildZip`, no dependencies):
`dataset_description.json` carrying the release hash, `participants.tsv/json`,
`phenotype/<instrument>.tsv/json` with a `<var>_status` column beside every
variable, `phenotype/scores.tsv/json` kept out of the raw files, and
`sub-<LABEL>/sessions.tsv`. `n/a` for missing, never a blank; a sidecar for
every data file. Survey-only data is not a valid BIDS dataset on its own —
following the layout is what lets the EEG drop in beside it later.

Not yet built: sync, server storage, access control, the audit slip and the
codebook/crosswalk generators described in §5. Until those exist the researcher
view is a laptop tool holding real answers, and is treated as such.

### Scoring definitions are checked against their items (r7.2.0, D-49)

**What was wrong.** The SWEMWBS and STAI-5 scoring definitions (1.0.0) summed
items named `q1`…`q7` and `q1`…`q5`. Neither instrument has ever had items by
those names — they are keyed by meaning (`optimistic` … `mind`; `upset` …
`confused`) — and the executor reads a name it cannot find as "not answered".
So in every sitting under r1.0.0–r7.1.0 the SWEMWBS raw total and the STAI-5
state-anxiety total are blank. The answers themselves are complete and
unaffected; only these two derived totals are missing. Nothing a participant
sees depends on them (the only score shown in a sitting is the EHI handedness
summary, whose definition is correct).

**The fix.** Definitions 1.0.1 name the real items; the rule is unchanged.
They are frozen into **r7.2.0**, a MINOR on r7.1.0: nothing a participant reads
or selects and no code changes, so r7.1.0 and r7.2.0 sittings pool without a
comparability argument (§3); it is not PATCH, because analysts now see totals
where there were blanks.

**The gate.** `scoringReferenceProblems()` (`@myself/scoring`) lists every name
a definition reads that is neither a question of its instrument nor the output
of an earlier step (or is an information screen). `buildRelease()` refuses to
publish a release with any such definition, or with a definition for a
different instrument than the one it is attached to. A test asserts that every
committed release from r7.2.0 on passes, and that the earlier ones fail on
exactly these two definitions — so a new broken definition cannot slip in
behind the known ones.

**Earlier releases stay as they are.** Nothing about a release is ever edited
(§3), and a sitting is read back through the release it was collected under, so
the survey's own SWEMWBS and STAI-5 totals stay blank for sittings under
r1.0.0–r7.1.0. For analysis, scores are derived from the stored answers by the
research dashboard (MySelf-Dashboard, docs/08 there), whose versioned scoring
schemes key on the real items and are checked against every release: it is the
scoring source for all data, old and new. The survey's own `scores` table
remains what the survey computed at the time.

### The RCADS-25 key, and totals built from subscales (r7.3.0, D-50)

**RCADS-25 (S8).** The scoring definition (1.0.0) counted item 18 ("I think about
death") as depression and item 24 ("I feel restless") as anxiety. The published
RCADS-25 key is the other way round: depression is items 1, 4, 8, 10, 13, 15, 16,
19, 21 and 24 — the full RCADS's ten major-depression items (RCADS-47 items 2, 6,
11, 15, 19, 21, 25, 29, 40, 47; item 37, "I think about death", is generalised
anxiety). Definition **2.0.0** uses the published key; it is MAJOR because the
subscales do not pool across the change (the total does). It is frozen into
**r7.3.0**, a MINOR on r7.2.0 for the same reasons as D-49: nothing a participant
reads or selects changes and no code changes. Sittings under r1.0.0–r7.2.0 keep
the swapped subscales in the survey's own `scores`; the research dashboard scores
every version with the published key.

**Totals built from subscales (S7).** Ingest handed the executor a blank for every
name a step reads, including the outputs of earlier steps, and the executor reads
a name it was given before its own outputs — so the SDQ total difficulties and the
RCADS total were blank in every sitting. `scoringItemKeys()` (`@myself/scoring`)
now lists only a definition's items, and ingest and the participant app fill only
those. This is a fix in the reading, not in any release: rebuilding a dataset
gives every version's totals.

### The SDQ by age: the 11–17 and 18+ forms (r8.0.0, D-51)

**The problem (A-7).** youthinmind publishes the self-report SDQ in two forms: one
for 11–17 year olds (S11-17, © Robert Goodman 2005) and one for adults (S18+,
© 2009). r1.0.0–r7.3.0 administered one form to everyone, and it was neither:
22 items were the S11-17 wording and three were the S18+ wording, word for word —
19 "Other people pick on me or bully me" (S11-17: "Other children or young
people…"), 20 "I often offer to help others (family members, friends,
colleagues)" (S11-17: "I often volunteer to help others (parents, teachers,
children)") and 22 "…from home, work or elsewhere" (S11-17: "…home, school or
elsewhere"). Checked against both forms as downloaded from sdqinfo.org (English,
UK).

**The decision.** Each participant is given the form published for their age:

- **Under 18 → `sdq25_s` 2.0, the S11-17 verbatim.** Items 19, 20 and 22 take
  the S11-17 wording as **revision 2**; the other 22 items are unchanged (revision
  1). Variables are unchanged (`sdq25_q19`…): names survive versions, and the
  codebook and long format carry the item revision (§2). MAJOR on the instrument,
  because three items read differently: sittings before and after r8.0.0 pool on
  the other 22 items, and on 19, 20 and 22 only with a comparability argument.
- **18 and over → `sdq25_s18` 1.0, the S18+ verbatim.** A separate instrument,
  because 12 of its 25 items read differently from the S11-17 ("I would rather be
  alone than with other people", "I am generally willing to do what other people
  want", "I have at least one good friend", "I am kind to children", …).
  Variables `sdq25_s18_q1`…`sdq25_s18_q25`. Same subscales, reverse-scored items
  and pro-rating as the S11-17 (`score.sdq25_s18`): youthinmind's scoring
  instructions (20 June 2016) are "identical for the similarly-worded '18+' SDQ",
  but the 4–17 cut-points "have not been validated for use with the 18+ SDQ, so
  … it is safest to use continuous scores rather than categories". No bands.
- **Age** is whole years from the date of birth (`ybm_identity.dob`, asked in
  "About you", before the SDQ) to the **day the sitting started** — the UTC
  calendar date of the session's start, so the device and anything re-evaluating
  the sitting later reach the same answer. In the UK that date differs from the
  local one only between midnight and 1 am in summer. A sitting resumed on a later
  day keeps the form it started with. If the date of birth is missing or cannot be
  read (it is required, so this should not happen), the participant is given the
  S11-17 — the study's population.

**How it is expressed.** The wellbeing section places both instruments with
component conditions: `sdq25_s18` when `age_gte(dob, 18)`, `sdq25_s` when
`not(age_gte(dob, 18))`. `age_gte` is a new logic operator: true when the target
is a date answer and the participant's age on the evaluation date is at least
`years`; false when the date is missing, unreadable, or no evaluation date was
supplied. Exactly one of the two conditions holds for every sitting, so every
participant sees exactly one SDQ. The walker takes the session's start date and
passes it to `evaluate()`; the publish gate's dependency audit already requires
the date of birth to be asked before anything that depends on it.

**Unchanged.** The as-administered Qualtrics form (`ybm-asadmin`, A-6/A-7) keeps
its wording and codes: it records what was fielded before MySelf and is never
administered. Instructions are the screen adaptation used since r4.0.0 for both
forms (the S11-17 and S18+ paper instructions are the same text).

**Licence.** The research team's youthinmind permission (D-10) covers the SDQ for
electronic administration; that it extends to the S18+ form is to be confirmed
with youthinmind, and is recorded on the instrument as unverified until then.

**For analysts.** Scores for under-18s are `score.sdq25_s`, for adults
`score.sdq25_s18`; the two share a scale structure, not norms. The research
dashboard reports them as separate instruments and bands only the S11-17.

### The home address instead of a secret code (r8.0.0, D-52)

**Decision.** The four questions that built a secret code (mother's initials, a
house digit, birth month, postcode letters) and their introduction are removed.
In their place participants give their **home address** — the one they live at
most of the time; a young person who lives across two homes gives the one they
stay at most. The research team derives an identifier from what participants
give, rather than asking them to construct one. Ethics: the team confirmed the
approval covers collecting addresses (PSCETHS-1449); the information screen and
consent statements say so (below).

**The question.** One screen (`ybm_identity.home_address`, a `form_fields` item
with a `postcodeCheck`), after name and date of birth: postcode first, then house
number or name, and street, stored as given as `{postcode, house, street}`. The postcode is checked on the device against
a list of every West Yorkshire postcode in use (`releases/assets/`, built by
`scripts/build-postcodes.mjs` from the ONS Postcode Directory, Open Government
Licence), and the ward and district it lies in are shown back — "Little London &
Woodhouse, Leeds" — so a mistyped postcode is noticed at once. The list ships
with the release and is pinned by hash in `manifest.assets`, so the check needs
no network and no postcode leaves the device. A postcode that is not in the list
(outside West Yorkshire, too new for the list, or mistyped) is **never refused**:
the participant confirms twice — that it is typed correctly, then that their home
is outside West Yorkshire ("No — I'll check my postcode" takes them back to it) —
and whatever they give is kept as typed. Nothing else is recorded: whether a saved
postcode is in the list can be worked out at any time from the postcode and the
list the release pins. Every field is optional — many 11-year-olds do not know
their postcode — so a participant gives what they know.

**Identity.** The address is identifying (`identifying: true`), frozen into the
release and diverted by ingest into the identity partition like the name and
date of birth; it never becomes a response row or reaches an export.

**The participant identifier.** From r8.0.0 a sitting carries no code, so ingest
derives the participant ID from **first name, last name and date of birth**:
`P` followed by ten characters of a SHA-256 of the three, each normalised
(letters and digits only, lower case, accents removed — so spacing, hyphens and apostrophes never split a person; the date as YYYY-MM-DD). Like the
code before it, the ID is a pseudonym, not an anonymisation: anyone holding a
name and a date of birth can recompute it, so it is handled as pseudonymous data.
The address is deliberately **not** part of it: people move, and some young
people live in two homes, so an address would split one person into two.
Different first names separate twins, which a shared secret code could not.
A participant who gives a different form of their name at a later wave (Tom,
Thomas) arrives as a new ID and is joined by a correction record, exactly as a
mistyped code was (§7). Sittings under r1.0.0–r7.3.0 keep their secret-code IDs;
the two schemes never produce the same ID (codes never begin `P` followed by
ten base-32 characters).

**Where the address is kept.** Ingest files it as an identity row (JSON of the
fields given). Every store reads that value through one helper,
`parseHomeAddress` in `packages/store`, which keeps only `postcode`, `house` and
`street`, trimmed, and drops a value it cannot read rather than storing it as
text. Each of the three stores below keeps it in two places. Every sitting's
claim keeps the address given at that sitting. The participant's record keeps
the address from the **most recent sitting that gave one**. Recency is judged by
when the sitting started, not when it arrived, so a sitting uploaded late does
not replace a newer address with an older one. A sitting that gives no address
leaves the one on file. Unlike a name, which keeps its first spelling, an
address is expected to change.

- **Firebase identity service** (`apps/functions`). The claim and registry
  documents carry `homeAddress`. The registry also carries
  `homeAddressRecordedAt`, the start time of the sitting the address came from.
  The registry is read and written in one transaction, with `mergeFields` rather
  than `merge`. `merge` folds a map into the stored one key by key, so a house
  number given once and left out later would survive under a new postcode. The
  first version deployed with r8.0.0 had that flaw. It would only show for
  someone who sat twice with different addresses, and on their next sitting the
  address is replaced whole. An address filed before `homeAddressRecordedAt`
  existed has no date, so the next sitting that gives one replaces it.
- **Postgres API** (`apps/api`, not deployed). Migration
  `006_home_address.sql` adds nullable columns:
  - `identity.code_claims.home_address`;
  - `identity.participants.home_address`;
  - `identity.participants.home_address_recorded_at`.

  The migration is additive. It rewrites no row, and a database that has never
  had an r8.0.0 sitting behaves as before. The columns fall under the existing
  table grants: the linkage role can read and write them, and the research role
  cannot reach the identity schema at all. The owner-only `/identity/lookup`
  returns `homeAddress`.
- **Researcher view**. The address is kept in the sealed person record, taken
  from the latest claim that has one. It is also added to the identifier file,
  with spreadsheet formulas neutralised.

**Wording.** The information screen no longer promises "an anonymous code"; it
says the team collects name, date of birth and home address, keeps them apart
from the answers, and uses them to link a young person's answers across visits
and to find them if they ask to withdraw. The consent statement "my name will
not be linked with the research materials" becomes "my name, date of birth and
address will be kept separately from my answers". The team should check this
wording against the documents the ethics committee approved.

**SDQ 18+ item 22.** The published S18+ reads "I take things that are not mine
from home, work or elsewhere". Many of the study's 18-year-olds are still at
school or college, or at university, so the study asks "…from home, school or
college, university, work or elsewhere". This departs from youthinmind's
published wording, which their terms do not allow without permission; it is
recorded on the item and in the instrument's changelog, and should be raised
with youthinmind with the S18+ licence question (D-51).

### Shorter consent, sleep quality and sanity checks (r9.0.0, D-53)

A batch of changes the team asked for after fielding r8.0.0. Every one is
participant-visible, so together they make a MAJOR release. No existing variable
changes meaning, and no response code changes.

**Consent moves on by itself.** The consent screen (`ybm_intro_consent.consent`)
goes to the next screen as soon as the last statement is ticked. There is no
Continue to press. A screen that moves on after an input has to say beforehand
that it will (WCAG 2.2, 3.2.2 On Input), so the instruction now ends "…and we'll
move on once they're all ticked." The move waits a moment, so the last tick is
seen landing. Coming back to the screen does not move it on again: only the tick
that completes the set does. Schema: `checkbox_set.autoAdvance`.

**"I understand".** The screen on why accurate answers matter
(`ybm_intro_consent.why_it_matters`) is answered with "I understand" rather than
"Continue". Schema: `info.advanceLabel`.

**Contact address.** The consent statement and the data-handling text gave a
team member's personal address (m.faizah@leeds.ac.uk). Both now give the study's
address, brainpop@leeds.ac.uk, which the cover already showed.

**Linkage with Connected Yorkshire.** A new question straight after consent
(`ybm_intro_consent.linkage_consent`, Yes / No) asks whether the participant
agrees to their answers being linked, pseudonymously, with health and education
records through the Connected Yorkshire research data platform. The screen
explains what is linked, that the details used to make the link are removed
before any researcher sees the data, that it continues unless they withdraw, and
how to withdraw. It is optional: saying no changes nothing else about taking part.
The team confirmed that linkage is covered by the ethics approval
(PSCETHS-1449). The wording is a draft for the team to check against the
approved documents before this release is fielded. The answer is an ordinary
research variable, and a researcher linking a record must check it first.

**Ethnic origin in West Yorkshire order.** The 19 options of
`scale.ethnicity_uk20` are listed most common first. The order uses usual
residents of the five West Yorkshire districts in the 2021 Census (table TS021,
ONS, Open Government Licence). "English, Welsh, Scottish, Northern Irish or
British" (72.0%) comes first, then "Pakistani" (10.7%) and "Any other White
background" (3.7%), down to "Gypsy or Irish Traveller" (0.1%). "Prefer not to
say" stays last. Only the order on screen changes: every code is as before, so
the data are comparable with earlier releases. The scale becomes 2.0.0.

**Languages.** After ethnic origin, three new questions:
- "Was English the first language you learned to speak?" (Yes / No / "I learned
  English and another language at the same time");
- "Do you speak or understand any language other than English?", counting home,
  family, friends and school;
- if yes, "Which other languages…?" (choose all).

The language list is the languages the 2021 Census names individually, most
common first as main languages in West Yorkshire (TS024): Urdu, Punjabi, Polish,
Arabic, Chinese, Gujarati, Bengali, Portuguese, Spanish, Russian, French, Tamil,
British Sign Language, Turkish. "Another language" opens a box to name it. Then
one question per language ticked, "How well do you understand Urdu?" (Very well /
Well / Not very well / Only a few words, after the Census question on English).
Each is shown only when its language is ticked, so a child with three languages
answers about all three, and the data has one column per language
(`understand_urdu` … `understand_other_language`). The main-language ranking
undercounts languages learned at school or spoken alongside English; it decides
only the order on screen.

**Sleep quality.** The Sleep Quality Scale (SQS; Snyder et al., 2018, *J Clin
Sleep Med* 14(11)) is asked before the Karolinska Sleepiness Scale: "During the
past 7 days, how would you rate your sleep quality overall?", from 0 to 10.
The eleven numbers sit in one row, with the published groupings drawn beneath
them: 0 Terrible, 1–3 Poor, 4–6 Fair, 7–9 Good, 10 Excellent. The score is the
number chosen. Its licence is recorded as unverified until the team confirms
permission. Schema: `responseScale.bands` and the `numbered` presentation.

**Handedness pictures.** The four objects (pen, ball, toothbrush, spoon) are
drawn from Microsoft's Fluent Emoji (MIT licence) instead of the study's own line
drawings. Each is stood upright, so no picture leans towards one hand (D-32).

**How long without social media.** An answer over 90 days is read back in
months and days ("That's about 1 year, 1 month and 5 days — is that right?")
and needs a tap on "Yes, that's right" before moving on. Nothing is refused: the
upper limit stays at 3,650 days. Schema: `numeric.confirmAbove`.

**How family manage social media.** Someone who answers Yes to "Does your family
manage or control your social media use?" is asked how, choosing all that apply
(`ybm_social_media.family_control_how`). If they choose "Something else", a short
box asks them to describe it (`family_control_other`). The options are the
study's own and are not a published measure.

**Not knowing the postcode.** On the address screen, someone who does not know
their postcode can say so after the warning. They then type their street, which
is matched against every named road in West Yorkshire (OS Open Names, Ordnance
Survey, Open Government Licence). The closest matches are offered with their
area and postcode district, e.g. "Hyde Park Road — Leeds · LS6" (there is also
one in Halifax). The search allows for abbreviations ("Rd", "St"), a house
number typed in front and small typing mistakes. Choosing one records the street
as the list spells it, with its area and district, under the keys the item's
`streetCheck` names (`area`, `postcode_district`). Nothing is refused: a street
not in the list is kept as typed. The list (39,718 street entries, built by
`scripts/build-streets.mjs` from the July 2026 edition) ships with the release
and is pinned by hash like the postcode list. The app loads it only when someone
says they don't know their postcode, as a separate part of the app that is still
stored for offline use.

**Welcome screen.** Pending: the team will mark what to remove, and the
screen will be titled "Taking part".

### Versions published from the dashboard (D-54) — design, before building

The team asked for an editor: change the survey, see what changed, and publish
it as a new, correctly numbered version, with the history easy to extract. They
chose to have a publish go **straight to the live survey**, from the signed-in
dashboard, rather than through a code change and a deploy. MyStory can be added
at the end of any version, with a protocol chosen, and edited, in the editor.

The editor itself lives in the dashboard (its docs/11). This section is what
changes on the survey's side. It is written before any of it is built, as every
change to the live survey has been.

**What a version is does not change.** A published version is still a frozen
release manifest, content-hashed with the same canonical JSON. The dashboard
builds it with this repository's own release builder (`buildRelease`), vendored
unchanged. So every publish runs the same publish gate a release cut here runs:
licences, unresolved references, scales and bands, pipes, scoring references,
street and postcode assets, and the MyStory protocol's own checks. A version from
the editor is indistinguishable from one cut with `publish.mjs`.

**Where a published version lives.** The dashboard's functions write two things
to this study's database with the Admin SDK:

- `studies/{study}/releases/{hash}`: the manifest (`manifestJson`), its version,
  key, who published it, when, and why.
- `studies/{study}/config/activeRelease`: which version new sittings use.
  `{ hash, version, activatedAt, activatedBy }`.

Both are readable by anyone and writable by no client. They hold the
questionnaire, which is already public in the participant app's bundle; nothing
about any participant.

**How a device picks its version** (`apps/participant`):

1. A device finishes any sitting it has started under the version it started
   with. Resuming never switches version.
2. Otherwise, at start-up it asks for `activeRelease`, with a short timeout. If
   the version is one it has not stored, it fetches that manifest and parses it.
   It keeps the manifest only if the content hashes to the stated hash, the
   schema accepts it, and the release's `engineVersion` is one this build can
   run. It then stores it (IndexedDB) and uses it.
3. With no network, or anything wrong in step 2, it uses the last version it
   stored, and failing that the one bundled in the build. It never shows a blank
   screen and never an unverified manifest.
4. The version reached on a device is recorded in the sitting, as today
   (`releaseHash`). The start screen shows which version is running, so a
   researcher can see it before handing the iPad over.
5. A device that is already open picks up a new version when it returns to its
   start screen after a handover, not in the middle of anything.

**Everything that reads a sitting learns the published versions too.**
- The functions (`releasesByHash`: ingest, export, the MyStory relay's model
  allowlist) read the database versions alongside the bundled ones.
- So does the researcher view, alongside the files in `releases/`.

A sitting under a version published from the dashboard is read exactly like one
under a bundled version. `scripts/pull-releases.mjs` copies published versions
into `releases/`, so git keeps the full history and
`packages/release/src/published.test.ts` checks them like any other.

**MyStory, per version.**
- A version either ends with MyStory or does not. When it does, MyStory is always
  the last section, then the finish screen, then the handover to the researcher:
  the device is only handed back after MyStory is done or left.
- The protocol is chosen in the editor, and its TOML can be edited there. It is
  frozen into the manifest's `narrativeProtocols`, as today, so a version fixes
  exactly which protocol, prompts and models it used.
- The embedded module is currently told only a protocol key, which it looks up
  in its own bundled list. That cannot carry an edited protocol. So the survey
  now also sends the frozen protocol to the module in a message. The module uses
  it when it passes the same schema and checks, and otherwise refuses to start
  rather than run something else.

**Preview before publishing.** The participant app gains a preview mode for the
dashboard. Opened inside the dashboard, it runs a draft sent to it in a message,
from the dashboard's origins only. It stores nothing and uploads nothing.

**Numbering and provenance.** The next version number follows §3, and the
dashboard works it out from the change:
- **MAJOR** for anything a participant could experience differently: wording,
  options and their order, which questions are asked, conditions, screens, and
  MyStory on, off or changed;
- **MINOR** for additions that leave every existing path alone;
- **PATCH** for researcher-facing metadata only.

Each version records its base version, the list of changes, why it was
published, who published it, and when it became and stopped being active. The
dashboard exports all of that as CSV or JSON.

**Safeguards.**
- Only an owner can publish or make a version active, and both are audited.
- Making an earlier version active again is the rollback. Nothing is deleted.
- Licensed instruments whose licence forbids modification (`modifiable: no`)
  cannot be reworded in the editor. They can only be included or left out.

#### As built, on the survey's side

Built as designed above. Where the design left a choice open, this is what was
chosen; [16-maintainers-guide.md](16-maintainers-guide.md) §3.6 says where each
part lives.

- **Which engine can run a version**: the same MAJOR as the app's engine, and a
  MINOR no newer (PATCH is ignored). The engine's version is `ENGINE_VERSION`,
  held to its `package.json` by a test.
- **How long a device waits**: 4 s for `activeRelease`, then 8 s for a manifest
  it has not stored. The page says "Getting ready…" meanwhile.
- **How it reads**: over Firestore's REST API (`batchGet`), with no SDK and no
  credential. A version's document id is its hash, and a colon in a Google API
  path is read as a method name, so the document is named in the request body.
- **Every version a device runs is stored**, the bundled one included, so a
  sitting can still be finished after a later build replaces it.
- **Resuming under another version**: on the start screen, a code with an
  unfinished sitting under another stored version reloads the app into that
  version, which carries straight on. A sitting from before devices stored their
  versions may not qualify; it starts afresh under the running version, as it
  always did.
- **After a handover**: the device asks again, stores a new version, and reloads
  onto it only on the start screen with no code typed and the staff panel shut.
- **Preview**: drafts are accepted from `https://myself-research-dashboard.web.app`,
  `.firebaseapp.com` and its preview channels, and from localhost only in a
  development build. A later, different draft reloads the page, which says it is
  ready again. MyStory's place is shown, not run.
- **MyStory's protocol**: the survey marks the module's URL `protocolFromHost=1`,
  waits for `mystory:ready`, and sends `myself:narrative-protocol`. The module
  runs it only if it parses, passes `checkProtocol` and has the key the URL
  named; otherwise, or if nothing arrives within 15 s, it refuses and tells the
  survey (`mystory:refused`), which offers a way on at once. The module's local
  server can only run its own copies, so it refuses a different one. When MyStory
  is last, its screen says the survey is done and its button says Finish.
- **The functions** read published versions at most once a minute per instance,
  and look again, no more than every 5 s, for a hash they have not seen. **The
  researcher view** reads them on signing in and before every pull.

## 7. Identifiers and linkage (r7.0.0, D-37)

Section 6 described the data layer as built. This corrects a gap in it that was
found on 2026-08-03: the separation described above was documented but not
implemented, and names were reaching the phenotype export.

**Identifying items are marked in the definition, not filtered downstream.**
`identifying: true` is set on `first_name`, `last_name`, `dob` and the four
secret-code components, and is frozen into the release. `ingest` diverts those
answers into a separate identity partition; they never become response rows.
Nothing downstream has to remember to exclude them, because they never arrive.

**Age replaces date of birth in the research data.** Derived at the session
date, in whole years — a decimal age is a date of birth in disguise.

**The participant code is a pseudonym, not an anonymisation.** It cannot be
reversed to a name. It is built from the components, so anyone who knows the
scheme reads the mother's initials, a house digit, a birth month and two
postcode letters off it. That is the trade for a code a participant can
reproduce years later without being told it (D-23), and it is why the code is
handled as pseudonymous data.

### Linkage service

Names are held — deliberately, in the `identity` schema — because two jobs
need them:

| Job | Route | Who |
|---|---|---|
| Who is this code? | `POST /identity/lookup` | owner |
| What codes has this person used? | `POST /identity/search` | owner |
| Attach the school's UPN | `POST /identity/upn` | owner |
| These two codes are the same child | `POST /identity/corrections` | owner |

Every call requires a written justification, stores it, and logs **before**
returning an answer — a log of successes is not a log. The search covers codes
that were claimed but never registered, which is exactly what a mistyped code
looks like. UPNs are unique per study: one UPN, one pupil, refused at entry
rather than found in an analysis.

### Correcting a mistyped code

Someone gives a slightly different code at wave 2 and arrives as a stranger.
The repair is a **correction record**, applied when the dataset is derived:

- the event log is never edited — it says what the participant actually typed,
  which is the only honest account of the sitting
- corrections resolve through chains, and a correction pointing at a code that
  is itself corrected away is refused
- withdrawing the correction puts everything back exactly as it was

The researcher view's **Linkage** tab does all of this locally today, against
its own identity table, and the API does the same against the identity schema
once the server is up.
