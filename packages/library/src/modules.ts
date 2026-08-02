import type { z } from "zod";
import type { itemDefinition, moduleDefinition } from "@myself/schema";

/**
 * Bespoke YBM modules encoded from the QSF with decisions applied:
 * D-01 (abstain-effect wording restored), D-02 (Twitch condition), D-03
 * (gaming logic inverted), D-04 (age "5" added — in scales), D-06 (forced
 * consent preserved), D-07 (bespoke typos fixed), D-09 (identity fields
 * collected in-flow, routed to the identity schema).
 */

export type ModuleInput = z.input<typeof moduleDefinition>;
type ItemInput = z.input<typeof itemDefinition>;

const single = (
  key: string,
  variable: string,
  legacyVariable: string,
  text: string,
  scale: string,
  extra?: Partial<ItemInput>,
): ItemInput =>
  ({
    responseType: "single_choice",
    key,
    revision: 1,
    variable,
    legacyVariable,
    stem: { text },
    scale,
    scaleVersion: "1.0.0",
    ...extra,
  }) as ItemInput;

const moduleBase = {
  version: "1.0" as const,
  kind: "module" as const,
  study: "ybm" as const,
  licence: { status: "open", modifiable: "yes", verified: true } as const,
  owner: "ybm",
};

const est = (a: number, b: number) =>
  [
    { ageBand: "11-13" as const, medianSeconds: a, provenance: "estimated-heuristic" as const },
    { ageBand: "14-16" as const, medianSeconds: b, provenance: "estimated-heuristic" as const },
  ];

// ---------------------------------------------------------------------------

const introText = `Yorkshire Brain Map School Workshop - Citizen Neuroscience - NotreDame

Thank you for taking part in this workshop.

In this study, we'll use a special tool called electroencephalography (EEG) to collect information about your brain. We'll put sensors on your head, and they'll record your brain activity. You'll also help collect brain data from another person. This new way helps us gather brain data quickly with help from people who aren't experts. The EEG headset should not feel uncomfortable, so if it does at any point, just let a member of the research team know. EEG is safe, pain free, and non-invasive.

In addition to EEG, we'll also ask questions about your life and how you feel. We made a list of questions that ask about things like who you are, how you feel, and how happy you are. We care about keeping your answers private so we'll give you an anonymous code so your answers stay confidential during the study.

Joining this study is your choice, and you can leave at any time with no problems. If you want to leave, please let a member of the research team or a teacher know.

Our study has permission from the School of Psychology Ethics Committee (Ethics Reference: PSCETHS-1449, Date of Approval: 5/6/25).

The questions you're about to answer should take about 10 minutes to answer. Please finish the survey quickly and carefully so we can stay on schedule. Thank you for joining our study! If you have questions or worries, please feel free to ask.`;

export const ybmIntroConsent: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_intro_consent",
  name: "YBM introduction and consent",
  construct: "Study information and informed consent",
  forms: [
    {
      language: "en-GB",
      label: "YBM NotreDame 2026 introduction + consent",
      items: [
        {
          responseType: "info",
          key: "intro",
          revision: 1,
          variable: "study_intro",
          legacyVariable: "Introduction",
          stem: { text: introText },
        },
        {
          responseType: "checkbox_set",
          key: "consent",
          revision: 1,
          variable: "consent",
          legacyVariable: "Consent",
          required: "hard", // D-06: all statements required, no in-app decline path
          stem: { text: "Please click to indicate you understand and agree to these statements and consent to take part." },
          statements: [
            {
              key: "dissemination",
              text: {
                text: "I understand that anonymized results from this study may be disseminated through conference presentations, publication in peer reviewed journals, compiled as part of a report, used in future projects, included on institutional websites, presented in electronic theses and may be made available on online data repositories.",
              },
            },
            {
              key: "no_identification",
              text: {
                text: "I understand that my name will not be linked with the research materials, and I will not be identified or identifiable in the report or reports that result from the research.",
              },
            },
            {
              key: "withdrawal_window",
              text: {
                text: "I understand that if I choose to withdraw my data by contacting the primary researcher within 24 hours of submission (up until {withdrawal_date}) that my responses will be removed from the dataset and not used for analysis",
                pipes: { withdrawal_date: { kind: "date_offset", offsetDays: 2 } },
              },
            },
            {
              key: "free_withdrawal",
              text: {
                text: "I understand that I am free to withdraw at any time without giving any reason and without there being any negative consequences",
              },
            },
            {
              key: "information_read",
              text: {
                text: "I have read and understood the information on the study presented above and have been offered the opportunity to ask the research team questions via email (m.faizah@leeds.ac.uk)",
              },
            },
            { key: "agree", text: { text: "I agree to take part in this study" } },
          ],
        },
      ],
    },
  ],
  timeEstimates: est(120, 90),
  changelog: "1.0: encoded from QSF. Legacy consent choice codes were 2-7. Withdrawal date piped as session start + 2 days.",
  researcherNotes: "The intro's 'about 10 minutes' estimate is superseded by computed per-release estimates (A-38).",
};

// ---------------------------------------------------------------------------

export const ybmIdentity: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_identity",
  name: "YBM participant identifiers",
  construct: "Identity and linkage fields (identity-schema routed, D-09)",
  forms: [
    {
      language: "en-GB",
      label: "YBM identifier collection (as administered; D-09)",
      items: [
        {
          responseType: "text_short",
          key: "first_name",
          revision: 1,
          variable: "first_name",
          legacyVariable: "first_name",
          required: "hard",
          stem: { text: "First Name" },
          maxChars: 100,
          researcherNote: "Direct identifier — identity-schema routed, excluded from default exports (D-09).",
        },
        {
          responseType: "text_short",
          key: "last_name",
          revision: 1,
          variable: "last_name",
          legacyVariable: "last_name",
          required: "hard",
          stem: { text: "Last Name" },
          maxChars: 100,
          researcherNote: "Direct identifier — identity-schema routed (D-09).",
        },
        {
          responseType: "form_fields",
          key: "ps_id",
          revision: 1,
          variable: "ps_id",
          legacyVariable: "ps_id",
          required: "hard",
          stem: {
            text: "PARTICIPANT ID: Please provide the following information to help us generate a unique identifier for you:\n\nFor example, if your mother's name is Jane, your house number is 123, you were born in January, and your postcode is AB1 2CD, your participant ID would be JA101CD.",
          },
          fields: [
            { key: "mother_initials", label: "First two letters of mother's first name", required: true, maxChars: 2 },
            { key: "house_digit", label: "First digit of your house number", required: true, maxChars: 1 },
            { key: "birth_month", label: "Month you were born", required: true, maxChars: 12 },
            { key: "postcode_letters", label: "Last two letters of your postcode", required: true, maxChars: 2 },
          ],
          researcherNote: "Quasi-identifying components — identity-schema routed; derived code used for legacy matching (A-27/D-09).",
        },
        {
          responseType: "form_fields",
          key: "val_id",
          revision: 1,
          variable: "val_id",
          legacyVariable: "val_id",
          required: "hard",
          stem: {
            text: "We also need you to put the validation ID. This ID starts with three letters (e.g. NDC), followed by two or more digits. This ID should have been provided by the research team. If you have not received it, please ask one of our team.",
          },
          fields: [{ key: "digits", label: "All digits after three letters", required: true, maxChars: 10 }],
          researcherNote: "Typos in the administered stem fixed per D-07 ('haven not', 'pleas', 'i.e,').",
        },
        {
          responseType: "date",
          key: "dob",
          revision: 1,
          variable: "dob",
          legacyVariable: "DoB ",
          required: "hard",
          stem: { text: "Date of Birth (dd/mm/yyyy)" },
          minYear: 1990,
          maxYear: 2020,
          researcherNote: "Direct identifier — identity-schema routed (D-09). Legacy tag carries a trailing space.",
        },
      ],
    },
  ],
  timeEstimates: est(150, 120),
  changelog: "1.0: encoded from QSF; collection preserved per D-09, storage separated at the data layer.",
};

// ---------------------------------------------------------------------------

export const ybmDemographics: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_demographics",
  name: "YBM demographics",
  construct: "Ethnicity, gender, mental-health medication",
  forms: [
    {
      language: "en-GB",
      label: "YBM demographics (typos fixed per D-07)",
      items: [
        single(
          "ethnicity",
          "ethnicity",
          "Ethnicity",
          "What best describes your ethnic origin?\n\nEthnic origin refers to your cultural background or where your family comes from, including your ancestors, country of origin, and cultural traditions you identify with.",
          "scale.ethnicity_uk20",
          { presentation: "wheel", required: "hard", researcherNote: "'Ethic origin' typo fixed per D-07." },
        ),
        single("gender", "gender", "Gender", "Gender", "scale.gender_4", { required: "hard" }),
        single(
          "medication",
          "mh_medication",
          "Medication",
          "Are you currently taking any prescribed medication for a mental health or psychiatric condition? (e.g., antidepressants). This information will only be used to help us describe the sample and it will not be used to decide whether you can take part in the study or shared with anyone else.",
          "scale.yes_no",
          { required: "hard", researcherNote: "Special-category health data (A-30). Mid-sentence 'It' fixed per D-07." },
        ),
      ],
    },
  ],
  timeEstimates: est(90, 70),
  changelog: "1.0: encoded from QSF; full 20-option ethnicity list recovered (docs/10 §3).",
};

// ---------------------------------------------------------------------------

export const ybmEegPractical: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_eeg_practical",
  name: "YBM EEG practicalities",
  construct: "Hair type (EEG cap fitting)",
  forms: [
    {
      language: "en-GB",
      label: "Hair type",
      items: [
        single(
          "hair_type",
          "hair_type",
          "Hair_type",
          "Please select below which hair type (number; letter) is most representative of your own hair. Please only select ONE hair type from all options below:",
          "scale.hair_type_12",
          {
            presentation: "grid",
            required: "hard",
            researcherNote:
              "Rendered as a tappable illustrated grid: each option draws its own curl pattern (MySelf-authored artwork, no third-party chart dependency). Replaces the Qualtrics chart image + dropdown.",
          },
        ),
      ],
    },
  ],
  timeEstimates: est(45, 35),
  changelog: "1.0: encoded from QSF.",
};

// ---------------------------------------------------------------------------

export const ybmSleepPriorities: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_sleep_priorities",
  name: "YBM sleep priorities",
  construct: "Sleep priorities and interests (bespoke; not part of the KSS)",
  forms: [
    {
      language: "en-GB",
      label: "Sleep priorities (2 items)",
      items: [
        {
          responseType: "multi_choice",
          key: "importance",
          revision: 1,
          variable: "sleep_importance",
          legacyVariable: "Sleep_Importance",
          required: "hard",
          stem: { text: "What feels most important to you for getting a good night's sleep? You can choose up to three." },
          scale: "scale.sleep_importance_11",
          scaleVersion: "1.0.0",
          minSelections: 1,
          maxSelections: 3,
        },
        {
          responseType: "multi_choice",
          key: "know_own",
          revision: 1,
          variable: "sleep_know_own",
          legacyVariable: "Sleep_Own",
          stem: { text: "If you could find out more about your own sleep, what would you most like to know? You can choose up to three." },
          scale: "scale.sleep_know_12",
          scaleVersion: "1.0.0",
          minSelections: 1,
          maxSelections: 3,
        },
      ],
    },
  ],
  timeEstimates: est(120, 90),
  changelog: "1.0: encoded from QSF; relocated out of the misnamed 'Karolinska' block (A-35).",
};

// ---------------------------------------------------------------------------

const smUseRef = { instrument: "ybm_smartphone", item: "sm_use", revision: 1 };

export const ybmSmartphone: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_smartphone",
  name: "YBM smartphone and social-media ownership",
  construct: "Ownership and ages of adoption",
  forms: [
    {
      language: "en-GB",
      label: "Smartphone ownership (typo fixed per D-07; age '5' added per D-04)",
      items: [
        single("own", "smartphone_own", "Smartphone_own", "Do you have your own smartphone?", "scale.yes_no"),
        single(
          "age_smartphone",
          "smartphone_age",
          "Age_smartphone",
          "At what age did you get your first smartphone? Please answer in years.",
          "scale.age_adoption_smartphone",
          {
            presentation: "wheel",
            displayIf: {
              op: "selected",
              target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } },
              code: 1,
            },
          },
        ),
        single("sm_use", "sm_use", "SM_Own", "Do you currently use social media?", "scale.yes_no"),
        single(
          "age_sm",
          "sm_age",
          "Age_SM",
          "At what age did you start using social media? Please answer in years.",
          "scale.age_adoption_sm",
          {
            presentation: "wheel",
            displayIf: { op: "selected", target: { item: smUseRef }, code: 1 },
          },
        ),
      ],
    },
  ],
  timeEstimates: est(100, 80),
  changelog: "1.0: encoded from QSF. 'did you you get' fixed (D-07); age '5' added to both scales (D-04); scrambled legacy codes preserved in scales (A-17).",
};

// ---------------------------------------------------------------------------

const appsOwnedRef = { instrument: "ybm_social_media", item: "apps_owned", revision: 1 };

/** Platform time items, one per platform (stepped presentation of the legacy matrix). */
const platformTime = (
  key: string,
  canonicalCode: number,
  label: string,
  legacyRow: number,
): ItemInput => ({
  responseType: "single_choice",
  key: `time_${key}`,
  revision: 1,
  variable: `sm_time_${key}`,
  legacyVariable: `TimeSpent on each _${legacyRow}`,
  stem: { text: `How much time do you usually spend on ${label} in one go without a break?` },
  scale: "scale.sm_sitting_time_6pt",
  scaleVersion: "1.0.0",
  displayIf: { op: "in_group", target: { item: appsOwnedRef }, group: "have", code: canonicalCode },
});

export const ybmSocialMedia: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_social_media",
  name: "YBM social-media use (adapted from AoW)",
  construct: "Social-media platforms, time, habits and attitudes",
  forms: [
    {
      language: "en-GB",
      label: "Social-media battery (D-01/D-02 fixes applied)",
      items: [
        single("overuse", "sm_overuse", "SM_Overuse", "Do you think you spend too much time on social media?", "scale.yes_no_unsure"),
        {
          responseType: "rank_group",
          key: "apps_owned",
          revision: 1,
          variable: "sm_apps_owned",
          legacyVariable: "DragDrop_SM",
          stem: {
            text: "Drag and drop the apps into the box that shows whether you have them on your phone.\n\nThen, in the 'I have these apps on my phone' box, rank the apps based on how much you use them (from most to least). You can ignore the ranking for the other box.",
          },
          scale: "scale.sm_platforms",
          scaleVersion: "1.0.0",
          groups: [
            { key: "have", label: "I have these apps on my phone", ranked: true },
            { key: "dont_have", label: "I don't have these apps on my phone" },
          ],
        },
        // Per-row stem rephrasing of the matrix header question (PRESENT disposition);
        // D-02: Twitch row now correctly conditions on Twitch (canonical code 8).
        platformTime("facebook", 1, "Facebook", 1),
        platformTime("instagram", 3, "Instagram", 2),
        platformTime("tiktok", 4, "TikTok", 3),
        platformTime("snapchat", 2, "Snapchat", 4),
        platformTime("youtube", 5, "YouTube", 5),
        platformTime("reddit", 9, "Reddit", 6),
        platformTime("x", 6, "X (Twitter)", 7),
        platformTime("discord", 7, "Discord", 9),
        platformTime("twitch", 8, "Twitch", 10),
        platformTime("kick", 10, "Kick", 11),
        platformTime("threads", 11, "Threads", 12),
        single(
          "account_privacy",
          "sm_account_privacy",
          "Acount_privacy",
          "On the social media site you use the most, is your account public or private?",
          "scale.sm_account_privacy",
          { researcherNote: "Legacy tag typo 'Acount_privacy' preserved as alias (A-31)." },
        ),
        single(
          "active_passive",
          "sm_active_passive",
          "SM_active_passive",
          "On the social media platform you use most often, would you describe yourself as more of an active or passive user?",
          "scale.sm_active_passive",
        ),
        {
          responseType: "multi_choice",
          key: "functions",
          revision: 1,
          variable: "sm_functions",
          legacyVariable: "SM_function",
          stem: { text: "Why do you use social media? Select all that apply." },
          scale: "scale.sm_functions_11",
          scaleVersion: "1.0.0",
        },
        single("night_checks", "sm_night_checks", "SM_night_check", "On a typical night, how many times do you wake up and check social media?", "scale.sm_night_checks_4pt", { presentation: "wheel" }),
        single("morning_latency", "sm_morning_latency", "SM_morning_check ", "How long after waking do you typically check social media?", "scale.sm_morning_latency_5pt", { presentation: "wheel" }),
        single("time_school_day", "sm_time_school_day", "SM_weekdays ", "How much time do you spend using social media on a typical school day (Monday-Friday)?", "scale.sm_daily_time_9pt", { presentation: "wheel" }),
        single("time_nonschool_day", "sm_time_nonschool_day", "SM_weekend/holiday ", "How much time do you spend using social media on a typical non-school day (e.g., weekend or school holiday)?", "scale.sm_daily_time_9pt", { presentation: "wheel", researcherNote: "Legacy tag contains a slash and trailing space (A-31)." }),
        single("lose_track", "sm_lose_track", "SM_lostrack", "I lose track of how much time I spend on social media", "scale.agree_5pt_dk"),
        single(
          "limit_features",
          "sm_limit_features",
          "app_reduce",
          "Do you use any features designed to reduce your social media use and/or screentime (e.g., screentime limits, break reminders, sleep hours reminders)?",
          "scale.yes_no_sometimes",
        ),
        single(
          "abstain_effect",
          "sm_abstain_effect",
          "Abstaining_SM ",
          "What effect do you think abstaining from social media would have on you?",
          "scale.abstain_effect_5pt",
          {
            researcherNote:
              "D-01/A-1: administered stem erroneously duplicated app_reduce; intended wording restored as revision 1 of the corrected item. Legacy data flagged unreliable in the crosswalk.",
          },
        ),
        {
          responseType: "numeric",
          key: "abstain_days",
          revision: 1,
          variable: "sm_abstain_days",
          legacyVariable: "Abstaining_days_1",
          stem: {
            text: "How long do you think you could completely abstain from social media, excluding instant messaging apps such as WhatsApp?\nBy social media, we mean platforms such as TikTok, Instagram, Facebook, Snapchat, X/Twitter, Reddit, YouTube, and Threads.",
          },
          min: 0,
          max: 3650,
          unitLabel: "days",
          researcherNote: "Legacy field was free text with no numeric validation (docs/10 §4); numeric control is a PRESENT-disposition modernisation.",
        },
        single("family_control", "sm_family_control", "SM_family_control", "Does your family manage or control your social media use?", "scale.yes_no"),
      ],
    },
  ],
  timeEstimates: est(420, 330),
  changelog:
    "1.0: encoded from QSF. TimeSpent matrix stepped into per-platform items with corrected Twitch condition (D-02); abstain-effect wording restored (D-01); platform canonical codes 1-11 with legacy codes skipping 7 preserved in the scale.",
};

// ---------------------------------------------------------------------------

export const ybmScreenAttitudes: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_screen_attitudes",
  name: "YBM screen control and social-media impact",
  construct: "Perceived screen control, dependence and social-media impact",
  forms: [
    {
      language: "en-GB",
      label: "Screen attitudes (typos fixed per D-07; agree-first direction preserved — A-18)",
      items: [
        single("control", "screen_control", "Screen Control_1", "I can control my screen behaviours", "scale.agree_5pt_desc"),
        single("dependent", "screen_dependent", "Screen Control_2", "I feel dependent on screens in order to function effectively in day-to-day life", "scale.agree_5pt_desc"),
        single("addicted", "screen_addicted", "Screen Control_3", "I feel addicted to any screen based activities", "scale.agree_5pt_desc"),
        single(
          "impact_positive",
          "sm_impact_positive",
          "Social media impact _4",
          "The impacts of social media on my mental wellbeing are mostly positive",
          "scale.agree_5pt_desc",
          { researcherNote: "D-07: administered stem read 'my mental welling is mostly positive'. Legacy row code 4." },
        ),
        single(
          "impact_negative",
          "sm_impact_negative",
          "Social media impact _5",
          "The impacts of social media on my wellbeing are mostly negative",
          "scale.agree_5pt_desc",
          { researcherNote: "D-07: administered stem read 'my wellbeing in mostly negative'. Legacy row code 5." },
        ),
        single("impact_essential", "sm_impact_essential", "Social media impact _6", "Social media is essential for day-to-day life", "scale.agree_5pt_desc"),
        single("impact_avoid", "sm_impact_avoid", "Social media impact _7", "I avoid some social media", "scale.agree_5pt_desc"),
      ],
    },
  ],
  timeEstimates: est(150, 120),
  changelog: "1.0: encoded from QSF. 'Social media impact' legacy rows were coded 4-7 (A-15).",
};

// ---------------------------------------------------------------------------

const gamingHoursRef = { instrument: "ybm_gaming", item: "hours_week", revision: 1 };
const topGamesRef = { instrument: "ybm_gaming", item: "top_games", revision: 1 };

const gameTimeItem = (n: number): ItemInput => ({
  responseType: "single_choice",
  key: `game_time_${n}`,
  revision: 1,
  variable: `gaming_game_time_${n}`,
  legacyVariable: `other_games_time _${n}`,
  stem: {
    text: `Roughly how many hours do you play {game_${n}} in a typical week?`,
    pipes: { [`game_${n}`]: { kind: "item_text_entry", item: topGamesRef, part: `game_${n}` } },
  },
  scale: "scale.game_hours_5pt",
  scaleVersion: "1.0.0",
  displayIf: { op: "not_empty", target: { item: topGamesRef, part: `game_${n}` } },
});

export const ybmGaming: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_gaming",
  name: "YBM gaming",
  construct: "Gaming time, titles and social play",
  forms: [
    {
      language: "en-GB",
      label: "Gaming (D-03 corrected logic)",
      items: [
        single(
          "hours_week",
          "gaming_hours_week",
          "weekday_games",
          "Roughly how many hours do you play video games in a typical week? For example, if you usually play 1 hour per day during the week (Monday – Friday) and 2 hours per day during the weekend (Saturday and Sunday), this would be 9 hours per week in total.",
          "scale.gaming_hours_6pt",
          { researcherNote: "Legacy tag 'weekday_games' mismatched content (A-9); canonical name corrected, alias kept. Band gap 5-6h preserved (C3)." },
        ),
        {
          responseType: "form_fields",
          key: "top_games",
          revision: 1,
          variable: "gaming_top_games",
          legacyVariable: "other_games ",
          stem: { text: "Please list up to five games that you currently spend the most time playing." },
          fields: [1, 2, 3, 4, 5].map((n) => ({ key: `game_${n}`, label: `Game ${n}`, maxChars: 80 })),
          // D-03/A-3: administered logic was inverted (shown only to NON-gamers). Corrected:
          displayIf: { op: "not_selected", target: { item: gamingHoursRef }, code: 1 },
        },
        gameTimeItem(1),
        gameTimeItem(2),
        gameTimeItem(3),
        gameTimeItem(4),
        gameTimeItem(5),
        {
          responseType: "slider",
          key: "social_pct",
          revision: 1,
          variable: "gaming_social_pct",
          legacyVariable: "game_time_per_wk_pct_1",
          stem: {
            text: "Roughly how much of the time you spend gaming per week is spent playing with others (e.g., multiplayer, online)? (in percentage)",
          },
          min: 0,
          max: 100,
          displayIf: { op: "not_selected", target: { item: gamingHoursRef }, code: 1 },
        },
      ],
    },
  ],
  timeEstimates: est(240, 180),
  changelog:
    "1.0: encoded from QSF. Display logic corrected per D-03 (games list + time + social % now shown to gamers); per-row pipes and NotEmpty conditions reproduced from QSF (A-4 withdrawn).",
};

// ---------------------------------------------------------------------------

export const ybmFutureSelf: ModuleInput = {
  ...moduleBase,
  instrument: "ybm_future_self",
  name: "YBM future self",
  construct: "Open-ended message to future self",
  forms: [
    {
      language: "en-GB",
      label: "Future-self question (plain open-text item per D-15)",
      items: [
        {
          responseType: "text_long",
          key: "message",
          revision: 1,
          variable: "future_self_message",
          legacyVariable: "Future Self",
          stem: {
            text: "And one FINAL question (thank you for bearing with us!): Imagine yourself 10 years from now. If you could leave one sentence for that future version of yourself, what would you say?",
          },
          minChars: 1,
          maxChars: 5000,
          researcherNote: "Relocated out of the BIS-BAS block (A-35). Legacy tag contains a space.",
        },
      ],
    },
  ],
  timeEstimates: est(90, 75),
  changelog: "1.0: encoded from QSF.",
};

export const allModules: ModuleInput[] = [
  ybmIntroConsent,
  ybmIdentity,
  ybmDemographics,
  ybmEegPractical,
  ybmSleepPriorities,
  ybmSmartphone,
  ybmSocialMedia,
  ybmScreenAttitudes,
  ybmGaming,
  ybmFutureSelf,
];
