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
    // Items with no Qualtrics ancestor carry no legacy tag at all, rather than
    // an empty one that would look like a crosswalk entry.
    ...(legacyVariable ? { legacyVariable } : {}),
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

// The title is a title, not the first line of a wall of text. The body keeps
// the approved wording verbatim; only its arrangement on screen changes.
const introTitle = "Yorkshire Brain Map School Workshop";
const introSubtitle = "Citizen Neuroscience — Notre Dame";

const introText = `Thank you for taking part in this workshop.

In this study, we'll use a special tool called electroencephalography (EEG) to collect information about your brain. We'll put sensors on your head, and they'll record your brain activity. You'll also help collect brain data from another person. This new way helps us gather brain data quickly with help from people who aren't experts. The EEG headset should not feel uncomfortable, so if it does at any point, just let a member of the research team know. EEG is safe, pain free, and non-invasive.

In addition to EEG, we'll also ask questions about your life and how you feel. We made a list of questions that ask about things like who you are, how you feel, and how happy you are. We care about keeping your answers private so we'll give you an anonymous code so your answers stay confidential during the study.

Joining this study is your choice, and you can leave at any time with no problems. If you want to leave, please let a member of the research team or a teacher know.

Our study has permission from the School of Psychology Ethics Committee (Ethics Reference: PSCETHS-1449, Date of Approval: 5/6/25).

The questions you're about to answer should take about 10 minutes to answer. Please finish the survey quickly and carefully so we can stay on schedule. Thank you for joining our study! If you have questions or worries, please feel free to ask.`;

/**
 * Data handling, in the participant's own terms, available from the first
 * screen without being imposed on anyone who does not want it (D-24). This is
 * a plain-language restatement of the approved information sheet, not new
 * permissions — every claim here is one the protocol already makes.
 */
const privacyText = `WHAT WE COLLECT
Your answers to these questions, the EEG recording from the session, and some details about how you used the app — such as how long you spent on each question. We also collect your name and date of birth so the research team can identify your session on the day.

WHERE IT IS KEPT
Everything is saved on this iPad first, encrypted, so it works even with no internet. It is later transferred to secure University of Leeds storage. Your name and date of birth are stored apart from your answers, so the two are not held together.

WHO CAN SEE IT
The research team. When we publish or share the data, your name is never attached — only your code and your answers.

YOUR SECRET CODE
The code you're about to make is how you can ask us to remove your answers later. Keep it somewhere you'll remember. We can't work out who you are from it, which is the point of it.

CHANGING YOUR MIND
You can stop at any time, and you don't have to give a reason. If you want your answers taken out afterwards, contact the research team within 24 hours of finishing and tell them your code.

QUESTIONS
Email the research team at m.faizah@leeds.ac.uk. Ethics reference PSCETHS-1449.`;


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
          stem: { text: introTitle },
          lede: { text: `${introSubtitle}\n\n${introText}` },
          moreInfo: { label: "How we look after your information", body: { text: privacyText } },
        },
        {
          responseType: "checkbox_set",
          key: "consent",
          revision: 1,
          variable: "consent",
          legacyVariable: "Consent",
          required: "hard", // D-06: all statements required, no in-app decline path
          // "click" was a desktop-Qualtrics word; this is a tablet. Interaction
          // verbs must describe the interaction that exists (D-29).
          stem: { text: "Please tap each statement to indicate you understand and agree to them, and that you consent to take part." },
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
                text: "I have read and understood the information about the study shown at the start of this survey and have been offered the opportunity to ask the research team questions via email (m.faizah@leeds.ac.uk)",
              },
            },
            { key: "agree", text: { text: "I agree to take part in this study" } },
          ],
        },
        // Placed after consent and before the first question: the last thing
        // read before answering starts (D-30). Deliberately short — a wall of
        // exhortation is skipped, and the point is one idea.
        {
          responseType: "info",
          key: "why_it_matters",
          revision: 1,
          variable: "why_accurate",
          required: "optional",
          stem: { text: "Why your answers matter" },
          lede: {
            text: "There are no right or wrong answers here — only true ones.\n\nWhat you tell us goes into research on how sleep, screens and feelings fit together for people your age, and on what actually helps. That only works if the answers are really yours, including the ones that aren't flattering.\n\nA rushed or made-up answer doesn't just lose one number. It makes the whole picture slightly less true — for everyone the research is meant to help.\n\nSo take your time. And if you'd rather not answer something, leave it blank — that's always allowed.",
          },
          researcherNote:
            "Brief statement of why accurate responding matters, shown once after consent (D-30). Not a consent statement and carries no agreement — informational only.",
        },
      ],
    },
  ],
  timeEstimates: est(120, 90),
  changelog:
    "1.0: encoded from QSF. Legacy consent choice codes were 2-7. Withdrawal date piped as session start + 2 days. " +
    "2.0 (D-23): one consent statement said the study information was 'presented above' — on a paper form it was, but here it is a previous screen, so the statement was literally untrue at the moment of signing. Changed to 'shown at the start of this survey'. Meaning unchanged; ETHICS COMMITTEE MUST BE NOTIFIED before this release is administered.",
  researcherNotes:
    "The intro's 'about 10 minutes' estimate is superseded by computed per-release estimates (A-38). " +
    "OUTSTANDING: the consent wording change in 2.0 is a factual correction, not a substantive one, but approved consent text was altered — confirm with PSCETHS-1449 before fielding.",
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
          responseType: "date",
          key: "dob",
          revision: 1,
          variable: "dob",
          legacyVariable: "DoB ",
          required: "hard",
          // No format hint: the native picker decides the order shown, so
          // promising "dd/mm/yyyy" is a claim the app does not control (D-30).
          stem: { text: "What's your date of birth?" },
          minYear: 1990,
          maxYear: 2026,
          // Plausibility only — a mistyped year is caught, an unusual but real
          // date is not blocked (D-19).
          minAgeYears: 4,
          maxAgeYears: 100,
          researcherNote:
            "Direct identifier — identity-schema routed (D-09). Legacy tag carries a trailing space. " +
            "Asked immediately after the name and before the secret code (D-25): the code's month component is cross-checked against it, and the age derived from it limits the age-of-first-device options later.",
        },
        // The secret code is built one piece at a time. Four short screens beat
        // one dense form: each piece gets its own instruction and its own
        // validation, and nobody has to hold four rules in their head at once.
        {
          responseType: "info",
          key: "secret_code_intro",
          revision: 1,
          variable: "ps_id_intro",
          required: "optional",
          stem: { text: "Next, you'll make your secret code" },
          lede: {
            text: "The next four questions build a short code that is yours alone. It is made from things you will always remember, so you can tell us your code again later — if you ever want your answers taken out of the study, that code is how we find them.\n\nWe cannot work it out from your code who you are. That is the point of it: your answers stay linked to you without being labelled with your name.",
          },
          researcherNote:
            "Explains the purpose of the ps_id components before collection (D-23). The code is participant-held; the research team cannot reverse it.",
        },
        {
          responseType: "text_short",
          key: "ps_mother_initials",
          revision: 1,
          variable: "ps_mother_initials",
          required: "hard",
          stem: { text: "The first two letters of your mother's first name" },
          lede: { text: "For example, if her name is Jane, type JA." },
          maxChars: 2,
          pattern: "^[A-Za-z]{2}$",
          patternHint: "Two letters, for example JA",
          researcherNote: "Secret-code component 1 of 4 — identity-schema routed (D-09/D-23).",
        },
        {
          responseType: "text_short",
          key: "ps_house_digit",
          revision: 1,
          variable: "ps_house_digit",
          required: "hard",
          stem: { text: "The first digit of your house number" },
          lede: { text: "For example, if you live at number 123, type 1." },
          maxChars: 1,
          pattern: "^[0-9]$",
          patternHint: "One number, for example 1",
          researcherNote: "Secret-code component 2 of 4 — identity-schema routed (D-09/D-23).",
        },
        {
          responseType: "single_choice",
          key: "ps_birth_month",
          revision: 1,
          variable: "ps_birth_month",
          required: "hard",
          stem: { text: "The month you were born" },
          lede: { text: "This is part of your code, so it needs to match the date of birth you gave a moment ago." },
          scale: "scale.month_12",
          scaleVersion: "1.0.0",
          presentation: "compact",
          // Asked twice, so it must agree with itself. Caught here, while the
          // participant can still say which one is right (D-25).
          crossChecks: [
            {
              kind: "matches_month_of_date",
              against: { instrument: "ybm_identity", item: "dob", revision: 1 },
              message: "That's not the month in the date of birth you gave. Check which one is right — you can use Back to change the date.",
            },
          ],
          researcherNote:
            "Secret-code component 3 of 4. Chosen from a list rather than typed, and cross-checked against dob so the derived ps_id cannot disagree with the recorded date of birth (D-23/D-25).",
        },
        {
          responseType: "text_short",
          key: "ps_postcode_letters",
          revision: 1,
          variable: "ps_postcode_letters",
          required: "hard",
          stem: { text: "The last two letters of your postcode" },
          lede: { text: "For example, if your postcode is AB1 2CD, type CD." },
          maxChars: 2,
          pattern: "^[A-Za-z]{2}$",
          patternHint: "Two letters, for example CD",
          researcherNote: "Secret-code component 4 of 4 — identity-schema routed (D-09/D-23).",
        },
      ],
    },
  ],
  timeEstimates: est(150, 120),
  changelog:
    "1.0: encoded from QSF; collection preserved per D-09, storage separated at the data layer. " +
    "2.0 (D-23): the validation ID moved to the opening screen, where it is entered once before anything else, " +
    "so the in-flow val_id item is removed. The ps_id form was split into four single-purpose screens preceded " +
    "by an explanation of what the code is for; birth month is now chosen from a list. Legacy ps_id is derived " +
    "from ps_mother_initials + ps_house_digit + ps_birth_month + ps_postcode_letters at export, and val_id from " +
    "the session's participant code — the crosswalk records both derivations rather than recoding silently.",
  researcherNotes:
    "Legacy crosswalk: ps_id = initials + house digit + zero-padded month number + postcode letters (e.g. JA101CD); " +
    "val_id = the participant code captured at the opening screen. Both are derived, never re-asked.",
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
          "What best describes your ethnic origin?",
          "scale.ethnicity_uk20",
          {
            required: "hard",
            lede: {
              text: "Ethnic origin refers to your cultural background or where your family comes from, including your ancestors, country of origin, and cultural traditions you identify with.",
            },
            researcherNote:
              "'Ethic origin' typo fixed per D-07. Presented as a full tappable list rather than a menu (D-23): the census categories are long enough to need reading, and a menu hides them behind an extra tap.",
          },
        ),
        single("gender", "gender", "Gender", "Gender", "scale.gender_4", { required: "hard" }),
        single(
          "medication",
          "mh_medication",
          "Medication",
          "Are you currently taking any prescribed medication for a mental health or psychiatric condition?",
          "scale.yes_no",
          {
            required: "hard",
            lede: {
              text: "For example, antidepressants. We only use this to describe who took part — it never affects whether you can take part, and it is not shared with anyone else.",
            },
            researcherNote: "Special-category health data (A-30). Mid-sentence 'It' fixed per D-07. Question and reassurance split into stem and lede (D-29).",
          },
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
          "Which of these is most like your own hair?",
          "scale.hair_type_12",
          {
            presentation: "grid",
            required: "hard",
            lede: { text: "Pick the one closest to yours — it helps us fit the EEG cap. Choose just one." },
            researcherNote:
              "Rendered as a tappable illustrated grid: each option draws its own curl pattern (MySelf-authored artwork, no third-party chart dependency). Replaces the Qualtrics chart image + dropdown. " +
              "The 1a-4c classification codes are no longer shown (D-23) — participants match a picture and a description; the code is kept in the scale's codeLabel for the codebook.",
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
  // NOT in the ybm_nd2026_standard composition from r6.0.0 (D-31, researcher
  // direction). Kept encoded and versioned so returning it is a composition
  // edit, not a re-encoding.
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
            presentation: "compact",
            // Nobody can have got their first phone at an age they have not
            // reached: ages above the participant's own are not offered (D-25).
            limitOptions: { kind: "at_most_age_now", from: { instrument: "ybm_identity", item: "dob", revision: 1 } },
            displayIf: {
              op: "selected",
              target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } },
              code: 1,
            },
          },
        ),
        single("sm_use", "sm_use", "SM_Own", "Do you currently use social media?", "scale.yes_no", {
          lede: {
            text: "We mean apps where you can see or share things other people have posted — even if you mostly just watch.",
          },
        }),
        // "No" is often a misunderstanding rather than an answer: people say it
        // when they only watch, or when they don't think YouTube or WhatsApp
        // count. Ask once more with examples, then take the answer as given —
        // and honour it, because the whole section hangs off it (D-26).
        single(
          "sm_use_confirm",
          "sm_use_confirm",
          "",
          "Just to check — do you use any of these?",
          "scale.yes_no",
          {
            lede: {
              text: "TikTok · Instagram · Snapchat · YouTube · WhatsApp · Discord · Reddit · X (Twitter) · Twitch · BeReal · Facebook · Pinterest\n\nWatching or reading without posting still counts. Messaging apps you use to keep up with friends count too.",
            },
            displayIf: {
              op: "selected",
              target: { item: { instrument: "ybm_smartphone", item: "sm_use", revision: 1 } },
              code: 2,
            },
            researcherNote:
              "Confirmation step for a 'No' to sm_use (D-26). Recorded separately from sm_use — the original answer is never overwritten — and the social-media section shows if EITHER says yes. A 'No' here is taken at face value and no app questions follow.",
          },
        ),
        single(
          "age_sm",
          "sm_age",
          "Age_SM",
          "At what age did you start using social media? Please answer in years.",
          "scale.age_adoption_sm",
          {
            presentation: "compact",
            limitOptions: { kind: "at_most_age_now", from: { instrument: "ybm_identity", item: "dob", revision: 1 } },
            // Either route into social media qualifies: someone who said no
            // and then recognised the apps still gets asked when they started.
            displayIf: {
              op: "any",
              args: [
                { op: "selected", target: { item: smUseRef }, code: 1 },
                {
                  op: "selected",
                  target: { item: { instrument: "ybm_smartphone", item: "sm_use_confirm", revision: 1 } },
                  code: 1,
                },
              ],
            },
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
            // Was "Drag and drop the apps into the box…", describing a
            // Qualtrics interaction that does not exist here: the control is
            // two tap steps, and it prints its own step labels (D-29).
            text: "Which of these apps do you have on your phone?",
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
        single("night_checks", "sm_night_checks", "SM_night_check", "On a typical night, how many times do you wake up and check social media?", "scale.sm_night_checks_4pt"),
        single("morning_latency", "sm_morning_latency", "SM_morning_check ", "How long after waking do you typically check social media?", "scale.sm_morning_latency_5pt"),
        single("time_school_day", "sm_time_school_day", "SM_weekdays ", "How much time do you spend using social media on a typical school day (Monday-Friday)?", "scale.sm_daily_time_9pt"),
        single("time_nonschool_day", "sm_time_nonschool_day", "SM_weekend/holiday ", "How much time do you spend using social media on a typical non-school day (e.g., weekend or school holiday)?", "scale.sm_daily_time_9pt", { researcherNote: "Legacy tag contains a slash and trailing space (A-31)." }),
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
            text: "How long do you think you could go without social media?",
          },
          lede: {
            text: "We mean platforms like TikTok, Instagram, Facebook, Snapchat, X (Twitter), Reddit, YouTube and Threads — not messaging apps such as WhatsApp.",
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
          "Roughly how many hours do you play video games in a typical week?",
          "scale.gaming_hours_6pt",
          {
            lede: {
              text: "For example, an hour a day Monday to Friday plus two hours a day at the weekend comes to 9 hours.",
            },
            researcherNote: "Legacy tag 'weekday_games' mismatched content (A-9); canonical name corrected, alias kept. Band gap closed in D-27. Worked example moved to the lede (D-29).",
          },
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
