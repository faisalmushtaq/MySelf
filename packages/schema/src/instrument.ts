import { z } from "zod";
import { informant, languageTag, readingLevel, semver, shortVersion, slug } from "./identifiers.js";
import { itemDefinition } from "./item.js";

/**
 * Instrument concept -> instrument version -> form (language / reading level /
 * informant / variant). Licence enforcement and the modifiability flag live
 * here; the composer's publish gate reads them (docs/03).
 */

export const licence = z.object({
  status: z.enum(["open", "permission_held", "permission_required", "blocked"]),
  holder: z.string().optional(),
  terms: z.string().optional(),
  /** May participant-visible wording legally/psychometrically be modified? */
  modifiable: z.enum(["yes", "no", "with_permission"]),
  evidence: z.string().optional(), // URL or register entry
  verified: z.boolean().default(false),
  verifiedAt: z.string().date().optional(),
});

export const timeEstimate = z.object({
  ageBand: z.enum(["8-10", "11-13", "14-16", "17-18", "adult"]),
  medianSeconds: z.number().positive(),
  provenance: z.enum(["estimated-heuristic", "published-source", "empirical-myself"]),
  note: z.string().optional(),
});

export const subscale = z.object({
  key: slug,
  name: z.string().min(1),
  itemKeys: z.array(slug).min(1),
});

export const instrumentForm = z.object({
  language: languageTag,
  readingLevel: readingLevel.default("standard"),
  informant: informant.default("self"),
  /** e.g. "ybm-asadmin" for the exact administered YBM 2026 form. */
  variant: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  label: z.string().min(1),
  instructions: z.string().optional(),
  items: z.array(itemDefinition).min(1),
  /** Matrices: keep simultaneous grid where administration fidelity requires it. */
  presentationFidelity: z.enum(["stepped_allowed", "grid_required"]).default("stepped_allowed"),
});

export const instrumentVersion = z.object({
  instrument: slug,
  version: shortVersion,
  name: z.string().min(1),
  abbreviation: z.string().optional(),
  construct: z.string().min(1),
  citation: z.string().optional(),
  citationVerified: z.boolean().default(false),
  ageRange: z.object({ min: z.number().int().min(3), max: z.number().int().max(120) }).optional(),
  licence,
  forms: z.array(instrumentForm).min(1),
  subscales: z.array(subscale).optional(),
  reverseScoredItems: z.array(slug).optional(),
  scoringKey: z.string().optional(), // -> scoring definition key
  missingDataRule: z.string().optional(),
  timeEstimates: z.array(timeEstimate).min(1),
  changelog: z.string().min(1),
  approvalStatus: z.enum(["draft", "in_review", "approved", "retired"]).default("draft"),
  owner: z.string().min(1),
  researcherNotes: z.string().optional(),
});

/** Bespoke study module: same shape as an instrument version, owned by a study. */
export const moduleDefinition = instrumentVersion.extend({
  kind: z.literal("module"),
  study: slug,
});

export const scoringDefinition = z.object({
  key: z.string().min(1),
  version: semver,
  instrument: slug,
  instrumentVersion: shortVersion,
  /**
   * Declarative pipeline: code transforms (e.g. administered 1–3 -> canonical
   * 0–2), reverse-scoring, subscale sums/means, conversion tables, cutoffs.
   * Executed by @myself/scoring; syntax emitters generate R/Python equivalents.
   */
  steps: z.array(
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("recode"),
        items: z.array(slug).min(1),
        map: z.record(z.string(), z.number()),
        output: z.enum(["replace_working", "new_variable"]).default("replace_working"),
      }),
      z.object({ op: z.literal("reverse"), items: z.array(slug).min(1), maxPlusMin: z.number() }),
      z.object({
        op: z.literal("sum"),
        items: z.array(slug).min(1),
        output: slug,
        minValid: z.number().int().min(0),
        prorate: z.boolean().default(false),
      }),
      z.object({
        op: z.literal("mean"),
        items: z.array(slug).min(1),
        output: slug,
        minValid: z.number().int().min(0),
      }),
      z.object({
        op: z.literal("lookup"), // e.g. SWEMWBS raw -> metric conversion
        input: slug,
        table: z.record(z.string(), z.number()),
        output: slug,
      }),
      z.object({
        op: z.literal("classify"),
        input: slug,
        bands: z
          .array(z.object({ label: z.string(), min: z.number(), max: z.number() }))
          .min(1),
        output: slug,
      }),
    ]),
  ),
  provenance: z.string().min(1), // where these rules come from (publication/manual)
  verified: z.boolean().default(false),
});

export type Licence = z.infer<typeof licence>;
export type InstrumentForm = z.infer<typeof instrumentForm>;
export type InstrumentVersion = z.infer<typeof instrumentVersion>;
export type ScoringDefinition = z.infer<typeof scoringDefinition>;
