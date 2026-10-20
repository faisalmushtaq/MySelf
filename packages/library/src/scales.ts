import type { ResponseScale, ScaleOption } from "@myself/schema";
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

/**
 * UK-census-style 20-option ethnicity list, codes identical to Qualtrics.
 *
 * 2.0.0 (D-53): listed most common first in West Yorkshire, so most people find
 * theirs at the top. Order from usual residents of Bradford, Calderdale,
 * Kirklees, Leeds and Wakefield in the 2021 Census (ONS table TS021, Open
 * Government Licence), share of 2,351,579 in brackets. Codes are exactly those
 * of 1.0.0 — only the order on screen changed — so answers compare across
 * releases. "Prefer not to say" stays last.
 */
const ethnicityLabels: Record<number, string> = {
  1: "Indian",
  2: "Pakistani",
  3: "Bangladeshi",
  4: "Chinese",
  5: "Any other Asian background",
  6: "Caribbean",
  7: "African",
  8: "Any other Black, Black British, or Caribbean background",
  9: "White and Black Caribbean",
  10: "White and Black African",
  11: "White and Asian",
  12: "Any other Mixed or multiple ethnic backgrounds",
  13: "English, Welsh, Scottish, Northern Irish or British",
  14: "Irish",
  15: "Gypsy or Irish Traveller",
  16: "Roma",
  17: "Any other White background",
  18: "Any other ethnic group",
  19: "Arab",
};
const ethnicityByWestYorkshire2021 = [
  13, // White: English, Welsh, Scottish, Northern Irish or British (72.0%)
  2, // Pakistani (10.7%)
  17, // Other White (3.7%)
  1, // Indian (2.7%)
  7, // African (2.0%)
  18, // Any other ethnic group (1.2%)
  5, // Other Asian (1.2%)
  9, // White and Black Caribbean (1.0%)
  11, // White and Asian (0.9%)
  3, // Bangladeshi (0.9%)
  6, // Caribbean (0.7%)
  14, // Irish (0.6%)
  12, // Other Mixed (0.5%)
  4, // Chinese (0.5%)
  19, // Arab (0.5%)
  8, // Other Black (0.4%)
  10, // White and Black African (0.3%)
  16, // Roma (0.2%)
  15, // Gypsy or Irish Traveller (0.1%)
];

export const ethnicityUk20: ResponseScale = {
  key: "scale.ethnicity_uk20",
  version: "2.0.0",
  name: "Ethnic origin (UK, 20 options; most common in West Yorkshire first)",
  direction: "unordered",
  options: [
    ...ethnicityByWestYorkshire2021.map((code) => opt(code, ethnicityLabels[code]!, code)),
    opt(20, "Prefer not to say", 20, "decline"),
  ],
};

/** Whether English was the first language spoken (D-53). */
export const firstLanguageEnglish: ResponseScale = {
  key: "scale.first_language_english",
  version: "1.0.0",
  name: "English as first language (yes / no / alongside another)",
  direction: "unordered",
  options: [
    opt(1, "Yes"),
    opt(2, "No"),
    opt(3, "I learned English and another language at the same time"),
  ],
};

/**
 * Languages other than English (D-53), most common first in West Yorkshire:
 * the languages the 2021 Census names individually (table TS024, main
 * language, usual residents of Bradford, Calderdale, Kirklees, Leeds and
 * Wakefield, ONS, Open Government Licence), in order of how many people there
 * gave each as their main language. Anything else is "Another language",
 * named in a box.
 */
export const LANGUAGES: { code: number; label: string; key: string }[] = [
  { code: 1, label: "Urdu", key: "urdu" }, // 29,077
  { code: 2, label: "Punjabi", key: "punjabi" }, // 27,309
  { code: 3, label: "Polish", key: "polish" }, // 26,929
  { code: 4, label: "Arabic", key: "arabic" }, // 9,443
  // Mandarin and Cantonese separately (D-58): not mutually intelligible as
  // spoken languages, so one "Chinese" option could not say which is meant.
  // Together 6,633 in West Yorkshire; kept side by side where "Chinese" was.
  // NEW CODES, 16 and 17: code 5 was "Chinese (Mandarin or Cantonese)" in
  // the fielded 10.0.0, and a code never changes meaning once answers carry
  // it. 5 is retired, not reused.
  { code: 16, label: "Mandarin Chinese", key: "mandarin" },
  { code: 17, label: "Cantonese Chinese", key: "cantonese" },
  { code: 6, label: "Gujarati", key: "gujarati" }, // 5,998
  { code: 7, label: "Bengali (including Sylheti)", key: "bengali" }, // 5,488
  { code: 8, label: "Portuguese", key: "portuguese" }, // 4,610
  { code: 9, label: "Spanish", key: "spanish" }, // 3,799
  { code: 10, label: "Russian", key: "russian" }, // 2,865
  { code: 11, label: "French", key: "french" }, // 2,273
  { code: 12, label: "Tamil", key: "tamil" }, // 1,254
  { code: 13, label: "British Sign Language", key: "bsl" }, // 1,106
  { code: 14, label: "Turkish", key: "turkish" }, // 739
];
/** "Another language", as fielded in 10.0.0. */
export const ANOTHER_LANGUAGE_CODE = 15;
/** Fielded in 10.0.0 as "Chinese (Mandarin or Cantonese)"; retired when Mandarin and Cantonese were split (D-58). */
export const RETIRED_LANGUAGE_CODES = [5];

export const otherLanguages: ResponseScale = {
  key: "scale.other_languages",
  version: "1.0.0",
  name: "Languages other than English (most common in West Yorkshire first; select all)",
  direction: "unordered",
  options: [
    ...LANGUAGES.map((l) => opt(l.code, l.label)),
    opt(ANOTHER_LANGUAGE_CODE, "Another language", undefined, "other_specify"),
  ],
};

/**
 * How well a language is understood, or spoken (D-53, D-58). Worded after the
 * Census question on English ("very well / well / not well / not at all"),
 * with "only a few words" before "not at all". ONE scale for both questions,
 * so understanding and speaking are directly comparable: someone who
 * understands Urdu very well and speaks only a few words (receptive, not
 * expressive, bilingualism) is 1 on one and 4 on the other.
 */
export const languageAbility5: ResponseScale = {
  key: "scale.language_ability_5",
  version: "1.0.0",
  name: "How well a language is understood or spoken (very well to not at all)",
  direction: "descending",
  options: [opt(1, "Very well"), opt(2, "Well"), opt(3, "Not very well"), opt(4, "Only a few words"), opt(5, "Not at all")],
  scoringNote:
    "1 = very well … 5 = not at all. The same scale for understanding and speaking, so speak_<language> − understand_<language> > 0 marks a language understood better than it is spoken.",
};

/**
 * Sleep Quality Scale (Snyder et al., 2018): 0-10, with the published
 * groupings drawn beneath the numbers (D-53). The number is the answer and
 * the score; the band is shown, never stored.
 */
export const sqs11: ResponseScale = {
  key: "scale.sqs_0_10",
  version: "1.0.0",
  name: "Sleep Quality Scale, 0 (Terrible) to 10 (Excellent)",
  direction: "ascending",
  options: Array.from({ length: 11 }, (_, n) => ({
    code: n,
    label: String(n),
    value: n,
    kind: "substantive" as const,
    textEntry: false,
  })),
  bands: [
    { label: "Terrible", from: 0, to: 0 },
    { label: "Poor", from: 1, to: 3 },
    { label: "Fair", from: 4, to: 6 },
    { label: "Good", from: 7, to: 9 },
    { label: "Excellent", from: 10, to: 10 },
  ],
  scoringNote: "Score = the number chosen, 0-10. Bands (Snyder et al., 2018): 0 terrible, 1-3 poor, 4-6 fair, 7-9 good, 10 excellent.",
};

/**
 * How family manage social media (D-53). The study's own options, not a
 * published measure; asked only of those who said their family does.
 */
export const smFamilyControlHow: ResponseScale = {
  key: "scale.sm_family_control_how",
  version: "1.0.0",
  name: "How family manage social media use (select all)",
  direction: "unordered",
  options: [
    opt(1, "They set time limits or times when I can't use it"),
    opt(2, "They use parental controls or a monitoring app"),
    opt(3, "They decide which apps or sites I can use"),
    opt(4, "They check my messages, posts or who I follow"),
    opt(5, "They know my passwords or can get into my accounts"),
    opt(6, "They take my phone or device away at certain times"),
    opt(7, "They have to agree before I get a new app or account"),
    opt(8, "Something else", undefined, "other_specify"),
  ],
};

/**
 * How often AI chatbots are used (D-59). The study's own wording, with the
 * steps of the social-media frequency questions so the two sit side by side.
 */
export const aiUseFrequency: ResponseScale = {
  key: "scale.ai_use_frequency",
  version: "1.0.0",
  name: "How often AI chatbots are used (never to several times a day)",
  direction: "ascending",
  options: [
    opt(1, "Never"),
    // Published as "Less than once a week"; a code never changes meaning, so a
    // label for exactly once a week would need a new code (D-62).
    opt(2, "Less than once a week"),
    opt(3, "A few times a week"),
    opt(4, "Once a day"),
    opt(5, "Several times a day"),
  ],
  scoringNote: "1 = never … 5 = several times a day.",
};

/**
 * What AI chatbots are used for (D-59; select all). Emotional support (6) and
 * company (7) are separate from advice (5) and from everything practical, so
 * that use as a confidant or companion can be told apart.
 */
export const aiUsePurpose: ResponseScale = {
  key: "scale.ai_use_purpose",
  version: "1.0.0",
  name: "What AI chatbots are used for (select all)",
  direction: "unordered",
  options: [
    opt(1, "Schoolwork or homework"),
    opt(2, "Looking things up or answering questions"),
    opt(3, "Creative things, like stories, pictures or music"),
    opt(4, "Just for fun or to pass the time"),
    opt(5, "Advice about problems or decisions"),
    opt(6, "Talking about my feelings or when I'm upset"),
    opt(7, "Chatting to it as a friend or for company"),
    opt(8, "Something else", undefined, "other_specify"),
  ],
};

/** How using AI chatbots usually leaves someone feeling (D-59). */
export const aiUseFeeling: ResponseScale = {
  key: "scale.ai_use_feeling",
  version: "1.0.0",
  name: "How using AI chatbots usually feels afterwards",
  direction: "unordered",
  options: [opt(1, "Better"), opt(2, "About the same"), opt(3, "Worse"), opt(4, "It depends")],
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
    // The month number, so the choice can be checked against a date of birth.
    value: i + 1,
    kind: "substantive" as const,
    textEntry: false,
  })),
};

/**
 * KSS canonical labels (D-08; A-8 typo corrected, point 4 "Rather alert").
 *
 * The digits are gone from what participants read (D-29). "1 - Extremely
 * alert" asks someone to hold a number and a phrase at once when the phrase
 * alone is the thing being measured; the number was a paper-form artefact for
 * counting by hand. Codes 1-9 are unchanged and the digit is kept in
 * `codeLabel` for the codebook, so scoring and the crosswalk see exactly what
 * they saw before.
 */
const kssLabels = [
  "Extremely alert",
  "Very alert",
  "Alert",
  "Rather alert",
  "Neither alert nor sleepy",
  "Some signs of sleepiness",
  "Sleepy, but no effort to keep awake",
  "Sleepy, some effort to keep awake",
  "Very sleepy, great effort to keep awake, fighting sleep",
];

export const kss9Canonical: ResponseScale = {
  key: "scale.kss_9pt",
  version: "2.0.0",
  name: "KSS 9-point sleepiness scale (canonical labels, words only)",
  direction: "ascending",
  options: kssLabels.map((label, i) => ({
    ...opt(i + 1, label, i + 1),
    codeLabel: String(i + 1),
  })),
  scoringNote:
    "Single-item state measure; score = selected code (1-9). The scale point is in codeLabel; participants see the verbal anchor only (D-29).",
};

/** Exact administered YBM labels preserved (A-8). */
export const kss9AsAdministered: ResponseScale = {
  ...kss9Canonical,
  key: "scale.kss_9pt_ybm",
  name: "KSS 9-point scale as administered in YBM 2026 (words only)",
  options: kss9Canonical.options.map((o) => {
    if (o.code === 4) return { ...o, label: "Fairly alert" };
    if (o.code === 7) return { ...o, label: "Sleepy, but not no effort to keep awake" };
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
    "Veale (2014) laterality quotient scoring. Anchor wording confirmed by the researcher 2026-08-02 (D-32); the midpoint 'Both equally' is shown on every screen size.",
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

/** PHQ-4 frequency anchors, coded 0–3 as published (Kroenke et al., 2009). */
export const phq4pt: ResponseScale = {
  key: "scale.phq_4pt",
  version: "1.0.0",
  name: "PHQ frequency scale (Not at all … Nearly every day, coded 0-3)",
  direction: "ascending",
  options: opts(["Not at all", "Several days", "More than half the days", "Nearly every day"], 0),
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
    opt(1, "Strongly agree", 1),
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

/**
 * Per-sitting time bands.
 *
 * The administered labels overlapped at every boundary — "1–15 minutes" and
 * "15–30 minutes" both claimed 15, "30–60 minutes" and "1–2 hours" both
 * claimed an hour — so a participant at a boundary had no way to know which
 * box was theirs, and two people with identical use could land in different
 * bands (A-36, resolved in D-27). Bands are now disjoint and exhaustive.
 * Codes and legacy codes are untouched: only the labels are clearer.
 *
 * "0 minutes" is also gone. This question is only asked about platforms the
 * participant has already said they use, so zero was a contradiction; the
 * option now says what it was presumably there to capture.
 */
export const smSittingTime6: ResponseScale = {
  key: "scale.sm_sitting_time_6pt",
  version: "2.0.0",
  name: "Time per sitting on a platform (6 bands, disjoint)",
  direction: "ascending",
  scoringNote:
    "Bands are disjoint and exhaustive (D-27). Code 1 is 'have it but barely use it' rather than a literal zero — it was administered as '0 minutes' on a question only asked of users of the platform.",
  options: [
    opt(1, "I have it but barely use it", 1),
    opt(2, "Up to 15 minutes", 2),
    opt(3, "16 to 30 minutes", 3),
    opt(4, "31 to 60 minutes", 4),
    opt(5, "More than 1 hour, up to 2 hours", 5),
    opt(6, "More than 2 hours", 6),
  ],
};

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
  options: [opt(1, "Never", 1), opt(2, "1 or 2 times", 4), opt(3, "3 to 5 times", 5), opt(4, "More than 5 times", 6)],
};

/** Morning check latency; legacy 1,4,5,6,7 (first label "<5 minutes" — A-14 resolved). */
export const morningLatency5: ResponseScale = {
  key: "scale.sm_morning_latency_5pt",
  version: "1.0.0",
  name: "Time to first social-media check after waking",
  direction: "ascending",
  options: [
    opt(1, "Less than 5 minutes", 1),
    opt(2, "5 to 10 minutes", 4),
    opt(3, "11 to 30 minutes", 5),
    opt(4, "31 to 60 minutes", 6),
    opt(5, "More than 60 minutes", 7),
  ],
};

/**
 * Daily social-media time. The administered bands shared every boundary
 * ("30 minutes–1 hour" and "1–2 hours" both claimed an hour), so each upper
 * bound is now explicitly exclusive (A-36 / D-27). Legacy codes 1, 4-11 are
 * preserved exactly — this is a labelling fix, not a recoding.
 */
export const smDailyTime9: ResponseScale = {
  key: "scale.sm_daily_time_9pt",
  version: "2.0.0",
  name: "Daily social-media time (9 bands, disjoint)",
  direction: "ascending",
  scoringNote: "Bands are disjoint and exhaustive (D-27); code and legacyCode pairs are unchanged from 1.0.0.",
  options: [
    opt(1, "Less than 30 minutes", 1),
    opt(2, "30 minutes to just under 1 hour", 4),
    opt(3, "1 hour to just under 2 hours", 5),
    opt(4, "2 hours to just under 3 hours", 6),
    opt(5, "3 hours to just under 4 hours", 7),
    opt(6, "4 hours to just under 5 hours", 8),
    opt(7, "5 hours to just under 6 hours", 9),
    opt(8, "6 hours to just under 7 hours", 10),
    opt(9, "7 hours or more", 11),
  ],
};

/** Weekly gaming hours; legacy 1,4-8; band gap 5-6 preserved (A-9, C3). */
export const gamingHours6: ResponseScale = {
  key: "scale.gaming_hours_6pt",
  version: "2.0.0",
  name: "Weekly gaming hours (6 bands, contiguous)",
  direction: "ascending",
  scoringNote:
    "The administered bands left 5-6 hours in no band at all (A-9): 'Less than 5' then '6-10'. Someone playing five and a half hours had nowhere to put themselves. Bands are now contiguous (D-27); codes and legacy codes are unchanged.",
  options: [
    opt(1, "I do not play video games", 1),
    opt(2, "Less than 5 hours", 4),
    opt(3, "5 to 10 hours", 5),
    opt(4, "11 to 15 hours", 6),
    opt(5, "16 to 20 hours", 7),
    opt(6, "More than 20 hours", 8),
  ],
};

/**
 * Per-game weekly hours (no zero band by design — a listed game is played).
 * Same gap closed as the weekly total above (A-9 / D-27).
 */
export const gameHours5: ResponseScale = {
  key: "scale.game_hours_5pt",
  version: "2.0.0",
  name: "Per-game weekly hours (5 bands, contiguous)",
  direction: "ascending",
  scoringNote: "Bands are contiguous (D-27); codes are unchanged from 1.0.0.",
  options: opts(["Less than 5 hours", "5 to 10 hours", "11 to 15 hours", "16 to 20 hours", "More than 20 hours"]),
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

/**
 * The age each option denotes, so an option older than the participant can be
 * withheld (D-25). "Younger than 5" denotes 4 — the oldest age it covers, so
 * it survives the filter for anyone it could apply to. The "not sure" escape
 * denotes nothing and is never filtered.
 */
const ageValue = (label: string): number => (label === "Younger than 5" ? 4 : Number(label));

const ageOptions = (legacy: (number | undefined)[]): ScaleOption[] =>
  ageLabels.map((label, i) => ({ ...opt(i + 1, label, legacy[i]), value: ageValue(label) }));

export const ageAdoptionSmartphone: ResponseScale = {
  key: "scale.age_adoption_smartphone",
  version: "2.0.0",
  name: "Age of first smartphone (canonical ordinal; legacy Qualtrics codes preserved)",
  direction: "ascending",
  scoringNote:
    "Each option carries the age it denotes in `value`; presentation may withhold ages above the participant's own (D-25). Codes and legacy codes are unaffected by that filtering.",
  options: [
    ...ageOptions(smartphoneLegacy),
    opt(99, "I’m not sure / I can’t remember", 10, "dont_know"),
  ],
};

export const ageAdoptionSocialMedia: ResponseScale = {
  key: "scale.age_adoption_sm",
  version: "2.0.0",
  name: "Age of first social-media use (canonical ordinal; legacy Qualtrics codes preserved)",
  direction: "ascending",
  scoringNote:
    "Each option carries the age it denotes in `value`; presentation may withhold ages above the participant's own (D-25). Codes and legacy codes are unaffected by that filtering.",
  options: [
    ...ageOptions(smLegacy),
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
  firstLanguageEnglish,
  otherLanguages,
  languageAbility5,
  aiUseFrequency,
  aiUsePurpose,
  aiUseFeeling,
  sqs11,
  smFamilyControlHow,
  hairType12,
  month12,
  kss9Canonical,
  kss9AsAdministered,
  ehiSf5Canonical,
  ehiSf5AsAdministered,
  swemwbs5,
  phq4pt,
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
