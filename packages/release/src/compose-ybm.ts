import type { z } from "zod";
import type { assessmentDraft } from "@myself/schema";

/**
 * The YBM NotreDame2026 standard assessment composition, mirroring the
 * Qualtrics flow (docs/10 §1) with the decided structure:
 * both social-media sections sit behind the SM_Own = Yes condition; canonical
 * instrument forms are selected per D-08 (as-administered variants stay in
 * the library for legacy interpretation).
 *
 * The micro-narrative section (np.micro_narrative, D-15) is added when the
 * protocol content is authored — the composition is versioned, so that will
 * be a draft edit followed by a fresh release.
 */

export type AssessmentDraftInput = z.input<typeof assessmentDraft>;

const en = { language: "en-GB", informant: "self", readingLevel: "standard" } as const;
/**
 * Everything about social media hangs off this one answer, so it is worth
 * getting right. "No" to `sm_use` triggers a confirmation with examples
 * (D-26); the section shows if *either* answer is yes, and a considered "no"
 * means no app questions at all.
 */
const yesTo = (item: string) => ({
  op: "selected" as const,
  target: { item: { instrument: "ybm_smartphone", item, revision: 1 } },
  code: 1,
});

const usesSocialMedia = {
  op: "any" as const,
  args: [yesTo("sm_use"), yesTo("sm_use_confirm")],
};

export const ybmComposition: AssessmentDraftInput = {
  key: "ybm_nd2026_standard",
  study: "ybm",
  title: "Yorkshire Brain Map — NotreDame 2026 standard questionnaire",
  // What a participant sees: the site and the year, not the catalogue title.
  // Researcher-set per fielding (D-24).
  studyLabel: "Notre Dame · 2026",
  contact: { email: "brainpop@leeds.ac.uk", ethicsReference: "PSCETHS-1449" },
  // r2.0.0 presentation changes (D-17/D-18): hair type is an illustrated
  // tappable grid, MacArthur ladders are tap/drag ladder graphics with anchor
  // labels. Item wording, response options and codes are unchanged from r1.
  language: "en-GB",
  readingLevel: "standard",
  ageBand: "14-16",
  allowBackNavigation: true, // matches Qualtrics BackButton=true (docs/10 §1)
  // The validation ID is entered here, once, before anything else — it used to
  // be asked again mid-survey, which was redundant and easy to get wrong the
  // second time (D-23). It is stored against `val_id`, so the legacy variable
  // is still populated without the participant retyping it.
  participantCode: {
    label: "Your study code",
    pattern: "^[A-Za-z]{3}[0-9]{4}$",
    hint: "Three letters then four numbers, for example NDC0042",
    placeholder: "NDC0042",
    variable: "val_id",
    instructions:
      "The research team gave you a code for today — three letters followed by four numbers. Type it in to begin. If you haven't got one, or you're not sure, ask a member of the team before you carry on.",
  },
  effort: {
    confirmSkip: true,
    skipRunCheckIn: 3,
    // Help is offered once someone has had time to read the screen three times
    // over, floored and capped (D-26) — a flat wait is far too long on a
    // two-word question and interrupts a careful reader on a long one.
    dwellHintSeconds: 20,
    dwellWordsPerSecond: 3,
    dwellReadingMultiple: 3,
    dwellMaxSeconds: 90,
    // The too-fast threshold scales with how much each screen asks people to
    // read, floored and capped (D-25). A flat two seconds flagged legitimate
    // quick answers to short battery items and buried the real cases.
    tooFastSeconds: 0.8,
    tooFastWordsPerSecond: 8,
    tooFastMaxSeconds: 6,
    tooFastRunPrompt: 5,
  },
  offline: { surveyOfflineCapable: true },
  screens: {
    // A last look before finishing. People notice a wrong answer when they
    // see it written down, not while they are giving it (D-30).
    review: {
      kind: "information",
      title: { text: "Before you finish" },
      body: {
        text: "Here's everything you told us. Have a scroll through — if anything looks wrong, tap it and you can change it.",
      },
    },
    // The name given at the very start comes back at the very end, so the
    // last thing a participant reads is addressed to them (D-26). The pipe
    // carries a fallback, so a lost or skipped name reads naturally too.
    finish: {
      kind: "finish",
      title: {
        text: "Thank you, {first_name}!",
        pipes: {
          first_name: {
            kind: "item_text_entry",
            item: { instrument: "ybm_identity", item: "first_name", revision: 1 },
            fallback: "and well done",
          },
        },
      },
      body: {
        text: "That's everything — thanks for taking part in the Yorkshire Brain Map study. Please hand the iPad back to the researcher.",
      },
    },
  },
  sections: [
    {
      key: "welcome",
      title: "Welcome",
      components: [{ kind: "module", ref: { instrument: "ybm_intro_consent", version: "1.0", ...en } }],
    },
    {
      key: "about_you",
      title: "About you",
      transition: "First, a few details about you.",
      components: [
        { kind: "module", ref: { instrument: "ybm_identity", version: "1.0", ...en } },
        { kind: "module", ref: { instrument: "ybm_demographics", version: "1.0", ...en } },
        { kind: "module", ref: { instrument: "ybm_eeg_practical", version: "1.0", ...en } },
      ],
    },
    {
      key: "hands_and_ladders",
      title: "Hands and standing",
      transition: "Great — now some quick questions about you and your world.",
      components: [
        { kind: "instrument", ref: { instrument: "ehi_sf", version: "1.0", ...en } },
        { kind: "instrument", ref: { instrument: "macarthur_ssy", version: "1.0", ...en } },
      ],
    },
    {
      key: "sleep",
      title: "Sleep",
      transition: "Next: sleep.",
      components: [
        { kind: "instrument", ref: { instrument: "kss", version: "1.0", ...en } },
        { kind: "module", ref: { instrument: "ybm_sleep_priorities", version: "1.0", ...en } },
      ],
    },
    {
      key: "wellbeing",
      title: "How you've been feeling",
      transition: "These questions ask how things have been for you lately.",
      components: [
        { kind: "instrument", ref: { instrument: "swemwbs", version: "1.0", ...en } },
        { kind: "instrument", ref: { instrument: "sdq25_s", version: "1.0", ...en } },
        { kind: "instrument", ref: { instrument: "rcads25", version: "1.0", ...en } },
      ],
    },
    {
      key: "phones",
      title: "Phones and social media",
      transition: "Now some questions about phones and social media.",
      components: [{ kind: "module", ref: { instrument: "ybm_smartphone", version: "1.0", ...en } }],
    },
    {
      key: "social_media",
      title: "Your social media",
      displayIf: usesSocialMedia,
      components: [
        { kind: "module", ref: { instrument: "ybm_social_media", version: "1.0", ...en } },
        { kind: "module", ref: { instrument: "ybm_screen_attitudes", version: "1.0", ...en } },
        { kind: "instrument", ref: { instrument: "doomscroll4", version: "1.0", ...en } },
      ],
    },
    {
      key: "gaming",
      title: "Gaming",
      transition: "Nearly there — a few questions about video games.",
      components: [{ kind: "module", ref: { instrument: "ybm_gaming", version: "1.0", ...en } }],
    },
    {
      key: "right_now",
      title: "Right now",
      transition: "Almost done! These last questions are about how you feel right now.",
      components: [
        { kind: "instrument", ref: { instrument: "stai5_s", version: "1.0", ...en } },
        { kind: "instrument", ref: { instrument: "bisbas12_ybm", version: "1.0", ...en } },
        { kind: "module", ref: { instrument: "ybm_future_self", version: "1.0", ...en } },
      ],
    },
  ],
};
