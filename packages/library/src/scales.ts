import type { ResponseScale } from "@myself/schema";
import { opt, opts } from "./util.js";

/**
 * Shared response scales for the YBM library.
 * Every migrated option carries its legacy Qualtrics recode (`legacyCode`);
 * canonical codes are clean and ordinal. The crosswalk is generated from
 * these pairs — codes are never silently recoded (docs/07 §2).
 * All code maps are taken verbatim from the QSF (docs/10 §3).
 */

export const yesNo: ResponseScale = {
  key: "scale.yes_no",
  version: "1.0.0",
  name: "Yes / No",
  direction: "unordered",
  options: [opt(1, "Yes", 1), opt(2, "No", 2)],
};

export const yesNoUnsure: ResponseScale = {
  key: "scale.yes_no_unsure",
  version: "1.0.0",
  name: "Yes / No / Unsure",
  direction: "unordered",
  options: [opt(1, "Yes", 1), opt(2, "No", 2), opt(3, "Unsure", 3, "dont_know")],
};

export const yesNoSometimes: ResponseScale = {
  key: "scale.yes_no_sometimes",
  version: "1.0.0",
  name: "Yes / No / Sometimes",
  direction: "unordered",
  options: [opt(1, "Yes", 1), opt(2, "No", 2), opt(3, "Sometimes", 3)],
};

export const gender4: ResponseScale = {
  key: "scale.gender_4",
  version: "1.0.0",
  name: "Gender (4 options)",
  direction: "unordered",
  options: [
    opt(1, "Male", 1),
    opt(2, "Female", 2),
    opt(3, "Non-binary / third gender", 3),
    opt(4, "Prefer not to say", 4, "decline"),
  ],
};

/** UK-census-style 20-option ethnicity list, codes identical to Qualtrics. */
export const ethnicityUk20: ResponseScale = {
  key: "scale.ethnicity_uk20",
  version: "1.0.0",
  name: "Ethnic origin (UK, 20 options, as administered)",
  direction: "unordered",
  options: [
    ...opts(
      [
        "Indian",
        "Pakistani",
        "Bangladeshi",
        "Chinese",
        "Any other Asian background",
        "Caribbean",
        "African",
        "Any other Black, Black British, or Caribbean background",
        "White and Black Caribbean",
        "White and Black African",
        "White and Asian",
        "Any other Mixed or multiple ethnic backgrounds",
        "English, Welsh, Scottish, Northern Irish or British",
        "Irish",
        "Gypsy or Irish Traveller",
        "Roma",
        "Any other White background",
        "Any other ethnic group",
        "Arab",
      ],
      1,
    ),
    opt(20, "Prefer not to say", 20, "decline"),
  ],
};

/**
 * Hair type (1a-4c). Each option carries an illustration key so participants
 * choose by looking at the curl pattern rather than decoding a code; the
 * label stays authoritative and is shown with every tile.
 */
const hairLabels = ["1a", "1b", "1c", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"] as const;
const hairDescriptions: Record<string, string> = {
  "1a": "Straight, fine",
  "1b": "Straight, medium",
  "1c": "Straight, coarse",
  "2a": "Loose waves",
  "2b": "Defined waves",
  "2c": "Strong waves",
  "3a": "Loose curls",
  "3b": "Springy curls",
  "3c": "Tight curls",
  "4a": "Soft coils",
  "4b": "Zig-zag coils",
  "4c": "Tight coils",
};

export const hairType12: ResponseScale = {
  key: "scale.hair_type_12",
  version: "2.0.0",
  name: "Hair type (1a-4c classification; described in plain words)",
  direction: "unordered",
  scoringNote:
    "Codes 1-12 run 1a, 1b, 1c, 2a … 4c in order. The classification code is kept in codeLabel for the codebook; participants see the picture and the description only.",
  options: hairLabels.map((label, i) => ({
    code: i + 1,
    legacyCode: i + 1,
    // The participant reads a description, not a classification code.
    label: hairDescriptions[label] ?? label,
    codeLabel: label,
    kind: "substantive" as const,
    textEntry: false,
    illustration: `hair:${label}`,
  })),
};

/** Calendar months, for the birth-month step of the secret code (D-23). */
export const month12: ResponseScale = {
  key: "scale.month_12",
  version: "1.0.0",
  name: "Calendar month",
  direction: "ascending",
  options: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ].map((label, i) => ({
    code: i + 1,
    label,
    kind: "substantive" as const,
    textEntry: false,
  })),
};

/** KSS canonical labels (D-08; A-8 typo corrected, point 4 "Rather alert"). */
export const kss9Canonical: ResponseScale = {
  key: "scale.kss_9pt",
  version: "1.0.0",
  name: "KSS 9-point sleepiness scale (canonical labels)",
  direction: "ascending",
  options: [
    opt(1, "1 - Extremely alert", 1),
    opt(2, "2 - Very alert", 2),
    opt(3, "3 - Alert", 3),
    opt(4, "4 - Rather alert", 4),
    opt(5, "5 - Neither alert nor sleepy", 5),
    opt(6, "6 - Some signs of sleepiness", 6),
    opt(7, "7 - Sleepy, but no effort to keep awake", 7),
    opt(8, "8 - Sleepy, some effort to keep awake", 8),
    opt(9, "9 - Very sleepy, great effort to keep awake, fighting sleep", 9),
  ],
  scoringNote: "Single-item state measure; score = selected code (1-9).",
};

/** Exact administered YBM labels preserved (A-8). */
export const kss9AsAdministered: ResponseScale = {
  ...kss9Canonical,
  key: "scale.kss_9pt_ybm",
  name: "KSS 9-point scale as administered in YBM 2026",
  options: kss9Canonical.options.map((o) => {
    if (o.code === 4) return { ...o, label: "4- Fairly alert" };
    if (o.code === 7) return { ...o, label: "7 - Sleepy, but not no effort to keep awake" };
    return o;
  }),
};

/** EHI-SF canonical anchors (Veale 2014) — right-anchored; VERIFY before publish. */
export const ehiSf5Canonical: ResponseScale = {
  key: "scale.ehi_sf_5pt",
  version: "1.0.0",
  name: "EHI-SF 5-point hand-preference scale (canonical, Veale 2014 anchors)",
  direction: "ascending",
  options: opts(["Always right", "Usually right", "Both equally", "Usually left", "Always left"]),
  scoringNote:
    "Veale (2014) laterality quotient scoring; anchor wording to be verified against the published form before approval.",
};

/** Administered YBM anchors (left-anchored, 5-point) — A-19. */
export const ehiSf5AsAdministered: ResponseScale = {
  key: "scale.ehi_sf_5pt_ybm",
  version: "1.0.0",
  name: "EHI 5-point scale as administered in YBM 2026",
  direction: "ascending",
  options: opts([
    "Left hand strongly preferred",
    "Left hand preferred",
    "Indifferent",
    "Right hand preferred",
    "Right hand strongly preferred",
  ]),
};

export const swemwbs5: ResponseScale = {
  key: "scale.swemwbs_5pt",
  version: "1.0.0",
  name: "SWEMWBS 5-point frequency scale",
  direction: "ascending",
  options: opts(["None of the time", "Rarely", "Some of the time", "Often", "All of the time"]),
};

/** SDQ canonical coding 0-2 with canonical anchor labels; legacy 1-3 (A-6/A-16). */
export const sdq3Canonical: ResponseScale = {
  key: "scale.sdq_3pt",
  version: "1.0.0",
  name: "SDQ 3-point scale (canonical: Not True / Somewhat True / Certainly True, coded 0-2)",
  direction: "ascending",
  options: [opt(0, "Not True", 1), opt(1, "Somewhat True", 2), opt(2, "Certainly True", 3)],
  scoringNote: "Canonical SDQ item coding 0-2; Qualtrics administered 1-3 (crosswalk pair).",
};

/** As administered: "Clearly true" anchor preserved (A-6), legacy codes shown as stored. */
export const sdq3AsAdministered: ResponseScale = {
  key: "scale.sdq_3pt_ybm",
  version: "1.0.0",
  name: "SDQ 3-point scale as administered in YBM 2026 ('Clearly true')",
  direction: "ascending",
  options: [opt(0, "Not True", 1), opt(1, "Somewhat True", 2), opt(2, "Clearly true", 3)],
};

/** RCADS canonical coding 0-3; legacy 1-4 (A-16). */
export const rcads4: ResponseScale = {
  key: "scale.rcads_4pt",
  version: "1.0.0",
  name: "RCADS 4-point frequency scale (canonical coding 0-3)",
  direction: "ascending",
  options: [opt(0, "Never", 1), opt(1, "Sometimes", 2), opt(2, "Often", 3), opt(3, "Always", 4)],
  scoringNote: "Canonical RCADS coding 0-3 required by published T-score norms; Qualtrics stored 1-4.",
};

export const stai4: ResponseScale = {
  key: "scale.stai_4pt",
  version: "1.0.0",
  name: "STAI 4-point state-intensity scale",
  direction: "ascending",
  options: opts(["Not at all", "Somewhat", "Moderately", "Very much"]),
};

export const bisbas4: ResponseScale = {
  key: "scale.bisbas_4pt",
  version: "1.0.0",
  name: "BIS/BAS 4-point true-false scale",
  direction: "descending",
  options: opts(["Very true for me", "Somewhat true for me", "Somewhat false for me", "Very false for me"]),
  scoringNote: "1 = very true; most items reverse-scored per Carver & White (1994) so higher = more of trait.",
};

export const doomscroll7: ResponseScale = {
  key: "scale.doomscroll_7pt",
  version: "1.0.0",
  name: "Doomscrolling 7-point agreement scale (disagree-first)",
  direction: "ascending",
  options: opts([
    "Strongly disagree",
    "Disagree",
    "Somewhat disagree",
    "Neutral",
    "Somewhat agree",
    "Agree",
    "Strongly agree",
  ]),
};

/** Agree-first 5-point (Screen control / Social media impact) — direction descending agreement. */
export const agree5Desc: ResponseScale = {
  key: "scale.agree_5pt_desc",
  version: "1.0.0",
  name: "5-point agreement scale, agree-first (1 = Strongly agree)",
  direction: "descending",
  options: opts([
    "Strongly agree",
    "Somewhat agree",
    "Neither agree nor disagree",
    "Somewhat disagree",
    "Strongly disagree",
  ]),
};

/** SM_lostrack: agree-first with Don't know; legacy 1,4,5,6,7,8 (A-15). */
export const agree5LostTrack: ResponseScale = {
  key: "scale.agree_5pt_dk",
  version: "1.0.0",
  name: "5-point agreement, agree-first, with Don't know",
  direction: "descending",
  options: [
    opt(1, "Strongly Agree", 1),
    opt(2, "Agree", 4),
    opt(3, "Neither agree nor disagree", 5),
    opt(4, "Disagree", 6),
    opt(5, "Strongly disagree", 7),
    opt(6, "Don’t know", 8, "dont_know"),
  ],
};

/** Anticipated abstention effect (D-01 corrected item); legacy 1,4,5,6,7. */
export const abstainEffect5: ResponseScale = {
  key: "scale.abstain_effect_5pt",
  version: "1.0.0",
  name: "Anticipated effect scale (Very negatively - Very positively)",
  direction: "ascending",
  options: [
    opt(1, "Very negatively", 1),
    opt(2, "Somewhat negatively", 4),
    opt(3, "No effect", 5),
    opt(4, "Somewhat positively", 6),
    opt(5, "Very positively", 7),
  ],
};

/** Social-media platforms; legacy codes skip 7 (A-15). Canonical 1-11 in display order. */
export const smPlatforms: ResponseScale = {
  key: "scale.sm_platforms",
  version: "1.0.0",
  name: "Social-media platforms (11, as administered)",
  direction: "unordered",
  options: [
    opt(1, "Facebook", 1),
    opt(2, "Snapchat", 2),
    opt(3, "Instagram", 3),
    opt(4, "TikTok", 4),
    opt(5, "YouTube", 5),
    opt(6, "X (Twitter)", 6),
    opt(7, "Discord", 8),
    opt(8, "Twitch", 9),
    opt(9, "Reddit", 10),
    opt(10, "Kick", 11),
    opt(11, "Threads", 12),
  ],
};

/** Per-sitting time bands (TimeSpent columns; boundary overlaps preserved — A-36/C2 pending future wave). */
export const smSittingTime6: ResponseScale = {
  key: "scale.sm_sitting_time_6pt",
  version: "1.0.0",
  name: "Time per sitting (6 bands, as administered)",
  direction: "ascending",
  options: opts(["0 minutes", "1–15 minutes", "15–30 minutes", "30–60 minutes", "1–2 hours", "More than 2 hours"]),
};

/** Reasons for social-media use; legacy 1,4-13 (A-15). */
export const smFunctions11: ResponseScale = {
  key: "scale.sm_functions_11",
  version: "1.0.0",
  name: "Reasons for using social media (11 options)",
  direction: "unordered",
  options: [
    opt(1, "Stay in touch with friends or family", 1),
    opt(2, "Entertainment", 4),
    opt(3, "When I am bored", 5),
    opt(4, "Keep up with news or current events", 6),
    opt(5, "Follow influencers or celebrities", 7),
    opt(6, "Find information or learn new things", 8),
    opt(7, "Share my own content or express myself", 9),
    opt(8, "Feel connected to online communities", 10),
    opt(9, "School or studying", 11),
    opt(10, "Shopping or discovering products", 12),
    opt(11, "Keep up with trends or viral content", 13),
  ],
};

export const activePassive: ResponseScale = {
  key: "scale.sm_active_passive",
  version: "1.0.0",
  name: "Active vs passive social-media use",
  direction: "unordered",
  options: [
    opt(1, "Mostly active: I often post, comment, message, or share content", 1),
    opt(2, "Mostly passive: I mostly look, scroll, or watch without posting much", 4),
    opt(3, "Both equally", 5),
  ],
};

export const accountPrivacy: ResponseScale = {
  key: "scale.sm_account_privacy",
  version: "1.0.0",
  name: "Account privacy",
  direction: "unordered",
  options: [opt(1, "Public", 1), opt(2, "Private", 2), opt(3, "Unsure", 3, "dont_know")],
};

/** Night-time checks; legacy 1,4,5,6. */
export const nightChecks4: ResponseScale = {
  key: "scale.sm_night_checks_4pt",
  version: "1.0.0",
  name: "Night-time social-media checks",
  direction: "ascending",
  options: [opt(1, "Never", 1), opt(2, "1-2 times", 4), opt(3, "3-5 times", 5), opt(4, "More than 5 times", 6)],
};

/** Morning check latency; legacy 1,4,5,6,7 (first label "<5 minutes" — A-14 resolved). */
export const morningLatency5: ResponseScale = {
  key: "scale.sm_morning_latency_5pt",
  version: "1.0.0",
  name: "Time to first social-media check after waking",
  direction: "ascending",
  options: [
    opt(1, "<5 minutes", 1),
    opt(2, "5-10 minutes", 4),
    opt(3, "11-30 minutes", 5),
    opt(4, "31-60 minutes", 6),
    opt(5, "More than 60 minutes", 7),
  ],
};

/** Daily social-media time; legacy 1,4-11 (shared by school-day and non-school-day items). */
export const smDailyTime9: ResponseScale = {
  key: "scale.sm_daily_time_9pt",
  version: "1.0.0",
  name: "Daily social-media time (9 bands)",
  direction: "ascending",
  options: [
    opt(1, "Less than 30 minutes", 1),
    opt(2, "30 minutes–1 hour", 4),
    opt(3, "1–2 hours", 5),
    opt(4, "2–3 hours", 6),
    opt(5, "3–4 hours", 7),
    opt(6, "4–5 hours", 8),
    opt(7, "5–6 hours", 9),
    opt(8, "6–7 hours", 10),
    opt(9, "7 hours or more", 11),
  ],
};

/** Weekly gaming hours; legacy 1,4-8; band gap 5-6 preserved (A-9, C3). */
export const gamingHours6: ResponseScale = {
  key: "scale.gaming_hours_6pt",
  version: "1.0.0",
  name: "Weekly gaming hours (6 bands, as administered)",
  direction: "ascending",
  options: [
    opt(1, "I do not play video games", 1),
    opt(2, "Less than 5 hours", 4),
    opt(3, "6-10 hours", 5),
    opt(4, "11-15 hours", 6),
    opt(5, "16-20 hours", 7),
    opt(6, "More than 20 hours", 8),
  ],
};

/** Per-game weekly hours (no zero band by design — a listed game is played). */
export const gameHours5: ResponseScale = {
  key: "scale.game_hours_5pt",
  version: "1.0.0",
  name: "Per-game weekly hours (5 bands)",
  direction: "ascending",
  options: opts(["Less than 5 hours", "6-10 hours", "11-15 hours", "16-20 hours", "More than 20 hours"]),
};

/**
 * Age-of-adoption scales. Canonical: ordinal 1 = "Younger than 5" through
 * 22 = "25", plus 99 = not sure. Option "5" added per D-04 (A-43) — it has NO
 * legacy code (legacy data cannot contain it). Legacy maps differ between the
 * two questions (QSF: scrambled codes), hence two scale instances.
 */
const ageLabels = [
  "Younger than 5",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
] as const;

const smartphoneLegacy: (number | undefined)[] = [
  4, undefined, 5, 27, 28, 11, 29, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
];
const smLegacy: (number | undefined)[] = [
  13, undefined, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
];

export const ageAdoptionSmartphone: ResponseScale = {
  key: "scale.age_adoption_smartphone",
  version: "1.0.0",
  name: "Age of first smartphone (canonical ordinal; legacy Qualtrics codes preserved)",
  direction: "ascending",
  options: [
    ...ageLabels.map((label, i) => opt(i + 1, label, smartphoneLegacy[i])),
    opt(99, "I’m not sure / I can’t remember", 10, "dont_know"),
  ],
};

export const ageAdoptionSocialMedia: ResponseScale = {
  key: "scale.age_adoption_sm",
  version: "1.0.0",
  name: "Age of first social-media use (canonical ordinal; legacy Qualtrics codes preserved)",
  direction: "ascending",
  options: [
    ...ageLabels.map((label, i) => opt(i + 1, label, smLegacy[i])),
    opt(99, "I’m not sure / I can’t remember", 9, "dont_know"),
  ],
};

export const sleepImportance11: ResponseScale = {
  key: "scale.sleep_importance_11",
  version: "1.0.0",
  name: "Sleep priorities (choose up to three)",
  direction: "unordered",
  options: [
    ...opts(
      [
        "Being able to fall asleep easily",
        "Staying asleep through the night",
        "Waking up feeling rested",
        "Getting enough hours of sleep",
        "Having a regular bedtime or routine",
        "Feeling relaxed before bed",
        "Not being disturbed by noise or other people",
        "Not using my phone or screens too late",
        "Having enough time to myself in the evening",
        "Not worrying about school, friends or family",
      ],
      1,
    ),
    opt(11, "Other", 11, "other_specify", true),
  ],
};

export const sleepKnow12: ResponseScale = {
  key: "scale.sleep_know_12",
  version: "1.0.0",
  name: "What participants want to know about their sleep (choose up to three)",
  direction: "unordered",
  options: [
    ...opts(
      [
        "How much sleep I get",
        "How good my sleep quality is",
        "How long it takes me to fall asleep",
        "How often I wake up during the night",
        "Whether I get enough deep sleep",
        "How my sleep affects my mood",
        "How my sleep affects my concentration or learning",
        "How phone or screen use affects my sleep",
        "How stress or worries affect my sleep",
        "What I could do to sleep better",
      ],
      1,
    ),
    opt(11, "Other", 11, "other_specify", true),
    opt(12, "Not sure", 12, "dont_know"),
  ],
};

export const allScales: ResponseScale[] = [
  yesNo,
  yesNoUnsure,
  yesNoSometimes,
  gender4,
  ethnicityUk20,
  hairType12,
  month12,
  kss9Canonical,
  kss9AsAdministered,
  ehiSf5Canonical,
  ehiSf5AsAdministered,
  swemwbs5,
  sdq3Canonical,
  sdq3AsAdministered,
  rcads4,
  stai4,
  bisbas4,
  doomscroll7,
  agree5Desc,
  agree5LostTrack,
  abstainEffect5,
  smPlatforms,
  smSittingTime6,
  smFunctions11,
  activePassive,
  accountPrivacy,
  nightChecks4,
  morningLatency5,
  smDailyTime9,
  gamingHours6,
  gameHours5,
  ageAdoptionSmartphone,
  ageAdoptionSocialMedia,
  sleepImportance11,
  sleepKnow12,
];
