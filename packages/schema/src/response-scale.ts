import { z } from "zod";
import { dottedKey, semver } from "./identifiers.js";

/**
 * Response scales are first-class, versioned artefacts. Direction metadata is
 * mandatory (anomaly A-18: adjacent instruments in YBM reverse direction).
 * Codes: `code` is the canonical MySelf code; `legacyCode` preserves the
 * original Qualtrics recode where the scale was migrated (never silently
 * recoded — the crosswalk is generated from these pairs).
 */

export const scaleOption = z.object({
  code: z.number().int(),
  label: z.string().min(1),
  /** Original source-system code (e.g. Qualtrics recode), if migrated. */
  legacyCode: z.number().int().optional(),
  /** Explicit display position (1-based); defaults to array order. */
  position: z.number().int().positive().optional(),
  /** Option is a non-substantive escape ("Prefer not to say", "Not sure"). */
  kind: z.enum(["substantive", "decline", "dont_know", "not_applicable", "other_specify"]).default("substantive"),
  /** Free-text entry attached to this option (e.g. "Other: ____"). */
  textEntry: z.boolean().default(false),
  /**
   * Illustration key for options that are chosen by appearance rather than
   * by reading (e.g. hair-type patterns). Rendered by the presentation layer;
   * the label remains authoritative and is always shown alongside.
   */
  illustration: z.string().optional(),
  /** Short plain-language gloss shown under an illustrated option. */
  description: z.string().optional(),
  /**
   * Source-system label for the option (e.g. the "2c" hair-typing code), kept
   * for the codebook and crosswalk but never shown to participants — they
   * choose by looking at the picture, not by decoding a classification.
   */
  codeLabel: z.string().optional(),
  /**
   * The quantity the option denotes, where it denotes one — the age for "13",
   * 4 for "Younger than 5". Distinct from `code`, which is an arbitrary
   * identifier: two scales can code the same age differently, but the age is
   * the age. Options that denote no quantity ("I'm not sure") leave it unset
   * and are never filtered by a quantity rule.
   */
  value: z.number().optional(),
});

export const responseScale = z.object({
  key: dottedKey, // e.g. "scale.sdq_3pt"
  version: semver,
  name: z.string().min(1),
  options: z.array(scaleOption).min(2),
  /**
   * Substantive direction of increasing codes, declared explicitly:
   * e.g. agreement scale coded 1=Strongly agree is "descending" agreement.
   */
  direction: z.enum(["ascending", "descending", "unordered"]),
  /** What the codes mean when scored (documented, not inferred). */
  scoringNote: z.string().optional(),
  /**
   * Named ranges of codes, as the published form groups them — the SQS's
   * 0 Terrible, 1–3 Poor, 4–6 Fair, 7–9 Good, 10 Excellent (D-53). Shown
   * beneath a `numbered` presentation; each option's accessible name carries
   * its band. Descriptive only: the code is the answer.
   */
  bands: z
    .array(z.object({ label: z.string().min(1), from: z.number().int(), to: z.number().int() }))
    .optional(),
});

export type ScaleOption = z.infer<typeof scaleOption>;
export type ResponseScale = z.infer<typeof responseScale>;
