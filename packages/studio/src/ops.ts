import { narrativeProtocol, type NarrativeProtocol } from "@myself/narrative";
import { refKeyOf } from "@myself/release/gate";
import type { ReservedIds } from "./history.js";
import { canonicalJson, type ItemDefinition, type LogicExpr, type TimeGridSource } from "@myself/schema";
import { CHOICE_TYPES, defaultTextFor, questionType, templateFor, type QuestionTypeId } from "./catalogue.js";
import type { ArchivedPosition, ArchivedQuestion, CompositionInput, ScaleInput, StudioDraft } from "./contract.js";
import { studioModule, studioModuleKey, studioModuleRef } from "./draft.js";
import {
  generateItemKey,
  generateScaleKey,
  generateSectionKey,
  generateVariable,
  MAX_VARIABLE_LENGTH,
  SLUG_PATTERN,
  uniqueSlug,
} from "./keys.js";
import { toLogic } from "./logic.js";
import {
  isMyStorySection,
  myStoryMisplaced,
  myStoryOf,
  MYSTORY_SECTION_KEY,
  MYSTORY_TITLE,
  protocolId,
  protocolProblems,
} from "./mystory.js";
import {
  editTier,
  fieldAllowed,
  findQuestion,
  identityRoleOf,
  instrumentDef,
  instrumentName,
  isUnlocked,
  itemsOf,
  protectedModule,
  scaleUsage,
  StudioOpError,
  studioTypeOf,
  type EditTier,
  type FoundQuestion,
  type QuestionPlacementRef,
} from "./model.js";
import { definedQuestions, formOf, liveQuestions, normaliseRef, placements, splitItemKey } from "./walk.js";
import {
  clone,
  componentAt,
  componentRefKey,
  componentsOf,
  dropComponent,
  insertAt,
  isPlaced,
  keepConsentFirst,
  keepMyStoryLast,
  live,
  newPlacement,
  pinWholeFormPlacements,
  placementKeys,
  placeNewItem,
  quoted,
  sectionIndexOf,
  takenKeys,
  takenScaleKeys,
  takenVariables,
  type Component,
  type PlacedComponent,
  type Section,
  type Where,
} from "./editing.js";

/**
 * The Studio's editing operations.
 *
 * Every operation takes a draft and returns a new one; the draft passed in is
 * never touched, so the editor can keep it for undo and compare the two for the
 * change summary. A request the model will not carry out throws a
 * `StudioOpError` whose message is written for the researcher.
 *
 * Two kinds of mistake are treated differently, deliberately:
 * - Refused outright: anything that would break a rule the survey's data rests
 *   on — rewording a licensed questionnaire, re-keying a published question,
 *   reusing an option value, removing a participant-code question. These are
 *   never a matter of a draft being unfinished.
 * - Allowed, and reported by validation: anything a draft passes through while
 *   being edited — an empty section, a question with no text yet, a condition
 *   that now points at a deleted question. An operation never quietly "fixes"
 *   those by deleting something, because the researcher would not see it happen.
 */

type Screen = CompositionInput["screens"][string];
type ScaleOption = ScaleInput["options"][number];
type ParticipantCode = NonNullable<CompositionInput["participantCode"]>;
type Contact = NonNullable<CompositionInput["contact"]>;
type Effort = NonNullable<CompositionInput["effort"]>;


/** Who did something, and when (ISO), for the records the draft keeps. */
export interface OpActor {
  by: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Refuse unless the instrument's tier allows its questions to be changed at all. */
function requireEditable(d: StudioDraft, instrument: string, action: string): void {
  const tier = editTier(d, instrument);
  if (tier === "editable") return;
  throw tierError(d, instrument, tier, action);
}

function tierError(d: StudioDraft, instrument: string, tier: "locked" | "protected", action: string): StudioOpError {
  const name = instrumentName(d, instrument);
  if (tier === "locked") {
    return new StudioOpError(
      `You can't ${action}: “${name}” is a licensed, validated questionnaire. Its wording, options, codes and ` +
        `question order are fixed by its licence and by the evidence it was validated on. You can still move the ` +
        `whole block, show it only to some participants, and make its questions required or optional.`,
      "locked",
    );
  }
  const p = protectedModule(instrument);
  const why = p?.reason === "ethics" ? "covered by the ethics approval" : "safe for participant linkage";
  return new StudioOpError(
    `You can't ${action} yet: “${name}” is protected. ${p?.explanation ?? ""} To change it, unlock it first and ` +
      `record why the change is ${why}.`,
    "protected",
  );
}

/**
 * Refuse a change to a question the identity pipeline reads by ID or variable,
 * whatever the module's tier: an unlock acknowledges a change to wording, not
 * permission to break linkage.
 */
function refuseIdentity(
  itemKey: string,
  item: ItemDefinition,
  action: string,
  roles: readonly ("linkage" | "identity")[] = ["linkage", "identity"],
): void {
  const role = identityRoleOf(itemKey, item);
  if (!role || !roles.includes(role)) return;
  if (role === "linkage") {
    throw new StudioOpError(
      `You can't ${action}: ${quoted(item)} is one of the four questions the participant code is built from. ` +
        `Ingest finds it by this exact ID and reads its answer to link a person's sittings together, so it stays ` +
        `as it is even when the module is unlocked.`,
      "linkage",
    );
  }
  throw new StudioOpError(
    `You can't ${action}: ${quoted(item)} is read by its variable name, “${item.variable}”, when names and dates ` +
      `of birth are separated from the research data. Changing that would stop it being separated, so it stays as ` +
      `it is even when the module is unlocked.`,
    "linkage",
  );
}

function publishedError(item: ItemDefinition, what: string, action: string): StudioOpError {
  return new StudioOpError(
    `You can't ${action}: ${quoted(item)} has been published, so participants' answers are already recorded ` +
      `against its ${what}. ${
        action.startsWith("delete")
          ? "Deleting it would leave those answers with no question to be read through, and its ID could be given to something else. Archive it instead: it stops being asked, its ID stays reserved and its data stays readable."
          : "Changing it would split one question's data across two meanings. To ask something different, replace it with a new question: the old one is archived, its data stays readable, and the new one starts its own column."
      }`,
    "published",
  );
}

/** Remove a key from every subset of an instrument, dropping placements left empty. */
function removeFromSubsets(d: StudioDraft, refKey: string, key: string): void {
  for (const c of componentsOf(d, refKey)) {
    if (!c.items) continue;
    c.items = c.items.filter((k) => k !== key);
    if (c.items.length === 0) dropComponent(d, c);
  }
}

/** Remove an instrument and every placement of it. */
function removeInstrument(d: StudioDraft, refKey: string): void {
  delete d.instruments[refKey];
  for (const c of componentsOf(d, refKey)) dropComponent(d, c);
}

/**
 * Delete an option list nothing in the draft uses any more, live or archived,
 * and that has no retired values. Called only when an unpublished question lets
 * go of it: a published question that used it would still be in the draft
 * (published questions are archived, never deleted), so no recorded answer can
 * be coded against a list removed here.
 */
function dropOrphanScale(d: StudioDraft, scaleKey: string): void {
  if (scaleUsage(d, scaleKey).length > 0) return;
  if (d.archived.some((a) => "scale" in a.item && a.item.scale === scaleKey)) return;
  if ((d.retiredCodes[scaleKey] ?? []).length > 0) return;
  delete d.scales[scaleKey];
}

function sectionHasProtected(d: StudioDraft, section: Section): string | null {
  for (const c of section.components) {
    if (isPlaced(c) && editTier(d, c.ref.instrument) === "protected") return c.ref.instrument;
  }
  return null;
}

function checkIndex(index: number, max: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max) {
    throw new StudioOpError(`That is not a position ${what} (choose 0 to ${max}).`, "invalid");
  }
}

/**
 * The tier an archived question's instrument has: its live definition's if the
 * draft still has one, otherwise that of the definition the record carries.
 */
function archivedTier(d: StudioDraft, record: ArchivedQuestion): EditTier {
  const { instrument } = splitItemKey(record.itemKey);
  if (instrumentDef(d, instrument)) return editTier(d, instrument);
  const shell = record.instrumentShell ?? d.archived.find((a) => a.refKey === record.refKey && a.instrumentShell)?.instrumentShell;
  if (shell && shell.licence.modifiable !== "yes") return "locked";
  return protectedModule(instrument) && !isUnlocked(d, instrument) ? "protected" : "editable";
}

/** The name of an archived question's instrument, from the draft or the definition the record carries. */
function archivedName(d: StudioDraft, record: ArchivedQuestion): string {
  const { instrument } = splitItemKey(record.itemKey);
  const shell = record.instrumentShell ?? d.archived.find((a) => a.refKey === record.refKey && a.instrumentShell)?.instrumentShell;
  return instrumentDef(d, instrument)?.def.name ?? shell?.name ?? instrument;
}

/** Archived questions that use an option list. */
function archivedUsers(d: StudioDraft, scaleKey: string): ArchivedQuestion[] {
  return d.archived.filter((a) => "scale" in a.item && a.item.scale === scaleKey);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * A new, empty section. It has no blocks, so the draft does not validate until
 * a question is added to it — which validation says, in those words.
 *
 * At the end means at the end of the questions: when MyStory is on, the new
 * section goes in just before it, since MyStory always comes last.
 */
export function addSection(draft: StudioDraft, req: { title: string; index?: number }): { draft: StudioDraft; sectionKey: string } {
  const title = req.title.trim();
  if (!title) throw new StudioOpError("A section needs a title.", "invalid");
  const d = clone(draft);
  const sections = d.composition.sections;
  const story = myStoryOf(d);
  const end = story && !myStoryMisplaced(d) ? story.sectionIndex : sections.length;
  const index = req.index ?? end;
  checkIndex(index, sections.length, "for a section");
  const sectionKey = generateSectionKey(title, new Set(sections.map((s) => s.key)));
  sections.splice(index, 0, { key: sectionKey, title, components: [] });
  keepMyStoryLast(draft, d, "add a section there");
  return { draft: d, sectionKey };
}

export function updateSection(
  draft: StudioDraft,
  sectionKey: string,
  patch: { title?: string; displayIf?: LogicExpr | null },
): { draft: StudioDraft } {
  const d = clone(draft);
  const section = d.composition.sections[sectionIndexOf(d, sectionKey)]!;
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new StudioOpError("A section needs a title.", "invalid");
    section.title = title;
  }
  if (patch.displayIf !== undefined) {
    // A condition on the section would hide a protected block along with it —
    // the consent, or the questions linkage depends on.
    const guarded = sectionHasProtected(d, section);
    if (guarded) throw tierError(d, guarded, "protected", "show this section only to some participants");
    if (patch.displayIf === null) delete section.displayIf;
    else section.displayIf = structuredClone(patch.displayIf);
  }
  return { draft: d };
}

export function moveSection(draft: StudioDraft, sectionKey: string, toIndex: number): { draft: StudioDraft } {
  const d = clone(draft);
  const sections = d.composition.sections;
  const from = sectionIndexOf(d, sectionKey);
  checkIndex(toIndex, sections.length - 1, "for a section");
  const guarded = sectionHasProtected(d, sections[from]!);
  if (guarded && from !== toIndex) throw tierError(d, guarded, "protected", "move this section");
  const [section] = sections.splice(from, 1);
  sections.splice(toIndex, 0, section!);
  keepConsentFirst(draft, d, "move this section there");
  keepMyStoryLast(draft, d, "move this section there");
  return { draft: d };
}

/** Remove a section that holds nothing. Blocks and questions are moved or archived first, never lost with it. */
export function removeSection(draft: StudioDraft, sectionKey: string): { draft: StudioDraft } {
  const d = clone(draft);
  const sections = d.composition.sections;
  const index = sectionIndexOf(d, sectionKey);
  const section = sections[index]!;
  if (isMyStorySection(section)) {
    throw new StudioOpError("This is MyStory's section. To take MyStory out of the survey, switch it off instead.", "invalid");
  }
  if (section.components.length > 0) {
    throw new StudioOpError(
      `“${section.title}” still has questions in it. Move them to another section or archive them first, then remove the section.`,
      "invalid",
    );
  }
  if (sections.length === 1) throw new StudioOpError("A survey needs at least one section.", "invalid");
  sections.splice(index, 1);
  return { draft: d };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Move a whole block (a placement of an instrument or module). This is how a
 * licensed questionnaire is moved: always whole, so its questions stay together
 * in their validated order.
 */
export function moveBlock(
  draft: StudioDraft,
  from: { sectionKey: string; componentIndex: number },
  to: { sectionKey: string; index: number },
): { draft: StudioDraft } {
  const d = clone(draft);
  const source = d.composition.sections[sectionIndexOf(d, from.sectionKey)]!;
  const target = d.composition.sections[sectionIndexOf(d, to.sectionKey)]!;
  const component = source.components[from.componentIndex];
  if (!component) throw new StudioOpError("That block is not in this section any more.", "not_found");
  if (isPlaced(component) && editTier(d, component.ref.instrument) === "protected") {
    throw tierError(d, component.ref.instrument, "protected", "move this block");
  }
  source.components.splice(from.componentIndex, 1);
  checkIndex(to.index, target.components.length, "in that section");
  target.components.splice(to.index, 0, component);
  keepConsentFirst(draft, d, "move this block there");
  keepMyStoryLast(draft, d, "move this block there");
  return { draft: d };
}

/** Show a block only when a condition holds, or (null) to everyone. Allowed on licensed questionnaires too. */
export function setBlockCondition(
  draft: StudioDraft,
  sectionKey: string,
  componentIndex: number,
  displayIf: LogicExpr | null,
): { draft: StudioDraft } {
  const d = clone(draft);
  const section = d.composition.sections[sectionIndexOf(d, sectionKey)]!;
  const component = section.components[componentIndex];
  if (!component) throw new StudioOpError("That block is not in this section any more.", "not_found");
  if (isPlaced(component) && editTier(d, component.ref.instrument) === "protected") {
    throw tierError(d, component.ref.instrument, "protected", "show this block only to some participants");
  }
  if (displayIf === null) delete component.displayIf;
  else component.displayIf = structuredClone(displayIf);
  return { draft: d };
}

/**
 * Remove a block, archiving every question it shows so each can be restored.
 *
 * Allowed for a licensed questionnaire (it leaves whole, and a restore brings it
 * back whole); refused for a protected module until it is unlocked, and always
 * for the block holding the participant-code questions.
 */
export function removeBlock(
  draft: StudioDraft,
  sectionKey: string,
  componentIndex: number,
  actor: OpActor,
): { draft: StudioDraft; archived: string[] } {
  const d = clone(draft);
  const sectionIndex = sectionIndexOf(d, sectionKey);
  const component = componentAt(d, sectionIndex, componentIndex);
  const instrument = component.ref.instrument;
  if (editTier(d, instrument) === "protected") throw tierError(d, instrument, "protected", "remove this block");
  const placement = placements(d).find((p) => p.sectionIndex === sectionIndex && p.componentIndex === componentIndex);
  const items = placement?.items ?? [];
  for (const item of items) refuseIdentity(`${instrument}.${item.key}`, item, "remove this block", ["linkage"]);
  const archived: string[] = [];
  // Last first, so each record's neighbours before it are still there to be
  // recorded, and the block comes back in its own order however it is restored.
  for (const item of [...items].reverse()) {
    const q = findQuestion(d, `${instrument}.${item.key}`);
    if (!q) continue;
    const indexInPlacement = placementKeys(d, component).indexOf(item.key);
    archiveInto(d, q, actor, { sectionIndex, sectionKey, componentIndex, indexInPlacement });
    archived.unshift(`${instrument}.${item.key}`);
  }
  dropComponent(d, component);
  return { draft: d, archived };
}

// ---------------------------------------------------------------------------
// Adding questions
// ---------------------------------------------------------------------------

export interface AddQuestionRequest {
  sectionKey: string;
  typeId: QuestionTypeId;
  text?: string;
  /** Put the new question straight after this one. */
  afterItemKey?: string;
  /** IDs and variables any published version used. */
  reserved?: ReservedIds;
}

/**
 * Add a new question.
 *
 * After a question of an editable module it joins that module, right after it
 * in the same placement. Anywhere else — including after a question of a
 * licensed questionnaire, which cannot take new questions — it goes into the
 * survey's own module (`<study>_studio`), placed by subset: onto the end of that
 * module's last placement in the section, or, when placed after a question in
 * another block, into a placement of it directly after that block (a new one
 * unless the next block already is one), so it appears where it was asked for.
 */
export function addQuestion(draft: StudioDraft, req: AddQuestionRequest): { draft: StudioDraft; itemKey: string } {
  const type = questionType(req.typeId);
  if (!type.canCreate) {
    throw new StudioOpError(`New “${type.label}” questions can't be created in the Studio.`, "invalid");
  }
  const d = clone(draft);
  const sectionIndex = sectionIndexOf(d, req.sectionKey);
  const section = d.composition.sections[sectionIndex]!;
  const text = req.text?.trim() || defaultTextFor(req.typeId);

  let target: { refKey: string; instrument: string; component: PlacedComponent | null; where: Where } | null = null;
  let anchorComponent: PlacedComponent | null = null;
  if (req.afterItemKey) {
    const after = live(d, req.afterItemKey);
    const at = after.placements.find((p) => p.sectionIndex === sectionIndex);
    if (!at) throw new StudioOpError(`${quoted(after.item)} is not in the section “${section.title}”.`, "invalid");
    const component = componentAt(d, at.sectionIndex, at.componentIndex);
    if (editTier(d, after.instrument) === "editable") {
      target = { refKey: after.refKey, instrument: after.instrument, component, where: { after: after.key } };
    } else {
      anchorComponent = component;
    }
  }

  if (!target) {
    const c = d.composition;
    const instrument = studioModuleKey(c.study);
    const existing = instrumentDef(d, instrument);
    const refKey = existing?.refKey ?? refKeyOf(normaliseRef(studioModuleRef(c.study, c.language)));
    if (!existing) {
      d.instruments[refKey] = studioModule({ study: c.study, language: c.language, ageBand: c.ageBand, items: [] });
    }
    const isStudio = (x: Component | undefined): x is PlacedComponent => !!x && isPlaced(x) && componentRefKey(x) === refKey;
    let component: PlacedComponent | null = null;
    let where: Where = "end";
    if (anchorComponent) {
      const next = section.components[section.components.indexOf(anchorComponent) + 1];
      if (isStudio(next)) {
        component = next;
        where = "start";
      } else {
        component = newPlacement(d.instruments[refKey]!, null, []);
        section.components.splice(section.components.indexOf(anchorComponent) + 1, 0, component);
      }
    } else {
      component = [...section.components].reverse().find(isStudio) ?? null;
      if (!component) {
        component = newPlacement(d.instruments[refKey]!, null, []);
        section.components.push(component);
      }
    }
    target = { refKey, instrument, component, where };
  }

  const key = generateItemKey(text, takenKeys(d, target.instrument, req.reserved));
  // From the words, not the key: a key made unique as `pets_2` would otherwise
  // give a variable of `pets_2_2` when `pets_2` is taken as a variable too.
  const variable = generateVariable(generateItemKey(text, new Set()), takenVariables(d, req.reserved));
  const scaleKey = CHOICE_TYPES.includes(req.typeId) ? generateScaleKey(target.instrument, key, takenScaleKeys(d)) : undefined;
  const { item, scale } = templateFor(req.typeId, {
    key,
    variable,
    text,
    instrument: target.instrument,
    ...(scaleKey ? { scaleKey } : {}),
  });
  if (scale) d.scales[scale.key] = scale;
  placeNewItem(d, target.refKey, item, target.component, target.where);
  if (item.responseType === "time_grid") chooseGridSource(d, `${target.instrument}.${key}`);
  keepConsentFirst(draft, d, "add a question there");
  keepMyStoryLast(draft, d, "add a question there");
  return { draft: d, itemKey: `${target.instrument}.${key}` };
}

/**
 * A copy of a question, straight after it in the same placement, with a new ID
 * and variable. A choice question's copy SHARES the original's option list, so
 * a Likert set built by copying stays one list and a later wording fix to the
 * options reaches every question in it; `forkScale` gives the copy its own list
 * when its options need to differ.
 */
export function duplicateQuestion(
  draft: StudioDraft,
  itemKey: string,
  opts: { reserved?: ReservedIds } = {},
): { draft: StudioDraft; itemKey: string } {
  const d = clone(draft);
  const q = live(d, itemKey);
  requireEditable(d, q.instrument, "copy this question");
  const key = uniqueSlug(q.key, takenKeys(d, q.instrument, opts.reserved), 64);
  const variable = generateVariable(q.item.variable, takenVariables(d, opts.reserved));
  const copy: ItemDefinition = { ...structuredClone(q.item), key, revision: 1, variable };
  // The legacy variable ties the original to its source-system column; the copy has none.
  delete copy.legacyVariable;
  const at = q.placements[0];
  placeNewItem(d, q.refKey, copy, at ? componentAt(d, at.sectionIndex, at.componentIndex) : null, { after: q.key });
  return { draft: d, itemKey: `${q.instrument}.${key}` };
}

// ---------------------------------------------------------------------------
// Changing questions
// ---------------------------------------------------------------------------

type PatchOf<T> = { [K in keyof T]?: T[K] | null };
/**
 * Changes to a question: any of its type's fields. `null` removes an optional
 * field; `undefined` (or leaving it out) leaves it alone.
 */
export type QuestionPatch = ItemDefinition extends infer T ? (T extends unknown ? PatchOf<T> : never) : never;

const BASE_REQUIRED = ["key", "revision", "variable", "stem", "required", "allowDecline", "identifying", "responseType"];
const BASE_OPTIONAL = [
  "legacyVariable",
  "lede",
  "moreInfo",
  "media",
  "displayIf",
  "illustration",
  "hint",
  "crossChecks",
  "a11yNote",
  "researcherNote",
  "reportingCategory",
];

/** The fields each type has beyond the shared ones: those it must have, and those it may. */
const TYPE_FIELDS: Record<ItemDefinition["responseType"], { required: string[]; optional: string[] }> = {
  info: { required: [], optional: [] },
  single_choice: { required: ["scale", "scaleVersion", "presentation", "spectrumReverse", "autoAdvance"], optional: ["limitOptions"] },
  multi_choice: { required: ["scale", "scaleVersion", "minSelections"], optional: ["maxSelections"] },
  slider: { required: ["min", "max", "step", "showValue"], optional: ["minLabel", "maxLabel"] },
  ladder: { required: ["rungs", "lowestValue"], optional: ["image", "topLabel", "bottomLabel"] },
  numeric: { required: ["integerOnly"], optional: ["min", "max", "unitLabel"] },
  date: { required: [], optional: ["minYear", "maxYear", "minAgeYears", "maxAgeYears"] },
  text_short: { required: ["minChars", "maxChars"], optional: ["pattern", "patternHint"] },
  text_long: { required: ["minChars", "maxChars"], optional: [] },
  form_fields: { required: ["fields"], optional: [] },
  rank_group: { required: ["scale", "scaleVersion", "groups"], optional: [] },
  time_grid: { required: ["rowsFrom"], optional: ["maxMinutesPerRow"] },
  checkbox_set: { required: ["statements"], optional: [] },
};

/** What changing a field amounts to, in the words a refusal uses. */
const FIELD_ACTIONS: Record<string, string> = {
  stem: "change its wording",
  lede: "change its wording",
  moreInfo: "change its wording",
  key: "change its ID",
  variable: "change its variable name",
  displayIf: "change when it is shown",
  scale: "change its options",
  scaleVersion: "change its options",
  identifying: "change whether its answer identifies someone",
  crossChecks: "change its answer checks",
  limitOptions: "change which options are offered",
  rowsFrom: "change which options become its rows",
  maxMinutesPerRow: "change its answer limits",
  statements: "change its statements",
  fields: "change its fields",
  groups: "change its groups",
  revision: "change its revision",
  legacyVariable: "change its legacy variable",
  required: "change whether it must be answered",
  allowDecline: "change whether it can be declined",
  hint: "change its hint",
  presentation: "change how it is laid out",
  a11yNote: "change its accessibility note",
  researcherNote: "change its researcher note",
  reportingCategory: "change its reporting category",
};

function typeLabel(d: StudioDraft, item: ItemDefinition): string {
  return questionType(studioTypeOf(item, "scale" in item ? d.scales[item.scale] : null)).label;
}

function actionFor(field: string): string {
  return FIELD_ACTIONS[field] ?? "change how it is answered";
}

/**
 * Change a question. Refuses, with the reason: a field its tier does not allow;
 * a field its type does not have; a new type (use `changeQuestionType`); a new
 * ID or variable once published, or ever for the identity questions. A change
 * of ID carries every reference to the question with it — conditions, pipes,
 * checks, placements, scoring and notes — so nothing is left pointing at the
 * old ID.
 */
export function updateQuestion(
  draft: StudioDraft,
  itemKey: string,
  patch: QuestionPatch,
  opts: { published?: ReadonlySet<string>; reserved?: ReservedIds } = {},
): { draft: StudioDraft; itemKey: string } {
  const d = clone(draft);
  const q = live(d, itemKey);
  const item = q.item as unknown as Record<string, unknown>;
  const changes = Object.entries(patch as Record<string, unknown>).filter(
    ([field, value]) => value !== undefined && !(value === null ? !(field in item) : canonicalJson(value) === canonicalJson(item[field])),
  );
  if (changes.length === 0) return { draft: d, itemKey };

  const tier = editTier(d, q.instrument);
  const fields = TYPE_FIELDS[q.item.responseType];
  let newKey = q.key;
  for (const [field, value] of changes) {
    if (field === "responseType") {
      throw new StudioOpError("To change what kind of question this is, change its type rather than editing it.", "invalid");
    }
    if (tier !== "editable" && !fieldAllowed(tier, field)) throw tierError(d, q.instrument, tier, actionFor(field));
    const required = BASE_REQUIRED.includes(field) || fields.required.includes(field);
    if (!required && !BASE_OPTIONAL.includes(field) && !fields.optional.includes(field)) {
      throw new StudioOpError(`A ${typeLabel(d, q.item).toLowerCase()} question has no “${field}” setting.`, "invalid");
    }
    if (value === null && required) {
      throw new StudioOpError(`A question's “${field}” can be changed but not removed.`, "invalid");
    }
    if (field === "key" || field === "variable") {
      const what = field === "key" ? "ID" : "variable name";
      refuseIdentity(itemKey, q.item, `change its ${what}`);
      if (opts.published?.has(itemKey)) throw publishedError(q.item, what, `change its ${what}`);
    }
    if (field === "identifying" && value === false) refuseIdentity(itemKey, q.item, "stop treating its answer as identifying");
    // Pointing a participant-code question at another option list changes the
    // codes ingest derives the participant code from, exactly as editing its
    // options would (which `optionTarget` refuses), so it is refused the same way.
    if (field === "scale" || field === "scaleVersion") refuseIdentity(itemKey, q.item, "change its options", ["linkage"]);
    if (field === "key") newKey = checkNewKey(d, q, value, opts.reserved);
    if (field === "variable") checkNewVariable(d, q.item.variable, value, opts.reserved);
    // Own property only: "constructor" is a valid scale key, and `d.scales.constructor` is not a list.
    if (field === "scale" && (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(d.scales, value))) {
      throw new StudioOpError(`There is no option list “${String(value)}” in this survey.`, "not_found");
    }
    if (field === "pattern" && typeof value === "string") checkPattern(value, "answer");
  }

  for (const [field, value] of changes) {
    if (field === "key") continue;
    if (value === null) delete item[field];
    else item[field] = structuredClone(value);
  }
  // A new option list brings its own version unless one was given.
  const scaleChange = changes.find(([f]) => f === "scale");
  if (scaleChange && !changes.some(([f]) => f === "scaleVersion")) {
    item["scaleVersion"] = d.scales[scaleChange[1] as string]!.version;
  }
  if (newKey !== q.key) renameQuestion(d, q.instrument, q.key, newKey);
  return { draft: d, itemKey: `${q.instrument}.${newKey}` };
}

function checkNewKey(d: StudioDraft, q: FoundQuestion, value: unknown, reserved?: ReservedIds): string {
  if (typeof value !== "string" || value.length > 64 || !SLUG_PATTERN.test(value)) {
    throw new StudioOpError(
      "A question ID must start with a lowercase letter and use only lowercase letters, numbers and underscores (at most 64).",
      "invalid",
    );
  }
  if (takenKeys(d, q.instrument, reserved).has(value)) {
    throw new StudioOpError(
      `The ID “${value}” is already used by another question in this block, now or in a published version. Choose another.`,
      "invalid",
    );
  }
  return value;
}

function checkNewVariable(d: StudioDraft, current: string, value: unknown, reserved?: ReservedIds): void {
  if (typeof value !== "string" || value.length > MAX_VARIABLE_LENGTH || !SLUG_PATTERN.test(value)) {
    throw new StudioOpError(
      `A variable name must start with a lowercase letter and use only lowercase letters, numbers and underscores (at most ${MAX_VARIABLE_LENGTH}).`,
      "invalid",
    );
  }
  const taken = takenVariables(d, reserved);
  taken.delete(current);
  if (taken.has(value)) {
    throw new StudioOpError(
      `The variable name “${value}” is already used, now or in a published version. Every column in the data needs its own name.`,
      "invalid",
    );
  }
}

function checkPattern(pattern: string, what: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new StudioOpError(`The ${what} format “${pattern}” is not a pattern the app can use. Check its brackets and symbols.`, "invalid");
  }
}

/** Give a question a new key, carrying every reference to it along. */
function renameQuestion(d: StudioDraft, instrument: string, from: string, to: string): void {
  const swap = (k: string) => (k === from ? to : k);
  // Item references ({instrument, item, revision}) appear in conditions, pipes,
  // cross-checks and option limits, anywhere in the composition or the items.
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o["instrument"] === instrument && o["item"] === from && typeof o["revision"] === "number") o["item"] = to;
    for (const child of Object.values(o)) visit(child);
  };
  visit(d.composition);
  visit(d.instruments);
  visit(d.archived);
  for (const [, def] of Object.entries(d.instruments)) {
    if (def.instrument !== instrument) continue;
    const item = itemsOf(def).find((i) => i.key === from);
    if (item) item.key = to;
    for (const s of def.subscales ?? []) s.itemKeys = s.itemKeys.map(swap);
    if (def.reverseScoredItems) def.reverseScoredItems = def.reverseScoredItems.map(swap);
  }
  for (const c of d.composition.sections.flatMap((s) => s.components)) {
    if (isPlaced(c) && c.ref.instrument === instrument && c.items) c.items = c.items.map(swap);
  }
  for (const s of Object.values(d.scoring)) {
    if (s.instrument !== instrument) continue;
    for (const step of s.steps) if ("items" in step) step.items = step.items.map(swap);
  }
  // Archived neighbours record where they stood by key, so a restore puts them
  // back beside this question under its new key rather than losing their place.
  for (const a of d.archived) {
    if (splitItemKey(a.itemKey).instrument !== instrument || !a.position) continue;
    a.position.formAfter = a.position.formAfter.map(swap);
    if (a.position.placement) a.position.placement.after = a.position.placement.after.map(swap);
  }
  const fromId = `${instrument}.${from}`;
  const note = d.notes[fromId];
  if (note) {
    d.notes[`${instrument}.${to}`] = note;
    delete d.notes[fromId];
  }
}

/**
 * The sorting or multiple-choice questions a time grid could take its rows
 * from: those asked before it, nearest first. The editor offers these.
 */
export function gridSources(draft: StudioDraft, itemKey: string): { itemKey: string; item: ItemDefinition }[] {
  const asked = liveQuestions(draft);
  const at = asked.findIndex((q) => q.itemKey === itemKey);
  if (at < 0) return [];
  return asked
    .slice(0, at)
    .filter((q) => q.item.responseType === "rank_group" || q.item.responseType === "multi_choice")
    .reverse()
    .map((q) => ({ itemKey: q.itemKey, item: q.item }));
}

/** A grid's source, as rowsFrom: a sorting question's first group by default. */
export function gridSourceRef(itemKey: string, item: ItemDefinition, group?: string): TimeGridSource {
  const { instrument, key } = splitItemKey(itemKey);
  const ref: TimeGridSource = { instrument, item: key, revision: item.revision };
  if (item.responseType === "rank_group") ref.group = group ?? item.groups[0]?.key ?? "";
  return ref;
}

/**
 * Point a new time grid at the nearest sorting or multiple-choice question
 * before it, so it starts out answerable; with none, it keeps pointing at
 * itself and validation asks for one.
 */
function chooseGridSource(d: StudioDraft, itemKey: string): void {
  const nearest = gridSources(d, itemKey)[0];
  if (!nearest) return;
  const q = live(d, itemKey);
  if (q.item.responseType !== "time_grid") return;
  q.item.rowsFrom = gridSourceRef(nearest.itemKey, nearest.item);
}

/** The fields a question keeps when its type changes: everything not about how it is answered. */
const KEPT_ON_TYPE_CHANGE = [
  "revision",
  "legacyVariable",
  "stem",
  "lede",
  "moreInfo",
  "media",
  "required",
  "allowDecline",
  "identifying",
  "displayIf",
  "illustration",
  "hint",
  "a11yNote",
  "researcherNote",
  "reportingCategory",
] as const;

/**
 * Change a question's type in place, keeping its ID, variable, wording,
 * condition, settings and notes, and rebuilding what is specific to the type.
 * A choice question keeps its options when it becomes another choice type,
 * except when the options are what makes the type: a question becoming Yes/No
 * gets the Yes/No list, and a Yes/No question becoming single choice or a
 * rating gets that type's starting options (with the Yes/No list it would
 * still read as Yes/No). Answer checks (`crossChecks`) are dropped: they are
 * defined for one kind of answer.
 *
 * Refused once published unless `force`: recorded answers would share a column
 * with answers of another kind. The editor offers `replaceWithNewType` instead.
 */
export function changeQuestionType(
  draft: StudioDraft,
  itemKey: string,
  typeId: QuestionTypeId,
  opts: { published?: ReadonlySet<string>; force?: boolean } = {},
): { draft: StudioDraft; itemKey: string } {
  const d = clone(draft);
  const q = live(d, itemKey);
  requireEditable(d, q.instrument, "change this question's type");
  refuseIdentity(itemKey, q.item, "change this question's type");
  if (opts.published?.has(itemKey) && !opts.force) throw publishedError(q.item, "type", "change this question's type");
  const type = questionType(typeId);
  if (!type.canCreate) throw new StudioOpError(`Questions can't be changed into “${type.label}” questions in the Studio.`, "invalid");
  const old = q.item;
  const oldScale = "scale" in old ? old.scale : null;
  if (studioTypeOf(old, oldScale ? d.scales[oldScale] : null) === typeId) return { draft: d, itemKey };

  // The options are kept only if, with them, the question reads back as the
  // type asked for. A Yes/No list is what makes a question Yes/No, so keeping
  // it for "Single choice" or "Rating scale" would leave the question a Yes/No
  // question and the change silently undone; those get the new type's options.
  const keepScale =
    oldScale !== null &&
    typeId !== "yes_no" &&
    CHOICE_TYPES.includes(typeId) &&
    studioTypeOf(templateFor(typeId, { key: old.key, variable: old.variable, text: old.stem.text, scaleKey: oldScale }).item, d.scales[oldScale]) ===
      typeId;
  const scaleKey = CHOICE_TYPES.includes(typeId) && !keepScale ? generateScaleKey(q.instrument, q.key, takenScaleKeys(d)) : undefined;
  const { item, scale } = templateFor(typeId, {
    key: old.key,
    variable: old.variable,
    text: old.stem.text,
    instrument: q.instrument,
    ...(scaleKey ? { scaleKey } : {}),
  });
  const next = item as unknown as Record<string, unknown>;
  for (const field of KEPT_ON_TYPE_CHANGE) {
    const value = (old as unknown as Record<string, unknown>)[field];
    if (value !== undefined) next[field] = value;
  }
  if (keepScale && "scale" in old) {
    next["scale"] = old.scale;
    next["scaleVersion"] = old.scaleVersion;
  } else if (scale) {
    d.scales[scale.key] = scale;
  }
  itemsOf(d.instruments[q.refKey])[q.formItemIndex] = item;
  if (item.responseType === "time_grid") chooseGridSource(d, itemKey);
  // A published list stays in the draft: its key must not be reissued to different options.
  if (oldScale && !keepScale && !opts.published?.has(itemKey)) dropOrphanScale(d, oldScale);
  return { draft: d, itemKey };
}

/**
 * What the editor offers instead of changing a published question's type: a
 * new question of the new type, with the old one's wording, straight after it,
 * and the old one archived — so its recorded answers keep their own column and
 * meaning, and the new answers start theirs.
 */
export function replaceWithNewType(
  draft: StudioDraft,
  itemKey: string,
  typeId: QuestionTypeId,
  opts: OpActor & { reserved?: ReservedIds },
): { draft: StudioDraft; itemKey: string; archivedItemKey: string } {
  const q = live(draft, itemKey);
  requireEditable(draft, q.instrument, "replace this question");
  refuseIdentity(itemKey, q.item, "replace this question with one of another type");
  const copied = duplicateQuestion(draft, itemKey, opts.reserved ? { reserved: opts.reserved } : {});
  const changed = changeQuestionType(copied.draft, copied.itemKey, typeId);
  const archived = archiveQuestion(changed.draft, itemKey, { by: opts.by, at: opts.at });
  return { draft: archived.draft, itemKey: copied.itemKey, archivedItemKey: itemKey };
}

// ---------------------------------------------------------------------------
// Moving questions
// ---------------------------------------------------------------------------

function refuseSingleMove(d: StudioDraft, q: FoundQuestion, action: string): void {
  const tier = editTier(d, q.instrument);
  if (tier === "locked") {
    throw new StudioOpError(
      `You can't ${action} on its own: it belongs to “${instrumentName(d, q.instrument)}”, a licensed, validated ` +
        `questionnaire whose questions stay together in their validated order. Move the whole block instead.`,
      "locked",
    );
  }
  if (tier === "protected") throw tierError(d, q.instrument, "protected", action);
}

/**
 * Move a question to a position among the questions of a section (`index` is
 * where it ends up, 0-based). Its ID never changes: it stays in its own
 * instrument, and only which placement shows it changes.
 *
 * Next to a question of its own instrument, it joins that placement. At a
 * boundary between blocks (or a section's start or end), it gets a placement of
 * its own there. In the middle of another instrument's block it is refused —
 * splitting someone else's block to make room would scatter it — and the
 * message says to put it before or after that block.
 *
 * A placement it leaves that showed the whole form is turned into an explicit
 * list first, and a placement left with no questions is removed.
 */
export function moveQuestion(draft: StudioDraft, itemKey: string, to: { sectionKey: string; index: number }): { draft: StudioDraft } {
  const d = clone(draft);
  const q = live(d, itemKey);
  refuseSingleMove(d, q, "move this question");
  const targetIndex = sectionIndexOf(d, to.sectionKey);
  const section = d.composition.sections[targetIndex]!;
  const from = q.placements[0];
  const source = from ? componentAt(d, from.sectionIndex, from.componentIndex) : null;

  // The target section's questions without the one moving, each with its block.
  const seq: { instrument: string; key: string; component: PlacedComponent; name: string }[] = [];
  for (const p of placements(d)) {
    if (p.sectionIndex !== targetIndex) continue;
    const component = componentAt(d, p.sectionIndex, p.componentIndex);
    for (const item of p.items) {
      if (p.instrument === q.instrument && item.key === q.key) continue;
      seq.push({ instrument: p.instrument, key: item.key, component, name: p.def?.name ?? p.instrument });
    }
  }
  checkIndex(to.index, seq.length, "in that section");
  const prev = seq[to.index - 1];
  const next = seq[to.index];

  let dest: { component: PlacedComponent; where: Where } | { after: PlacedComponent | null; before: PlacedComponent | null };
  if (prev && prev.instrument === q.instrument) dest = { component: prev.component, where: { after: prev.key } };
  else if (next && next.instrument === q.instrument) dest = { component: next.component, where: { before: next.key } };
  else if (prev && next && prev.component === next.component) {
    throw new StudioOpError(
      `${quoted(q.item)} can't go in the middle of “${prev.name}”: a question always stays with its own block. ` +
        `Put it before or after “${prev.name}” instead.`,
      "invalid",
    );
  } else dest = { after: prev?.component ?? null, before: next?.component ?? null };

  if ("component" in dest && dest.component === source) {
    // A reorder within its own placement.
    const keys = placementKeys(d, source).filter((k) => k !== q.key);
    insertAt(keys, q.key, dest.where, (k) => k);
    if (source.items) source.items = keys;
    else orderForm(d, q.refKey, keys);
    keepConsentFirst(draft, d, "move this question there");
    keepMyStoryLast(draft, d, "move this question there");
    return { draft: d };
  }

  if (source) {
    const keys = placementKeys(d, source).filter((k) => k !== q.key);
    if (keys.length > 0) source.items = keys;
    else dropComponent(d, source);
  }
  if ("component" in dest) {
    const keys = placementKeys(d, dest.component).filter((k) => k !== q.key);
    insertAt(keys, q.key, dest.where, (k) => k);
    dest.component.items = keys;
  } else {
    const component = newPlacement(d.instruments[q.refKey]!, source, [q.key]);
    const comps = section.components;
    let at = comps.length;
    if (dest.after && comps.includes(dest.after)) at = comps.indexOf(dest.after) + 1;
    else if (dest.before && comps.includes(dest.before)) at = comps.indexOf(dest.before);
    comps.splice(at, 0, component);
  }
  keepConsentFirst(draft, d, "move this question there");
  keepMyStoryLast(draft, d, "move this question there");
  return { draft: d };
}

/** Put a form's items in the order of `keys` (which lists every one of them). */
function orderForm(d: StudioDraft, refKey: string, keys: string[]): void {
  const items = itemsOf(d.instruments[refKey]);
  const byKey = new Map(items.map((i) => [i.key, i]));
  items.splice(0, items.length, ...keys.map((k) => byKey.get(k)!));
}

/** Move a question within the placement that shows it. */
export function reorderQuestion(draft: StudioDraft, itemKey: string, toIndexInPlacement: number): { draft: StudioDraft } {
  const d = clone(draft);
  const q = live(d, itemKey);
  refuseSingleMove(d, q, "reorder this question");
  const at = q.placements[0];
  if (!at) throw new StudioOpError(`${quoted(q.item)} is not placed in any section.`, "invalid");
  const component = componentAt(d, at.sectionIndex, at.componentIndex);
  const keys = placementKeys(d, component);
  checkIndex(toIndexInPlacement, keys.length - 1, "in this block");
  keys.splice(keys.indexOf(q.key), 1);
  keys.splice(toIndexInPlacement, 0, q.key);
  if (component.items) component.items = keys;
  else orderForm(d, q.refKey, keys);
  return { draft: d };
}

// ---------------------------------------------------------------------------
// Archiving, restoring and deleting
// ---------------------------------------------------------------------------

/**
 * Move a question out of its form and every placement into the archive,
 * whole, with where it was, so a restore is exact. An instrument left with no
 * questions leaves the draft with its placements, and its definition travels
 * with the record.
 */
function archiveInto(d: StudioDraft, q: FoundQuestion, actor: OpActor, block?: QuestionPlacementRef): void {
  const def = d.instruments[q.refKey]!;
  const items = itemsOf(def);
  const formIndex = items.findIndex((i) => i.key === q.key);
  const at = block ?? q.placements[0];
  let placement: ArchivedPosition["placement"] = null;
  if (at) {
    const component = componentAt(d, at.sectionIndex, at.componentIndex);
    const keys = placementKeys(d, component);
    const index = keys.indexOf(q.key);
    placement = {
      componentIndex: at.componentIndex,
      after: index > 0 ? keys.slice(0, index).reverse() : [],
      wholeForm: !component.items,
    };
  }
  const record: ArchivedQuestion = {
    itemKey: `${q.instrument}.${q.key}`,
    refKey: q.refKey,
    item: structuredClone(q.item),
    sectionKey: at ? d.composition.sections[at.sectionIndex]!.key : null,
    archivedAt: actor.at,
    archivedBy: actor.by,
    position: { formAfter: items.slice(0, formIndex).map((i) => i.key).reverse(), placement },
  };
  items.splice(formIndex, 1);
  removeFromSubsets(d, q.refKey, q.key);
  if (items.length === 0) {
    record.instrumentShell = structuredClone(def);
    removeInstrument(d, q.refKey);
  }
  d.archived.push(record);
}

/**
 * Put a value straight after the nearest of its old neighbours still present
 * (`after` is nearest first), or first if none is. Keyed by neighbour rather
 * than index, so questions restored in any order still land in their order.
 */
function insertAfterNearest<T>(list: T[], value: T, after: readonly string[], keyOf: (t: T) => string): void {
  for (const key of after) {
    const i = list.findIndex((x) => keyOf(x) === key);
    if (i >= 0) {
      list.splice(i + 1, 0, value);
      return;
    }
  }
  list.unshift(value);
}

/**
 * Stop asking a question, keeping it restorable. Its ID and variable stay
 * reserved, and data recorded under it stays readable through the versions
 * that asked it. Conditions that depend on it are left as they are, and
 * validation points them out.
 */
export function archiveQuestion(draft: StudioDraft, itemKey: string, actor: OpActor): { draft: StudioDraft } {
  const d = clone(draft);
  const q = live(d, itemKey);
  if (editTier(d, q.instrument) === "locked") {
    throw new StudioOpError(
      `You can't archive a single question of “${instrumentName(d, q.instrument)}”: it is a licensed, validated ` +
        `questionnaire, and it is only valid when asked whole. Remove the whole block instead.`,
      "locked",
    );
  }
  requireEditable(d, q.instrument, "archive this question");
  refuseIdentity(itemKey, q.item, "archive this question", ["linkage"]);
  archiveInto(d, q, actor);
  return { draft: d };
}

/**
 * Bring an archived question back into its own instrument.
 *
 * Into the section it was in (the default), it goes back exactly where it was:
 * after the same neighbours, in the same block, recreating the block where it
 * stood if it has gone. Into another section, it goes at the end of its
 * instrument's placement there, or a new placement at the end of the section.
 *
 * A licensed questionnaire only ever leaves whole (`removeBlock`), so restoring
 * any of its questions brings all of them back, as one block, in their order.
 */
export function restoreQuestion(
  draft: StudioDraft,
  itemKey: string,
  opts: { sectionKey?: string } = {},
): { draft: StudioDraft; itemKey: string; restored: string[] } {
  const d = clone(draft);
  const record = d.archived.find((a) => a.itemKey === itemKey);
  if (!record) {
    if (findQuestion(d, itemKey)) throw new StudioOpError("That question is not archived.", "invalid");
    throw new StudioOpError(`There is no archived question ${itemKey} in this survey.`, "not_found");
  }
  const sectionKey = opts.sectionKey ?? record.sectionKey;
  if (opts.sectionKey) sectionIndexOf(d, opts.sectionKey);
  if (!sectionKey || !d.composition.sections.some((s) => s.key === sectionKey)) {
    throw new StudioOpError(
      `The section ${quoted(record.item)} was in is no longer in the survey. Choose a section to restore it into.`,
      "invalid",
    );
  }
  const section = d.composition.sections[sectionIndexOf(d, sectionKey)]!;
  const clash = definedQuestions(d).find((x) => x.item.variable === record.item.variable);
  if (clash) {
    throw new StudioOpError(
      `${quoted(record.item)} can't be restored: its variable “${record.item.variable}” is now used by ${quoted(clash.item)}.`,
      "invalid",
    );
  }
  const { instrument } = splitItemKey(itemKey);
  const refKey = record.refKey;
  const comps = section.components;
  // Where it was, if it is going back to the same section.
  const was = sectionKey === record.sectionKey ? (record.position?.placement ?? null) : null;
  const insertForm = (items: ItemDefinition[], r: ArchivedQuestion) => {
    const item = structuredClone(r.item);
    if (r.position) insertAfterNearest(items, item, r.position.formAfter, (i) => i.key);
    else items.push(item);
  };
  const take = (records: ArchivedQuestion[]) => {
    d.archived = d.archived.filter((a) => !records.includes(a));
    return records.map((r) => r.itemKey);
  };

  const existing = d.instruments[refKey];
  if (!existing) {
    const shell = record.instrumentShell ?? d.archived.find((a) => a.refKey === refKey && a.instrumentShell)?.instrumentShell;
    if (!shell) {
      throw new StudioOpError(`${quoted(record.item)} can't be restored: the block it belonged to is no longer in this survey.`, "not_found");
    }
    const locked = shell.licence.modifiable !== "yes";
    if (!locked && protectedModule(instrument) && !isUnlocked(d, instrument)) {
      throw tierError(d, instrument, "protected", "restore this question");
    }
    const def = structuredClone(shell);
    const items = formOf(def)!.items as ItemDefinition[];
    items.length = 0;
    const records = locked ? d.archived.filter((a) => a.refKey === refKey) : [record];
    for (const r of records) insertForm(items, r);
    d.instruments[refKey] = def;
    // The form holds only what is restored, so a whole-form placement shows
    // exactly that — and needs no subset, unless it had one before.
    const keys = !locked && was && !was.wholeForm ? [record.item.key] : null;
    comps.splice(was ? Math.min(was.componentIndex, comps.length) : comps.length, 0, newPlacement(def, null, keys));
    keepConsentFirst(draft, d, "restore this question there");
    keepMyStoryLast(draft, d, "restore this question there");
    return { draft: d, itemKey, restored: take(records) };
  }

  if (editTier(d, instrument) === "protected") throw tierError(d, instrument, "protected", "restore this question");
  const mine = (c: Component | undefined): c is PlacedComponent => !!c && isPlaced(c) && componentRefKey(c) === refKey;
  const atWas = was ? comps[was.componentIndex] : undefined;
  const component = mine(atWas) ? atWas : ([...comps].reverse().find(mine) ?? null);
  pinWholeFormPlacements(d, refKey, component);
  insertForm(itemsOf(existing), record);
  if (component?.items) {
    if (was) insertAfterNearest(component.items, record.item.key, was.after, (k) => k);
    else component.items.push(record.item.key);
  } else if (!component) {
    comps.splice(was ? Math.min(was.componentIndex, comps.length) : comps.length, 0, newPlacement(existing, null, [record.item.key]));
  }
  // A whole-form placement shows the form in order, so the form position is its position.
  keepConsentFirst(draft, d, "restore this question there");
  keepMyStoryLast(draft, d, "restore this question there");
  return { draft: d, itemKey, restored: take([record]) };
}

/**
 * Delete a question for good. Only for one never published: a published
 * question is archived instead, so its ID stays reserved and its data readable.
 * Also deletes an archived, never-published question from the archive.
 */
export function deleteQuestion(draft: StudioDraft, itemKey: string, opts: { published: ReadonlySet<string> }): { draft: StudioDraft } {
  const d = clone(draft);
  const q = findQuestion(d, itemKey);
  const archivedIndex = d.archived.findIndex((a) => a.itemKey === itemKey);
  const item = q?.item ?? d.archived[archivedIndex]?.item;
  if (!item) throw new StudioOpError(`There is no question ${itemKey} in this survey.`, "not_found");
  if (opts.published.has(itemKey)) throw publishedError(item, "ID", "delete this question");
  if (q) {
    requireEditable(d, q.instrument, "delete this question");
    refuseIdentity(itemKey, q.item, "delete this question", ["linkage"]);
    const def = d.instruments[q.refKey]!;
    const items = itemsOf(def);
    items.splice(q.formItemIndex, 1);
    removeFromSubsets(d, q.refKey, q.key);
    if (items.length === 0) {
      // Archived questions of this instrument still need something to be restored into.
      const siblings = d.archived.filter((a) => a.refKey === q.refKey);
      if (siblings[0] && !siblings.some((a) => a.instrumentShell)) siblings[0].instrumentShell = structuredClone(def);
      removeInstrument(d, q.refKey);
    }
  } else {
    // The archive is not a way round the tiers. A licensed questionnaire leaves
    // whole and must come back whole, so deleting one of its archived questions
    // would let it be restored with a question missing; a protected module's
    // archived question is as protected as a live one.
    const tier = archivedTier(d, d.archived[archivedIndex]!);
    if (tier === "locked") {
      throw new StudioOpError(
        `You can't delete a single question of “${archivedName(d, d.archived[archivedIndex]!)}”: it is a licensed, ` +
          `validated questionnaire, which is only valid when asked whole. It stays archived, and restoring it brings back the whole questionnaire.`,
        "locked",
      );
    }
    if (tier === "protected") throw tierError(d, splitItemKey(itemKey).instrument, "protected", "delete this question");
    const [record] = d.archived.splice(archivedIndex, 1);
    // Another archived question of the same instrument may need the shell to be restored.
    const heir = d.archived.find((a) => a.refKey === record!.refKey);
    if (record!.instrumentShell && heir && !heir.instrumentShell) heir.instrumentShell = record!.instrumentShell;
  }
  delete d.notes[itemKey];
  if ("scale" in item) dropOrphanScale(d, item.scale);
  return { draft: d };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The option list a question's option edit applies to, after checking the edit
 * is allowed for every question sharing the list — a shared list is one list,
 * so editing it through an editable question would otherwise reword a licensed
 * questionnaire's options too.
 */
function optionTarget(d: StudioDraft, itemKey: string, action: string): { q: FoundQuestion; scaleKey: string; scale: ScaleInput } {
  const q = live(d, itemKey);
  if (!("scale" in q.item)) throw new StudioOpError(`${quoted(q.item)} has no options.`, "invalid");
  requireEditable(d, q.instrument, action);
  refuseIdentity(itemKey, q.item, action, ["linkage"]);
  const scaleKey = q.item.scale;
  const scale = d.scales[scaleKey];
  if (!scale) throw new StudioOpError(`The option list “${scaleKey}” is missing from this survey.`, "not_found");
  for (const user of scaleUsage(d, scaleKey)) {
    if (user === itemKey) continue;
    const other = findQuestion(d, user);
    if (!other) continue;
    const tier = editTier(d, other.instrument);
    const linkage = identityRoleOf(user, other.item) === "linkage";
    if (tier !== "editable" || linkage) {
      throw new StudioOpError(
        `You can't ${action}: these options are shared with ${quoted(other.item)} in “${instrumentName(d, other.instrument)}”, ` +
          `whose options can't change${tier === "protected" ? " while it is protected" : ""}. Give this question its own copy of the options first.`,
        tier === "editable" ? "linkage" : tier,
      );
    }
  }
  // Archived questions share the list too, and come back with whatever it then
  // says: with a licensed questionnaire's block removed, editing the list
  // through a question that shares it would otherwise restore that
  // questionnaire with changed options.
  for (const record of archivedUsers(d, scaleKey)) {
    const tier = archivedTier(d, record);
    const linkage = identityRoleOf(record.itemKey, record.item) === "linkage";
    if (tier !== "editable" || linkage) {
      throw new StudioOpError(
        `You can't ${action}: these options are shared with ${quoted(record.item)} (archived) in ` +
          `“${archivedName(d, record)}”, whose options can't change` +
          `${tier === "protected" ? " while it is protected" : ""}. Give this question its own copy of the options first.`,
        tier === "editable" ? "linkage" : tier,
      );
    }
  }
  return { q, scaleKey, scale };
}

function findOption(scale: ScaleInput, code: number): ScaleOption {
  const option = scale.options.find((o) => o.code === code);
  if (!option) throw new StudioOpError(`There is no option with value ${code} in this list.`, "not_found");
  return option;
}

/**
 * The value a new option gets: one more than any value the list has, has
 * retired, or has ever published. A value is never reused, because answers
 * recorded under it would then mean two things.
 */
function nextCode(d: StudioDraft, scaleKey: string, scale: ScaleInput, publishedCodes?: ReadonlySet<number>): number {
  const codes = [
    ...scale.options.map((o) => o.code),
    ...(d.retiredCodes[scaleKey] ?? []).map((r) => r.code),
    ...(publishedCodes ?? []),
  ];
  return codes.length > 0 ? Math.max(...codes) + 1 : 1;
}

export interface OptionInput {
  label: string;
  description?: string;
  kind?: ScaleOption["kind"];
}

export function addOption(
  draft: StudioDraft,
  itemKey: string,
  input: OptionInput,
  opts: { publishedCodes?: ReadonlySet<number> } = {},
): { draft: StudioDraft; code: number } {
  const d = clone(draft);
  const { scaleKey, scale } = optionTarget(d, itemKey, "add an option");
  const label = input.label.trim();
  if (!label) throw new StudioOpError("An option needs a label.", "invalid");
  const code = nextCode(d, scaleKey, scale, opts.publishedCodes);
  const option: ScaleOption = { code, label, kind: input.kind ?? "substantive", textEntry: false };
  if (input.description?.trim()) option.description = input.description.trim();
  if (scale.options.some((o) => o.position !== undefined)) option.position = scale.options.length + 1;
  scale.options.push(option);
  return { draft: d, code };
}

/** Change an option's label, description or kind. Its value never changes. */
export function updateOption(
  draft: StudioDraft,
  itemKey: string,
  code: number,
  patch: { label?: string; description?: string | null; kind?: ScaleOption["kind"] },
): { draft: StudioDraft } {
  const d = clone(draft);
  const { scale } = optionTarget(d, itemKey, "change an option");
  const option = findOption(scale, code);
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new StudioOpError("An option needs a label.", "invalid");
    option.label = label;
  }
  if (patch.description !== undefined) {
    if (patch.description === null || !patch.description.trim()) delete option.description;
    else option.description = patch.description.trim();
  }
  if (patch.kind !== undefined) option.kind = patch.kind;
  return { draft: d };
}

/**
 * Remove an option. If the list has been published, its value is retired: kept
 * in the draft so no later option can take it.
 *
 * `published` is either whether the list has been published, or — safer — the
 * set of question IDs any version has published: the value is then retired if
 * any question using the list, live or archived, was published. That matters
 * after `forkScale`: a question's own copy has a new key no version has
 * published, yet the question's recorded answers are coded against its values,
 * so "has this list's key been published?" would wrongly answer no.
 */
export function removeOption(
  draft: StudioDraft,
  itemKey: string,
  code: number,
  opts: { published: boolean | ReadonlySet<string>; at: string },
): { draft: StudioDraft } {
  const d = clone(draft);
  const { scaleKey, scale } = optionTarget(d, itemKey, "remove an option");
  const option = findOption(scale, code);
  if (scale.options.length <= 2) {
    throw new StudioOpError("A choice question needs at least two options. Add another before removing this one.", "invalid");
  }
  const published =
    typeof opts.published === "boolean"
      ? opts.published
      : [...scaleUsage(d, scaleKey), ...archivedUsers(d, scaleKey).map((a) => a.itemKey)].some((k) =>
          (opts.published as ReadonlySet<string>).has(k),
        );
  scale.options = scale.options.filter((o) => o !== option);
  if (scale.options.some((o) => o.position !== undefined)) scale.options.forEach((o, i) => (o.position = i + 1));
  if (published) {
    const retired = (d.retiredCodes[scaleKey] ??= []);
    if (!retired.some((r) => r.code === code)) retired.push({ code, label: option.label, retiredAt: opts.at });
  }
  return { draft: d };
}

/** Move an option in the list. Only the order participants see changes; values stay as they are. */
export function moveOption(draft: StudioDraft, itemKey: string, code: number, toIndex: number): { draft: StudioDraft } {
  const d = clone(draft);
  const { scale } = optionTarget(d, itemKey, "reorder the options");
  const option = findOption(scale, code);
  checkIndex(toIndex, scale.options.length - 1, "in the list");
  const options = scale.options.filter((o) => o !== option);
  options.splice(toIndex, 0, option);
  // An explicit display position would otherwise override the new order.
  if (options.some((o) => o.position !== undefined)) options.forEach((o, i) => (o.position = i + 1));
  scale.options = options;
  return { draft: d };
}

/**
 * Give a question its own copy of an option list it shares, so its options can
 * change without changing the others'. The copy keeps the list's retired values,
 * which were retired for this question's data too. A list only this question
 * uses — counting archived questions, which come back with the list as it then
 * is — is left as it is.
 *
 * The copy's key is new, so no version has published it; the values in it may
 * still have been answered (see `removeOption`'s `published`).
 */
export function forkScale(draft: StudioDraft, itemKey: string): { draft: StudioDraft; scaleKey: string } {
  const d = clone(draft);
  const q = live(d, itemKey);
  if (!("scale" in q.item)) throw new StudioOpError(`${quoted(q.item)} has no options.`, "invalid");
  requireEditable(d, q.instrument, "give this question its own options");
  refuseIdentity(itemKey, q.item, "give this question its own options", ["linkage"]);
  const from = q.item.scale;
  const scale = d.scales[from];
  if (!scale) throw new StudioOpError(`The option list “${from}” is missing from this survey.`, "not_found");
  // Archived users count: otherwise a list shared only with an archived
  // licensed questionnaire could neither be edited (optionTarget refuses) nor forked.
  if (scaleUsage(d, from).length + archivedUsers(d, from).length <= 1) return { draft: d, scaleKey: from };
  const scaleKey = generateScaleKey(q.instrument, q.key, takenScaleKeys(d));
  d.scales[scaleKey] = { ...structuredClone(scale), key: scaleKey };
  const retired = d.retiredCodes[from];
  if (retired && retired.length > 0) d.retiredCodes[scaleKey] = structuredClone(retired);
  q.item.scale = scaleKey;
  q.item.scaleVersion = scale.version;
  return { draft: d, scaleKey };
}

/**
 * "Other (please specify)", built from what the whole pipeline already
 * handles: an "Other" option, and a short-text follow-up straight after the
 * question, shown only when "Other" is chosen. The option's own `textEntry`
 * stays off because the participant app does not render it; the follow-up
 * question is what collects the text, with its own column.
 *
 * "Other" belongs to one question. If its option list is shared (a Likert set,
 * or the survey-wide Yes/No list), the question is given its own copy first
 * (`forkScale`, whose key is returned as `scaleKey`): adding "Other" to the
 * shared list would give every question using it an "Other" option with no
 * follow-up to say what.
 */
export function addOtherOption(
  draft: StudioDraft,
  itemKey: string,
  opts: { reserved?: ReservedIds; publishedCodes?: ReadonlySet<number> } = {},
): { draft: StudioDraft; code: number; followUpItemKey: string; scaleKey: string } {
  const q = live(draft, itemKey);
  if (q.item.responseType !== "single_choice" && q.item.responseType !== "multi_choice") {
    throw new StudioOpError(`Only a single- or multiple-choice question can have an “Other” option.`, "invalid");
  }
  if (draft.scales[q.item.scale]?.options.some((o) => o.kind === "other_specify")) {
    throw new StudioOpError(`${quoted(q.item)} already has an “Other” option.`, "invalid");
  }
  requireEditable(draft, q.instrument, "add an “Other” option");
  refuseIdentity(itemKey, q.item, "add an “Other” option", ["linkage"]);
  const own = forkScale(draft, itemKey);
  const added = addOption(own.draft, itemKey, { label: "Other", kind: "other_specify" }, opts.publishedCodes ? { publishedCodes: opts.publishedCodes } : {});
  const d = added.draft;
  const key = uniqueSlug(`${q.key.slice(0, 58).replace(/_+$/, "")}_other`, takenKeys(d, q.instrument, opts.reserved), 64);
  const variable = generateVariable(`${q.item.variable.slice(0, MAX_VARIABLE_LENGTH - 6).replace(/_+$/, "")}_other`, takenVariables(d, opts.reserved));
  const { item } = templateFor("short_text", { key, variable, text: "Please tell us what", instrument: q.instrument });
  item.displayIf = toLogic([{ itemKey, test: "selected", code: added.code }], "all");
  const at = findQuestion(d, itemKey)!.placements[0];
  placeNewItem(d, q.refKey, item, at ? componentAt(d, at.sectionIndex, at.componentIndex) : null, { after: q.key });
  return { draft: d, code: added.code, followUpItemKey: `${q.instrument}.${key}`, scaleKey: own.scaleKey };
}

// ---------------------------------------------------------------------------
// Welcome, completion and settings
// ---------------------------------------------------------------------------

export interface WelcomePatch {
  participantCode?: {
    pattern?: string;
    hint?: string;
    label?: string | null;
    instructions?: string | null;
    placeholder?: string | null;
    variable?: string | null;
  };
  studyLabel?: string | null;
  contact?: { email?: string; ethicsReference?: string | null; note?: string | null } | null;
}

/** Merge a patch into an object: undefined leaves a field, null removes it. */
function merge(current: object | undefined, patch: object): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

/** The opening screen: the code a participant starts with, the label they see, and who to contact. */
export function updateWelcome(draft: StudioDraft, patch: WelcomePatch): { draft: StudioDraft } {
  const d = clone(draft);
  const c = d.composition;
  if (patch.participantCode) {
    const next = merge(c.participantCode, patch.participantCode);
    if (typeof next["pattern"] !== "string" || !next["pattern"] || typeof next["hint"] !== "string") {
      throw new StudioOpError("The participant code needs a format and a hint describing it.", "invalid");
    }
    checkPattern(next["pattern"], "participant code");
    if (patch.participantCode.variable) checkNewVariable(d, c.participantCode?.variable ?? "", patch.participantCode.variable);
    c.participantCode = next as ParticipantCode;
  }
  if (patch.studyLabel !== undefined) {
    if (patch.studyLabel === null || !patch.studyLabel.trim()) delete c.studyLabel;
    else c.studyLabel = patch.studyLabel.trim();
  }
  if (patch.contact !== undefined) {
    if (patch.contact === null) delete c.contact;
    else {
      const next = merge(c.contact, patch.contact);
      if (typeof next["email"] !== "string" || !next["email"].trim()) {
        throw new StudioOpError("A contact needs an email address.", "invalid");
      }
      c.contact = next as Contact;
    }
  }
  return { draft: d };
}

/**
 * The finish screen, or the review screen shown before it. Pipes in the text
 * (e.g. `{first_name}`) are kept as they are; one whose placeholder has gone is
 * reported by validation rather than removed here.
 */
export function updateScreen(
  draft: StudioDraft,
  which: "finish" | "review",
  patch: { title?: string | null; body?: string },
): { draft: StudioDraft } {
  const d = clone(draft);
  const screens = d.composition.screens;
  let screen: Screen | undefined = screens[which];
  if (!screen) {
    if (patch.body === undefined) throw new StudioOpError("A new screen needs some text.", "invalid");
    screen = { kind: which === "finish" ? "finish" : "information", body: { text: patch.body } };
    screens[which] = screen;
  }
  if (patch.title !== undefined) {
    if (patch.title === null || !patch.title.trim()) delete screen.title;
    else screen.title = { ...(screen.title ?? {}), text: patch.title };
  }
  if (patch.body !== undefined) screen.body = { ...screen.body, text: patch.body };
  return { draft: d };
}

export interface SettingsPatch {
  title?: string;
  allowBackNavigation?: boolean;
  resumption?: NonNullable<CompositionInput["resumption"]>;
  progressIndicator?: NonNullable<CompositionInput["progressIndicator"]>;
  readingLevel?: CompositionInput["readingLevel"];
  ageBand?: CompositionInput["ageBand"];
  effort?: Partial<Effort>;
  notes?: string | null;
}

/**
 * Survey-wide settings. The language is not among them: every placement's
 * reference names its form's language, so changing it is a different survey.
 */
export function updateSettings(draft: StudioDraft, patch: SettingsPatch): { draft: StudioDraft } {
  const d = clone(draft);
  const c = d.composition;
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new StudioOpError("The survey needs a title.", "invalid");
    c.title = title;
  }
  if (patch.allowBackNavigation !== undefined) c.allowBackNavigation = patch.allowBackNavigation;
  if (patch.resumption !== undefined) c.resumption = patch.resumption;
  if (patch.progressIndicator !== undefined) c.progressIndicator = patch.progressIndicator;
  if (patch.readingLevel !== undefined) c.readingLevel = patch.readingLevel;
  if (patch.ageBand !== undefined) c.ageBand = patch.ageBand;
  if (patch.effort !== undefined) c.effort = merge(c.effort, patch.effort) as Effort;
  if (patch.notes !== undefined) {
    if (patch.notes === null || !patch.notes.trim()) delete c.notes;
    else c.notes = patch.notes;
  }
  return { draft: d };
}

// ---------------------------------------------------------------------------
// MyStory
// ---------------------------------------------------------------------------

/**
 * Switch MyStory on with a protocol, or (null) off (docs/16 §10.1).
 *
 * On, MyStory is the survey's last section, holding only the conversation, and
 * the protocol's whole definition is frozen into the draft by `key@version` —
 * the definition the release will freeze and the survey will send the module.
 * Choosing another protocol replaces it; the section keeps its title and stays
 * last. On also says the conversation needs the network, when nothing says
 * otherwise yet: its model stages do.
 *
 * Off removes MyStory's section, its protocol and that connectivity setting,
 * which mean nothing without it. Nothing else in the survey moves.
 *
 * The protocol must read as one by the schema the module reads it with, and
 * pass its own checks: one that could not run is never worth putting in a
 * survey, and refusing it here says why at once. Whether it is approved, and
 * whether its key and version already name different content, are left to
 * validation, which knows what has been published: a draft may carry a
 * protocol still being approved, and the preview shows where it would run.
 */
export function setMyStory(draft: StudioDraft, protocol: NarrativeProtocol | null): { draft: StudioDraft } {
  const d = clone(draft);
  const c = d.composition;
  const was = myStoryOf(d);
  const old = was && isMyStorySection(c.sections[was.sectionIndex]) ? c.sections[was.sectionIndex]! : null;

  // Every conversation comes out, wherever it was; MyStory's own section with it.
  c.sections = c.sections
    .filter((s) => !isMyStorySection(s))
    .map((s) => (s.components.some((x) => x.kind === "narrative") ? { ...s, components: s.components.filter((x) => x.kind !== "narrative") } : s));
  delete d.narrativeProtocols;

  if (!protocol) {
    if (c.offline) delete c.offline.narrativeConnectivity;
    return { draft: d };
  }

  const parsed = narrativeProtocol.safeParse(protocol);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StudioOpError(
      `That protocol can't be used: it isn't in the protocol format (${issue?.path.join(".") || "protocol"}: ${issue?.message ?? "invalid"}).`,
      "invalid",
    );
  }
  const p = parsed.data;
  const problems = protocolProblems(p);
  if (problems.length > 0) {
    const more = problems.length > 1 ? ` There ${problems.length === 2 ? "is 1 more problem" : `are ${problems.length - 1} more problems`} to fix.` : "";
    throw new StudioOpError(`That protocol can't be used: ${problems[0]}.${more}`, "invalid");
  }

  const taken = new Set(c.sections.map((s) => s.key));
  const section: CompositionInput["sections"][number] = {
    ...(old ? structuredClone(old) : { title: MYSTORY_TITLE }),
    key: old && !taken.has(old.key) ? old.key : generateSectionKey(MYSTORY_SECTION_KEY, taken),
    components: [{ kind: "narrative", protocol: p.key, protocolVersion: p.version }],
  };
  c.sections.push(section);
  d.narrativeProtocols = { [protocolId(p)]: p };
  c.offline = { ...c.offline, surveyOfflineCapable: true, narrativeConnectivity: c.offline?.narrativeConnectivity ?? "online_required" };
  return { draft: d };
}

// ---------------------------------------------------------------------------
// Unlocking, and notes
// ---------------------------------------------------------------------------

/** The shortest acknowledgement accepted: long enough that it has to say something. */
export const MIN_UNLOCK_REASON = 20;

/**
 * Open a protected module, or a licensed questionnaire, for editing, recording
 * who, when and why. The reason is kept verbatim and goes into the audit log
 * with the draft.
 */
export function unlockModule(draft: StudioDraft, instrumentKey: string, req: OpActor & { reason: string }): { draft: StudioDraft } {
  const protection = protectedModule(instrumentKey);
  const licensed = instrumentDef(draft, instrumentKey)?.def.licence.modifiable !== undefined && instrumentDef(draft, instrumentKey)?.def.licence.modifiable !== "yes";
  if (!protection && !licensed) throw new StudioOpError(`“${instrumentKey}” is not locked, so it does not need unlocking.`, "invalid");
  if (req.reason.trim().length < MIN_UNLOCK_REASON) {
    throw new StudioOpError(
      `Say in a sentence why ${!protection ? "its wording needs to change" : `this change is ${protection.reason === "ethics" ? "covered by the ethics approval" : "safe for participant linkage"}`} ` +
        `(at least ${MIN_UNLOCK_REASON} characters). It is kept with the survey's history.`,
      "invalid",
    );
  }
  const d = clone(draft);
  d.unlocked[instrumentKey] = { instrument: instrumentKey, by: req.by, at: req.at, reason: req.reason };
  return { draft: d };
}

/** Protect a module again. Changes made while it was unlocked stay. */
export function relockModule(draft: StudioDraft, instrumentKey: string): { draft: StudioDraft } {
  const d = clone(draft);
  delete d.unlocked[instrumentKey];
  return { draft: d };
}

/** Coding notes for analysts. Studio-only: never part of a release, so allowed on any question. */
export function setQuestionNotes(draft: StudioDraft, itemKey: string, notes: { codingNotes: string | null }): { draft: StudioDraft } {
  const d = clone(draft);
  if (!findQuestion(d, itemKey) && !d.archived.some((a) => a.itemKey === itemKey)) {
    throw new StudioOpError(`There is no question ${itemKey} in this survey.`, "not_found");
  }
  const text = notes.codingNotes?.trim();
  if (!text) delete d.notes[itemKey];
  else d.notes[itemKey] = { ...(d.notes[itemKey] ?? {}), codingNotes: text };
  return { draft: d };
}
