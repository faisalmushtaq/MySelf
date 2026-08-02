# QSF Resolution — Machine-Level Findings

**Source:** `Yorkshire_Brain_Map_-_NotreDame2026.qsf` (received 2026-08-02, after the Word-export audit).
This document records everything the Word export could not confirm and updates the anomaly register accordingly. The QSF is now the machine source of truth for migration; the Word export remains the human-readable cross-check.

## 1. Survey flow — nesting resolved (closes A-11)

```
Introduction → Consent → Demographics → Hair Type → EHI-SF → McArthur → Karolinska
→ Mental Well-Being → SDQ → RCADS-25 → Smartphone Ownership
→ BRANCH (QID136 SM_Own, choice 1 "Yes" Is Selected):
     ├─ Social media rank and time (adapted from AoW)
     └─ Screen control, social media impact and doomscrolling's
→ Gaming → STAI Short → BIS-BAS
```

**Both** social-media blocks are inside the branch; Gaming, STAI and BIS-BAS are asked of everyone. There is **no randomisation anywhere**, no embedded-data flow elements, no end-of-survey redirect (`EOSMessage: none` = default thank-you).

Survey options that matter for migration:
- **Back button: enabled** — participants can navigate backwards throughout.
- Progress bar: displayed as text ("Text").
- Partial data recorded after +1 hour of inactivity.
- Ballot-box-stuffing prevention: off.

## 2. A Trash block exists (previously invisible)

`Trash / Unused Questions` contains five removed questions, two of them substantive: **`STAI-T`** (5 trait-anxiety items, "Almost Never … Almost Always") and **`Fasting`** ("Are you fasting today?", Yes/No), plus three empty placeholders (Q57–Q59). These were part of earlier drafts. Historical datasets may contain these columns; the crosswalk marks them `retired-before-fieldwork` (to confirm against the first exported dataset).

## 3. Elided dropdown choice lists — all resolved (closes A-39)

- **Ethnicity (QID16):** full 20-option UK-census-style list, sequential codes 1–20 (Indian, Pakistani, Bangladeshi, Chinese, Any other Asian background, Caribbean, African, Any other Black/Black British/Caribbean, White and Black Caribbean, White and Black African, White and Asian, Any other Mixed, English/Welsh/Scottish/NI/British, Irish, Gypsy or Irish Traveller, Roma, Any other White background, Any other ethnic group, Arab, Prefer not to say). Note: display order is code order, which interleaves Asian/Black/Mixed/White groupings in the non-standard census order — acceptable, but the standard ONS ordering differs; noted for the composer.
- **Age_smartphone (QID135):** display order "Younger than 5, 6, 7, 8, 9, 10, 11 … 25, I'm not sure" with scrambled codes (4,5,27,28,11,29,12–26,10). **The option "5" is missing** — the list jumps from "Younger than 5" to "6" (new anomaly A-43).
- **Age_SM (QID137):** same structure, codes 13–33 + 9; **also missing "5"** (A-43).
- **SM_night_check:** Never (1), 1-2 times (4), 3-5 times (5), More than 5 times (6).
- **SM_morning_check:** **"<5 minutes" (1)** — the blank label in the Word export was an HTML-swallowed `<`; then 5-10 (4), 11-30 (5), 31-60 (6), More than 60 minutes (7). Closes A-14.
- **SM_weekdays / SM_weekend/holiday:** identical 9-option lists: Less than 30 minutes (1), 30 minutes–1 hour (4), 1–2 (5), 2–3 (6), 3–4 (7), 4–5 (8), 5–6 (9), 6–7 (10), 7 hours or more (11).
- **Hair_type:** 1a…4c, sequential 1–12 (as assumed).

## 4. Validation settings — all resolved (closes A-40)

| Question | Setting |
|---|---|
| Hard **ForceResponse ON** | first_name, last_name, ps_id, val_id, DoB, Ethnicity, Gender, Medication, Hair_type, Mental well-being (SWEMWBS), Handedness (EHI), **sdq**, **rcads**, SM_Overuse, Consent |
| Soft **RequestResponse** (prompt once, may continue) | Karolinska, bisbas, STAI-S, Screen Control, Social media impact |
| Choice-range | Sleep_Importance: 1–3 required, forced; Sleep_Own: 1–3, not forced |
| Text | DoB: `DateAltFormat` date validation (A-37 partially withdrawn — validation exists); Future Self: MinChars 1; Abstaining_days: forced-type flag only, **no numeric validation** (free text confirmed) |
| Consent | **MinChoices 6** — all six statements must be ticked; still no decline pathway (A-5 stands) |
| No force at all | DragDrop_SM, TimeSpent, Acount_privacy, SM_active_passive, SM_function, all SM dropdowns, SM_lostrack, app_reduce, Abstaining_SM, SM_family_control, Doomscrolling, weekday_games, other_games, other_games_time, game_time_per_wk_pct |

**New anomaly A-44 (C4 — ethics/data-quality):** the RCADS-25 instructions promise *"if you do not want to answer a question, you can skip it"*, but the question is configured **ForceResponse ON** — participants cannot skip. The instruction and the behaviour contradict each other; this affects consent accuracy and RCADS missing-data assumptions. SDQ is also hard-forced, which conflicts with its own "answer all items as best you can" (advisory) framing and with MySelf's decline-path principle. Requires researcher + ethics decision for r1.

## 5. Display logic — confirmed and corrected

- **A-3 CONFIRMED as a genuine live error:** `other_games` displays if `weekday_games` choice 1 ("I do not play video games") **Is Selected**. Only non-gamers are asked which games they play.
- **A-2 CONFIRMED:** in `TimeSpent on each`, the Twitch row's condition is `DragDrop_SM Group/6` (X/Twitter) instead of Group/9 (Twitch). Definitive duplicated/wrong condition.
- **A-4 WITHDRAWN:** the QSF shows `other_games_time` choice-level logic is per-row correct (row *N* ← game *N* NotEmpty). The Word export rendered all five conditions identically; that was an export artefact, not a survey error. The question-level condition is "game 1 NotEmpty" — so a participant who fills only slots 2–5 would skip the matrix entirely; edge case worth noting but plausible as intended (minor C2 note folded into A-3's decision).
- `Age_smartphone` ← Smartphone_own = Yes; `Age_SM` ← SM_Own = Yes (as assumed).

## 6. Custom JavaScript — the only unsupported construct (closes A-41)

`SES_Family` (QID63) and `SES_Self` (QID66) carry Qualtrics JS that paints the MacArthur ladder image as the slider background from **`https://sparqtools.org/wp-content/uploads/2018/06/ladder-115x300.png`** (Stanford SPARQ MacArthur toolkit asset). No other question has JS. In MySelf this becomes a first-class "ladder" response control (image + tappable rungs) — no scripting needed; the JS is `PRESENT`-disposition (presentation mechanism only). Asset licence: SPARQ publishes the MacArthur toolkit for research use — confirm attribution requirements.

## 7. Images — all located (closes A-42)

| Asset | Location | Action |
|---|---|---|
| Hair-type chart (700×301) | Leeds Qualtrics graphics library `IM_0VW7lNCmjc75IGi` | Download via account access; **identify original source/licence** (commercial hair-typology charts are commonly copyrighted) |
| MacArthur ladder (199×454) | Leeds Qualtrics graphics library `IM_9QR5ycr6HarV5Iy` (used in both ladder intro texts) | Download via account access; likely the SPARQ asset |
| Ladder slider background | sparqtools.org URL above | Mirror locally in the release bundle (no runtime external dependency) |

## 8. Sliders

`SES_Family`/`SES_Self`: 0–10, 10 gridlines, **snap-to-grid off** (continuous drag; Qualtrics stores to configured decimal places). `game_time_per_wk_pct`: 0–100, gridlines 10, snap off. Migration note: MacArthur canonical form is a discrete 10-rung choice; the administered continuous 0–10 slider is a further deviation detail under A-20 (values like 7.4 may exist in historical data — the crosswalk must not assume integers).

## 9. Remaining unresolved after QSF

1. Original source + licence of the hair-type chart image (A-42 residue).
2. Whether historical datasets contain `STAI-T`/`Fasting` columns (§2).
3. All C2/C4 researcher and licensing decisions (unchanged).

Everything else previously marked `[UNCONFIRMED — needs QSF]` is now resolved; the machine-readable inventory extracted from the QSF lives at `source-materials/qsf_questions.json`.
