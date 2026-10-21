import { z } from "zod";

/**
 * How a questionnaire, module or question came to be (D-68): so that anyone,
 * years later, can say whether it is a validated instrument used as published,
 * one we adapted, items borrowed from another study, or something the team
 * wrote, and who else had a hand in it (a Youth Advisory Group, say).
 *
 * It is a record about the content, never part of it: participants never see
 * it, it changes nothing about how answers are stored or scored, and editing
 * it needs no unlock. Optional in the schema so releases published before it
 * existed still read; every entry in the repository's library carries one.
 */
export const PROVENANCE_KINDS = [
  /** A published, validated instrument, administered as published. */
  "validated",
  /** A validated instrument with wording, items or format changed. */
  "validated_adapted",
  /** Items taken from another study's survey or a standard source (a census, a cohort study), not a validated scale. */
  "existing_items",
  /** Written by the research team. */
  "researcher_developed",
  /** Developed together with young people or members of the public. */
  "co_produced",
  /** Not recorded yet. */
  "unknown",
] as const;

export const provenanceKind = z.enum(PROVENANCE_KINDS);

/** Plain-language names, for the Studio, codebooks and exports. */
export const PROVENANCE_KIND_LABELS: Record<(typeof PROVENANCE_KINDS)[number], string> = {
  validated: "Validated instrument, as published",
  validated_adapted: "Validated instrument, adapted",
  existing_items: "Items from another study or source",
  researcher_developed: "Researcher-developed",
  co_produced: "Co-produced",
  unknown: "Not recorded yet",
};

export const provenanceInvolvement = z.object({
  /** Who: "Youth Advisory Group", "Teachers at partner schools". Never a personal email. */
  group: z.string().min(1).max(120),
  /** What they did: "co-wrote the questions", "reviewed the wording", "piloted it". */
  role: z.string().min(1).max(200),
  /** When, as an ISO date or year-month ("2026-09"). */
  when: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .optional(),
});

export const provenance = z.object({
  kind: provenanceKind,
  /** What it was taken or adapted from: an instrument, a study's survey, a source. */
  basedOn: z.string().min(1).max(1000).optional(),
  /** What differs from the source, and why. */
  adaptations: z.string().min(1).max(2000).optional(),
  /** Who wrote or encoded it: a team, not a person's email. */
  developedBy: z.string().min(1).max(200).optional(),
  /** Others who took part in developing it. */
  involvement: z.array(provenanceInvolvement).max(20).optional(),
  /** What is known about its validity: a validation study, "none yet". */
  evidence: z.string().min(1).max(1000).optional(),
  /** The decisions that shaped it (docs/09), e.g. "D-67". */
  decisions: z.array(z.string().regex(/^D-\d+$/)).max(40).optional(),
  /** Anything else worth knowing about where it came from. */
  notes: z.string().min(1).max(2000).optional(),
  /**
   * Whether someone on the research team has checked this record. Records
   * written from the repository's own history start unconfirmed: what is not
   * known is said to be not known, never guessed.
   */
  confirmed: z.boolean().default(false),
  /** Who checked it (a name or role, not an email), and when. */
  confirmedBy: z.string().min(1).max(120).optional(),
  confirmedAt: z.string().date().optional(),
});

export type Provenance = z.infer<typeof provenance>;
export type ProvenanceInput = z.input<typeof provenance>;
export type ProvenanceKind = z.infer<typeof provenanceKind>;
