import { refKeyOf } from "@myself/release/gate";
import type { ItemDefinition } from "@myself/schema";
import type { CompositionInput, InstrumentOrModule, StudioDraft } from "./contract.js";
import type { ReservedIds } from "./history.js";
import {
  allItemKeys,
  allVariables,
  CONSENT_MODULES,
  findQuestion,
  instrumentName,
  itemsOf,
  shortText,
  StudioOpError,
  type FoundQuestion,
} from "./model.js";
import { myStoryMisplaced, type MyStoryMisplacement } from "./mystory.js";
import { formOf, liveQuestions, normaliseRef, splitItemKey } from "./walk.js";

/**
 * The machinery the editing operations share: finding blocks, choosing keys
 * that are free, placing a question in a block, and the two ordering rules
 * every edit keeps (consent first, MyStory last).
 *
 * Internal to the package. ops.ts and library.ts both build on it, so adding a
 * question by hand and adding one copied from the library place it, and refuse
 * it, by exactly the same rules. Not exported from the package's index.
 */

export type Section = CompositionInput["sections"][number];
export type Component = Section["components"][number];
export type PlacedComponent = Extract<Component, { kind: "instrument" | "module" }>;

export function clone(draft: StudioDraft): StudioDraft {
  return structuredClone(draft);
}

export function quoted(item: { stem: { text: string } }): string {
  return `“${shortText(item.stem.text)}”`;
}

export function isPlaced(c: Component): c is PlacedComponent {
  return c.kind === "instrument" || c.kind === "module";
}

export function componentRefKey(c: PlacedComponent): string {
  return refKeyOf(normaliseRef(c.ref));
}

export function sectionIndexOf(d: StudioDraft, sectionKey: string): number {
  const i = d.composition.sections.findIndex((s) => s.key === sectionKey);
  if (i < 0) throw new StudioOpError(`There is no section “${sectionKey}” in this survey.`, "not_found");
  return i;
}

export function componentAt(d: StudioDraft, sectionIndex: number, componentIndex: number): PlacedComponent {
  const c = d.composition.sections[sectionIndex]?.components[componentIndex];
  if (!c || !isPlaced(c)) throw new StudioOpError("That block is not in this section any more.", "not_found");
  return c;
}

/** A live question, or a refusal that says whether it is archived or simply absent. */
export function live(d: StudioDraft, itemKey: string): FoundQuestion {
  const found = findQuestion(d, itemKey);
  if (found) return found;
  const archived = d.archived.find((a) => a.itemKey === itemKey);
  if (archived) {
    throw new StudioOpError(`${quoted(archived.item)} is archived. Restore it before changing it.`, "not_found");
  }
  throw new StudioOpError(`There is no question ${itemKey} in this survey.`, "not_found");
}

/** Keys already used in an instrument, including archived and published ones. */
export function takenKeys(d: StudioDraft, instrument: string, reserved?: ReservedIds): Set<string> {
  const out = new Set<string>();
  for (const itemKey of [...allItemKeys(d), ...(reserved?.itemKeys ?? [])]) {
    const { instrument: i, key } = splitItemKey(itemKey);
    if (i === instrument) out.add(key);
  }
  return out;
}

export function takenVariables(d: StudioDraft, reserved?: ReservedIds): Set<string> {
  return new Set([...allVariables(d), ...(reserved?.variables ?? [])]);
}

/**
 * Scale keys that may not be given to a new option list: every list in the
 * draft, every list an archived question uses, and every list with retired
 * codes — whose retired values would otherwise be inherited by a stranger.
 */
export function takenScaleKeys(d: StudioDraft): Set<string> {
  const out = new Set([...Object.keys(d.scales), ...Object.keys(d.retiredCodes)]);
  for (const a of d.archived) if ("scale" in a.item) out.add(a.item.scale);
  return out;
}

/** The reference a new placement of an instrument uses, built from its one form. */
export function refFromDef(def: InstrumentOrModule): PlacedComponent["ref"] {
  const form = formOf(def);
  if (!form) throw new StudioOpError(`“${def.name}” has no form to place.`, "invalid");
  return {
    instrument: def.instrument,
    version: def.version,
    ...(form.variant ? { variant: form.variant } : {}),
    language: form.language,
    informant: form.informant ?? "self",
    readingLevel: form.readingLevel ?? "standard",
  };
}

export function newPlacement(def: InstrumentOrModule, template: PlacedComponent | null, keys: string[] | null): PlacedComponent {
  const kind = template?.kind ?? ((def as { kind?: string }).kind === "module" ? "module" : "instrument");
  const ref = template ? structuredClone(template.ref) : refFromDef(def);
  return keys ? { kind, ref, items: keys } : { kind, ref };
}

/** The keys a placement shows, in order: its subset, or its whole form. */
export function placementKeys(d: StudioDraft, c: PlacedComponent): string[] {
  return c.items ? [...c.items] : itemsOf(d.instruments[componentRefKey(c)]).map((i) => i.key);
}

export function dropComponent(d: StudioDraft, c: Component): void {
  for (const s of d.composition.sections) {
    const i = s.components.indexOf(c);
    if (i >= 0) {
      s.components.splice(i, 1);
      return;
    }
  }
}

/** Every placement component of an instrument, wherever it is. */
export function componentsOf(d: StudioDraft, refKey: string): PlacedComponent[] {
  const out: PlacedComponent[] = [];
  for (const s of d.composition.sections) for (const c of s.components) if (isPlaced(c) && componentRefKey(c) === refKey) out.push(c);
  return out;
}

/**
 * Give every whole-form placement of an instrument (other than `except`) an
 * explicit list of what it shows now. Done before a question joins the form for
 * a placement elsewhere: a whole-form placement would otherwise start showing
 * it too, and the question would be asked twice.
 */
export function pinWholeFormPlacements(d: StudioDraft, refKey: string, except: PlacedComponent | null): void {
  const keys = itemsOf(d.instruments[refKey]).map((i) => i.key);
  for (const c of componentsOf(d, refKey)) {
    if (c !== except && !c.items && keys.length > 0) c.items = [...keys];
  }
}

export type Where = { after: string } | { before: string } | "start" | "end";

export function insertAt<T>(list: T[], value: T, where: Where, keyOf: (t: T) => string): void {
  let index = list.length;
  if (where === "start") index = 0;
  else if (where !== "end") {
    const anchor = "after" in where ? where.after : where.before;
    const i = list.findIndex((x) => keyOf(x) === anchor);
    if (i >= 0) index = "after" in where ? i + 1 : i;
  }
  list.splice(index, 0, value);
}

/**
 * Add a new question to an instrument's form and, when given, to one of its
 * placements at a position. A whole-form placement shows the form in order, so
 * there the form itself is ordered; a subset placement lists the key, and the
 * form keeps the question beside its anchor so the codebook reads sensibly.
 */
export function placeNewItem(d: StudioDraft, refKey: string, item: ItemDefinition, c: PlacedComponent | null, where: Where): void {
  const items = itemsOf(d.instruments[refKey]);
  pinWholeFormPlacements(d, refKey, c);
  if (c && !c.items) {
    insertAt(items, item, where, (i) => i.key);
    return;
  }
  insertAt(items, item, typeof where === "string" ? "end" : where, (i) => i.key);
  if (c) {
    const keys = c.items ?? [];
    insertAt(keys, item.key, where, (k) => k);
    c.items = keys;
  }
}

/**
 * The consent module that some other question is now asked before, or in the
 * middle of; null if there is none.
 */
export function askedBeforeConsent(d: StudioDraft): string | null {
  const order = liveQuestions(d);
  for (const key of CONSENT_MODULES) {
    let last = -1;
    order.forEach((q, i) => {
      if (q.instrument === key) last = i;
    });
    if (last >= 0 && order.slice(0, last).some((q) => q.instrument !== key)) return key;
  }
  return null;
}

/**
 * Refuse an edit that would ask anything before the consent module.
 *
 * Refusing to move the consent block itself is not enough on its own: moving
 * another section or block in front of it, adding a section before it, or
 * moving a question into its section ahead of it would all have participants
 * answer questions before they have read the introduction and given consent
 * (docs/16 R4). Only a change that newly does so is refused, so a draft
 * already in that state can still be edited back out of it.
 */
export function keepConsentFirst(before: StudioDraft, after: StudioDraft, action: string): void {
  const key = askedBeforeConsent(after);
  if (!key || askedBeforeConsent(before) === key) return;
  throw new StudioOpError(
    `You can't ${action}: it would be asked before “${instrumentName(after, key)}”. Participants read the ` +
      `introduction and give their consent before they are asked anything else, so nothing may come before it. ` +
      `Put it after the consent instead.`,
    "protected",
  );
}

export const MISPLACED: Record<MyStoryMisplacement, string> = {
  not_last: "MyStory is the last part of the survey, so nothing can come after it. Put it before MyStory instead.",
  not_alone: "MyStory's section holds only the MyStory conversation. Put it in another section instead.",
  more_than_one: "A survey has one MyStory, at the end.",
};

/**
 * Refuse an edit that would put anything after MyStory, or in its section.
 *
 * MyStory always comes last: the survey, then MyStory, then the finish screen,
 * and only then is the device handed back to the researcher (docs/16 §10.1).
 * Adding a section at the end, dragging one below MyStory, or moving a question
 * or block into its section would each break that. As with the consent, only a
 * change that newly does so is refused, so a draft already in that state can
 * still be edited back out of it.
 */
export function keepMyStoryLast(before: StudioDraft, after: StudioDraft, action: string): void {
  const problem = myStoryMisplaced(after);
  if (!problem || myStoryMisplaced(before) === problem) return;
  throw new StudioOpError(`You can't ${action}: ${MISPLACED[problem]}`, "invalid");
}
