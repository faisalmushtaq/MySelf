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
  /**
   * Secondary explanatory text shown under the stem in body size. Lets a long
   * framing passage sit on the same screen as its response control instead of
   * becoming a click-through page the participant has already forgotten by the
   * time the control appears.
   */
  lede: displayText.optional(),
  /**
   * Detail a participant may want but should not have to wade through — how
   * their data is handled, who sees it, how long it is kept. Collapsed behind
   * its own label so it is available without being imposed.
   */
  moreInfo: z
    .object({
      label: z.string().min(1),
      body: displayText,
    })
    .optional(),
  media: z.array(mediaRef).optional(),
  required: z.enum(["hard", "soft", "optional"]).default("soft"),
  /** Offer an explicit decline control (D-05 / A-44). */
  allowDecline: z.boolean().default(false),
  /** Intra-module display condition (e.g. Age_smartphone if smartphone owned). */
  displayIf: logicExpr.optional(),
  /** Illustration token drawn beside the question (e.g. "object:pen"). */
  illustration: z.string().optional(),
  /**
   * Plain-language help revealed on request, or offered automatically when a
   * participant dwells on the item. Never shown by default — it must not
   * become extra reading for people who are managing fine.
   */
  hint: z.string().optional(),
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
    /**
     * "grid" tiles illustrated options; "spectrum" lays them along a left-to-
     * right axis so the spatial arrangement carries the meaning (handedness);
     * "compact" wraps many short labels (ages, months) into tappable chips so a
     * long list is still answered in one look rather than through a menu.
     * Menus ("dropdown"/"wheel") hide the options and cost an extra tap — use
     * them only where the list is genuinely too long to lay out.
     */
    presentation: z.enum(["cards", "dropdown", "wheel", "grid", "spectrum", "compact"]).default("cards"),
    /** Display the spectrum in reverse option order (presentation only —
     * response codes are never affected). */
    spectrumReverse: z.boolean().default(false),
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
    /** Plausibility bounds for dates of birth, checked against session date. */
    minAgeYears: z.number().int().min(0).optional(),
    maxAgeYears: z.number().int().min(0).optional(),
  }),
  z.object({
    ...baseItem,
    responseType: z.literal("text_short"),
    minChars: z.number().int().min(0).default(0),
    maxChars: z.number().int().positive().default(200),
    /** Anchored regular expression the answer must match. */
    pattern: z.string().optional(),
    /** Plain-language description of the expected format, shown on mismatch. */
    patternHint: z.string().optional(),
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
          pattern: z.string().optional(),
          patternHint: z.string().optional(),
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
