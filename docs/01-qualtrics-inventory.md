# Yorkshire Brain Map — NotreDame2026: Structured Survey Inventory

**Source artefact:** `Yorkshire_Brain_Map_-_NotreDame2026.docx` (Qualtrics Word export)
**Analysed:** 2026-08-02
**Status of this inventory:** Reconstructed from the Word export only. The Word export omits several machine-level details (full dropdown choice lists, validation settings, flow nesting, randomisation, embedded data). Items that cannot be confirmed from this export are marked **[UNCONFIRMED — needs QSF]** throughout. A Qualtrics `.qsf` export has been requested to close these gaps.

---

## 1. Survey flow (as exported)

| # | Flow element | Type | Question count (per export header) |
|---|---|---|---|
| 1 | Introduction | Standard block | 1 |
| 2 | Consent | Standard block | 1 |
| 3 | Demographics | Standard block | 8 |
| 4 | Hair Type | Standard block | 1 |
| 5 | Edinburgh Handedness Inventory - Short Form | Standard block | 1 |
| 6 | McArthur Scale *(sic — misspelling of MacArthur)* | Standard block | 6 |
| 7 | Karolinska | Standard block | 3 |
| 8 | Mental Well-Being | Standard block | 1 |
| 9 | SDQ 25 Items | Block | 2 |
| 10 | RCADS-25 | Standard block | 1 |
| 11 | Smartphone Ownership | Standard block | 4 |
| 12 | **Branch:** "New Branch" — If *"Do you currently use social media?" = Yes Is Selected* | Branch | — |
| 13 | Social media rank and time (adapted from AoW) | Block | 15 |
| 14 | Screen control, social media impact and doomscrolling's *(sic)* | Block | 3 |
| 15 | Gaming | Standard block | 4 |
| 16 | STAI Short | Standard block | 1 |
| 17 | BIS-BAS | Block | 2 |

**Flow ambiguity:** the Word export does not indent branch contents, so it is not possible to confirm which blocks sit *inside* the `SM_Own = Yes` branch. The most plausible reading is that only block 13 ("Social media rank and time") is inside the branch (blocks 14–17 apply to everyone, and Gaming/STAI/BIS-BAS are clearly not social-media-conditional). But block 14 is social-media-specific in content, so it may also be intended to be inside the branch. **[UNCONFIRMED — needs QSF]**. See anomaly A-11.

No randomisation, embedded-data fields or end-of-survey elements are visible in the export. **[UNCONFIRMED — needs QSF]**

---

## 2. Question-level inventory

Legend: **Var** = Qualtrics export tag (variable name as it will appear in exported data). Codes shown as `label (code)` exactly as exported.

### Block: Introduction
| Var | Type | Content |
|---|---|---|
| `Introduction` | Descriptive text | Study intro: EEG citizen-neuroscience workshop; anonymity code; voluntariness; ethics ref **PSCETHS-1449, approved 5/6/25**; "about 10 minutes". |

### Block: Consent
| Var | Type | Content |
|---|---|---|
| `Consent` | Multiple choice (checkbox list, presumed multi-select) | 6 consent statements, choice codes **2–7** (non-sequential; starts at 2 — code 1 evidently deleted during editing). Statement 4 contains piped text `${date://OtherDate/SL/+2%20day}` (withdrawal deadline = submission date + 2 days). Statement 6 references `m.faizah@leeds.ac.uk`. No visible "I do not consent" option or screen-out branch. Whether all boxes are forced is **[UNCONFIRMED — needs QSF]**. |

### Block: Demographics
| Var | Type | Response detail |
|---|---|---|
| `first_name` | Text entry (single line) | Free text. **Direct identifier.** |
| `last_name` | Text entry (single line) | Free text. **Direct identifier.** |
| `ps_id` | Form with 4 text fields | Constructed participant ID: (1) first two letters of mother's first name, (2) first digit of house number, (3) month of birth, (4) last two letters of postcode. Worked example "JA101CD" is internally consistent. **Quasi-identifying components.** |
| `val_id` | Form with 1 text field | Team-issued validation ID, "three letters (i.e, NDC) followed by two or more digits". Question text contains typos ("haven not", "pleas"). |
| `Ethnicity` | Dropdown | Export elides list: `Indian (1) … Prefer not to say (20)` → 20 options, **full list not recoverable from Word export [UNCONFIRMED — needs QSF]**. Question text typo: "Ethic origin". |
| `DoB` | Text entry (single line) | "Date of Birth (dd/mm/yyyy)" — free text, no visible format validation. **Direct identifier.** |
| `Gender` | Single choice | Male (1), Female (2), Non-binary / third gender (3), Prefer not to say (4). |
| `Medication` | Single choice | Yes (1), No (2). Mental-health medication. **Special-category data.** Question text: "It will not be used…" (capitalised "It" mid-sentence). |

### Block: Hair Type
| Var | Type | Response detail |
|---|---|---|
| `Hair_type` | Dropdown | `1a (1) … 4c (12)` — 12 hair-type categories (EEG practicality measure). Full list elided but reconstructable (1a,1b,1c,2a…4c). The referenced hair-type chart image is **not present in the export** (only Qualtrics UI glyphs are embedded). |

### Block: Edinburgh Handedness Inventory - Short Form
| Var | Type | Response detail |
|---|---|---|
| `Handedness` | Matrix 4×5 | Rows: Writing (1), Throwing (3), Toothbrush (5), Spoon (7) — **row codes 1,3,5,7** (non-sequential; consistent with items deleted from the long-form EHI). Columns: Left hand strongly preferred (1) … Right hand strongly preferred (5). Note: canonical EHI-SF (Veale 2014) response anchors are "Always right / Usually right / Both equally / Usually left / Always left" — administered anchors differ (see anomaly A-19). |

### Block: McArthur Scale
| Var | Type | Response detail |
|---|---|---|
| `Ladder_ses` | Descriptive text | "Imagine that the ladder below pictures how British society is set up." |
| `Ladder_image` | Descriptive text (+ image) | Society-ladder description text. **Ladder image itself absent from export.** |
| `SES_Family` | Slider | 0–10 (11 points). "Mark the rung that best represents where your family would be on this ladder." Canonical MacArthur ladder has 10 rungs (1–10); administered scale is 0–10 (see anomaly A-20). |
| `ladder_school` | Descriptive text | School-ladder framing (lowercase variable name, inconsistent with `Ladder_ses`). |
| `Ladder_image2` | Descriptive text | School-ladder description text; image absent. |
| `SES_Self` | Slider | 0–10 (11 points), school/peer-standing ladder. |

### Block: Karolinska
| Var | Type | Response detail |
|---|---|---|
| `Karolinska` | Single choice, 9 options | KSS 1–9, all points labelled. Item 7 label reads "Sleepy, but **not no** effort to keep awake" (typo; canonical: "Sleepy, but no effort to keep awake"). Item 4 formatted "4- Fairly alert" (spacing inconsistent; canonical label "Rather alert"). |
| `Sleep_Importance` | Multiple choice, "choose up to three" | 11 options (1–11), option 11 = Other + text. Max-3 validation **[UNCONFIRMED — needs QSF]**. Bespoke item, not part of KSS. |
| `Sleep_Own` | Multiple choice, "choose up to three" | 12 options (1–12): 11 = Other + text, 12 = Not sure. Bespoke item, not part of KSS. |

### Block: Mental Well-Being
| Var | Type | Response detail |
|---|---|---|
| `Mental well-being` *(variable name contains space and hyphen)* | Matrix 7×5 | SWEMWBS: 7 items (1–7), columns None of the time (1) … All of the time (5). Wording matches SWEMWBS; recall window "last 2 weeks" matches. **Licensed instrument — registration required (see licensing).** |

### Block: SDQ 25 Items
| Var | Type | Response detail |
|---|---|---|
| `Introduction` | Descriptive text | **Duplicate variable name** — same export tag as the Introduction block's question. Instruction text says "Not True, Somewhat True or **Certainly True**"; six-month window. |
| `sdq` | Matrix 25×3 | 25 SDQ self-report items (1–25), columns Not True (1), Somewhat True (2), **"Clearly true" (3)** — contradicts its own instructions and the canonical SDQ label "Certainly True". Item wording appears to mix the 11–17 self-report and 18+ self-report forms (e.g. item 20 "…family members, friends, colleagues" and item 22 "…home, work or elsewhere" are adult-form phrasings). Canonical SDQ scoring is 0–2; administered codes are 1–3. **Licensed instrument — electronic administration requires youthinmind authorisation.** |

### Block: RCADS-25
| Var | Type | Response detail |
|---|---|---|
| `rcads` | Matrix 25×4 | RCADS-25 items (1–25), columns Never (1) … Always (4). Canonical RCADS coding is 0–3; administered codes 1–4. Instructions explicitly permit skipping. Item 18 "I think about death." — **safeguarding-relevant item**. |

### Block: Smartphone Ownership
| Var | Type | Response detail |
|---|---|---|
| `Smartphone_own` | Single choice | Yes (1), No (2). |
| `Age_smartphone` | Dropdown; display if `Smartphone_own = Yes` | Elided: `Younger than 5 (4) … I'm not sure / I can't remember (10)`. **Codes start at 4** — full list and code map not recoverable **[UNCONFIRMED — needs QSF]**. Typo: "did you you get". |
| `SM_Own` | Single choice | Yes (1), No (2). "Do you currently use social media?" — drives the flow branch. |
| `Age_SM` | Dropdown; display if `SM_Own = Yes` | Elided: `Younger than 5 (13) … I'm not sure / I can't remember (9)`. **Non-monotonic codes (13 … 9)** — code map unrecoverable from Word export **[UNCONFIRMED — needs QSF]**. |

### Block: Social media rank and time (adapted from AoW) — inside `SM_Own = Yes` branch
| Var | Type | Response detail |
|---|---|---|
| `SM_Overuse` | Single choice | Yes (1), No (2), Unsure (3). |
| `DragDrop_SM` | Pick/Group/Rank (drag-and-drop into 2 groups + rank within group 1) | 11 platforms: Facebook (1), Snapchat (2), Instagram (3), TikTok (4), Youtube (5), X (Twitter) (6), Discord (8), Twitch (9), Reddit (10), Kick (11), Threads (12). **Code 7 missing** (deleted platform). Groups: "I have these apps on my phone" / "I don't have these apps on my phone"; rank only meaningful in group 1. |
| `TimeSpent on each ` *(variable name contains spaces and trailing space)* | Matrix 11×6 with choice-level display logic | Columns: 0 minutes (1), 1–15 (2), 15–30 (3), 30–60 (4), 1–2 hours (5), More than 2 hours (6). Rows shown only if the platform was placed in "I have these apps on my phone". **Row 10 (Twitch) has the wrong display condition — it tests `DragDrop_SM = X (Twitter)` instead of Twitch** (duplicated condition; anomaly A-2). Row codes skip 8. Row labels' capitalisation inconsistent with DragDrop_SM ("Youtube" vs "YouTube", "kick"). Column boundaries overlap (15 appears in two bands; 60/1–2 hours ambiguous at boundary). |
| `Acount_privacy` *(sic)* | Single choice | Public (1), Private (2), Unsure (3). |
| `SM_active_passive` | Single choice | Mostly active (1), Mostly passive (4), Both equally (5) — non-sequential codes. |
| `SM_function` | Multiple choice | 11 options, codes 1, 4–13 (2–3 missing). |
| `SM_night_check` | Dropdown | Elided: `Never (1) … More than 5 times (6)` **[UNCONFIRMED — needs QSF]**. |
| `SM_morning_check` | Dropdown | Elided: `(1) … More than 60 minutes (7)` — **first option label is blank in the export** **[UNCONFIRMED — needs QSF]**. |
| `SM_weekdays` | Dropdown | Elided: `Less than 30 minutes (1) … 7 hours or more (11)` **[UNCONFIRMED — needs QSF]**. |
| `SM_weekend/holiday` *(variable name contains slash)* | Dropdown | Elided: `Less than 30 minutes (1) … 7 hours or more (11)` **[UNCONFIRMED — needs QSF]**. |
| `SM_lostrack` | Single choice | Strongly Agree (1), Agree (4), Neither (5), Disagree (6), Strongly disagree (7), Don't know (8) — non-sequential; agree-first direction. |
| `app_reduce` | Single choice | Yes (1), No (2), Sometimes (3). Screen-time-management features question. |
| `Abstaining_SM` | Single choice | **Question text is a duplicate of `app_reduce`** ("Do you use any features designed to reduce…") **but the response options are an effect scale**: Very negatively (1), Somewhat negatively (4), No effect (5), Somewhat positively (6), Very positively (7). The intended question text (presumably about the anticipated effect of abstaining from social media) is missing. **Substantive error — see anomaly A-1.** |
| `Abstaining_days` | Form: 1 text field ("Number of days") | Numeric intent, no visible numeric validation **[UNCONFIRMED — needs QSF]**. Includes definition of social media excluding messaging apps. |
| `SM_family_control` | Single choice | Yes (1), No (2). |

### Block: Screen control, social media impact and doomscrolling's
| Var | Type | Response detail |
|---|---|---|
| `Screen Control` *(space in name)* | Matrix 3×5 | Rows 1–3 (control, dependence, addiction). Columns Strongly agree (1) … Strongly disagree (5) — **agree-first**. |
| `Social media impact ` *(space + trailing space)* | Matrix 4×5 | **Row codes 4–7** (1–3 deleted). Row 4 typo "mental **welling**"; row 5 typo "wellbeing **in** mostly negative". Same agree-first 5-point columns. |
| `Doomscrolling ` *(trailing space)* | Matrix 4×7 | Columns Strongly disagree (1) … Strongly agree (7) — **disagree-first, opposite direction to the two matrices above**. 4 items on compulsive negative-news consumption (resembles items from the Sharma et al. doomscrolling scale — citation to verify). |

### Block: Gaming
| Var | Type | Response detail |
|---|---|---|
| `weekday_games` | Single choice | I do not play video games (1), Less than 5 hours (4), 6-10 (5), 11-15 (6), 16-20 (7), More than 20 (8). Name says "weekday" but question asks **weekly total** (name/content mismatch). Band gap: "Less than 5" → "6-10" leaves 5–6 uncovered. |
| `other_games` | Form: 5 text fields; display logic: **If `weekday_games` = "I do not play video games"** | **Display logic appears inverted** — as exported, only non-gamers are asked to list the games they play most. See anomaly A-3. Variable name (`other_games`) does not match content (top-5 games). |
| `other_games_time` | Matrix 5×5, piped rows; question display: If `other_games` Text Response Is Not Empty | Rows pipe `${other_games /ChoiceTextEntryValue/N}` (note stray space in pipe path — may fail; anomaly A-13). Choice-level display conditions are **five identical copies** of "If [question-level] Text Response Is Not Empty" instead of per-entry conditions — so all five rows display if any game was entered. Columns Less than 5 hours (1) … More than 20 hours (5) — note **no "0/none" column** and bands don't match `weekday_games` bands. |
| `game_time_per_wk_pct` | Slider | 0–100 (%), gaming time spent playing with others. |

### Block: STAI Short
| Var | Type | Response detail |
|---|---|---|
| `STAI-S` *(hyphen in name)* | Matrix 5×4 | Items: upset, frightened, nervous, jittery, confused (1–5). Columns Not at all (1) … Very much (4). Matches the Zsido et al. STAI-5 state short form. **Licensing review required** (parent STAI is Mind Garden-licensed). |

### Block: BIS-BAS
| Var | Type | Response detail |
|---|---|---|
| `bisbas` | Matrix 12×4 | Row codes **1–8, 25, 9, 26, 27** (subset carried over from a longer form). Content = 4 BIS items + 4 BAS Reward Responsiveness items + 4 BAS Drive items (Fun Seeking omitted). Columns Very true for me (1) … Very false for me (4). Item 4 contains a stray closing quote ("…something important'"). |
| `Future Self` *(space in name)* | Essay text (5 lines) | "Imagine yourself 10 years from now… leave one sentence for that future version of yourself." Open-ended; **placed inside the BIS-BAS block**. This is the seed item for the micro-narrative module. |

---

## 3. Cross-cutting observations

**Piped text (2 uses):**
1. Consent statement 4: `${date://OtherDate/SL/+2%20day}` — dynamic withdrawal deadline.
2. `other_games_time` rows: `${other_games /ChoiceTextEntryValue/1..5}` — stray space in the pipe path.

**Display logic (question-level):** `Age_smartphone` (if smartphone), `Age_SM` (if social media), `other_games` (if non-gamer — suspected inversion), `other_games_time` (if any game text).
**Display logic (choice-level):** `TimeSpent on each` (11 conditions, one wrong + one duplicated), `other_games_time` (5 identical conditions).
**Branch (flow-level):** social-media branch on `SM_Own = Yes`; nesting extent unconfirmed.

**Media:** the export contains only Qualtrics UI glyphs (slider handles, required-answer asterisks, speaker icons). The MacArthur ladder images and the hair-type chart are referenced but **not embedded** — original assets must be supplied and licence-checked before migration.

**Validation:** required-answer asterisk glyphs appear adjacent to some questions (Karolinska, EHI, sleep items, BIS-BAS at minimum), but per-question required/optional status, max-selections, and format validation are **not recoverable from the Word export**.

**Sensitive fields:** `first_name`, `last_name`, `DoB`, `ps_id` components (mother's name fragment, house number digit, birth month, postcode fragment), `val_id` (linkage key), `Medication` (special category), `rcads` item 18 (death ideation — safeguarding), plus RCADS/SDQ totals as derived mental-health indicators.

**Variables with structurally unsafe names:** `Mental well-being`, `TimeSpent on each `, `SM_weekend/holiday`, `Screen Control`, `Social media impact `, `Doomscrolling `, `STAI-S`, `Future Self`, `Acount_privacy` (typo), duplicate `Introduction` (×2).

**Scoring requirements implied by content:** EHI-SF laterality classification; KSS single score; SWEMWBS sum + metric conversion; SDQ subscales (emotional, conduct, hyperactivity, peer, prosocial; 5 reverse-scored items) + total difficulties; RCADS-25 anxiety (15) and depression (10) subscales + total, with age/grade T-score norms; STAI-5 sum; BIS/BAS subscale sums with reverse scoring per Carver & White. None of the scoring is encoded in the export — all must be added from canonical sources and verified.
