import type { z } from "zod";
import { instrumentVersion } from "../instrument.js";
import { responseScale } from "../response-scale.js";

/**
 * First library entry: Karolinska Sleepiness Scale.
 * Canonical form (decision D-08) + the exact administered YBM form
 * (variant "ybm-asadmin") preserved for legacy interpretation, including the
 * point-7 typo (anomaly A-8) and "4- Fairly alert" label.
 * Legacy Qualtrics codes were 1..9 identical to canonical (QSF RecodeValues).
 */

export const kssScaleCanonical: z.input<typeof responseScale> = {
  key: "scale.kss_9pt",
  version: "1.0.0",
  name: "KSS 9-point sleepiness scale (canonical labels)",
  direction: "ascending",
  options: [
    { code: 1, legacyCode: 1, label: "1 - Extremely alert", kind: "substantive", textEntry: false },
    { code: 2, legacyCode: 2, label: "2 - Very alert", kind: "substantive", textEntry: false },
    { code: 3, legacyCode: 3, label: "3 - Alert", kind: "substantive", textEntry: false },
    { code: 4, legacyCode: 4, label: "4 - Rather alert", kind: "substantive", textEntry: false },
    { code: 5, legacyCode: 5, label: "5 - Neither alert nor sleepy", kind: "substantive", textEntry: false },
    { code: 6, legacyCode: 6, label: "6 - Some signs of sleepiness", kind: "substantive", textEntry: false },
    { code: 7, legacyCode: 7, label: "7 - Sleepy, but no effort to keep awake", kind: "substantive", textEntry: false },
    { code: 8, legacyCode: 8, label: "8 - Sleepy, some effort to keep awake", kind: "substantive", textEntry: false },
    {
      code: 9,
      legacyCode: 9,
      label: "9 - Very sleepy, great effort to keep awake, fighting sleep",
      kind: "substantive",
      textEntry: false,
    },
  ],
  scoringNote: "Single-item state measure; score = selected code (1-9).",
};

export const kssScaleAsAdministered: z.input<typeof responseScale> = {
  ...kssScaleCanonical,
  key: "scale.kss_9pt_ybm",
  name: "KSS 9-point scale as administered in YBM 2026 (deviating labels preserved)",
  options: kssScaleCanonical.options.map((o) => {
    if (o.code === 4) return { ...o, label: "4- Fairly alert" };
    if (o.code === 7) return { ...o, label: "7 - Sleepy, but not no effort to keep awake" };
    return o;
  }),
};

export const kssInstrument: z.input<typeof instrumentVersion> = {
  instrument: "kss",
  version: "1.0",
  name: "Karolinska Sleepiness Scale",
  abbreviation: "KSS",
  construct: "State sleepiness",
  citation:
    "Åkerstedt, T., & Gillberg, M. (1990). Subjective and objective sleepiness in the active individual. International Journal of Neuroscience, 52(1-2), 29-37.",
  citationVerified: false,
  ageRange: { min: 11, max: 120 },
  licence: {
    status: "open",
    modifiable: "no",
    terms: "Widely used without fee in academic research; confirmation pending (docs/03).",
    verified: false,
  },
  forms: [
    {
      language: "en-GB",
      readingLevel: "standard",
      informant: "self",
      label: "KSS canonical (en-GB)",
      presentationFidelity: "stepped_allowed",
      items: [
        {
          responseType: "single_choice",
          key: "q1",
          revision: 1,
          variable: "kss_q1",
          legacyVariable: "Karolinska",
          stem: { text: "On a scale of 1 through 9 indicate how sleepy you are feeling right now:" },
          required: "soft",
          allowDecline: false,
          scale: "scale.kss_9pt",
          scaleVersion: "1.0.0",
          presentation: "cards",
          autoAdvance: true,
        },
      ],
    },
    {
      language: "en-GB",
      readingLevel: "standard",
      informant: "self",
      variant: "ybm-asadmin",
      label: "KSS as administered, YBM 2026 (label deviations preserved — A-8)",
      presentationFidelity: "stepped_allowed",
      items: [
        {
          responseType: "single_choice",
          key: "q1",
          revision: 1,
          variable: "kss_q1",
          legacyVariable: "Karolinska",
          stem: { text: "On a scale of 1 through 9 indicate how sleepy you are feeling right now:" },
          required: "soft",
          allowDecline: false,
          scale: "scale.kss_9pt_ybm",
          scaleVersion: "1.0.0",
          presentation: "cards",
          autoAdvance: true,
        },
      ],
    },
  ],
  timeEstimates: [
    { ageBand: "11-13", medianSeconds: 25, provenance: "estimated-heuristic", note: "Single item, 9 labelled options" },
    { ageBand: "14-16", medianSeconds: 20, provenance: "estimated-heuristic" },
  ],
  changelog: "1.0: initial encoding from YBM NotreDame2026 QSF; canonical labels restored per decision D-08.",
  approvalStatus: "draft",
  owner: "ybm",
};
