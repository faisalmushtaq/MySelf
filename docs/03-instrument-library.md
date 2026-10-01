# Initial MySelf Instrument Library (derived from the YBM survey)

Every recognised validated scale becomes a separately versioned instrument; bespoke items are organised into named modules. Licensing status below distinguishes **verified** (checked against an authoritative source on 2026-08-02) from **to confirm**.

## Validated instruments

| Library ID | Canonical name | Construct | Items | Citation (to verify against original) | Licence status |
|---|---|---|---|---|---|
| `ehi_sf` | Edinburgh Handedness Inventory – Short Form | Handedness | 4 | Veale (2014), *Laterality* 19(2); original Oldfield (1971) | Freely usable for research (**to confirm**); administered anchors deviate → stored as `ehi_sf@1.0-ybm-asadmin` |
| `macarthur_ssy` | MacArthur Scale of Subjective Social Status – Youth | Subjective SES (family, school) | 2 ladders | Goodman et al. (2001), *Pediatrics* 108(2):e31 | Free for research (**to confirm**); administered 0–10 slider deviates from 10-rung canonical |
| `kss` | Karolinska Sleepiness Scale | State sleepiness | 1 | Åkerstedt & Gillberg (1990), *Int J Neurosci* 52 | Free for academic research (**to confirm**); administered labels deviate (typo on point 7) |
| `sqs` | Sleep Quality Scale (SQS) | Sleep quality over the past 7 days | 1 (0–10) | Snyder et al. (2018), *J Clin Sleep Med* 14(11) | Item and anchors published in full; terms of use for this study **to confirm** with the authors. Asked before the KSS from r9.0.0 (D-53), as one numbered row with the published bands (0 Terrible, 1–3 Poor, 4–6 Fair, 7–9 Good, 10 Excellent). Score = the number chosen. |
| `swemwbs` | Short Warwick–Edinburgh Mental Wellbeing Scale | Mental wellbeing | 7 | Stewart-Brown et al. (2009), *Health Qual Life Outcomes* 7:15 | **Verified: registration/licence required (free non-commercial)** — [Warwick licences page](https://warwick.ac.uk/services/innovations/wemwbs/licenses/). Scoring uses the published raw→metric conversion table. |
| `sdq25_s` | Strengths and Difficulties Questionnaire, self-report | Emotional/behavioural difficulties | 25 (5 subscales) | Goodman (1997), *J Child Psychol Psychiatry* 38 | **Verified: youthinmind copyright; electronic versions require youthinmind authorisation and may carry fees** — [youthinmind copyright](https://youthinmind.com/copyright/), [FAQ](https://youthinmind.com/faq/). **Blocking until authorised.** Administered form mixes youth/adult wording + "Clearly true" anchor → `sdq25_s@1.0-ybm-asadmin`. From r8.0.0 (D-51) `sdq25_s` 2.0 is the S11-17 verbatim, for under-18s. |
| `sdq25_s18` | Strengths and Difficulties Questionnaire, self-report 18+ (S18+) | Emotional/behavioural difficulties | 25 (5 subscales, scored as `sdq25_s`) | Goodman (1997); youthinmind S18+ (© 2009) | youthinmind, as `sdq25_s`; coverage of the S18+ under the D-10 permission to be confirmed. Given to participants 18 and over from r8.0.0 (D-51). The 4–17 cut-points are not validated for it: continuous scores only. Item 22 adapted by the study to name school or college and university as well as work (D-52) — a departure from the published wording to raise with youthinmind. |
| `rcads25` | Revised Child Anxiety and Depression Scale – 25 | Anxiety (15) + depression (10) | 25 | Ebesutani et al. (2012), *J Psychopathol Behav Assess* | **Verified: free; permission process via rcads.ucla.edu Permissions tab** — [CORC entry](https://www.corc.uk.net/outcome-measures-guidance/directory-of-outcome-measures/revised-childrens-anxiety-and-depression-scale-rcads/). Canonical coding 0–3; T-score norms by grade/gender. |
| `stai5_s` | STAI-5 (state short form) | State anxiety | 5 | Zsido et al. (2020), *Psychiatry Res* 291:113223 | **Review required**: parent STAI licensed by Mind Garden ([STAI page](https://www.mindgarden.com/145-state-trait-anxiety-inventory-for-adults)); status of the 5-item derivative for electronic research use to be confirmed. |
| `bisbas12_ybm` | BIS/BAS – 12-item YBM subset | Behavioural inhibition/approach | 12 (BIS 4, RR 4, Drive 4) | Carver & White (1994), *JPSP* 67 | Widely used without fee (**to confirm**); the 12-item subset is an explicit adapted form — provenance (possibly the AoW study) to document. |
| `doomscroll4` | Doomscrolling items (4) | Compulsive negative-news consumption | 4 | Possibly Sharma, Lee & Johnson (2022), *Technol Mind Behav* — **to verify** | **To confirm** (citation + reproduction rights). |

## Bespoke modules (named, versioned, owned by the YBM programme)

| Module ID | Contents (canonical variables) | Notes |
|---|---|---|
| `ybm_intro_consent` | intro text, consent statements, decline path | Study-specific; reading level editable (not a validated measure) |
| `ybm_identity` | `val_id`, linkage fields per approved identifier design | Replaces `first_name`/`last_name`/`ps_id`/`DoB` pending decision A-26/A-27 |
| `ybm_demographics` | `ethnicity`, `gender`, `mh_medication` | Ethnicity list pending QSF (A-39) |
| `ybm_eeg_practical` | `hair_type` | EEG cap practicality; chart asset pending (A-42) |
| `ybm_sleep_priorities` | `sleep_importance`, `sleep_know_own` | Bespoke sleep items (currently mislocated in "Karolinska" block) |
| `ybm_smartphone` | `smartphone_own`, `smartphone_age`, `sm_use`, `sm_age` | Ownership + adoption ages |
| `ybm_social_media` | `sm_overuse`, `sm_apps_owned` (+rank), `sm_app_time_*`, `sm_account_privacy`, `sm_active_passive`, `sm_functions`, `sm_night_checks`, `sm_morning_latency`, `sm_time_school_day`, `sm_time_nonschool_day`, `sm_lose_track`, `sm_limit_features`, `sm_abstain_effect`, `sm_abstain_days`, `sm_family_control` | "Adapted from AoW" — source attribution to document |
| `ybm_screen_attitudes` | `screen_control_*` (3), `sm_impact_*` (4) | Bespoke agree/disagree matrices |
| `ybm_gaming` | `gaming_hours_week`, `gaming_top_games_1..5`, `gaming_game_time_1..5`, `gaming_social_pct` | Logic fixes pending decisions A-3/A-4 |
| `ybm_future_self` | `future_self_message` | Seed of the micro-narrative protocol `np.future_self` |

Each library record carries the full metadata set required by the brief (construct, citation, licence, age range, languages, forms, wording, instructions, options, coding, reverse-scoring, subscales, scoring rules, missing-data rules, per-age-band time estimates with provenance, version, change history, notes, modifiability flag, approval status). Time estimates for the initial release are derived from the item count and response-format heuristics, marked `provenance: estimated-heuristic`, and are replaced by empirical distributions (`provenance: empirical-myself`) as MySelf data accumulate — originals retained.

**Licensing enforcement:** instruments carry `licence.status ∈ {open, permission_held, permission_required, blocked}` and `licence.modifiable ∈ {yes, no, with_permission}`. The composer refuses to publish a release containing `permission_required`/`blocked` instruments, and the item editor refuses wording edits on `modifiable: no` instruments (a new explicitly-labelled adapted form must be created instead, which itself starts as `permission_required` where the licence demands it).
