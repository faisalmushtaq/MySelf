import { z } from "zod";

/**
 * Identifier primitives (see docs/06):
 * - human keys: permanent lowercase slugs
 * - machine ids: ULIDs (sortable, offline-generatable)
 * - content hashes: sha256 over JCS-canonicalised artefacts
 * - semver adapted for psychometric artefacts (participant-visible change => MAJOR)
 */

export const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case, starting with a letter");

/** Dotted key for namespaced entities, e.g. "np.micro_narrative", "scale.sdq_3pt". */
export const dottedKey = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID");

export const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** MAJOR.MINOR.PATCH — see docs/06 §3 for the psychometric adaptation of semver. */
export const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/** Short semver used in human-readable references, e.g. "1.0". */
export const shortVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/** BCP 47-ish language tag restricted to the shapes we support. */
export const languageTag = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "e.g. en or en-GB");

export const readingLevel = z.enum(["standard", "simplified", "early_reader"]);

export const informant = z.enum(["self", "parent", "teacher", "clinician", "other"]);

/** Reference to an instrument version + form, e.g. "sdq25_s@1.0/en-GB/self". */
export const instrumentRef = z.object({
  instrument: slug,
  version: shortVersion,
  /** Variant tag distinguishes explicitly-labelled deviating forms, e.g. "ybm-asadmin". */
  variant: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  language: languageTag,
  informant: informant.default("self"),
  readingLevel: readingLevel.default("standard"),
});

/** Reference to a single item revision within an instrument. */
export const itemRef = z.object({
  instrument: slug,
  item: slug,
  revision: z.number().int().positive(),
});

/** Export-facing variable name (R/Python/Stata-safe; Stata limit enforced). */
export const variableName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/);

export type Slug = z.infer<typeof slug>;
export type InstrumentRef = z.infer<typeof instrumentRef>;
export type ItemRef = z.infer<typeof itemRef>;
