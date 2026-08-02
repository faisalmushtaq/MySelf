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
const smUseYes = {
  op: "selected" as const,
  target: { item: { instrument: "ybm_smartphone", item: "sm_use", revision: 1 } },
  code: 1,
};

export const ybmComposition: AssessmentDraftInput = {
  key: "ybm_nd2026_standard",
  study: "ybm",
  title: "Yorkshire Brain Map — NotreDame 2026 standard questionnaire",
  language: "en-GB",
  readingLevel: "standard",
  ageBand: "14-16",
  allowBackNavigation: true, // matches Qualtrics BackButton=true (docs/10 §1)
  offline: { surveyOfflineCapable: true },
  screens: {
    finish: {
      kind: "finish",
      body: "That's everything — thank you for taking part in the Yorkshire Brain Map study! Please hand the iPad back to the researcher.",
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
      displayIf: smUseYes,
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
