# Anomaly Report — Yorkshire Brain Map (NotreDame2026) Qualtrics Export

> **Updated 2026-08-02 after receipt of the QSF.** See [10-qsf-findings.md](10-qsf-findings.md) for machine-level resolutions. Status changes: **A-2, A-3 CONFIRMED** as live errors; **A-4 WITHDRAWN** (Word-export artefact — QSF logic is correct); **A-11, A-14, A-37(part), A-39, A-40, A-41, A-42 RESOLVED**; new anomalies **A-43** (age dropdowns missing option "5") and **A-44** (RCADS instructions promise skipping but the question is force-response) added below.

Each anomaly is classified as:

- **C1 — Clearly safe to correct** (presentation/metadata only; zero effect on data meaning)
- **C2 — Requires a researcher decision**
- **C3 — Must remain unchanged for historical comparability** (preserve as administered; document)
- **C4 — Requires psychometric, ethical or licensing review**

Migration disposition codes (from the migration strategy): `EXACT` (exact reproduction), `PRESENT` (presentation-only modernisation), `SAFE-FIX`, `APPROVED-FIX` (researcher-approved substantive correction), `DEPART` (intentional departure), `UNRESOLVED`.

---

## Substantive logic and content errors

| ID | Class | Anomaly | Detail and recommendation |
|----|----|----|----|
| **A-1** | **C2** | `Abstaining_SM` question text is wrong | Its text duplicates `app_reduce` ("Do you use any features designed to reduce your social media use…?") but its options are an effect scale (Very negatively … Very positively). The intended question (presumably "What effect do you think abstaining from social media would have on you?") is missing. Historical data for this variable are of doubtful meaning. **Decision needed:** correct wording in MySelf (APPROVED-FIX, new item version) and flag legacy data; or retire the item. |
| **A-2** | **C2** | Wrong display condition on Twitch row of `TimeSpent on each` | The Twitch row displays if **X (Twitter)** is in "I have these apps"; the correct condition (Twitch) appears nowhere. Consequence: Twitch time was asked of the wrong participants and never of some right ones. **Decision:** fix in MySelf (APPROVED-FIX); mark legacy Twitch-time data unreliable in the crosswalk. |
| **A-3** | **C2** | Inverted display logic on `other_games` | Shown **if `weekday_games` = "I do not play video games"** — i.e., only non-gamers are asked to list the games they play. Almost certainly should be *Is Not Selected*. If data were collected this way, gamers' top-5 games were never captured. **Decision:** confirm intent; fix in MySelf (APPROVED-FIX); annotate legacy data. |
| **A-4** | ~~C2~~ **WITHDRAWN** | ~~`other_games_time` choice-level conditions are five identical question-level tests~~ | QSF shows per-row conditions are correct (row *N* ← game *N* NotEmpty); the Word export rendered them misleadingly. Residual minor note: the *question-level* condition tests only game 1, so filling only slots 2–5 skips the matrix — reviewed under A-3's decision. |
| **A-5** | **C2** | No non-consent pathway | Consent block has no "I do not consent" option and no screen-out branch visible. If a participant will not tick all boxes, behaviour is undefined (or forced). MySelf requires an explicit decline path with a respectful exit screen. **Decision:** confirm forced-consent behaviour in Qualtrics and approve the MySelf consent flow. |
| **A-6** | **C4** | SDQ response anchor "Clearly true" contradicts canonical "Certainly True" (and the survey's own instructions) | Canonical label must be restored **only with youthinmind authorisation** (their terms prohibit modification and unauthorised electronic versions). Preserve the administered variant as its own labelled form for comparability. |
| **A-7** | **C4** | SDQ item wording appears to mix the 11–17 and 18+ self-report forms | E.g. item 20 "(family members, friends, colleagues)" and item 22 "home, work or elsewhere" match the adult form; other items match the youth form. Requires verification against canonical youthinmind forms and a decision about which edition future waves should use. Administered form must be preserved verbatim as `sdq25 v1.0-ybm-asadmin`. **Resolved from r8.0.0 (D-51):** verified word for word — items 19, 20 and 22 are the S18+ wording, the other 22 the S11-17. Participants under 18 now get the S11-17 verbatim (`sdq25_s` 2.0) and those 18 and over the S18+ (`sdq25_s18`); docs/06 §6. |
| **A-8** | **C4** | KSS label deviations | Point 7 "Sleepy, but **not no** effort to keep awake" (typo, semantics inverted vs canonical "no effort"); point 4 "4- Fairly alert" vs canonical "Rather alert". Correcting the typo changes a validated anchor → psychometric review; preserve administered form as its own version. |
| **A-9** | **C2** | `weekday_games` name/content mismatch and band gap | Name implies weekdays; question asks weekly total. Bands skip 5–6 hours ("Less than 5" → "6-10"). Canonical variable rename is safe (`gaming_hours_week`); the band gap is a substantive instrument change → decision for future waves; C3 for the regression fixture. |
| **A-10** | **C2** | `other_games_time` has no "0 hours" column and bands mismatch `weekday_games` | A listed game cannot be reported at <"Less than 5 hours"— fine — but bands are inconsistent with the parent question's bands. Decision for future waves; preserve as administered for comparability. |
| **A-11** | **RESOLVED** | Branch nesting confirmed via QSF | The `SM_Own = Yes` branch contains **both** "Social media rank and time" and "Screen control, social media impact and doomscrolling's". Gaming, STAI and BIS-BAS are asked of everyone. |
| **A-12** | **C2** | Duplicate question text within `app_reduce`/`Abstaining_SM` pair | Same as A-1 viewed from the duplication side; also both sit adjacent, so participants saw the same question twice with different answer sets. Confirm which data are interpretable. |
| **A-13** | **C1** | Piped text `${other_games /ChoiceTextEntryValue/N}` contains a stray space | May render literally or fail depending on Qualtrics parsing. MySelf's piping references will be validated identifiers; the crosswalk records the original string. |
| **A-14** | **RESOLVED** | `SM_morning_check` first option label | QSF shows it is "**<5 minutes**" (code 1) — the Word export swallowed the `<` as HTML. |

## Response-coding anomalies (all C3 by default — preserve codes, crosswalk to clean canonical codes)

| ID | Class | Anomaly |
|----|----|----|
| **A-15** | C3 | Non-sequential choice codes throughout: Consent (2–7), `SM_active_passive` (1,4,5), `SM_function` (1,4–13), `SM_lostrack` (1,4–8), `Abstaining_SM` (1,4–7), `weekday_games` (1,4–8), `Social media impact` rows (4–7), `bisbas` rows (1–8,25,9,26,27), `DragDrop_SM` (skips 7), `TimeSpent` rows (skip 8), EHI rows (1,3,5,7). Standard Qualtrics editing artefacts. **Never silently recode**: MySelf assigns clean canonical codes and ships a tested crosswalk; legacy view exports original codes. |
| **A-16** | C3/C4 | SDQ administered 1–3 vs canonical scoring 0–2; RCADS administered 1–4 vs canonical 0–3. Published norms and cutoffs assume canonical coding. Scoring definitions must transform administered codes; both codings preserved in exports. C4 because scoring/norms are affected. |
| **A-17** | C3 (was C2) | `Age_SM`/`Age_smartphone` code maps now fully recovered from QSF (see 10-qsf-findings §3): display order is sensible (Younger than 5, 6, 7 … 25, not sure) but codes are scrambled (e.g. age 7 = code 27, age 9 = code 11). Crosswalk certified from QSF; codes preserved in legacy view, clean ordinal codes canonical. |
| **A-18** | C3 | Scale-direction reversals between adjacent instruments: `Screen Control`/`Social media impact`/`SM_lostrack` are agree-first (1 = agree); `Doomscrolling` is disagree-first (1 = disagree). Not an error per se (Doomscrolling follows its source scale) but a data-analysis hazard; document prominently in the codebook. Direction metadata is mandatory on every scale in MySelf. |

## Validated-measure deviations (all C4)

| ID | Class | Anomaly |
|----|----|----|
| **A-19** | C4 | EHI-SF response anchors differ from Veale (2014) ("Left hand strongly preferred…" vs "Always right… Always left"). Laterality-quotient scoring and classification cutoffs assume canonical anchors. Preserve administered form; decide canonical vs administered for future waves. |
| **A-20** | C4 | MacArthur ladders administered as 0–10 sliders (11 points); canonical youth ladder has 10 rungs (1–10). Also block misspelled "McArthur". Comparability with published distributions affected. |
| **A-21** | C4 | STAI-5: parent instrument is Mind Garden-licensed; the Zsido et al. 5-item short form's licence status for electronic use must be confirmed before further deployment. |
| **A-22** | C4 | BIS/BAS administered as an undocumented 12-item subset (BIS×4, RR×4, Drive×4; Fun Seeking omitted) with a stray quote in item 4. Document as an explicit adapted form with its own scoring definition; confirm citation and any prior use of this subset (possibly from the AoW source study). |
| **A-23** | C4 | Doomscrolling items resemble the Sharma, Lee & Johnson (2022) Doomscrolling Scale (short subset). Citation and permission to reproduce/administer electronically must be verified. |
| **A-24** | C4 | SWEMWBS requires a (free, non-commercial) registration/licence from Warwick; confirm the team holds one covering this and future MySelf use. |
| **A-25** | C4 | SDQ: youthinmind states no one except youthinmind is authorised to create/distribute electronic versions without contact/licence; fees apply for electronic administration. Administering SDQ inside MySelf **requires explicit authorisation** — this is a blocking licensing issue for the SDQ component. |

## Identifier, privacy and safeguarding issues

| ID | Class | Anomaly |
|----|----|----|
| **A-26** | **C2/C4** | Full names and DoB collected in the same instrument as mental-health responses; no separation. MySelf must split identity data from response data at the data-model and access-control levels (see architecture). Decision: whether names/DoB are still required at all, given `val_id` exists. |
| **A-27** | **C2** | `ps_id` self-generated code embeds quasi-identifiers (mother's name fragment, house number, birth month, postcode fragment) and is error-prone (typos, moves, name variants defeat longitudinal matching). Proposed replacement in migration strategy §5 (team-issued ID + optional legacy-code computation kept only as a derived hash). |
| **A-28** | C1 | `val_id` question typos ("haven not", "pleas", "i.e," ) — instruction text, not a validated measure: safe to fix. |
| **A-29** | **C4** | RCADS item 18 ("I think about death.") and the RCADS/SDQ instruments generally: define the study's safeguarding stance explicitly (no real-time monitoring implied; review cadence; escalation route). The current survey provides no distress signposting at the end. Decision + ethics alignment required. |
| **A-30** | C2 | `Medication` (special-category health data): confirm continued necessity and retention rules. |

## Naming, wording and presentation (C1 unless noted)

| ID | Class | Anomaly |
|----|----|----|
| **A-31** | C1 | Unsafe variable names: `Mental well-being`, `TimeSpent on each ` (trailing space), `SM_weekend/holiday` (slash), `Screen Control`, `Social media impact ` (trailing space), `Doomscrolling ` (trailing space), `STAI-S` (hyphen), `Future Self` (space), `Acount_privacy` (typo). Canonical snake_case names assigned; originals preserved as aliases. |
| **A-32** | C1 | Duplicate variable name `Introduction` (Introduction block text and SDQ intro text). Descriptive-text items get unique canonical IDs. |
| **A-33** | C1 | Instruction-text typos (not validated wording): "Ethic origin" (Ethnicity), "did you you get" (Age_smartphone), "It will not" (Medication), capitalisation inconsistencies in `TimeSpent` rows ("Youtube/YouTube", "kick"). Safe to fix; originals recorded in migration metadata. |
| **A-34** | C2 | `Social media impact` item pair "mostly positive"/"mostly negative" includes typos **inside bespoke item wording** ("mental welling", "wellbeing in mostly negative"). Bespoke, not validated — but wording changes still affect comparability with the current wave. Decision: fix for future waves (APPROVED-FIX) vs preserve. |
| **A-35** | C1 | Block-name issues: "McArthur" misspelling, "doomscrolling's" stray apostrophe, `Karolinska` block contains two non-KSS sleep items, `Future Self` item located in the BIS-BAS block. Canonical structure reorganises modules; original block membership preserved in migration metadata. |
| **A-36** | C2 | `TimeSpent` column bands overlap at boundaries ("1–15", "15–30", "30–60", "1–2 hours"). Decision for future waves; preserve for comparability. |
| **A-37** | C1 | `DoB` free-text with no format validation; MySelf uses a proper date control (presentation-only modernisation) — subject to A-26 decision on collecting DoB at all. |
| **A-38** | C2 | "About 10 minutes" completion estimate in the intro is asserted without provenance; MySelf will compute estimates per age band and update from empirical data. Decide the initial estimate to display. |

## Reconstruction gaps — all resolved by the QSF (details in 10-qsf-findings.md)

| ID | Class | Status |
|----|----|----|
| **A-39** | RESOLVED | All dropdown lists + codes recovered (QSF §3). |
| **A-40** | RESOLVED | Full validation map recovered (QSF §4): 15 hard-forced questions, 5 soft-prompted, choice-range on sleep items, DoB has date validation, `Abstaining_days` has **no** numeric validation, consent requires all 6 boxes. |
| **A-41** | RESOLVED | No embedded data, no randomisation, no scoring, no redirects; the only custom JavaScript is the ladder background image on the two SES sliders (QSF §6) — migrates as a native ladder control, `PRESENT` disposition. Trash block found (STAI-T, Fasting removed pre-launch — to confirm against first dataset). Back button is **enabled** survey-wide. |
| **A-42** | RESOLVED (licence check outstanding) | Ladder image = Leeds Qualtrics library `IM_9QR5ycr6HarV5Iy` + SPARQ toolkit PNG (sparqtools.org); hair chart = `IM_0VW7lNCmjc75IGi` (700×301). Download via account access; hair-chart original source/licence still to identify. |

## New anomalies from the QSF

| ID | Class | Anomaly |
|----|----|----|
| **A-43** | **C2** | Both age-of-adoption dropdowns (`Age_smartphone`, `Age_SM`) jump from "Younger than 5" to "6" — **age 5 cannot be reported**. Decision: add "5" in MySelf (APPROVED-FIX, new item version) or preserve the gap for comparability. |
| **A-44** | **C4** | RCADS-25 instructions tell participants *"you can skip it"* but the question is **ForceResponse ON** — skipping is impossible. SDQ is also hard-forced. Contradiction between participant-facing promise and behaviour; affects ethics accuracy and missing-data assumptions. Decide r1 behaviour (recommended: honour the instruction — make items soft-required with an explicit decline option, and document the departure from the Qualtrics configuration as APPROVED-FIX/DEPART). |

---

### Summary counts (post-QSF)
- C1 (safe fix): 7 · C2 (researcher decision): 13 · C3 (preserve): 4 · C4 (review): 11 · Withdrawn: 1 (A-4) · Resolved: 8 (A-11, A-14, A-37-part, A-39, A-40, A-41, A-42, A-17-codes).

**Remaining blockers before a faithful YBM release can be frozen:** A-25 (SDQ licence), A-24 (SWEMWBS registration), A-1/A-2/A-3/A-43/A-44 decisions, A-26/A-27 (identifier design approval), hair-chart image licence, image downloads from the Qualtrics library.
