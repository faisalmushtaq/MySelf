import { administeredItems, formFor, refKeyOf } from "@myself/release/gate";
import type { InstrumentForm, InstrumentRef, ItemDefinition } from "@myself/schema";
import type { InstrumentOrModule, StudioDraft } from "./contract.js";

/**
 * Walking a draft in the order a participant meets it.
 *
 * Shared by the editor's outline, validation, the diff and the operations, so
 * that "where is this question" and "what comes before it" have one answer.
 * Tolerant of a draft that is half-edited: a placement whose instrument or
 * form is missing is reported with `form: null` rather than thrown over, since
 * that is exactly the state validation exists to describe.
 */

/** Normalise a component's reference, applying the schema's defaults. */
export function normaliseRef(ref: {
  instrument: string;
  version: string;
  variant?: string | undefined;
  language: string;
  informant?: InstrumentRef["informant"] | undefined;
  readingLevel?: InstrumentRef["readingLevel"] | undefined;
}): InstrumentRef {
  return {
    instrument: ref.instrument,
    version: ref.version,
    ...(ref.variant ? { variant: ref.variant } : {}),
    language: ref.language,
    informant: ref.informant ?? "self",
    readingLevel: ref.readingLevel ?? "standard",
  };
}

/** The one form a draft instrument carries (a frozen instrument has exactly one). */
export function formOf(def: InstrumentOrModule | undefined, ref?: InstrumentRef): InstrumentForm | null {
  if (!def) return null;
  const forms = def.forms as InstrumentForm[];
  if (ref) return formFor({ forms }, ref) ?? forms[0] ?? null;
  return forms[0] ?? null;
}

export interface Placement {
  sectionIndex: number;
  sectionKey: string;
  componentIndex: number;
  kind: "instrument" | "module";
  refKey: string;
  instrument: string;
  def: InstrumentOrModule | null;
  form: InstrumentForm | null;
  /** Explicit subset, or null for "the whole form". */
  subset: string[] | null;
  /** The questions shown, in order. Empty when the form is missing. */
  items: ItemDefinition[];
  /** Subset keys the form does not have. */
  missing: string[];
}

/** Every instrument/module placement, in administered order. */
export function placements(draft: StudioDraft): Placement[] {
  const out: Placement[] = [];
  draft.composition.sections.forEach((section, sectionIndex) => {
    section.components.forEach((component, componentIndex) => {
      if (component.kind !== "instrument" && component.kind !== "module") return;
      const ref = normaliseRef(component.ref);
      const refKey = refKeyOf(ref);
      const def = draft.instruments[refKey] ?? null;
      const form = formOf(def ?? undefined, ref);
      const subset = component.items ? [...component.items] : null;
      const placed = form ? administeredItems(form, subset ?? undefined) : { items: [], missing: subset ?? [] };
      out.push({
        sectionIndex,
        sectionKey: section.key,
        componentIndex,
        kind: component.kind,
        refKey,
        instrument: ref.instrument,
        def,
        form,
        subset,
        items: placed.items,
        missing: placed.missing,
      });
    });
  });
  return out;
}

export interface LiveQuestion {
  /** `<instrument>.<key>` — the stable question ID. */
  itemKey: string;
  instrument: string;
  key: string;
  refKey: string;
  item: ItemDefinition;
  sectionIndex: number;
  sectionKey: string;
  componentIndex: number;
  /** Position within its placement. */
  indexInPlacement: number;
  /** Position in the whole administered order (0-based). */
  position: number;
}

/**
 * Every administered question, in the order a participant meets them. A
 * question placed twice appears twice — which validation reports.
 */
export function liveQuestions(draft: StudioDraft): LiveQuestion[] {
  const out: LiveQuestion[] = [];
  for (const p of placements(draft)) {
    p.items.forEach((item, indexInPlacement) => {
      out.push({
        itemKey: `${p.instrument}.${item.key}`,
        instrument: p.instrument,
        key: item.key,
        refKey: p.refKey,
        item,
        sectionIndex: p.sectionIndex,
        sectionKey: p.sectionKey,
        componentIndex: p.componentIndex,
        indexInPlacement,
        position: out.length,
      });
    });
  }
  return out;
}

/** Every question defined in the draft's instruments, placed or not. */
export function definedQuestions(draft: StudioDraft): { itemKey: string; refKey: string; instrument: string; item: ItemDefinition }[] {
  const out: { itemKey: string; refKey: string; instrument: string; item: ItemDefinition }[] = [];
  for (const [refKey, def] of Object.entries(draft.instruments)) {
    const form = formOf(def);
    for (const item of (form?.items ?? []) as ItemDefinition[]) {
      out.push({ itemKey: `${def.instrument}.${item.key}`, refKey, instrument: def.instrument, item });
    }
  }
  return out;
}

/** Split `<instrument>.<key>`. */
export function splitItemKey(itemKey: string): { instrument: string; key: string } {
  const dot = itemKey.indexOf(".");
  return dot < 0 ? { instrument: "", key: itemKey } : { instrument: itemKey.slice(0, dot), key: itemKey.slice(dot + 1) };
}
