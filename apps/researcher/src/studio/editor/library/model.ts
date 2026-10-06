import {
  insertFragment,
  itemsOf,
  MODULE_ID_PATTERN,
  protectedModule,
  provenanceOf,
  type FragmentOrigin,
  type InsertOptions,
  type InsertReport,
  type InsertTarget,
  type LibraryCatalogueResponse,
  type LibraryModuleSummary,
  type ModuleUpdateOutcome,
  type Outline,
  type OutlineBlock,
  type PendingModuleUpdate,
  type PieceSelection,
  type StudioDraft,
  type StudioFragment,
} from "@myself/studio";
import { versionLabel } from "../../format.js";

/**
 * The item library's decisions that need no screen (D-57, docs/16 §12): what
 * a search matches, what a set of ticks makes as pieces, where each piece
 * goes, what to call a module, and how provenance reads in words. The drawer,
 * the dialogs and the library page draw these; the rules about copying itself
 * are @myself/studio's (`insertFragment` and friends).
 */

// ── Searching ─────────────────────────────────────────────────────────────

/** Lower case, accents off, spaces collapsed: "Café  Use" and "cafe use" are the same search. */
export function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether every word of the query is somewhere in the fields. An empty query matches everything. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = normalise(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalise(fields.filter((f): f is string => typeof f === "string").join(" \u0000 "));
  return words.every((w) => haystack.includes(w));
}

/** A published version's questions that match: by wording, question ID, variable, or the name of their block. */
export function matchingQuestions(source: StudioDraft, o: Outline, query: string): Set<string> {
  const out = new Set<string>();
  if (!normalise(query)) return out;
  const variables = variablesOf(source);
  for (const s of o.sections) {
    for (const b of s.blocks) {
      for (const q of b.questions) {
        if (matches(query, q.text, q.itemKey, variables.get(q.itemKey), b.name)) out.add(q.itemKey);
      }
    }
  }
  return out;
}

function variablesOf(draft: StudioDraft): Map<string, string> {
  const out = new Map<string, string>();
  for (const def of Object.values(draft.instruments)) {
    for (const item of itemsOf(def)) out.set(`${def.instrument}.${item.key}`, item.variable);
  }
  return out;
}

/** The saved modules a search and a tag pick out: title, description, tags and ID. */
export function filterModules(modules: readonly LibraryModuleSummary[], query: string, tag: string | null): LibraryModuleSummary[] {
  return modules
    .filter((m) => (tag ? m.tags.some((t) => normalise(t) === normalise(tag)) : true))
    .filter((m) => matches(query, m.title, m.description, m.moduleId, m.tags.join(" ")))
    .sort((a, b) => a.title.localeCompare(b.title, "en-GB") || a.moduleId.localeCompare(b.moduleId));
}

/** Every tag in use, once each (whatever its case), in order. */
export function allTags(modules: readonly LibraryModuleSummary[]): string[] {
  const seen = new Map<string, string>();
  for (const m of modules) for (const t of m.tags) if (!seen.has(normalise(t))) seen.set(normalise(t), t);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en-GB"));
}

// ── The published surveys shelf ───────────────────────────────────────────

export type CatalogueStudy = LibraryCatalogueResponse["studies"][number] & { here: boolean };
export type CatalogueSurvey = CatalogueStudy["surveys"][number];

/**
 * The catalogue as the shelf lists it: the study the Studio is in first, then
 * the others by title; in each, the surveys that have published a version, by
 * title, each with its versions newest first.
 */
export function orderCatalogue(catalogue: LibraryCatalogueResponse, here: string): CatalogueStudy[] {
  return catalogue.studies
    .map((s) => ({
      ...s,
      here: s.study === here,
      surveys: s.surveys
        .filter((v) => v.versions.length > 0)
        .map((v) => ({ ...v, versions: [...v.versions].sort((a, b) => compareDotted(b.version, a.version)) }))
        .sort((a, b) => a.title.localeCompare(b.title, "en-GB") || a.surveyId.localeCompare(b.surveyId)),
    }))
    .filter((s) => s.surveys.length > 0)
    .sort((a, b) => Number(b.here) - Number(a.here) || a.title.localeCompare(b.title, "en-GB") || a.study.localeCompare(b.study));
}

function compareDotted(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── Ticking questions, blocks and sections ────────────────────────────────

/** What can be ticked in a published version: a section, a block, or a question. */
export const pickKey = {
  section: (sectionKey: string) => `s:${sectionKey}`,
  block: (sectionKey: string, componentIndex: number) => `b:${sectionKey}:${componentIndex}`,
  question: (itemKey: string) => `q:${itemKey}`,
};

/**
 * Tick or untick one thing. Ticking a section or a block takes everything in
 * it, so the ticks inside it are dropped (they are shown ticked, implied).
 */
export function togglePick(o: Outline, picked: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(picked);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  next.add(key);
  for (const s of o.sections) {
    const inSection = key === pickKey.section(s.key);
    for (const b of s.blocks) {
      const blockKey = pickKey.block(s.key, b.componentIndex);
      if (inSection) next.delete(blockKey);
      if (inSection || key === blockKey) for (const q of b.questions) next.delete(pickKey.question(q.itemKey));
    }
  }
  return next;
}

/** Whether something is ticked because what holds it is. */
export function impliedPick(picked: ReadonlySet<string>, sectionKey: string, componentIndex?: number): boolean {
  if (picked.has(pickKey.section(sectionKey))) return true;
  return componentIndex !== undefined && picked.has(pickKey.block(sectionKey, componentIndex));
}

/**
 * The pieces the ticks make, in survey order: each ticked section whole, each
 * ticked block whole, and each block's ticked questions as one piece of that
 * block — a piece is never more than one block's questions (`fragmentFromDraft`).
 */
export function piecesFor(o: Outline, picked: ReadonlySet<string>): PieceSelection[] {
  const out: PieceSelection[] = [];
  for (const s of o.sections) {
    if (picked.has(pickKey.section(s.key))) {
      out.push({ kind: "section", sectionKey: s.key });
      continue;
    }
    for (const b of s.blocks) {
      if (picked.has(pickKey.block(s.key, b.componentIndex))) {
        out.push({ kind: "block", sectionKey: s.key, componentIndex: b.componentIndex });
        continue;
      }
      const itemKeys = b.questions.filter((q) => picked.has(pickKey.question(q.itemKey))).map((q) => q.itemKey);
      if (itemKeys.length > 0) out.push({ kind: "questions", sectionKey: s.key, componentIndex: b.componentIndex, itemKeys });
    }
  }
  return out;
}

/** How many questions the ticks take. */
export function pickedCount(o: Outline, picked: ReadonlySet<string>): number {
  let n = 0;
  for (const s of o.sections) {
    const whole = picked.has(pickKey.section(s.key));
    for (const b of s.blocks) {
      if (whole || picked.has(pickKey.block(s.key, b.componentIndex))) n += b.questions.length;
      else n += b.questions.filter((q) => picked.has(pickKey.question(q.itemKey))).length;
    }
  }
  return n;
}

/** The protected modules (consent, identity) the pieces take, by instrument: adding one asks why. */
export function protectedIn(o: Outline, pieces: readonly PieceSelection[]): { instrument: string; name: string }[] {
  const out = new Map<string, string>();
  for (const piece of pieces) {
    const section = o.sections.find((s) => s.key === piece.sectionKey);
    const blocks = piece.kind === "section" ? (section?.blocks ?? []) : (section?.blocks.filter((b) => b.componentIndex === piece.componentIndex) ?? []);
    for (const b of blocks) if (protectedModule(b.instrument)) out.set(b.instrument, b.name);
  }
  return [...out].map(([instrument, name]) => ({ instrument, name }));
}

/** The protected modules a piece carries (a module or validated questionnaire never does, but a survey's section may). */
export function protectedInFragment(fragment: StudioFragment): { instrument: string; name: string }[] {
  return fragment.blocks
    .filter((b) => protectedModule(b.definition.instrument))
    .map((b) => ({ instrument: b.definition.instrument, name: b.definition.name ?? b.definition.instrument }));
}

// ── A piece's questions ───────────────────────────────────────────────────

export interface PieceQuestion {
  itemKey: string;
  text: string;
  variable: string;
  block: string;
}

/** The questions a piece holds, block by block, in order. */
export function fragmentQuestions(fragment: StudioFragment): PieceQuestion[] {
  return fragment.blocks.flatMap((b) =>
    itemsOf(b.definition).map((item) => ({
      itemKey: `${b.definition.instrument}.${item.key}`,
      text: item.stem.text,
      variable: item.variable,
      block: b.definition.name ?? b.definition.instrument,
    })),
  );
}

// ── Where the piece goes ──────────────────────────────────────────────────

/** Where the researcher asked for the piece: into a section (after a question, or at its end), or as a new section. */
export type TargetChoice =
  | { kind: "section"; sectionKey: string; afterItemKey: string | null }
  | { kind: "new"; title: string; index: number | null };

/** Somewhere sensible to start from: after the selected question, else at the end of the selected (or last) section. */
export function defaultTarget(
  o: Outline,
  selection: { kind: string; itemKey?: string; sectionKey?: string; componentIndex?: number } | null,
): TargetChoice | null {
  if (selection?.kind === "question" && selection.itemKey) {
    for (const s of o.sections) {
      for (const b of s.blocks) {
        if (b.questions.some((q) => q.itemKey === selection.itemKey)) return { kind: "section", sectionKey: s.key, afterItemKey: selection.itemKey };
      }
    }
  }
  if ((selection?.kind === "section" || selection?.kind === "block") && selection.sectionKey) {
    const s = o.sections.find((x) => x.key === selection.sectionKey);
    if (s) {
      const block = selection.kind === "block" ? s.blocks.find((b) => b.componentIndex === selection.componentIndex) : null;
      const last = block?.questions[block.questions.length - 1];
      return { kind: "section", sectionKey: s.key, afterItemKey: last?.itemKey ?? null };
    }
  }
  const last = o.sections[o.sections.length - 1];
  return last ? { kind: "section", sectionKey: last.key, afterItemKey: null } : null;
}

/** The target in words: "after “Do you own a phone?” in Phones", "at the end of Phones", "as a new section". */
export function targetWords(o: Outline, choice: TargetChoice): string {
  if (choice.kind === "new") return `as a new section, “${choice.title.trim() || "Untitled"}”`;
  const s = o.sections.find((x) => x.key === choice.sectionKey);
  const title = s?.title ?? choice.sectionKey;
  if (!choice.afterItemKey) return `at the end of “${title}”`;
  const q = s?.blocks.flatMap((b) => b.questions).find((x) => x.itemKey === choice.afterItemKey);
  return `after “${shorten(q?.text ?? choice.afterItemKey, 50)}” in “${title}”`;
}

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Add several pieces as ONE edit: each goes after the one before it, so their
 * order is kept. A whole section always comes as a new section of its own
 * (docs/16 §12.2), straight after the section the pieces are going into.
 * Throws whatever `insertFragment` throws, before anything is changed — the
 * caller's edit then leaves the draft as it was.
 */
export function insertPieces(
  draft: StudioDraft,
  fragments: readonly StudioFragment[],
  choice: TargetChoice,
  opts: InsertOptions,
): { draft: StudioDraft; reports: InsertReport[] } {
  let current = draft;
  const reports: InsertReport[] = [];
  const indexOf = (d: StudioDraft, key: string) => d.composition.sections.findIndex((s) => s.key === key);
  let cursor: InsertTarget =
    choice.kind === "section"
      ? { sectionKey: choice.sectionKey, afterItemKey: choice.afterItemKey }
      : { newSection: { title: choice.title.trim(), index: choice.index } };
  let nextIndex: number | null = choice.kind === "section" ? indexOf(draft, choice.sectionKey) + 1 : choice.index;
  fragments.forEach((fragment, i) => {
    const target: InsertTarget = fragment.section
      ? { newSection: { title: i === 0 && choice.kind === "new" ? choice.title.trim() : fragment.section.title, index: nextIndex } }
      : cursor;
    const { draft: next, report } = insertFragment(current, fragment, target, opts);
    current = next;
    reports.push(report);
    // Nothing added (all of it already here) leaves the next piece going where this one would have.
    if (!report.sectionKey) return;
    const last = report.added[report.added.length - 1] ?? null;
    const previousAfter = "sectionKey" in cursor && cursor.sectionKey === report.sectionKey ? (cursor.afterItemKey ?? null) : null;
    cursor = { sectionKey: report.sectionKey, afterItemKey: last ?? previousAfter };
    nextIndex = indexOf(current, report.sectionKey) + 1;
  });
  return { draft: current, reports };
}

export interface InsertOutcome {
  added: string[];
  alreadyThere: string[];
  renamed: { from: string; to: string }[];
  variablesRenamed: { itemKey: string; from: string; to: string }[];
  conditionsRemoved: InsertReport["conditionsRemoved"];
  unlocked: string[];
}

/** Several inserts' reports as one: what to tell the researcher, with every rename. */
export function combineReports(reports: readonly InsertReport[]): InsertOutcome {
  return {
    added: reports.flatMap((r) => r.added),
    alreadyThere: reports.flatMap((r) => r.alreadyThere),
    renamed: reports.flatMap((r) => r.renamed),
    variablesRenamed: reports.flatMap((r) => r.variablesRenamed),
    conditionsRemoved: reports.flatMap((r) => r.conditionsRemoved),
    unlocked: [...new Set(reports.flatMap((r) => r.unlocked))],
  };
}

/** Whether the researcher must read the outcome rather than glance at a toast: anything renamed or dropped. */
export function needsReading(outcome: InsertOutcome): boolean {
  return outcome.renamed.length > 0 || outcome.variablesRenamed.length > 0 || outcome.conditionsRemoved.length > 0;
}

// ── Naming a module ───────────────────────────────────────────────────────

/** A module ID from a title, as the dialog suggests until one is typed. */
export function moduleSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/_+$/, "");
}

/** Why an ID can't be a new module's, in words; null when it can. */
export function moduleIdProblem(id: string, taken: readonly string[]): string | null {
  if (!id) return "Give the module an ID.";
  if (id.length < 3) return "Use at least 3 characters.";
  if (!MODULE_ID_PATTERN.test(id)) return "Use lower-case letters, numbers and underscores, starting with a letter (at most 64).";
  if (taken.includes(id)) return "There’s already a module with this ID. Choose another, or save a new version of that one.";
  return null;
}

/** Tags as typed ("sleep, Wellbeing , sleep"): trimmed, each once whatever its case, in the order given. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(",")) {
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!tag || seen.has(normalise(tag))) continue;
    seen.add(normalise(tag));
    out.push(tag);
  }
  return out;
}

// ── Provenance in words ───────────────────────────────────────────────────

export interface OriginNames {
  /** The study the Studio is in: a source in it is not named again. */
  here?: string;
  studyTitle?: (study: string) => string | null;
  surveyTitle?: (study: string, surveyId: string) => string | null;
  moduleTitle?: (moduleId: string) => string | null;
  validatedName?: (refKey: string) => string | null;
}

/** Where a piece came from, in a phrase: "“Phones” r8.0.0 in study space “Futures”", "SDQ (validated questionnaire)", "module “Sleep habits” v3". */
export function originWords(origin: FragmentOrigin, names: OriginNames = {}): string {
  switch (origin.kind) {
    case "release": {
      const survey = names.surveyTitle?.(origin.study, origin.surveyId);
      const what = survey ? `“${survey}” (${origin.surveyId})` : origin.surveyId;
      const where = origin.study === names.here ? "" : ` in study space “${names.studyTitle?.(origin.study) ?? origin.study}”`;
      return `${what} ${versionLabel(origin.version)}${where}`;
    }
    case "validated":
      return `${names.validatedName?.(origin.refKey) ?? origin.instrument} (validated questionnaire, ${origin.refKey})`;
    case "module": {
      const title = names.moduleTitle?.(origin.moduleId);
      return `module ${title ? `“${title}” (${origin.moduleId})` : origin.moduleId} v${origin.version}`;
    }
  }
}

/** What updating one question from a newer module version does, in words for the review table. */
export const OUTCOME_WORDS: Record<ModuleUpdateOutcome, string> = {
  updated: "Takes the newer version",
  kept_local: "Keeps this survey’s version (changed here)",
  kept_local_conflict: "Keeps this survey’s version — it was changed here and in the library",
  archived: "Archived — the module no longer has it (its ID stays reserved)",
  kept_removed_upstream: "Kept — the module no longer has it, but it was changed here",
  added: "Added",
  unchanged: "No change",
};

/** Outcomes a researcher should look at before updating. */
export const OUTCOME_ATTENTION: ReadonlySet<ModuleUpdateOutcome> = new Set(["kept_local_conflict", "archived", "kept_removed_upstream"]);

// ── Saved modules in a draft ──────────────────────────────────────────────

/** The newer module versions that concern a block: those whose copied questions are in it. */
export function updatesForBlock(updates: readonly PendingModuleUpdate[], block: Pick<OutlineBlock, "questions">): PendingModuleUpdate[] {
  const keys = new Set(block.questions.map((q) => q.itemKey));
  return updates.filter((u) => u.itemKeys.some((k) => keys.has(k)));
}

/**
 * The saved modules some of these questions were copied from (or saved as),
 * newest version of each: what "Save as a new version of …" offers.
 */
export function moduleSourcesOf(draft: StudioDraft, itemKeys: readonly string[]): { moduleId: string; version: number; itemKeys: string[] }[] {
  const out = new Map<string, { moduleId: string; version: number; itemKeys: string[] }>();
  for (const key of itemKeys) {
    const found = provenanceOf(draft, key);
    if (found?.record.origin.kind !== "module") continue;
    const { moduleId, version } = found.record.origin;
    const entry = out.get(moduleId);
    if (!entry) out.set(moduleId, { moduleId, version, itemKeys: [key] });
    else {
      entry.version = Math.max(entry.version, version);
      entry.itemKeys.push(key);
    }
  }
  return [...out.values()];
}
