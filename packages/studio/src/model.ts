import type { ItemDefinition } from "@myself/schema";
import type { QuestionTypeId } from "./catalogue.js";
import type { CompositionInput, InstrumentOrModule, ScaleInput, StudioDraft } from "./contract.js";
import { isMyStorySection, myStoryOf } from "./mystory.js";
import { definedQuestions, formOf, placements, splitItemKey, type Placement } from "./walk.js";

/**
 * The read side of the Studio's editing model: what the editor shows, and the
 * rules about what may be changed (docs/16 §4.4).
 *
 * Everything here is a pure function of a draft. The operations in ops.ts ask
 * the same questions through the same functions, so what the editor greys out
 * and what an operation refuses can never disagree.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why an editing operation was refused, for the editor to branch on. */
export type StudioOpErrorCode =
  | "not_found"
  | "locked"
  | "protected"
  | "linkage"
  | "published"
  | "invalid";

/**
 * An editing request the model will not carry out. The message is written for
 * the researcher, not a developer: it says what was refused, why, and what to
 * do instead, and the editor shows it as it is.
 */
export class StudioOpError extends Error {
  constructor(
    message: string,
    readonly code: StudioOpErrorCode = "invalid",
  ) {
    super(message);
    this.name = "StudioOpError";
  }
}

// ---------------------------------------------------------------------------
// What is protected, and why
// ---------------------------------------------------------------------------

export interface ProtectedModule {
  reason: "ethics" | "linkage";
  /** Shown beside the padlock, and in the unlock dialogue. */
  explanation: string;
}

/**
 * The study's introduction and consent modules. They are not protected — the
 * study team changes their wording as it needs to, and those changes do not
 * need sign-off in the Studio (D-61) — but they always come first: nothing is
 * asked before a participant has read them and consented (`keepConsentFirst`).
 */
export const CONSENT_MODULES: readonly string[] = ["ybm_intro_consent"];

/**
 * Study modules that stay read-only until someone unlocks them and records why
 * (docs/16 R4, R5). Unlocking is recorded in the draft and audited; it is not a
 * licence to change the identity questions' keys, types or variables, which
 * stay fixed even when unlocked (see `identityRoleOf`).
 */
export const PROTECTED_MODULES: Readonly<Record<string, ProtectedModule>> = {
  ybm_identity: {
    reason: "linkage",
    explanation:
      "These questions build the participant code and identity diversion: the code that links one person's " +
      "sittings together is derived from four of them, and their answers are diverted away from the research " +
      "data at ingest. Changing them can break linkage between sittings or put names and dates of birth " +
      "into the dataset.",
  },
};

/**
 * The protection on a module, or null. An own-property lookup: instrument keys
 * are slugs, and "constructor" is a valid slug that a plain `PROTECTED_MODULES[key]`
 * would resolve to Object's constructor — truthy, and so "protected".
 */
export function protectedModule(instrumentKey: string): ProtectedModule | null {
  return Object.prototype.hasOwnProperty.call(PROTECTED_MODULES, instrumentKey) ? PROTECTED_MODULES[instrumentKey]! : null;
}

/** Whether a protected module has been unlocked in this draft (own property only, as above). */
export function isUnlocked(draft: StudioDraft, instrumentKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.unlocked, instrumentKey);
}

/**
 * The four questions the participant code is derived from at ingest
 * (packages/store/src/ingest.ts, `secretParts`). They are looked up by these
 * exact IDs, so none may be removed, re-keyed or change type — even with
 * ybm_identity unlocked.
 */
export const LINKAGE_ITEM_KEYS: readonly string[] = [
  "ybm_identity.ps_mother_initials",
  "ybm_identity.ps_house_digit",
  "ybm_identity.ps_birth_month",
  "ybm_identity.ps_postcode_letters",
];

/**
 * Variables ingest and identity capture read by name (ingest.ts derives
 * `age_years` from `dob` and checks `first_name` across sittings;
 * apps/functions/src/identity.ts files all three as the person's identity).
 * Renaming one would silently stop that happening.
 */
export const IDENTITY_VARIABLES: readonly string[] = ["first_name", "last_name", "dob"];

/**
 * Whether a question is one the identity pipeline depends on: "linkage" for the
 * participant-code components, "identity" for the name and date-of-birth
 * questions, null otherwise.
 */
export function identityRoleOf(itemKey: string, item: { variable: string }): "linkage" | "identity" | null {
  if (LINKAGE_ITEM_KEYS.includes(itemKey)) return "linkage";
  if (IDENTITY_VARIABLES.includes(item.variable)) return "identity";
  return null;
}

// ---------------------------------------------------------------------------
// Editability tiers
// ---------------------------------------------------------------------------

export type EditTier = "locked" | "protected" | "editable";

/** The draft's definition of an instrument or module, by instrument key. */
export function instrumentDef(draft: StudioDraft, instrumentKey: string): { refKey: string; def: InstrumentOrModule } | null {
  for (const [refKey, def] of Object.entries(draft.instruments)) {
    if (def.instrument === instrumentKey) return { refKey, def };
  }
  return null;
}

/** A human name for an instrument: its own name, or its key if the draft no longer has it. */
export function instrumentName(draft: StudioDraft, instrumentKey: string): string {
  return instrumentDef(draft, instrumentKey)?.def.name ?? instrumentKey;
}

/**
 * How far an instrument may be edited.
 *
 * - "locked": a licensed instrument whose wording may not be modified
 *   (`licence.modifiable` is "no" or "with_permission"). Its block can move and
 *   be shown conditionally, and each question can be made required or optional,
 *   but its wording, options, order and type are fixed.
 * - "protected": the identity module, until unlocked.
 * - "editable": everything else, and protected modules once unlocked.
 */
export function editTier(draft: StudioDraft, instrumentKey: string): EditTier {
  const found = instrumentDef(draft, instrumentKey);
  // Licensed questionnaires start locked, so nobody changes one by accident,
  // and are unlocked with a recorded reason to edit them (as consent is).
  if (found && found.def.licence.modifiable !== "yes") return isUnlocked(draft, instrumentKey) ? "editable" : "locked";
  if (protectedModule(instrumentKey) && !isUnlocked(draft, instrumentKey)) return "protected";
  return "editable";
}

/** Every field any question type has. */
export type ItemField = ItemDefinition extends infer T ? (T extends unknown ? keyof T : never) : never;

/**
 * The question fields each tier may change (docs/16 §4.4). A locked question
 * keeps its wording, options and type; what it may change is how it is
 * administered and annotated. A protected question, until unlocked, may only
 * be annotated for analysis, which changes nothing a participant sees.
 */
export const ALLOWED_FIELDS_BY_TIER: {
  readonly locked: readonly ItemField[];
  readonly protected: readonly ItemField[];
  readonly editable: "all";
} = {
  locked: ["required", "allowDecline", "hint", "presentation", "a11yNote", "researcherNote", "reportingCategory", "provenance"],
  // The age limits on the date of birth are each survey's own (who may take
  // part), so they change without unlocking the identity module (D-65).
  protected: ["researcherNote", "reportingCategory", "provenance", "minAgeYears", "maxAgeYears", "minYear", "maxYear"],
  editable: "all",
};

/** Whether a tier allows a field to change. */
export function fieldAllowed(tier: EditTier, field: string): boolean {
  const allowed = ALLOWED_FIELDS_BY_TIER[tier];
  return allowed === "all" || (allowed as readonly string[]).includes(field);
}

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

/** Whether a scale is the two-option Yes/No preset (in either order). */
export function isYesNoScale(scale: ScaleInput | null | undefined): boolean {
  if (!scale || scale.options.length !== 2) return false;
  const labels = scale.options.map((o) => o.label.trim().toLowerCase()).sort();
  return labels[0] === "no" && labels[1] === "yes";
}

/** The Studio type a question shows as (catalogue.ts `QUESTION_TYPES`). */
export function studioTypeOf(item: ItemDefinition, scale?: ScaleInput | null): QuestionTypeId {
  switch (item.responseType) {
    case "info":
      return "info";
    case "text_short":
      return "short_text";
    case "text_long":
      return "long_text";
    case "single_choice":
      if (item.presentation === "dropdown") return "dropdown";
      if (isYesNoScale(scale)) return "yes_no";
      if (item.presentation === "spectrum") return "rating";
      return "single_choice";
    case "multi_choice":
      return "multiple_choice";
    case "slider":
      return "slider";
    case "numeric":
      return "number";
    case "date":
      return "date";
    case "checkbox_set":
      return "consent";
    case "ladder":
      return "ladder";
    case "form_fields":
      return "form_fields";
    case "rank_group":
      return "rank_group";
    case "time_grid":
      return "time_grid";
  }
}

// ---------------------------------------------------------------------------
// Finding things
// ---------------------------------------------------------------------------

/** The mutable item list of a draft instrument's form (a draft instrument carries one form). */
export function itemsOf(def: InstrumentOrModule | undefined | null): ItemDefinition[] {
  const form = formOf(def ?? undefined);
  return form ? (form.items as ItemDefinition[]) : [];
}

export interface QuestionPlacementRef {
  sectionIndex: number;
  sectionKey: string;
  componentIndex: number;
  indexInPlacement: number;
}

export interface FoundQuestion {
  refKey: string;
  instrument: string;
  key: string;
  item: ItemDefinition;
  /** Position in its instrument's form. */
  formItemIndex: number;
  /** Every placement that shows it — normally exactly one. */
  placements: QuestionPlacementRef[];
}

/** A live (not archived) question by ID, with where it is shown; null if the draft has no such question. */
export function findQuestion(draft: StudioDraft, itemKey: string): FoundQuestion | null {
  const { instrument, key } = splitItemKey(itemKey);
  for (const [refKey, def] of Object.entries(draft.instruments)) {
    if (def.instrument !== instrument) continue;
    const items = itemsOf(def);
    const formItemIndex = items.findIndex((i) => i.key === key);
    if (formItemIndex < 0) continue;
    const at: QuestionPlacementRef[] = [];
    for (const p of placements(draft)) {
      if (p.instrument !== instrument) continue;
      const indexInPlacement = p.items.findIndex((i) => i.key === key);
      if (indexInPlacement >= 0) {
        at.push({ sectionIndex: p.sectionIndex, sectionKey: p.sectionKey, componentIndex: p.componentIndex, indexInPlacement });
      }
    }
    return { refKey, instrument, key, item: items[formItemIndex]!, formItemIndex, placements: at };
  }
  return null;
}

/** The option list a question uses, or null if it has none (or the draft lacks it). */
export function scaleOf(draft: StudioDraft, itemKey: string): ScaleInput | null {
  const item = findQuestion(draft, itemKey)?.item ?? draft.archived.find((a) => a.itemKey === itemKey)?.item;
  if (!item || !("scale" in item)) return null;
  return draft.scales[item.scale] ?? null;
}

/**
 * The questions using an option list, in the draft's instruments (archived
 * questions are not counted: they are not asked, and a restore re-checks).
 */
export function scaleUsage(draft: StudioDraft, scaleKey: string): string[] {
  const out: string[] = [];
  for (const q of definedQuestions(draft)) {
    if ("scale" in q.item && q.item.scale === scaleKey && !out.includes(q.itemKey)) out.push(q.itemKey);
  }
  return out;
}

/**
 * Every question ID the draft holds, live or archived. An archived question's
 * ID stays taken, so restoring it can never collide with a newer question.
 */
export function allItemKeys(draft: StudioDraft): Set<string> {
  const out = new Set<string>();
  for (const q of definedQuestions(draft)) out.add(q.itemKey);
  for (const a of draft.archived) out.add(a.itemKey);
  return out;
}

/**
 * Every analysis variable the draft uses, live or archived, and the variable
 * the participant code is stored against: an export has one column per name,
 * so no question may take any of these.
 */
export function allVariables(draft: StudioDraft): Set<string> {
  const out = new Set<string>();
  for (const q of definedQuestions(draft)) out.add(q.item.variable);
  for (const a of draft.archived) out.add(a.item.variable);
  const codeVariable = draft.composition.participantCode?.variable;
  if (codeVariable) out.add(codeVariable);
  return out;
}

/** Question text cut to a length a sentence can carry, on a word boundary. */
export function shortText(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  // Cut back to the last whole word, unless the cut already falls between two.
  const space = flat[max - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

// ---------------------------------------------------------------------------
// The outline the editor draws
// ---------------------------------------------------------------------------

type ParticipantCode = NonNullable<CompositionInput["participantCode"]>;
type Contact = NonNullable<CompositionInput["contact"]>;
type Screen = CompositionInput["screens"][string];

export interface OutlineQuestion {
  itemKey: string;
  key: string;
  instrument: string;
  refKey: string;
  text: string;
  responseType: ItemDefinition["responseType"];
  studioType: QuestionTypeId;
  required: "hard" | "soft" | "optional";
  allowDecline: boolean;
  hasCondition: boolean;
  identifying: boolean;
  tier: EditTier;
  indexInPlacement: number;
  /** Position in the whole survey, 0-based, as a participant meets it. */
  position: number;
}

export interface OutlineBlock {
  componentIndex: number;
  kind: "instrument" | "module";
  instrument: string;
  refKey: string;
  name: string;
  tier: EditTier;
  hasCondition: boolean;
  /** The placement lists its questions rather than showing the whole form. */
  subset: boolean;
  questions: OutlineQuestion[];
}

export interface OutlineSection {
  key: string;
  title: string;
  index: number;
  hasCondition: boolean;
  /**
   * Instrument and module blocks. Screen components are outside what the
   * Studio edits (docs/16 §8) and are not listed; MyStory is `Outline.mystory`.
   */
  blocks: OutlineBlock[];
}

/** MyStory, when it is on (docs/16 §10.1). */
export interface OutlineMyStory {
  sectionKey: string;
  sectionIndex: number;
  title: string;
  /** `key@version`. */
  id: string;
  protocol: string;
  version: string;
  /** The protocol's own name, when the draft carries its definition. */
  name: string | null;
  approvalStatus: "draft" | "in_review" | "approved" | null;
}

export interface Outline {
  welcome: {
    /** The survey's full, researcher-facing title. */
    title: string;
    studyLabel: string | null;
    participantCode: ParticipantCode | null;
    contact: Contact | null;
  };
  /** Every section but MyStory's, which is always last and listed on its own. */
  sections: OutlineSection[];
  mystory: OutlineMyStory | null;
  completion: { finish: Screen | null; review: Screen | null };
  archived: { itemKey: string; text: string; sectionKey: string | null }[];
}

/** The survey as the editor lists it, in the order a participant meets it. */
export function outline(draft: StudioDraft): Outline {
  const c = draft.composition;
  const all = placements(draft);
  const tiers = new Map<string, EditTier>();
  const tierOf = (instrument: string) => {
    let t = tiers.get(instrument);
    if (!t) tiers.set(instrument, (t = editTier(draft, instrument)));
    return t;
  };
  let position = 0;
  const sections: OutlineSection[] = c.sections.flatMap((section, index) =>
    isMyStorySection(section)
      ? []
      : [
          {
            key: section.key,
            title: section.title,
            index,
            hasCondition: section.displayIf != null,
            blocks: all
              .filter((p) => p.sectionIndex === index)
              .map((p) => outlineBlock(draft, p, tierOf(p.instrument), () => position++)),
          },
        ],
  );
  const story = myStoryOf(draft);
  return {
    welcome: {
      title: c.title,
      studyLabel: c.studyLabel ?? null,
      participantCode: c.participantCode ?? null,
      contact: c.contact ?? null,
    },
    sections,
    mystory: story
      ? {
          sectionKey: story.sectionKey,
          sectionIndex: story.sectionIndex,
          title: c.sections[story.sectionIndex]?.title ?? "",
          id: story.id,
          protocol: story.protocol,
          version: story.version,
          name: story.definition?.name ?? null,
          approvalStatus: story.definition?.approvalStatus ?? null,
        }
      : null,
    completion: { finish: c.screens["finish"] ?? null, review: c.screens["review"] ?? null },
    archived: draft.archived.map((a) => ({ itemKey: a.itemKey, text: a.item.stem.text, sectionKey: a.sectionKey })),
  };
}

function outlineBlock(draft: StudioDraft, p: Placement, tier: EditTier, next: () => number): OutlineBlock {
  const component = draft.composition.sections[p.sectionIndex]!.components[p.componentIndex]!;
  return {
    componentIndex: p.componentIndex,
    kind: p.kind,
    instrument: p.instrument,
    refKey: p.refKey,
    name: p.def?.name ?? p.instrument,
    tier,
    hasCondition: component.displayIf != null,
    subset: p.subset !== null,
    questions: p.items.map((item, indexInPlacement) => {
      const scale = "scale" in item ? draft.scales[item.scale] : undefined;
      return {
        itemKey: `${p.instrument}.${item.key}`,
        key: item.key,
        instrument: p.instrument,
        refKey: p.refKey,
        text: item.stem.text,
        responseType: item.responseType,
        studioType: studioTypeOf(item, scale),
        required: item.required ?? "soft",
        allowDecline: item.allowDecline ?? false,
        hasCondition: item.displayIf != null,
        identifying: item.identifying ?? false,
        tier,
        indexInPlacement,
        position: next(),
      };
    }),
  };
}
