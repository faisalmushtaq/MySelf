import { z } from "zod";
import { dottedKey, semver, slug, variableName } from "./identifiers.js";
import { logicExpr, pipeRef } from "./logic.js";

/**
 * Items are versioned as integer revisions within their instrument. Any change
 * to participant-visible wording or response semantics requires a new revision
 * (and a MAJOR bump on the owning instrument version) — see docs/06 §3.
 */

/** Rich text limited to a safe inline subset; pipes are structured refs. */
export const displayText = z.object({
  text: z.string().min(1),
  pipes: z.record(z.string(), pipeRef).optional(), // placeholders like {withdrawal_date}
});

export const mediaRef = z.object({
  assetKey: slug, // resolved against the release bundle's asset table
  alt: z.string().min(1), // accessibility text is mandatory for media
  kind: z.enum(["image", "audio", "video"]),
});

const baseItem = {
  key: slug,
  revision: z.number().int().positive(),
  variable: variableName,
  /** Legacy source variable (verbatim Qualtrics tag), for the crosswalk. */
  legacyVariable: z.string().optional(),
  stem: displayText,
  media: z.array(mediaRef).optional(),
  required: z.enum(["hard", "soft", "optional"]).default("soft"),
  /** Offer an explicit decline control (D-05 / A-44). */
  allowDecline: z.boolean().default(false),
  /** Intra-module display condition (e.g. Age_smartphone if smartphone owned). */
  displayIf: logicExpr.optional(),
  a11yNote: z.string().optional(),
  researcherNote: z.string().optional(),
};

export const itemDefinition = z.discriminatedUnion("responseType", [
  z.object({
    ...baseItem,
    responseType: z.literal("info"), // descriptive text, no response
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("single_choice"),
    scale: dottedKey, // response-scale key
    scaleVersion: semver,
    /** "grid" tiles illustrated options (see scaleOption.illustration). */
    presentation: z.enum(["cards", "dropdown", "wheel", "grid"]).default("cards"),
    autoAdvance: z.boolean().default(true),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("multi_choice"),
    scale: dottedKey,
    scaleVersion: semver,
    minSelections: z.number().int().min(0).default(0),
    maxSelections: z.number().int().positive().optional(),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("slider"),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().default(1),
    minLabel: z.string().optional(),
    maxLabel: z.string().optional(),
    showValue: z.boolean().default(true),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("ladder"), // MacArthur-style discrete rung selector
    rungs: z.number().int().min(2),
    lowestValue: z.number().int().default(1),
    image: mediaRef.optional(),
    /** Anchors shown at the ends of the ladder so the metaphor needs no
     * explanation (e.g. "The people who are best off" / "…worst off"). */
    topLabel: z.string().optional(),
    bottomLabel: z.string().optional(),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("numeric"),
    min: z.number().optional(),
    max: z.number().optional(),
    integerOnly: z.boolean().default(true),
    unitLabel: z.string().optional(),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("date"),
    minYear: z.number().int().optional(),
    maxYear: z.number().int().optional(),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("text_short"),
    minChars: z.number().int().min(0).default(0),
    maxChars: z.number().int().positive().default(200),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("text_long"),
    minChars: z.number().int().min(0).default(0),
    maxChars: z.number().int().positive().default(5000),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("form_fields"), // labelled multi-field entry (ps_id, games list)
    fields: z
      .array(
        z.object({
          key: slug,
          label: z.string().min(1),
          kind: z.enum(["text", "numeric"]).default("text"),
          required: z.boolean().default(false),
          maxChars: z.number().int().positive().default(100),
        }),
      )
      .min(1),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("rank_group"), // drag-and-drop into groups + rank within group
    scale: dottedKey, // the draggable options
    scaleVersion: semver,
    groups: z
      .array(
        z.object({
          key: slug,
          label: z.string().min(1),
          ranked: z.boolean().default(false),
        }),
      )
      .min(2),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("checkbox_set"), // consent-style statement set
    statements: z
      .array(z.object({ key: slug, text: displayText, required: z.boolean().default(true) }))
      .min(1),
  }),
]);

export type ItemDefinition = z.infer<typeof itemDefinition>;
