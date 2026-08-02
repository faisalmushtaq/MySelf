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
});

export type ScaleOption = z.infer<typeof scaleOption>;
export type ResponseScale = z.infer<typeof responseScale>;
