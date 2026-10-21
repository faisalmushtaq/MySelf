import { allInstruments, allModules, allScales } from "@myself/library";
import { refKeyOf } from "@myself/release/gate";
import { allScoring } from "@myself/scoring";
import {
  canonicalJson,
  instrumentVersion,
  itemDefinition,
  moduleDefinition,
  responseScale,
  scoringDefinition,
  type InstrumentForm,
  type InstrumentVersion,
  type ItemDefinition,
  PROVENANCE_KIND_LABELS,
  type ProvenanceInput,
} from "@myself/schema";
import {
  FRAGMENT_FORMAT,
  FRAGMENT_FORMAT_VERSION,
  MAX_IMPORTED_RELEASES,
  MAX_MODULE_CHARS,
  type FragmentBlock,
  type FragmentOrigin,
  type ImportRecord,
  type InstrumentOrModule,
  type Issue,
  type IssueLocation,
  type ScaleInput,
  type ScoringInput,
  type StudioDraft,
  type StudioFragment,
} from "./contract.js";
import {
  clone,
  componentAt,
  componentRefKey,
  isPlaced,
  keepConsentFirst,
  keepMyStoryLast,
  live,
  newPlacement,
  placeNewItem,
  quoted,
  sectionIndexOf,
  takenKeys,
  takenScaleKeys,
  type PlacedComponent,
  type Where,
} from "./editing.js";
import type { ReservedIds } from "./history.js";
import { generateScaleKey, generateVariable, uniqueSlug } from "./keys.js";
import { joinAnd, lockedFingerprint, openInLibrary, type LockedOptions } from "./locked.js";
import { allVariables, findQuestion, identityRoleOf, instrumentDef, isUnlocked, itemsOf, protectedModule, scaleUsage, StudioOpError } from "./model.js";
import { isMyStorySection } from "./mystory.js";
import { addSection, archiveQuestion, MIN_UNLOCK_REASON } from "./ops.js";
import { liveQuestions, placements, splitItemKey, type Placement } from "./walk.js";

/**
 * The item library (D-57, docs/16 §12): taking pieces out of one survey and
 * adding them to another, the validated questionnaires as pieces, the
 * vouchers that let a copied questionnaire through its locks, and saved
 * modules' update notices.
 *
 * Everything here is a pure function of drafts and pieces, as in ops.ts: the
 * editor and the server ask the same questions through the same functions.
 * Adding a piece places its questions by the same machinery as adding a
 * question by hand (editing.ts), so the two can never disagree about where a
 * question may go, which key is free, or what may come before the consent.
 *
 * Three promises run through it:
 *
 * - A copied question keeps its question ID and its variable, so the same
 *   question in two surveys exports to the same column and can be pooled. It
 *   is renamed only when the name is already taken by something else, and every
 *   rename is reported, because a rename means the data will not line up.
 * - A validated questionnaire is only ever taken whole and unchanged; the server
 *   checks it again at publish against the library and the releases the draft
 *   names (§12.4), so nothing here is the last word on a licence.
 * - Nothing changes in a survey because the library did: a newer version of a
 *   saved module is a notice, and taking it is an edit somebody chooses.
 */

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function own<T>(record: Record<string, T> | undefined | null, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Whether a definition's licence keeps its wording fixed (anything but a plain "yes" — fails closed). */
function licenceLocked(def: unknown): boolean {
  return (def as { licence?: { modifiable?: unknown } } | null)?.licence?.modifiable !== "yes";
}

/** The instruments the library holds as validated, by key: locked wherever they turn up, whatever a copy's licence says. */
const VALIDATED_KEYS: ReadonlySet<string> = new Set(allInstruments.filter((i) => licenceLocked(i)).map((i) => i.instrument));

/** Locked: by its own licence, or because the library says that instrument is a validated one. */
function isLockedDef(def: unknown): boolean {
  if (licenceLocked(def)) return true;
  const key = (def as { instrument?: unknown } | null)?.instrument;
  return typeof key === "string" && VALIDATED_KEYS.has(key);
}

function nameOf(def: unknown, fallback: string): string {
  const d = (def ?? {}) as { abbreviation?: unknown; name?: unknown };
  if (typeof d.abbreviation === "string" && d.abbreviation) return d.abbreviation;
  if (typeof d.name === "string" && d.name) return d.name;
  return fallback;
}

function itemsOfForm(def: unknown): ItemDefinition[] {
  const forms = (def as { forms?: unknown } | null)?.forms;
  const form = Array.isArray(forms) ? forms[0] : undefined;
  const items = isObject(form) ? form["items"] : undefined;
  return Array.isArray(items) ? (items as ItemDefinition[]) : [];
}

// ---------------------------------------------------------------------------
// Comparing content
// ---------------------------------------------------------------------------

/** A value read through a schema, so a default spelled out in one and implicit in the other is not a difference. */
function normalised(schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/** An option list's content: what participants see and what is recorded, without the key it is filed under. */
function scaleContent(scale: unknown): unknown {
  if (!isObject(scale)) return null;
  const s = { ...(normalised(responseScale, scale) as Loose) };
  delete s["key"];
  return s;
}

function sameScale(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && canonicalJson(scaleContent(a)) === canonicalJson(scaleContent(b));
}

function sameScoring(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && canonicalJson(normalised(scoringDefinition, a)) === canonicalJson(normalised(scoringDefinition, b));
}

/** The identity fields a copy may be given anew; set aside when comparing what a question asks. */
const IDENTITY_FIELDS = ["key", "variable", "revision", "legacyVariable"] as const;

/**
 * A question as data, for "is this the same question?": its definition read
 * through the schema, with its answer options in place of the key of the list
 * that holds them — two surveys may file the same options under different keys.
 */
function questionContent(
  item: unknown,
  scales: Record<string, ScaleInput> | undefined,
  opts: { withoutIdentity?: boolean; mapRefs?: ReadonlyMap<string, string> } = {},
): string {
  const out = { ...(normalised(itemDefinition, item) as Loose) };
  const scaleKey = out["scale"];
  if (typeof scaleKey === "string") out["scale"] = scaleContent(own(scales, scaleKey));
  if (opts.withoutIdentity) for (const field of IDENTITY_FIELDS) delete out[field];
  if (opts.mapRefs && opts.mapRefs.size > 0) {
    // A copy: what the schema could not read comes back as the draft's own object.
    const copy = structuredClone(out);
    rewriteRefs(copy, opts.mapRefs);
    return canonicalJson(copy);
  }
  return canonicalJson(out);
}

// ---------------------------------------------------------------------------
// References between questions
// ---------------------------------------------------------------------------

/**
 * Every question a logic expression tests, as `<instrument>.<key>`. Tolerant
 * of shapes it does not know (a piece from elsewhere is data, not trusted
 * code): anything it cannot read as a target is ignored rather than thrown on.
 */
function targetsOf(expr: unknown, out: string[] = []): string[] {
  if (!isObject(expr)) return out;
  if (Array.isArray(expr["args"])) for (const a of expr["args"]) targetsOf(a, out);
  if (expr["arg"]) targetsOf(expr["arg"], out);
  const target = expr["target"];
  const item = isObject(target) ? target["item"] : undefined;
  if (isObject(item) && typeof item["instrument"] === "string" && typeof item["item"] === "string") {
    const key = `${item["instrument"]}.${item["item"]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Point every item reference (`{instrument, item, revision}` — conditions,
 * pipes, answer checks, option limits) at a question's new ID, wherever it
 * appears inside `value`. Mutates.
 */
function rewriteRefs(value: unknown, renamed: ReadonlyMap<string, string>): void {
  if (renamed.size === 0) return;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isObject(v)) return;
    if (typeof v["instrument"] === "string" && typeof v["item"] === "string" && typeof v["revision"] === "number") {
      const to = renamed.get(`${v["instrument"]}.${v["item"]}`);
      if (to) {
        const next = splitItemKey(to);
        v["instrument"] = next.instrument;
        v["item"] = next.key;
      }
    }
    for (const child of Object.values(v)) visit(child);
  };
  visit(value);
}

/** The files a question needs from the release's asset table (D-52). */
function assetKeysOf(item: unknown): string[] {
  const out: string[] = [];
  if (!isObject(item)) return out;
  for (const field of ["postcodeCheck", "streetCheck"]) {
    const check = item[field];
    if (isObject(check) && typeof check["asset"] === "string") out.push(check["asset"]);
  }
  const media = Array.isArray(item["media"]) ? item["media"] : [];
  for (const m of [...media, item["image"]]) if (isObject(m) && typeof m["assetKey"] === "string") out.push(m["assetKey"]);
  return [...new Set(out)];
}

/** Every slug a scoring definition's steps name as an item. */
function scoringItems(scoring: unknown): string[] {
  const steps = isObject(scoring) && Array.isArray(scoring["steps"]) ? scoring["steps"] : [];
  return steps.flatMap((s) => (isObject(s) && Array.isArray(s["items"]) ? (s["items"] as unknown[]).filter((x): x is string => typeof x === "string") : []));
}

function missingPhrase(missing: string[]): string {
  return missing.length === 1
    ? `It tests ${missing[0]}, which this survey does not ask.`
    : `It tests questions this survey does not ask: ${joinAnd(missing)}.`;
}

// ---------------------------------------------------------------------------
// Picking a piece
// ---------------------------------------------------------------------------

/** What can be picked from a draft (or from a published version, as a draft). */
export type PieceSelection =
  /** Some questions of ONE editable block, in the order given. */
  | { kind: "questions"; sectionKey: string; componentIndex: number; itemKeys: string[] }
  /** One whole block. */
  | { kind: "block"; sectionKey: string; componentIndex: number }
  /** One whole section (not MyStory's). */
  | { kind: "section"; sectionKey: string };

function protectedWhy(instrument: string, name: string): string {
  const p = protectedModule(instrument);
  return p?.reason === "ethics"
    ? `“${name}” is the study's ethics-approved introduction and consent, and approval of its wording is for one study`
    : `“${name}” holds the questions participant linkage rests on`;
}

function lockedOnlyWhole(name: string): string {
  return (
    `“${name}” is a licensed, validated questionnaire, so it can only be copied whole, exactly as licensed: ` +
    `some of its questions on their own would not be scored or valid, and its licence covers it only as published. Copy the whole block instead.`
  );
}

/**
 * The definition of a block of an editable instrument, holding only `items`,
 * in that order. Subscales and reverse-scored lists keep only the keys still
 * there; scoring that names a question left behind is not carried (it would
 * score nothing, and the publish check refuses it).
 */
function trimmedDefinition(def: InstrumentOrModule, form: InstrumentForm, items: ItemDefinition[], scoring: Record<string, ScoringInput>): InstrumentOrModule {
  const keys = new Set(items.map((i) => i.key));
  const out = structuredClone(def) as InstrumentOrModule & Loose;
  out.forms = [{ ...structuredClone(form), items: structuredClone(items) }] as InstrumentOrModule["forms"];
  if (out.subscales) {
    const subscales = out.subscales.map((s) => ({ ...s, itemKeys: s.itemKeys.filter((k) => keys.has(k)) })).filter((s) => s.itemKeys.length > 0);
    if (subscales.length > 0) out.subscales = subscales;
    else delete out.subscales;
  }
  if (out.reverseScoredItems) {
    const reverse = out.reverseScoredItems.filter((k) => keys.has(k));
    if (reverse.length > 0) out.reverseScoredItems = reverse;
    else delete out.reverseScoredItems;
  }
  if (typeof out.scoringKey === "string") {
    const sd = own(scoring, out.scoringKey);
    if (!sd || !scoringItems(sd).every((k) => keys.has(k))) delete out.scoringKey;
  }
  return out;
}

/**
 * The piece a selection makes, self-contained: its definitions trimmed to the
 * chosen questions, every option list, scoring and file they use.
 *
 * Display conditions travel with it as the source had them, on the questions
 * and on the blocks: whether each still makes sense depends on the survey the
 * piece is added to, so `insertFragment` keeps each only when every question it
 * tests is there after the copy, and reports the ones it removes (§12.3 rule 7).
 * A piece saved as a module must not test anything outside itself
 * (`moduleProblems`); `withoutOutsideConditions` takes those conditions off.
 *
 * Throws StudioOpError ("invalid") for questions picked from a validated
 * questionnaire or a consent or identity module (only the whole one can be
 * taken), for questions not shown by the block named, and for MyStory, which is
 * switched on per survey rather than copied (§12.2).
 */
export function fragmentFromDraft(source: StudioDraft, selection: PieceSelection, origin: FragmentOrigin): StudioFragment {
  const sectionIndex = source.composition.sections.findIndex((s) => s.key === selection.sectionKey);
  if (sectionIndex < 0) throw new StudioOpError(`There is no section “${selection.sectionKey}” in this survey.`, "not_found");
  const section = source.composition.sections[sectionIndex]!;
  if (isMyStorySection(section)) {
    throw new StudioOpError("MyStory can't be copied: it is switched on for each survey, and always comes last. Switch it on in the survey you are adding to instead.", "invalid");
  }
  const inSection = placements(source).filter((p) => p.sectionIndex === sectionIndex);
  let picks: { p: Placement; keys: string[] | null }[];
  if (selection.kind === "section") {
    picks = inSection.map((p) => ({ p, keys: null }));
    if (picks.length === 0) throw new StudioOpError(`“${section.title}” has no questions to copy.`, "invalid");
  } else {
    const p = inSection.find((x) => x.componentIndex === selection.componentIndex);
    if (!p) throw new StudioOpError("That block is not in this section any more.", "not_found");
    if (selection.kind === "block") picks = [{ p, keys: null }];
    else {
      const name = nameOf(p.def, p.instrument);
      if (isLockedDef(p.def)) throw new StudioOpError(lockedOnlyWhole(name), "invalid");
      if (protectedModule(p.instrument)) {
        throw new StudioOpError(`${protectedWhy(p.instrument, name)}, so it can only be copied whole, with the reason recorded. Copy the whole block instead.`, "invalid");
      }
      const keys: string[] = [];
      for (const raw of selection.itemKeys) {
        const { instrument, key } = raw.includes(".") ? splitItemKey(raw) : { instrument: p.instrument, key: raw };
        if (instrument !== p.instrument) {
          throw new StudioOpError("Questions can be copied together only from one block. Copy the others separately, or copy the whole section.", "invalid");
        }
        if (!p.items.some((i) => i.key === key)) throw new StudioOpError(`${instrument}.${key} is not in this block.`, "not_found");
        if (!keys.includes(key)) keys.push(key);
      }
      if (keys.length === 0) throw new StudioOpError("Choose at least one question to copy.", "invalid");
      picks = [{ p, keys }];
    }
  }

  const blocks: FragmentBlock[] = [];
  for (const { p, keys } of picks) {
    if (!p.def || !p.form) {
      throw new StudioOpError(`“${nameOf(p.def, p.instrument)}” can't be copied: its questions are missing from this survey.`, "invalid");
    }
    let definition: InstrumentOrModule;
    if (isLockedDef(p.def)) {
      // Always the whole licensed form, exactly as the survey froze it.
      definition = { ...structuredClone(p.def), forms: [structuredClone(p.form)] } as InstrumentOrModule;
    } else {
      const byKey = new Map(p.form.items.map((i) => [i.key, i]));
      const chosen = (keys ?? p.items.map((i) => i.key)).map((k) => byKey.get(k)).filter((i): i is ItemDefinition => !!i);
      definition = trimmedDefinition(p.def, p.form, chosen, source.scoring);
    }
    const block: FragmentBlock = { refKey: p.refKey, definition };
    const component = source.composition.sections[p.sectionIndex]!.components[p.componentIndex];
    if (component && isPlaced(component) && component.displayIf != null) block.displayIf = structuredClone(component.displayIf);
    blocks.push(block);
  }

  const scales: Record<string, ScaleInput> = {};
  const scoring: Record<string, ScoringInput> = {};
  const assets: NonNullable<StudioFragment["assets"]> = {};
  for (const block of blocks) {
    for (const item of itemsOfForm(block.definition)) {
      if ("scale" in item && typeof item.scale === "string") {
        const scale = own(source.scales, item.scale);
        if (scale) scales[item.scale] = structuredClone(scale);
      }
      for (const key of assetKeysOf(item)) {
        const asset = own(source.assets, key);
        if (asset) assets[key] = structuredClone(asset);
      }
    }
    const scoringKey = (block.definition as { scoringKey?: unknown }).scoringKey;
    if (typeof scoringKey === "string") {
      const sd = own(source.scoring, scoringKey);
      if (sd) scoring[scoringKey] = structuredClone(sd);
    }
  }

  const title = selection.kind === "section" ? section.title : (blocks[0]?.definition.name ?? section.title);
  return {
    format: FRAGMENT_FORMAT,
    formatVersion: FRAGMENT_FORMAT_VERSION,
    title,
    ...(selection.kind === "section" ? { section: { title: section.title } } : {}),
    blocks,
    scales,
    scoring,
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    origin: structuredClone(origin),
  };
}

/** Whether a question may be picked on its own (editable blocks only), and if not, why. */
export function pickable(source: StudioDraft, itemKey: string): { ok: true } | { ok: false; reason: string } {
  const q = findQuestion(source, itemKey);
  if (!q) return { ok: false, reason: "That question is not in this survey." };
  const def = source.instruments[q.refKey];
  const name = nameOf(def, q.instrument);
  if (isLockedDef(def)) return { ok: false, reason: lockedOnlyWhole(name) };
  if (protectedModule(q.instrument)) {
    return { ok: false, reason: `${protectedWhy(q.instrument, name)}, so it can only be copied whole, with the reason recorded. Copy the whole block instead.` };
  }
  return { ok: true };
}

/**
 * A piece without the display conditions that test questions outside it: what
 * a block can be saved to the library as (§12.6), since a module has to make
 * sense wherever it is added. Returns what was taken off, in the words
 * `insertFragment` would use, so the editor can say so before saving.
 */
export function withoutOutsideConditions(fragment: StudioFragment): {
  fragment: StudioFragment;
  removed: { itemKey: string | null; block: string | null; reason: string }[];
} {
  const out = structuredClone(fragment);
  const ids = new Set(out.blocks.flatMap((b) => itemsOfForm(b.definition).map((i) => `${b.definition.instrument}.${i.key}`)));
  const removed: { itemKey: string | null; block: string | null; reason: string }[] = [];
  for (const block of out.blocks) {
    for (const item of itemsOfForm(block.definition)) {
      const missing = targetsOf(item.displayIf).filter((t) => !ids.has(t));
      if (item.displayIf != null && missing.length > 0) {
        delete (item as Loose)["displayIf"];
        removed.push({ itemKey: `${block.definition.instrument}.${item.key}`, block: null, reason: outsidePhrase(missing) });
      }
    }
    const missing = targetsOf(block.displayIf).filter((t) => !ids.has(t));
    if (block.displayIf != null && missing.length > 0) {
      delete block.displayIf;
      removed.push({ itemKey: null, block: nameOf(block.definition, block.refKey), reason: outsidePhrase(missing) });
    }
  }
  return { fragment: out, removed };
}

function outsidePhrase(missing: string[]): string {
  return missing.length === 1 ? `It tests ${missing[0]}, which is not in the piece.` : `It tests questions that are not in the piece: ${joinAnd(missing)}.`;
}

// ---------------------------------------------------------------------------
// The validated questionnaires
// ---------------------------------------------------------------------------

export interface ValidatedEntry {
  instrument: string;
  version: string;
  refKey: string;
  name: string;
  abbreviation: string | null;
  questionCount: number;
  /** Who it is for, in words ("11–17", "18+"), when the library says. */
  audience: string | null;
  /** The licence in one line, for the shelf. */
  licence: string;
  /** How it was made, in words ("Validated instrument, as published"), and whether the team has checked that (D-68). */
  provenance: string | null;
}

interface LibraryForm {
  def: InstrumentVersion;
  form: InstrumentForm;
  refKey: string;
}

let libraryFormsCache: Map<string, LibraryForm> | null = null;

/**
 * Every form of every instrument in the library, by the reference string a
 * release keys it under, each read through the schema exactly as
 * `freezeRelease` reads it (so every default is spelled out).
 */
function libraryForms(): Map<string, LibraryForm> {
  if (libraryFormsCache) return libraryFormsCache;
  const out = new Map<string, LibraryForm>();
  for (const raw of allInstruments) {
    const def = instrumentVersion.parse(raw);
    for (const form of def.forms) {
      const refKey = refKeyOf({
        instrument: def.instrument,
        version: def.version,
        variant: form.variant,
        language: form.language,
        informant: form.informant,
        readingLevel: form.readingLevel,
      });
      out.set(refKey, { def, form, refKey });
    }
  }
  libraryFormsCache = out;
  return out;
}

let libraryScalesCache: Map<string, ScaleInput> | null = null;
function libraryScales(): Map<string, ScaleInput> {
  libraryScalesCache ??= new Map(allScales.map((s) => [s.key, responseScale.parse(s) as ScaleInput]));
  return libraryScalesCache;
}

let libraryScoringCache: Map<string, ScoringInput> | null = null;
function libraryScoring(): Map<string, ScoringInput> {
  libraryScoringCache ??= new Map(allScoring.map((s) => [s.key, scoringDefinition.parse(s) as ScoringInput]));
  return libraryScoringCache;
}

function audienceOf(def: InstrumentVersion): string | null {
  const range = def.ageRange;
  if (!range) return null;
  return range.max >= 100 ? `${range.min}+` : `${range.min}–${range.max}`;
}

function licenceLine(def: InstrumentVersion): string {
  const l = def.licence;
  const holder = l.holder ? ` (${l.holder})` : "";
  const status = l.status === "open" ? "Open licence" : l.status === "permission_held" ? `Permission held${holder}` : `Licence: ${l.status}`;
  const use =
    l.modifiable === "yes"
      ? "Its wording may be adapted."
      : l.modifiable === "with_permission"
        ? "Used exactly as licensed; any change needs the licence holder's permission."
        : "Used exactly as licensed.";
  return `${status}.${l.verified ? "" : " Permission still to be confirmed."} ${use}`;
}

function provenanceLine(def: InstrumentVersion): string | null {
  const p = def.provenance;
  if (!p) return null;
  return `${PROVENANCE_KIND_LABELS[p.kind]}.${p.confirmed ? "" : " Not yet checked by the team."}`;
}

/** The validated questionnaires, as the shelf lists them, for one language (en-GB). */
export function validatedCatalogue(language = "en-GB"): ValidatedEntry[] {
  const out: ValidatedEntry[] = [];
  for (const { def, form, refKey } of libraryForms().values()) {
    // The canonical form for self-report at the standard reading level; the
    // "as administered" variants stay in the library for reading old data.
    if (form.language !== language || form.variant || form.informant !== "self" || form.readingLevel !== "standard") continue;
    out.push({
      instrument: def.instrument,
      version: def.version,
      refKey,
      name: def.name,
      abbreviation: def.abbreviation ?? null,
      questionCount: form.items.length,
      audience: audienceOf(def),
      licence: licenceLine(def),
      provenance: provenanceLine(def),
    });
  }
  return out;
}

/**
 * A validated questionnaire as a piece, frozen exactly as a release freezes it
 * (`freezeRelease`): the definition read through the schema with its one
 * form, the option lists its questions use and its scoring, each read through
 * its schema too. So a questionnaire added from the shelf is, byte for byte,
 * what the instrument library vouches for at publish (§12.4).
 */
export function validatedFragment(refKey: string): StudioFragment {
  const found = libraryForms().get(refKey);
  if (!found) throw new StudioOpError(`There is no validated questionnaire “${refKey}” in the library.`, "not_found");
  const { def, form } = found;
  const definition = { ...def, forms: [form] } as unknown as InstrumentOrModule;
  const scales: Record<string, ScaleInput> = {};
  for (const item of form.items) {
    if (!("scale" in item)) continue;
    const scale = libraryScales().get(item.scale);
    if (!scale) throw new StudioOpError(`“${nameOf(def, def.instrument)}” can't be added: its answer options (${item.scale}) are missing from the library.`, "invalid");
    scales[item.scale] = structuredClone(scale);
  }
  const scoring: Record<string, ScoringInput> = {};
  if (def.scoringKey) {
    const sd = libraryScoring().get(def.scoringKey);
    if (!sd) throw new StudioOpError(`“${nameOf(def, def.instrument)}” can't be added: its scoring (${def.scoringKey}) is missing from the library.`, "invalid");
    scoring[def.scoringKey] = structuredClone(sd);
  }
  return {
    format: FRAGMENT_FORMAT,
    formatVersion: FRAGMENT_FORMAT_VERSION,
    title: def.name,
    blocks: [{ refKey, definition: structuredClone(definition) }],
    scales,
    scoring,
    origin: { kind: "validated", instrument: def.instrument, refKey },
  };
}

/**
 * Some or all questions of one of the study's own modules in the repository
 * library (`packages/library`), as a piece, with the option lists they use:
 * how questions written in the repository reach the Studio's library
 * (`library-seed`, D-58). The module must be editable; locked content comes
 * only from `validatedFragment`. Questions keep their module's instrument key,
 * so added to a survey that has that module they join its block.
 *
 * Throws StudioOpError for a module, form or question that does not exist.
 */
export function repositoryModuleFragment(
  instrument: string,
  opts: { itemKeys?: readonly string[]; title: string; language?: string },
): StudioFragment {
  const raw = allModules.find((m) => m.instrument === instrument);
  if (!raw) throw new StudioOpError(`There is no module “${instrument}” in the repository library.`, "not_found");
  const def = moduleDefinition.parse(raw);
  if (def.licence.modifiable !== "yes") throw new StudioOpError(`“${def.name}” is locked; add it from the validated questionnaires instead.`, "locked");
  const language = opts.language ?? "en-GB";
  const form = def.forms.find((f) => f.language === language);
  if (!form) throw new StudioOpError(`“${def.name}” has no ${language} form.`, "not_found");
  const wanted = opts.itemKeys ?? form.items.map((i) => i.key);
  const items = wanted.map((key) => {
    const item = form.items.find((i) => i.key === key);
    if (!item) throw new StudioOpError(`“${def.name}” has no question “${key}”.`, "not_found");
    return item;
  });
  const scales: Record<string, ScaleInput> = {};
  for (const item of items) {
    if (!("scale" in item)) continue;
    const scale = libraryScales().get(item.scale);
    if (!scale) throw new StudioOpError(`“${key(item)}” uses answer options (${item.scale}) that are missing from the library.`, "invalid");
    scales[item.scale] = structuredClone(scale);
  }
  const refKey = refKeyOf({ instrument: def.instrument, version: def.version, variant: form.variant, language: form.language, informant: form.informant, readingLevel: form.readingLevel });
  const definition = { ...def, forms: [{ ...form, items }] } as unknown as InstrumentOrModule;
  return {
    format: FRAGMENT_FORMAT,
    formatVersion: FRAGMENT_FORMAT_VERSION,
    title: opts.title,
    blocks: [{ refKey, definition: structuredClone(definition) }],
    scales,
    scoring: {},
    origin: { kind: "module", moduleId: "", version: 0, contentHash: "" },
  };

  function key(item: { key: string }): string {
    return `${def.instrument}.${item.key}`;
  }
}

// ---------------------------------------------------------------------------
// Adding a piece to a draft
// ---------------------------------------------------------------------------

export type InsertTarget =
  /** Into a section: after a question in it, or at its end. */
  | { sectionKey: string; afterItemKey?: string | null }
  /** As a new section, before MyStory (and never before the consent module). */
  | { newSection: { title: string; index?: number | null } };

export interface InsertOptions {
  /** Every question ID and variable this survey has ever published. */
  reserved?: ReservedIds;
  by: string;
  byEmail: string;
  /** ISO. */
  at: string;
  /** Required to add a consent or identity module: why (at least MIN_UNLOCK_REASON characters). */
  protectedReason?: string | null;
  /** For tests; random otherwise. */
  importId?: string;
}

export interface InsertReport {
  importId: string;
  /** Question IDs added to the draft, in order. */
  added: string[];
  /** Source question IDs not added because the draft already has them, unchanged. */
  alreadyThere: string[];
  renamed: { from: string; to: string }[];
  variablesRenamed: { itemKey: string; from: string; to: string }[];
  scalesRenamed: { from: string; to: string }[];
  /** Conditions removed because they test a question the draft does not ask. */
  conditionsRemoved: { itemKey: string | null; block: string | null; reason: string }[];
  /** Protected modules unlocked, with the reason given, to add them. */
  unlocked: string[];
  /** The section the piece went into; empty when nothing was added and no new section was needed. */
  sectionKey: string;
}

/** `imp_` and 16 random letters and digits. */
function newImportId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(16);
  const web = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (web.crypto?.getRandomValues) web.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `imp_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/** Refuse a piece that is not one, before anything in it is trusted. */
function checkFragment(fragment: StudioFragment): void {
  const bad = (why: string) => new StudioOpError(`That piece can't be added: ${why}`, "invalid");
  if (!isObject(fragment) || fragment.format !== FRAGMENT_FORMAT) throw bad("it is not in the library's format.");
  if (fragment.formatVersion !== FRAGMENT_FORMAT_VERSION) throw bad(`it was saved in format ${String(fragment.formatVersion)}, which this version of the Studio cannot read.`);
  if (!Array.isArray(fragment.blocks) || fragment.blocks.length === 0) throw bad("it holds no questions.");
  for (const block of fragment.blocks) {
    const def = block?.definition as unknown;
    if (!isObject(block) || typeof block.refKey !== "string" || !isObject(def) || typeof def["instrument"] !== "string") throw bad("one of its blocks is malformed.");
    const items = itemsOfForm(def);
    if (items.length === 0 || items.some((i) => !isObject(i) || typeof i.key !== "string" || typeof i.variable !== "string")) {
      throw bad(`the block “${block.refKey}” has no questions, or a question without an ID or variable.`);
    }
  }
}

/** What adding a piece did, before it is written into the draft's provenance. */
interface Inserted {
  d: StudioDraft;
  report: InsertReport;
  /** Null when nothing was added. */
  record: ImportRecord | null;
}

/**
 * The work of `insertFragment` on a draft the caller owns (it is changed in
 * place, and a new section may replace it, so use the returned one). Kept
 * apart so that `updateFromModule` can add a newer version's questions by the
 * same rules and merge them into the copy's existing record.
 */
function insertInto(input: StudioDraft, fragment: StudioFragment, target: InsertTarget, opts: InsertOptions, importId: string): Inserted {
  checkFragment(fragment);
  let d = input;
  const reserved = opts.reserved;
  const report: InsertReport = {
    importId,
    added: [],
    alreadyThere: [],
    renamed: [],
    variablesRenamed: [],
    scalesRenamed: [],
    conditionsRemoved: [],
    unlocked: [],
    sectionKey: "",
  };
  const pieceScales = fragment.scales ?? {};
  const pieceScoring = fragment.scoring ?? {};

  // A consent or identity module may be copied only with a reason (§12.2),
  // asked for only when something of it would actually be added.
  const needsReason: string[] = [];
  for (const block of fragment.blocks) {
    const instrument = block.definition.instrument;
    if (!protectedModule(instrument) || needsReason.includes(instrument)) continue;
    const adds = itemsOfForm(block.definition).some((item) => {
      const there = findQuestion(d, `${instrument}.${item.key}`);
      return !there || questionContent(there.item, d.scales) !== questionContent(item, pieceScales);
    });
    if (adds) needsReason.push(instrument);
  }
  if (needsReason.length > 0) {
    const reason = opts.protectedReason?.trim() ?? "";
    if (reason.length < MIN_UNLOCK_REASON) {
      const names = needsReason.map((i) => `“${nameOf(fragment.blocks.find((b) => b.definition.instrument === i)?.definition, i)}”`);
      const ethics = needsReason.some((i) => protectedModule(i)?.reason === "ethics");
      throw new StudioOpError(
        `To add ${joinAnd(names)}, say in a sentence why ${
          ethics ? "using this consent wording is covered by this study's ethics approval" : "this is safe for participant linkage"
        } (at least ${MIN_UNLOCK_REASON} characters). ${
          ethics ? "Consent wording is approved for one study, so using it in another is a decision someone must own." : ""
        } The reason is kept with the survey's history.`.replace(/\s+/g, " ").trim(),
        "protected",
      );
    }
    for (const instrument of needsReason) {
      if (isUnlocked(d, instrument)) continue;
      d.unlocked[instrument] = { instrument, by: opts.by, at: opts.at, reason };
      report.unlocked.push(instrument);
    }
  }

  // Where it goes.
  let sectionKey: string;
  if ("newSection" in target) {
    const title = target.newSection.title?.trim() || fragment.section?.title?.trim() || fragment.title?.trim() || "Copied questions";
    const index = target.newSection.index;
    const made = addSection(d, index == null ? { title } : { title, index });
    d = made.draft;
    sectionKey = made.sectionKey;
  } else {
    sectionKey = target.sectionKey;
  }
  const sectionIndex = sectionIndexOf(d, sectionKey);
  const section = () => d.composition.sections[sectionIndexOf(d, sectionKey)]!;
  if (isMyStorySection(section())) {
    throw new StudioOpError("MyStory's section holds only the MyStory conversation. Put it in another section instead.", "invalid");
  }
  report.sectionKey = sectionKey;

  /** The block a question placed next would follow, and the question it would follow in it; null for the end of the section. */
  let cursor: { component: PlacedComponent; afterKey: string | null } | null = null;
  if (!("newSection" in target) && target.afterItemKey) {
    const after = live(d, target.afterItemKey);
    const at = after.placements.find((p) => p.sectionIndex === sectionIndex);
    if (!at) throw new StudioOpError(`${quoted(after.item)} is not in the section “${section().title}”.`, "invalid");
    cursor = { component: componentAt(d, at.sectionIndex, at.componentIndex), afterKey: after.key };
  }

  /** Put a new component where the cursor says: straight after its block, or at the end of the section. */
  const insertComponent = (component: PlacedComponent) => {
    const comps = section().components;
    const at = cursor ? comps.indexOf(cursor.component) : -1;
    comps.splice(at >= 0 ? at + 1 : comps.length, 0, component);
  };
  const isOf = (c: unknown, refKey: string): c is PlacedComponent => isObject(c) && isPlaced(c as PlacedComponent) && componentRefKey(c as PlacedComponent) === refKey;

  /**
   * The block a question of `refKey` joins, and where in it, for the first
   * question of a piece's block. Mirrors `addQuestion`: next to a question of
   * the same instrument it joins that block; after another block, the next
   * block if it is one of the same instrument, else a new block straight after;
   * at the end of a section, the last block if it is one of the same
   * instrument, else a new block at the end. A block with a display condition
   * of its own never joins (or is joined by) another: its questions would take
   * on a condition they did not have.
   */
  const chooseComponent = (refKey: string, ownCondition: boolean): { component: PlacedComponent; where: Where } => {
    const comps = section().components;
    if (!ownCondition) {
      if (cursor && cursor.afterKey && isOf(cursor.component, refKey)) return { component: cursor.component, where: { after: cursor.afterKey } };
      if (cursor) {
        const next = comps[comps.indexOf(cursor.component) + 1];
        if (isOf(next, refKey) && next.displayIf == null) return { component: next, where: "start" };
      } else {
        const last = comps[comps.length - 1];
        if (isOf(last, refKey) && last.displayIf == null) return { component: last, where: "end" };
      }
    }
    const component = newPlacement(d.instruments[refKey]!, null, []);
    insertComponent(component);
    return { component, where: "end" };
  };

  const renamedIds = new Map<string, string>();
  const items: Record<string, string> = {};
  const variablesRenamed: Record<string, string> = {};
  const scaleMap = new Map<string, string>();
  const newComponents: { component: PlacedComponent; name: string }[] = [];

  /** The key a copied question's option list is filed under here (§12.3 rule 5). */
  const scaleFor = (fromKey: string, instrument: string, key: string, validated: boolean, name: string): string => {
    const done = scaleMap.get(fromKey);
    if (done) return done;
    const piece = own(pieceScales, fromKey);
    if (!piece) {
      // The piece lacks it: left for validation to report, which says what to do.
      scaleMap.set(fromKey, fromKey);
      return fromKey;
    }
    const have = own(d.scales, fromKey);
    const retired = (own(d.retiredCodes, fromKey) ?? []).length > 0;
    if (have ? sameScale(have, piece) : !retired) {
      if (!have) d.scales[fromKey] = structuredClone(piece);
      scaleMap.set(fromKey, fromKey);
      return fromKey;
    }
    if (validated) {
      throw new StudioOpError(
        `“${name}” can't be added: this survey already has a different list of answer options under its options' name (${fromKey}), and a validated questionnaire must use its licensed options exactly.`,
        "locked",
      );
    }
    const to = generateScaleKey(instrument, key, takenScaleKeys(d));
    d.scales[to] = { ...structuredClone(piece), key: to };
    scaleMap.set(fromKey, to);
    report.scalesRenamed.push({ from: fromKey, to });
    return to;
  };

  /** The scoring a block brings, shared when identical and refused when different (§12.3 rule 6). */
  const bringScoring = (def: InstrumentOrModule, name: string, validated: boolean) => {
    const key = (def as { scoringKey?: unknown }).scoringKey;
    if (typeof key !== "string") return;
    const piece = own(pieceScoring, key);
    if (!piece) {
      if (validated) throw new StudioOpError(`“${name}” can't be added: its scoring (${key}) is missing from the piece. Add it again from the library.`, "locked");
      return;
    }
    const have = own(d.scoring, key);
    if (!have) d.scoring[key] = structuredClone(piece);
    else if (!sameScoring(have, piece)) {
      throw new StudioOpError(
        `“${name}” can't be added: this survey already has different scoring under the same name (${key}). Two sets of scoring rules can't share one name, or scores would be computed from the wrong ones.`,
        "invalid",
      );
    }
  };

  /** The variables a copy may not take: the draft's, and everything published except this same question's own. */
  const takenVariablesFor = (sourceId: string, variable: string, sameQuestion: boolean): Set<string> => {
    const taken = allVariables(d);
    for (const v of reserved?.variables ?? []) {
      if (sameQuestion && v === variable && reserved?.variablesByItem?.get(sourceId)?.has(v)) continue;
      taken.add(v);
    }
    return taken;
  };

  /** A published ID is the same question coming back when it was published with this variable (§12.3 rule 3). */
  const reservedClash = (sourceId: string, variable: string): boolean =>
    !!reserved?.itemKeys.has(sourceId) && !reserved.variablesByItem?.get(sourceId)?.has(variable);

  for (const block of fragment.blocks) {
    const def = block.definition;
    const instrument = def.instrument;
    const name = nameOf(def, instrument);
    const blockItems = itemsOfForm(def);
    const ownCondition = block.displayIf != null;
    // Filed under the reference its own definition makes, whatever the piece
    // says: a placement built from the definition must find it.
    const defRefKey = componentRefKey(newPlacement(def, null, null));

    if (isLockedDef(def)) {
      // A validated questionnaire: whole, unchanged, one version per survey (§12.3 rule 4).
      const existing = instrumentDef(d, instrument);
      if (existing && existing.refKey !== defRefKey) {
        const was = existing.def.version;
        throw new StudioOpError(
          `“${name}” can't be added: this survey already uses ${nameOf(existing.def, instrument)} ${was === def.version ? `(${existing.refKey})` : was}. ` +
            `A survey holds one version of a validated questionnaire, so every participant's scores mean the same thing. ` +
            `Remove the one it has first if this survey should use ${def.version === was ? "this form" : `version ${def.version}`} instead.`,
          "locked",
        );
      }
      if (existing) {
        const sameScales = blockItems.every((i) => !("scale" in i) || sameScale(own(d.scales, i.scale), own(pieceScales, i.scale)));
        const scoringKey = (def as { scoringKey?: unknown }).scoringKey;
        const sameScore = typeof scoringKey !== "string" || sameScoring(own(d.scoring, scoringKey), own(pieceScoring, scoringKey));
        if (lockedFingerprint(existing.def) !== lockedFingerprint(def) || !sameScales || !sameScore) {
          throw new StudioOpError(
            `“${name}” can't be added: this survey already has it, and its copy differs from this one. A survey holds one copy of a validated questionnaire.`,
            "locked",
          );
        }
        for (const item of blockItems) report.alreadyThere.push(`${instrument}.${item.key}`);
        continue;
      }
      if (d.archived.some((a) => splitItemKey(a.itemKey).instrument === instrument)) {
        throw new StudioOpError(
          `“${name}” can't be added: this survey has it in its archive. Restore it from the archive instead, which brings it back whole with its history.`,
          "locked",
        );
      }
      for (const item of blockItems) {
        const id = `${instrument}.${item.key}`;
        if (reservedClash(id, item.variable) || takenVariablesFor(id, item.variable, true).has(item.variable)) {
          throw new StudioOpError(
            `“${name}” can't be added: ${reservedClash(id, item.variable) ? `its question ID ${id}` : `its variable “${item.variable}”`} is already used by a different question in this survey, now or in a published version. ` +
              `A validated questionnaire keeps its own IDs and variables, so it can't be renamed to fit.`,
            "locked",
          );
        }
      }
      for (const item of blockItems) if ("scale" in item) scaleFor(item.scale, instrument, item.key, true, name);
      bringScoring(def, name, true);
      d.instruments[defRefKey] = structuredClone(def);
      const component = newPlacement(def, null, null);
      if (ownCondition) component.displayIf = structuredClone(block.displayIf) as PlacedComponent["displayIf"];
      insertComponent(component);
      newComponents.push({ component, name });
      for (const item of blockItems) {
        const id = `${instrument}.${item.key}`;
        items[id] = id;
        report.added.push(id);
      }
      cursor = { component, afterKey: blockItems[blockItems.length - 1]?.key ?? null };
      continue;
    }

    // An editable block (or a consent or identity module, unlocked above): question by question.
    const existing = instrumentDef(d, instrument);
    if (existing && isLockedDef(existing.def)) {
      throw new StudioOpError(
        `“${name}” can't be added: this survey's “${nameOf(existing.def, instrument)}” is a licensed, validated questionnaire under the same name, and questions can't be added to one.`,
        "locked",
      );
    }
    const refKey = existing?.refKey ?? defRefKey;
    let component: PlacedComponent | null = null;
    let prev: string | null = null;

    for (const item of blockItems) {
      const sourceId = `${instrument}.${item.key}`;
      const there = findQuestion(d, sourceId);
      if (there && questionContent(there.item, d.scales) === questionContent(item, pieceScales)) {
        report.alreadyThere.push(sourceId);
        continue;
      }
      const archived = d.archived.find((a) => a.itemKey === sourceId);
      // The same question sitting in the archive comes back as this copy, keeping its ID and data.
      const comesBack = !there && !!archived && questionContent(archived.item, d.scales) === questionContent(item, pieceScales);
      if (comesBack) d.archived = d.archived.filter((a) => a !== archived);
      const clash = !!there || (!!archived && !comesBack) || reservedClash(sourceId, item.variable);
      const copy = structuredClone(item) as ItemDefinition & Loose;
      let key = item.key;
      if (clash) {
        if (identityRoleOf(sourceId, item)) {
          throw new StudioOpError(
            `${quoted(item)} can't be added: its ID ${sourceId} is already used by a different question here, and it is one the identity pipeline reads by ID or variable, so it can't be renamed.`,
            "linkage",
          );
        }
        key = uniqueSlug(item.key, takenKeys(d, instrument, reserved), 64);
        copy.key = key;
        copy.revision = 1;
        delete copy.legacyVariable;
        renamedIds.set(sourceId, `${instrument}.${key}`);
        report.renamed.push({ from: sourceId, to: `${instrument}.${key}` });
      }
      const newId = `${instrument}.${key}`;
      const taken = takenVariablesFor(sourceId, item.variable, !clash);
      if (taken.has(copy.variable)) {
        if (identityRoleOf(sourceId, item)) {
          throw new StudioOpError(
            `${quoted(item)} can't be added: its variable “${item.variable}” is already used here, and the identity pipeline reads it by that name, so it can't be renamed.`,
            "linkage",
          );
        }
        const variable = generateVariable(copy.variable, taken);
        report.variablesRenamed.push({ itemKey: newId, from: copy.variable, to: variable });
        variablesRenamed[item.variable] = variable;
        copy.variable = variable;
        delete copy.legacyVariable;
      }
      if ("scale" in copy && typeof copy.scale === "string") {
        const scaleKey = scaleFor(copy.scale, instrument, key, false, name);
        if (scaleKey !== copy.scale) {
          copy.scale = scaleKey;
          copy.scaleVersion = d.scales[scaleKey]!.version;
        }
      }
      let where: Where;
      if (!d.instruments[refKey]) {
        // The instrument comes with the piece, holding just the questions copied.
        const shell = structuredClone(def) as InstrumentOrModule;
        (shell.forms[0] as { items: unknown[] }).items = [];
        if (shell.forms.length > 1) shell.forms.splice(1);
        d.instruments[refKey] = shell;
        bringScoring(def, name, false);
        component = newPlacement(shell, null, null);
        if (ownCondition) component.displayIf = structuredClone(block.displayIf) as PlacedComponent["displayIf"];
        insertComponent(component);
        newComponents.push({ component, name });
        where = "end";
      } else if (!component) {
        const chosen = chooseComponent(refKey, ownCondition);
        component = chosen.component;
        where = chosen.where;
        if (ownCondition) {
          component.displayIf = structuredClone(block.displayIf) as PlacedComponent["displayIf"];
          newComponents.push({ component, name });
        }
      } else {
        where = { after: prev! };
      }
      placeNewItem(d, refKey, copy, component, where);
      prev = key;
      items[newId] = sourceId;
      report.added.push(newId);
    }
    if (component && prev) cursor = { component, afterKey: prev };
  }

  // Display conditions (§12.3 rule 7): follow renamed questions, then keep
  // each only when everything it tests is asked once the piece is in.
  const asked = new Set(liveQuestions(d).map((q) => q.itemKey));
  for (const newId of report.added) {
    const q = findQuestion(d, newId);
    if (!q) continue;
    rewriteRefs(q.item, renamedIds);
    if (q.item.displayIf == null) continue;
    const missing = targetsOf(q.item.displayIf).filter((t) => !asked.has(t));
    if (missing.length > 0) {
      delete (q.item as Loose)["displayIf"];
      report.conditionsRemoved.push({ itemKey: newId, block: null, reason: missingPhrase(missing) });
    }
  }
  for (const { component, name } of newComponents) {
    if (component.displayIf == null) continue;
    rewriteRefs(component.displayIf, renamedIds);
    const missing = targetsOf(component.displayIf).filter((t) => !asked.has(t));
    if (missing.length > 0) {
      delete component.displayIf;
      report.conditionsRemoved.push({ itemKey: null, block: name, reason: missingPhrase(missing) });
    }
  }

  // Files the questions need (§12.3 rule 8): carried, shared when the same pin, refused when not.
  for (const newId of report.added) {
    const q = findQuestion(d, newId);
    for (const key of assetKeysOf(q?.item)) {
      const piece = own(fragment.assets, key);
      if (!piece) continue;
      const have = own(d.assets, key);
      if (!have) (d.assets ??= {})[key] = structuredClone(piece);
      else if (canonicalJson(have) !== canonicalJson(piece)) {
        throw new StudioOpError(
          `${quoted(q!.item)} can't be added: it needs the file “${key}”, and this survey already carries a different version of it (${have.path}). ` +
            `A survey can carry one version of a file; ask whoever manages the survey's files which should be used.`,
          "invalid",
        );
      }
    }
  }

  // A new section made for a piece that added nothing would be left empty, which no survey can publish.
  if ("newSection" in target && report.added.length === 0) {
    const index = d.composition.sections.findIndex((s) => s.key === sectionKey);
    if (index >= 0 && d.composition.sections[index]!.components.length === 0) {
      d.composition.sections.splice(index, 1);
      report.sectionKey = "";
    }
  }

  const renamed: Record<string, string> = Object.fromEntries(renamedIds);
  const record: ImportRecord | null =
    report.added.length === 0
      ? null
      : {
          id: importId,
          at: opts.at,
          by: opts.by,
          byEmail: opts.byEmail,
          origin: structuredClone(fragment.origin),
          items,
          ...(Object.keys(renamed).length > 0 ? { renamed } : {}),
          ...(Object.keys(variablesRenamed).length > 0 ? { variablesRenamed } : {}),
        };
  return { d, report, record };
}

/**
 * Add a piece to a draft by the rules of docs/16 §12.3: IDs and variables
 * kept, renamed only on a clash; already-there questions skipped; option
 * lists shared, added or renamed; conditions kept only when they still test
 * something; files carried; provenance recorded in `draft.imports`.
 *
 * Placement mirrors adding a question by hand: after the question named, in
 * its block when it is of the same instrument, otherwise in a block straight
 * after; at the end of a section; or in a new section (before MyStory). A
 * validated questionnaire always goes in as a block of its own. Nothing may end
 * up before the consent module or after MyStory.
 *
 * Throws StudioOpError for what cannot be done: a second version of a
 * validated questionnaire, a licensed option list or scoring that differs, a
 * protected module without a reason, a section that does not exist.
 */
export function insertFragment(
  draft: StudioDraft,
  fragment: StudioFragment,
  target: InsertTarget,
  opts: InsertOptions,
): { draft: StudioDraft; report: InsertReport } {
  const importId = opts.importId ?? newImportId();
  const { d, report, record } = insertInto(clone(draft), fragment, target, opts, importId);
  if (record) d.imports = [...(d.imports ?? []), record];
  keepConsentFirst(draft, d, "add this there");
  keepMyStoryLast(draft, d, "add this there");
  return { draft: d, report };
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function arrows(pairs: { from: string; to: string }[]): string {
  return joinAnd(pairs.map((p) => `${p.from} → ${p.to}`));
}

/** A one-paragraph summary of an insert for the editor's toast, in plain words. */
export function describeInsert(report: InsertReport): string {
  const parts: string[] = [];
  if (report.added.length === 0) {
    parts.push(
      report.alreadyThere.length > 0
        ? "Nothing was added: this survey already has every one of these questions, unchanged."
        : "Nothing was added.",
    );
  } else {
    parts.push(`Added ${count(report.added.length, "question")}.`);
    if (report.alreadyThere.length > 0) {
      parts.push(`${count(report.alreadyThere.length, "other was", "others were")} already in the survey, unchanged, so ${report.alreadyThere.length === 1 ? "it was" : "they were"} not added again.`);
    }
  }
  if (report.unlocked.length > 0) {
    parts.push(`${joinAnd(report.unlocked)} ${report.unlocked.length === 1 ? "was" : "were"} unlocked with the reason you gave, which is kept with the survey's history.`);
  }
  if (report.renamed.length > 0) {
    parts.push(
      `${count(report.renamed.length, "question ID was", "question IDs were")} already used here for something else, so ${report.renamed.length === 1 ? "the copy has" : "the copies have"} a new ID: ${arrows(report.renamed)}. ` +
        `${report.renamed.length === 1 ? "Its" : "Their"} data will not line up with the original's.`,
    );
  }
  if (report.variablesRenamed.length > 0) {
    parts.push(
      `${count(report.variablesRenamed.length, "variable name was", "variable names were")} already taken, so ${report.variablesRenamed.length === 1 ? "it was" : "they were"} renamed: ${arrows(report.variablesRenamed)}. ` +
        `${report.variablesRenamed.length === 1 ? "That column" : "Those columns"} will not pool with the original's in the data.`,
    );
  }
  if (report.scalesRenamed.length > 0) {
    parts.push(
      `This survey already had different answer options under the same name, so the copied ones were added as their own list: ${arrows(report.scalesRenamed)}.`,
    );
  }
  for (const c of report.conditionsRemoved) {
    const whose = c.itemKey ? `The display condition on ${c.itemKey}` : `The display condition on the block “${c.block ?? ""}”`;
    const what = c.itemKey ? "the question" : "the block";
    parts.push(
      `${whose} was removed. ${c.reason} A condition about a question the survey does not ask would hide ${what} from everyone, or from no-one, so ${what} is now shown to everyone: check whether it needs a new condition.`,
    );
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Vouchers: why a copied questionnaire is the licensed one (docs/16 §12.4)
// ---------------------------------------------------------------------------

/**
 * The releases a draft names as sources, deduplicated, at most
 * MAX_IMPORTED_RELEASES (the rest are reported). Only records whose questions
 * the draft still holds count: a release nothing is left from vouches for
 * nothing, and reading it would only use up the cap.
 */
export function importedReleases(draft: StudioDraft): { releases: { study: string; hash: string }[]; overLimit: number } {
  const seen = new Set<string>();
  const all: { study: string; hash: string }[] = [];
  const held = new Set<string>();
  for (const def of Object.values(draft.instruments ?? {})) {
    for (const item of itemsOfForm(def)) held.add(`${def.instrument}.${item.key}`);
  }
  for (const record of Array.isArray(draft.imports) ? draft.imports : []) {
    const origin = record?.origin as Loose | undefined;
    if (!isObject(origin) || origin["kind"] !== "release") continue;
    const study = origin["study"];
    const hash = origin["hash"];
    if (typeof study !== "string" || typeof hash !== "string") continue;
    if (!Object.keys(isObject(record.items) ? record.items : {}).some((id) => held.has(id))) continue;
    const key = `${study}\u0000${hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push({ study, hash });
  }
  return { releases: all.slice(0, MAX_IMPORTED_RELEASES), overLimit: Math.max(0, all.length - MAX_IMPORTED_RELEASES) };
}

interface Voucher {
  def: InstrumentOrModule;
  scales: Record<string, ScaleInput>;
  scoring: Record<string, ScoringInput>;
}

function voucherFor(def: InstrumentOrModule, scales: Record<string, ScaleInput>, scoring: Record<string, ScoringInput>): Voucher {
  const v: Voucher = { def, scales: {}, scoring: {} };
  for (const item of itemsOfForm(def)) {
    if ("scale" in item && typeof item.scale === "string") {
      const scale = own(scales, item.scale);
      if (scale) v.scales[item.scale] = scale;
    }
  }
  const key = (def as { scoringKey?: unknown }).scoringKey;
  if (typeof key === "string") {
    const sd = own(scoring, key);
    if (sd) v.scoring[key] = sd;
  }
  return v;
}

/** Whether a voucher vouches for the draft's copy at `refKey`: definition, options and scoring all as it froze them. */
function vouchesFor(v: Voucher, draft: StudioDraft, refKey: string): boolean {
  const def = own(draft.instruments, refKey);
  if (!def || lockedFingerprint(def) !== lockedFingerprint(v.def)) return false;
  for (const item of itemsOfForm(v.def)) {
    if ("scale" in item && typeof item.scale === "string" && !sameScale(own(draft.scales, item.scale), own(v.scales, item.scale))) return false;
  }
  const key = (v.def as { scoringKey?: unknown }).scoringKey;
  return typeof key !== "string" || sameScoring(own(draft.scoring, key), own(v.scoring, key));
}

/**
 * The reference definitions locked content may match, as `validateDraft`'s
 * `reference`, `referenceScales` and `referenceScoring`: the validated
 * questionnaires (when `library` is true) and the locked instruments of the
 * given releases (each already verified against its hash, as drafts).
 *
 * The library and a release may freeze the same reference differently (a
 * release is frozen; the library moves on), and the options are one flat list
 * per kind. Given `draft`, each reference is filled from a source that vouches
 * for the draft's copy whole — definition, answer options and scoring together
 * — so a copy taken from an older release is matched against that release, and
 * options can never be borrowed from one source to pass a definition from
 * another; releases are then consulted only for instruments the draft has.
 * Without it, the library comes first, then the releases in order.
 */
export function lockVouchers(sources: { releases: StudioDraft[]; library: boolean; draft?: StudioDraft | null }): Required<LockedOptions> {
  const draft = sources.draft ?? null;
  const instrumentsInDraft = draft ? new Set(Object.values(draft.instruments ?? {}).map((d) => d.instrument)) : null;
  const candidates = new Map<string, Voucher[]>();
  const add = (refKey: string, v: Voucher) => {
    const list = candidates.get(refKey) ?? [];
    list.push(v);
    candidates.set(refKey, list);
  };
  if (sources.library) {
    const scales = Object.fromEntries(libraryScales());
    const scoring = Object.fromEntries(libraryScoring());
    for (const { def, form, refKey } of libraryForms().values()) {
      if (!licenceLocked(def)) continue;
      add(refKey, voucherFor({ ...def, forms: [form] } as unknown as InstrumentOrModule, scales, scoring));
    }
  }
  for (const release of sources.releases) {
    for (const [refKey, def] of Object.entries(release.instruments ?? {})) {
      if (!licenceLocked(def)) continue;
      if (instrumentsInDraft && !instrumentsInDraft.has(def.instrument)) continue;
      add(refKey, voucherFor(def, release.scales ?? {}, release.scoring ?? {}));
    }
  }

  const reference: Record<string, InstrumentOrModule> = {};
  const referenceScales: Record<string, ScaleInput> = {};
  const referenceScoring: Record<string, ScoringInput> = {};
  const chosen: Voucher[] = [];
  for (const [refKey, list] of candidates) {
    const pick = (draft && list.find((v) => vouchesFor(v, draft, refKey))) || list[0]!;
    reference[refKey] = pick.def;
    chosen.push(pick);
  }
  // Options and scoring from the chosen sources first, so each accepted
  // instrument is checked against its own; then whatever else is known.
  const fill = <T>(into: Record<string, T>, from: Record<string, T>, current: Record<string, T> | undefined, same: (a: unknown, b: unknown) => boolean) => {
    for (const [key, value] of Object.entries(from)) {
      if (!(key in into)) into[key] = value;
      else if (current && own(current, key) !== undefined && !same(into[key], own(current, key)) && same(value, own(current, key))) into[key] = value;
    }
  };
  for (const v of chosen) {
    fill(referenceScales, v.scales, draft?.scales, sameScale);
    fill(referenceScoring, v.scoring, draft?.scoring, sameScoring);
  }
  for (const list of candidates.values()) {
    for (const v of list) {
      fill(referenceScales, v.scales, undefined, sameScale);
      fill(referenceScoring, v.scoring, undefined, sameScoring);
    }
  }
  return { reference, referenceScales, referenceScoring };
}

/**
 * The licence the instrument library now records for an instrument whose
 * draft copy is still locked, when the library says its wording may be
 * modified (D-61); null otherwise. The editor offers to take it up.
 */
export function libraryLicenceUpdate(draft: StudioDraft, instrument: string): InstrumentOrModule["licence"] | null {
  if (!openInLibrary(instrument)) return null;
  const copies = Object.values(draft.instruments ?? {}).filter((d) => d.instrument === instrument);
  if (copies.length === 0 || copies.every((d) => d.licence.modifiable === "yes")) return null;
  for (const { def } of libraryForms().values()) if (def.instrument === instrument) return def.licence as InstrumentOrModule["licence"];
  return null;
}

/**
 * Bring the draft's copies of an instrument up to the licence the library now
 * records for it (D-61), so its wording can be edited. Only a licence the
 * library itself marks as modifiable can be taken up this way.
 */
export function adoptLibraryLicence(draft: StudioDraft, instrument: string): { draft: StudioDraft } {
  const licence = libraryLicenceUpdate(draft, instrument);
  if (!licence) throw new StudioOpError(`The instrument library doesn't list “${instrument}” as one whose wording may be changed.`, "locked");
  const d = clone(draft);
  for (const def of Object.values(d.instruments)) if (def.instrument === instrument) def.licence = structuredClone(licence);
  return { draft: d };
}

// ---------------------------------------------------------------------------
// Saved modules (docs/16 §12.6)
// ---------------------------------------------------------------------------

function pieceIssue(code: string, message: string, location: IssueLocation, hint?: string): Issue {
  return hint ? { severity: "error", code, message, hint, location } : { severity: "error", code, message, location };
}

/** Why a piece cannot be saved as a module (locked or protected content, too large, malformed); empty when it can. */
export function moduleProblems(fragment: StudioFragment): Issue[] {
  const out: Issue[] = [];
  const survey: IssueLocation = { kind: "survey" };
  if (!isObject(fragment) || fragment.format !== FRAGMENT_FORMAT || fragment.formatVersion !== FRAGMENT_FORMAT_VERSION) {
    return [pieceIssue("piece.malformed", "Not a piece the library can hold", survey, "Choose the block again and save it from the editor.")];
  }
  if (typeof fragment.title !== "string" || !fragment.title.trim()) out.push(pieceIssue("piece.malformed", "The piece has no name", survey));
  if (!Array.isArray(fragment.blocks) || fragment.blocks.length === 0) {
    return [...out, pieceIssue("piece.empty", "There are no questions to save", survey, "Choose at least one question.")];
  }
  if (!isObject(fragment.scales ?? {}) || !isObject(fragment.scoring ?? {})) out.push(pieceIssue("piece.malformed", "The piece's answer options or scoring are malformed", survey));

  const ids = new Set<string>();
  for (const block of fragment.blocks) {
    const def = block?.definition as unknown;
    if (!isObject(block) || !isObject(def) || typeof def["instrument"] !== "string" || typeof block.refKey !== "string") {
      out.push(pieceIssue("piece.malformed", "One of the blocks is malformed", survey));
      continue;
    }
    for (const item of itemsOfForm(def)) if (isObject(item)) ids.add(`${def["instrument"]}.${String(item["key"])}`);
  }

  for (const block of fragment.blocks) {
    const def = block?.definition as unknown;
    if (!isObject(block) || !isObject(def) || typeof def["instrument"] !== "string") continue;
    const instrument = def["instrument"];
    const name = nameOf(def, instrument);
    const at: IssueLocation = { kind: "block", refKey: block.refKey };
    // A licensed questionnaire, edited or not, may be saved as the library's
    // own copy (a variant), to be used again in other surveys.
    if (protectedModule(instrument)) {
      out.push(
        pieceIssue(
          "piece.protected",
          "The consent and identity modules can't be saved as a module",
          at,
          `${protectedWhy(instrument, name)}. They belong to their study; another survey copies them from a published version, with the reason recorded.`,
        ),
      );
      continue;
    }
    const schema = def["kind"] === "module" ? moduleDefinition : instrumentVersion;
    const parsed = schema.safeParse(def);
    if (!parsed.success) {
      for (const zi of parsed.error.issues.slice(0, 5)) {
        out.push(pieceIssue("piece.schema", "Not in a form the survey app can use", at, `${zi.path.join(".") || "definition"}: ${zi.message}.`));
      }
    } else {
      const expected = (() => {
        const form = (parsed.data as InstrumentVersion).forms[0]!;
        return refKeyOf({
          instrument,
          version: String(def["version"]),
          variant: form.variant,
          language: form.language,
          informant: form.informant,
          readingLevel: form.readingLevel,
        });
      })();
      if (expected !== block.refKey) out.push(pieceIssue("piece.malformed", "A block is filed under the wrong name", at, `It says ${block.refKey}, but its definition is ${expected}.`));
      if ((def["forms"] as unknown[]).length !== 1) out.push(pieceIssue("piece.malformed", "A block carries more than one form", at));
    }
    for (const item of itemsOfForm(def)) {
      if (!isObject(item)) continue;
      const itemKey = `${instrument}.${String(item["key"])}`;
      const q: IssueLocation = { kind: "question", itemKey, refKey: block.refKey };
      if ("scale" in item && typeof item["scale"] === "string") {
        const scale = own(fragment.scales, item["scale"]);
        if (!scale) out.push(pieceIssue("piece.scale_missing", "Its answer options are missing from the piece", q, `The list ${item["scale"]} isn't in the piece.`));
        else if (!responseScale.safeParse(scale).success) out.push(pieceIssue("piece.scale_invalid", "Its answer options are not in a form the survey app can use", q));
      }
      const missing = targetsOf(item["displayIf"]).filter((t) => !ids.has(t));
      if (missing.length > 0) {
        out.push(
          pieceIssue(
            "piece.condition_outside",
            "Its display condition tests a question outside the piece",
            { ...q, field: "displayIf" },
            `${outsidePhrase(missing)} A module has to make sense in whatever survey it is added to: take the condition off, or include the question it tests.`,
          ),
        );
      }
    }
    const missing = targetsOf(block.displayIf).filter((t) => !ids.has(t));
    if (missing.length > 0) {
      out.push(
        pieceIssue(
          "piece.condition_outside",
          "The block's display condition tests a question outside the piece",
          { ...at, field: "displayIf" },
          `${outsidePhrase(missing)} Take the condition off, or include the question it tests.`,
        ),
      );
    }
  }
  if (ids.size !== fragment.blocks.reduce((n, b) => n + itemsOfForm(b?.definition).length, 0)) {
    out.push(pieceIssue("piece.duplicate", "The same question is in the piece twice", survey));
  }
  for (const [key, sd] of Object.entries(isObject(fragment.scoring) ? fragment.scoring : {})) {
    if (!scoringDefinition.safeParse(sd).success) out.push(pieceIssue("piece.scoring_invalid", `The scoring ${key} is not in a form the survey app can use`, survey));
  }
  for (const [key, asset] of Object.entries(isObject(fragment.assets) ? fragment.assets : {})) {
    const a = asset as unknown;
    if (!isObject(a) || typeof a["path"] !== "string" || typeof a["bytes"] !== "number" || typeof a["sha256"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(a["sha256"])) {
      out.push(pieceIssue("piece.asset_invalid", `The file ${key} is not described properly`, survey));
    }
  }
  const size = canonicalJson(fragment).length;
  if (size > MAX_MODULE_CHARS) {
    out.push(
      pieceIssue(
        "piece.too_large",
        "Too large to save as one module",
        survey,
        `It is ${size.toLocaleString("en-GB")} characters; a module can be at most ${MAX_MODULE_CHARS.toLocaleString("en-GB")}. Save it as two or more modules.`,
      ),
    );
  }
  return out;
}

/** The piece as a module version stores it: only the fields a piece has, with the module's own origin. */
function storedPiece(fragment: StudioFragment, module: { moduleId: string; version: number }): StudioFragment {
  return {
    format: FRAGMENT_FORMAT,
    formatVersion: FRAGMENT_FORMAT_VERSION,
    title: fragment.title,
    ...(fragment.section ? { section: { title: fragment.section.title } } : {}),
    blocks: fragment.blocks.map((b) => ({
      refKey: b.refKey,
      definition: structuredClone(b.definition),
      ...(b.displayIf != null ? { displayIf: structuredClone(b.displayIf) } : {}),
    })),
    scales: structuredClone(fragment.scales ?? {}),
    scoring: structuredClone(fragment.scoring ?? {}),
    ...(fragment.assets && Object.keys(fragment.assets).length > 0 ? { assets: structuredClone(fragment.assets) } : {}),
    origin: { kind: "module", moduleId: module.moduleId, version: module.version, contentHash: "" },
  };
}

/** `sha256:<hex>` of text as UTF-8, via WebCrypto (Node 22 and every browser the study supports). */
export async function moduleContentHash(content: string): Promise<string> {
  const web = globalThis as unknown as {
    crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
    TextEncoder?: new () => { encode(input: string): Uint8Array };
  };
  const subtle = web.crypto?.subtle;
  if (!subtle || !web.TextEncoder) throw new Error("WebCrypto is not available here, so a module cannot be hashed");
  const digest = await subtle.digest("SHA-256", new web.TextEncoder().encode(content));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The canonical JSON a module version stores, and its `sha256:` hash.
 *
 * The stored piece's origin is `{ kind: "module", moduleId, version,
 * contentHash: "" }` — the hash cannot be inside what it hashes — and the
 * functions fill `contentHash` in when they hand a version out. Whatever origin
 * the saving editor sent is replaced, so the hash depends only on the content,
 * the module and the version. Only the fields a piece has are kept.
 */
export async function moduleContent(
  fragment: StudioFragment,
  module: { moduleId: string; version: number },
): Promise<{ content: string; contentHash: string }> {
  const content = canonicalJson(storedPiece(fragment, module));
  return { content, contentHash: await moduleContentHash(content) };
}

/** How many questions a piece holds. */
export function questionCount(fragment: StudioFragment): number {
  const ids = new Set<string>();
  for (const block of Array.isArray(fragment?.blocks) ? fragment.blocks : []) {
    const instrument = block?.definition?.instrument;
    for (const item of itemsOfForm(block?.definition)) ids.add(`${String(instrument)}.${String(item?.key)}`);
  }
  return ids.size;
}

function moduleOrigin(fragment: StudioFragment, what: string): Extract<FragmentOrigin, { kind: "module" }> {
  const origin = fragment?.origin;
  if (!isObject(origin) || origin.kind !== "module" || typeof origin.moduleId !== "string" || typeof origin.version !== "number") {
    throw new StudioOpError(`${what} is not a version of a saved module.`, "invalid");
  }
  return origin;
}

/**
 * After a block is saved to the library: record in the saving draft that its
 * questions are now that module's version, so a later version of the module
 * gives this survey an update notice too. `fragment` is the saved piece with
 * its module origin (contentHash filled in). An older record of the same
 * module no longer speaks for these questions, so it gives them up.
 */
export function recordSavedModule(
  draft: StudioDraft,
  fragment: StudioFragment,
  opts: { by: string; byEmail: string; at: string; importId?: string },
): { draft: StudioDraft } {
  const origin = moduleOrigin(fragment, "That piece");
  const d = clone(draft);
  const items: Record<string, string> = {};
  for (const block of fragment.blocks) {
    for (const item of itemsOfForm(block.definition)) {
      const id = `${block.definition.instrument}.${item.key}`;
      if (findQuestion(d, id)) items[id] = id;
    }
  }
  if (Object.keys(items).length === 0) return { draft: d };
  const others = (d.imports ?? [])
    .map((r) => {
      if (r.origin.kind !== "module" || r.origin.moduleId !== origin.moduleId) return r;
      const kept = Object.fromEntries(Object.entries(r.items).filter(([id]) => !(id in items)));
      return { ...r, items: kept };
    })
    .filter((r) => Object.keys(r.items).length > 0);
  d.imports = [
    ...others,
    { id: opts.importId ?? newImportId(), at: opts.at, by: opts.by, byEmail: opts.byEmail, origin: structuredClone(origin), items },
  ];
  return { draft: d };
}

/** A module copy with a newer version available and not dismissed. */
export interface PendingModuleUpdate {
  importId: string;
  moduleId: string;
  from: number;
  to: number;
  /** The copied questions still in the draft. */
  itemKeys: string[];
}

/** The module copies in a draft that have a newer version, given each module's latest version. */
export function pendingModuleUpdates(draft: StudioDraft, latest: Record<string, number>): PendingModuleUpdate[] {
  const out: PendingModuleUpdate[] = [];
  for (const record of draft.imports ?? []) {
    if (record.origin.kind !== "module") continue;
    const to = own(latest, record.origin.moduleId);
    if (typeof to !== "number" || to <= record.origin.version || to <= (record.dismissed ?? 0)) continue;
    const itemKeys = Object.keys(record.items).filter((id) => findQuestion(draft, id));
    if (itemKeys.length === 0) continue;
    out.push({ importId: record.id, moduleId: record.origin.moduleId, from: record.origin.version, to, itemKeys });
  }
  return out;
}

export type ModuleUpdateOutcome =
  | "updated"
  | "kept_local"
  | "kept_local_conflict"
  | "archived"
  | "kept_removed_upstream"
  | "added"
  | "unchanged";

export interface ModuleUpdatePlan {
  importId: string;
  moduleId: string;
  from: number;
  to: number;
  changes: { itemKey: string; sourceKey: string; text: string; outcome: ModuleUpdateOutcome; detail: string }[];
}

const OUTCOME_DETAIL: Record<ModuleUpdateOutcome, string> = {
  updated: "Unchanged here since it was copied, and changed in the newer version: takes the newer wording and options.",
  kept_local: "Changed in this survey since it was copied, and the same in the newer version: this survey's is kept.",
  kept_local_conflict:
    "Changed both in this survey and in the newer version: this survey's is kept. Compare the two and copy across anything you want by hand.",
  archived: "Removed from the newer version, and unchanged here: it is archived, so its ID stays reserved and its data readable.",
  kept_removed_upstream: "Removed from the newer version, but changed in this survey: it is kept.",
  added: "New in the newer version: added by the usual rules for copied questions.",
  unchanged: "The same in both versions.",
};

interface SourceQuestion {
  sourceId: string;
  item: ItemDefinition;
  block: FragmentBlock;
}

function sourceQuestions(fragment: StudioFragment): Map<string, SourceQuestion> {
  const out = new Map<string, SourceQuestion>();
  for (const block of fragment.blocks ?? []) {
    for (const item of itemsOfForm(block.definition)) {
      const sourceId = `${block.definition.instrument}.${item.key}`;
      if (!out.has(sourceId)) out.set(sourceId, { sourceId, item, block });
    }
  }
  return out;
}

interface UpdateWork {
  plan: ModuleUpdatePlan;
  record: ImportRecord;
  /** Source ID -> the question it became here. */
  toDraft: Map<string, string>;
  older: Map<string, SourceQuestion>;
  newer: Map<string, SourceQuestion>;
}

/** The three-way comparison behind `planModuleUpdate`, with what applying it needs. */
function moduleUpdateWork(draft: StudioDraft, importId: string, older: StudioFragment, newer: StudioFragment): UpdateWork {
  const record = (draft.imports ?? []).find((r) => r.id === importId);
  if (!record) throw new StudioOpError("That copy is not recorded in this survey any more.", "not_found");
  if (record.origin.kind !== "module") throw new StudioOpError("Only a copy of a saved module can be updated from the library.", "invalid");
  const was = moduleOrigin(older, "The older piece");
  const now = moduleOrigin(newer, "The newer piece");
  if (was.moduleId !== record.origin.moduleId || now.moduleId !== record.origin.moduleId) {
    throw new StudioOpError("Those versions are of a different module from the one this survey copied.", "invalid");
  }
  if (was.version !== record.origin.version) {
    throw new StudioOpError(`This survey's copy is version ${record.origin.version}, not ${was.version}: compare with the version it copied.`, "invalid");
  }
  if (now.version <= was.version) throw new StudioOpError(`Version ${now.version} is not newer than this survey's copy (version ${was.version}).`, "invalid");

  const toDraft = new Map(Object.entries(record.items).map(([id, source]) => [source, id]));
  const toSource = new Map(Object.entries(record.items).filter(([id, source]) => id !== source));
  const olderQs = sourceQuestions(older);
  const newerQs = sourceQuestions(newer);
  const asked = new Set(liveQuestions(draft).map((q) => q.itemKey));
  const plan: ModuleUpdatePlan = { importId, moduleId: record.origin.moduleId, from: was.version, to: now.version, changes: [] };

  /** Whether this survey's copy is still what was copied, setting aside what a copy is given anew and conditions the copy could not keep. */
  const changedHere = (draftItem: ItemDefinition, old: SourceQuestion): boolean => {
    const then = structuredClone(old.item) as ItemDefinition & Loose;
    if (draftItem.displayIf == null && then.displayIf != null) {
      const targets = targetsOf(then.displayIf).map((t) => toDraft.get(t) ?? t);
      if (!targets.every((t) => asked.has(t))) delete then.displayIf;
    }
    return (
      questionContent(draftItem, draft.scales, { withoutIdentity: true, mapRefs: toSource }) !==
      questionContent(then, older.scales, { withoutIdentity: true })
    );
  };
  const changedUpstream = (a: SourceQuestion, b: SourceQuestion): boolean =>
    questionContent(a.item, older.scales, { withoutIdentity: true }) !== questionContent(b.item, newer.scales, { withoutIdentity: true });

  const order = [...newerQs.keys(), ...[...olderQs.keys()].filter((k) => !newerQs.has(k))];
  for (const sourceId of order) {
    const old = olderQs.get(sourceId);
    const next = newerQs.get(sourceId);
    const draftId = toDraft.get(sourceId);
    const here = draftId ? findQuestion(draft, draftId) : null;
    const text = here?.item.stem.text ?? next?.item.stem.text ?? old?.item.stem.text ?? "";
    const change = (outcome: ModuleUpdateOutcome, detail = OUTCOME_DETAIL[outcome]) =>
      plan.changes.push({ itemKey: draftId ?? sourceId, sourceKey: sourceId, text, outcome, detail });
    if (old && next) {
      if (!here) change("unchanged", "No longer in this survey, so left out.");
      else {
        const local = changedHere(here.item, old);
        const upstream = changedUpstream(old, next);
        change(!upstream ? (local ? "kept_local" : "unchanged") : local ? "kept_local_conflict" : "updated");
      }
    } else if (old) {
      if (!here) change("unchanged", "Removed from the newer version, and no longer in this survey.");
      else change(changedHere(here.item, old) ? "kept_removed_upstream" : "archived");
    } else if (next) {
      const there = findQuestion(draft, sourceId);
      if (there && questionContent(there.item, draft.scales) === questionContent(next.item, newer.scales)) {
        change("unchanged", "New in the newer version, and this survey already has it, unchanged.");
      } else change("added");
    }
  }
  return { plan, record, toDraft, older: olderQs, newer: newerQs };
}

/** What updating a module copy would do, question by question, three ways (docs/16 §12.6). Changes nothing. */
export function planModuleUpdate(draft: StudioDraft, importId: string, older: StudioFragment, newer: StudioFragment): ModuleUpdatePlan {
  return moduleUpdateWork(draft, importId, older, newer).plan;
}

/**
 * Apply `planModuleUpdate` as one draft edit; the import record moves to the newer version.
 *
 * A question taking the newer version keeps its ID and variable here — its
 * recorded answers are filed under them — and its place. Its options change in
 * place when no other question uses its list, and otherwise it is given its own
 * list, so a list shared with something else never changes underneath it; a
 * value the newer list drops is retired when the question has been published,
 * so it is never reused. A question the newer version removed is archived, not
 * deleted, so its ID stays reserved. New questions are added by the rules for
 * any copy (§12.3), after the copy's last question.
 */
export function updateFromModule(
  draft: StudioDraft,
  importId: string,
  older: StudioFragment,
  newer: StudioFragment,
  opts: InsertOptions,
): { draft: StudioDraft; plan: ModuleUpdatePlan } {
  const work = moduleUpdateWork(draft, importId, older, newer);
  const { plan, toDraft } = work;
  let d = clone(draft);
  const updating = new Set(plan.changes.filter((c) => c.outcome === "updated").map((c) => c.itemKey));
  const asked = new Set(liveQuestions(d).map((q) => q.itemKey));
  const fromSource = new Map([...toDraft].filter(([source, id]) => source !== id));

  for (const change of plan.changes) {
    if (change.outcome !== "updated") continue;
    const q = findQuestion(d, change.itemKey)!;
    const next = work.newer.get(change.sourceKey)!;
    const renamed = q.key !== splitItemKey(change.sourceKey).key;
    const item = structuredClone(next.item) as ItemDefinition & Loose;
    item.key = q.key;
    item.variable = q.item.variable;
    item.revision = renamed ? q.item.revision + 1 : next.item.revision;
    if (renamed || q.item.variable !== next.item.variable || q.item.legacyVariable === undefined) delete item.legacyVariable;
    rewriteRefs(item, fromSource);
    if (item.displayIf != null && !targetsOf(item.displayIf).every((t) => asked.has(t))) {
      delete item.displayIf;
      change.detail += " Its display condition was left off: it tests a question this survey does not ask.";
    }
    if ("scale" in item && typeof item.scale === "string") {
      let scaleKey: string = item.scale;
      const wanted = own(newer.scales, scaleKey);
      const current = "scale" in q.item ? q.item.scale : null;
      if (wanted && current && sameScale(own(d.scales, current), wanted)) {
        scaleKey = current;
      } else if (wanted && current && own(d.scales, current)) {
        const users = [...scaleUsage(d, current), ...d.archived.filter((a) => "scale" in a.item && a.item.scale === current).map((a) => a.itemKey)];
        if (users.every((u) => updating.has(u))) {
          // Only questions taking this update use the list: it changes in place,
          // so its key, and the published codes checked against it, stay.
          const before = d.scales[current]!;
          d.scales[current] = { ...structuredClone(wanted), key: current };
          if (users.some((u) => opts.reserved?.itemKeys.has(u))) {
            const kept = new Set(wanted.options.map((o) => o.code));
            const retired = (d.retiredCodes[current] ??= []);
            for (const o of before.options) {
              if (!kept.has(o.code) && !retired.some((r) => r.code === o.code)) retired.push({ code: o.code, label: o.label, retiredAt: opts.at });
            }
          }
          scaleKey = current;
        } else {
          // Shared with a question not taking it: this one gets its own list.
          scaleKey = generateScaleKey(q.instrument, q.key, takenScaleKeys(d));
          d.scales[scaleKey] = { ...structuredClone(wanted), key: scaleKey };
          const retired = own(d.retiredCodes, current);
          if (retired && retired.length > 0) d.retiredCodes[scaleKey] = structuredClone(retired);
        }
      } else if (wanted) {
        if (own(d.scales, scaleKey) && !sameScale(own(d.scales, scaleKey), wanted)) scaleKey = generateScaleKey(q.instrument, q.key, takenScaleKeys(d));
        d.scales[scaleKey] = { ...structuredClone(wanted), key: scaleKey };
      }
      item.scale = scaleKey;
      item.scaleVersion = d.scales[scaleKey]?.version ?? item.scaleVersion;
    }
    itemsOf(d.instruments[q.refKey])[q.formItemIndex] = item as ItemDefinition;
  }

  for (const change of plan.changes) {
    if (change.outcome === "archived") d = archiveQuestion(d, change.itemKey, { by: opts.by, at: opts.at }).draft;
  }

  const adding = plan.changes.filter((c) => c.outcome === "added");
  if (adding.length > 0) {
    const wanted = new Set(adding.map((c) => c.sourceKey));
    const blocks: FragmentBlock[] = [];
    for (const block of newer.blocks) {
      const keep = itemsOfForm(block.definition).filter((i) => wanted.has(`${block.definition.instrument}.${i.key}`));
      if (keep.length === 0) continue;
      const form = (block.definition.forms[0] ?? {}) as InstrumentForm;
      blocks.push({ ...structuredClone(block), definition: trimmedDefinition(block.definition, form, keep, newer.scoring ?? {}) });
    }
    // After the copy's last question still asked, in its section; else at the end of the survey's last section.
    const mine = new Set(Object.keys(work.record.items));
    const lastAsked = [...liveQuestions(d)].reverse().find((q) => mine.has(q.itemKey));
    const lastSection = [...d.composition.sections].reverse().find((s) => !isMyStorySection(s));
    const target: InsertTarget = lastAsked
      ? { sectionKey: lastAsked.sectionKey, afterItemKey: lastAsked.itemKey }
      : { sectionKey: lastSection?.key ?? d.composition.sections[0]!.key };
    const inserted = insertInto(d, { ...newer, blocks }, target, { ...opts, protectedReason: null }, importId);
    d = inserted.d;
    for (const change of adding) {
      const to = inserted.record?.renamed?.[change.sourceKey] ?? change.sourceKey;
      if (inserted.report.added.includes(to)) change.itemKey = to;
      else if (inserted.report.alreadyThere.includes(change.sourceKey)) {
        change.outcome = "unchanged";
        change.detail = "New in the newer version, and this survey already has it, unchanged.";
      }
    }
    const record = d.imports!.find((r) => r.id === importId)!;
    if (inserted.record) {
      record.items = { ...record.items, ...inserted.record.items };
      if (inserted.record.renamed) record.renamed = { ...(record.renamed ?? {}), ...inserted.record.renamed };
      if (inserted.record.variablesRenamed) record.variablesRenamed = { ...(record.variablesRenamed ?? {}), ...inserted.record.variablesRenamed };
    }
    for (const c of inserted.report.conditionsRemoved) {
      const change = plan.changes.find((x) => x.itemKey === c.itemKey);
      if (change) change.detail += ` Its display condition was removed: ${c.reason}`;
    }
  }
  const latest = d.imports!.find((r) => r.id === importId)!;
  latest.origin = structuredClone(newer.origin);
  latest.at = opts.at;
  latest.by = opts.by;
  latest.byEmail = opts.byEmail;
  if (latest.dismissed !== undefined && latest.dismissed <= plan.to) delete latest.dismissed;
  keepConsentFirst(draft, d, "update this module there");
  keepMyStoryLast(draft, d, "update this module there");
  return { draft: d, plan };
}

/** "Not now": record that this version of the module was seen and not taken. */
export function dismissModuleUpdate(draft: StudioDraft, importId: string, version: number): { draft: StudioDraft } {
  const d = clone(draft);
  const record = (d.imports ?? []).find((r) => r.id === importId);
  if (!record) throw new StudioOpError("That copy is not recorded in this survey any more.", "not_found");
  if (record.origin.kind !== "module") throw new StudioOpError("Only a copy of a saved module has update notices.", "invalid");
  if (!Number.isInteger(version) || version <= record.origin.version) {
    throw new StudioOpError(`Version ${version} is not newer than this survey's copy (version ${record.origin.version}).`, "invalid");
  }
  record.dismissed = Math.max(record.dismissed ?? 0, version);
  return { draft: d };
}

/**
 * The import records whose questions a version still asks, trimmed to those
 * questions, for `VersionDoc.imports`. Renames are kept only for questions
 * still asked; whether a module update was dismissed is the draft's business,
 * not the version's, and is left out.
 */
export function importsForVersion(draft: StudioDraft): ImportRecord[] {
  const asked = new Map(liveQuestions(draft).map((q) => [q.itemKey, q.item.variable]));
  const out: ImportRecord[] = [];
  for (const record of draft.imports ?? []) {
    const items = Object.entries(record.items).filter(([id]) => asked.has(id));
    if (items.length === 0) continue;
    const kept = new Set(items.map(([id]) => id));
    const variables = new Set(items.map(([id]) => asked.get(id)!));
    const renamed = Object.entries(record.renamed ?? {}).filter(([, to]) => kept.has(to));
    const variablesRenamed = Object.entries(record.variablesRenamed ?? {}).filter(([, to]) => variables.has(to));
    out.push({
      id: record.id,
      at: record.at,
      by: record.by,
      byEmail: record.byEmail,
      origin: structuredClone(record.origin),
      items: Object.fromEntries(items),
      ...(renamed.length > 0 ? { renamed: Object.fromEntries(renamed) } : {}),
      ...(variablesRenamed.length > 0 ? { variablesRenamed: Object.fromEntries(variablesRenamed) } : {}),
    });
  }
  return out;
}

/** Where a question in the draft was copied from, if it was: the latest record that names it. */
export function provenanceOf(draft: StudioDraft, itemKey: string): { record: ImportRecord; sourceKey: string } | null {
  const records = draft.imports ?? [];
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const sourceKey = own(record.items, itemKey);
    if (typeof sourceKey === "string") return { record, sourceKey };
  }
  return null;
}

/**
 * The record a piece saved to the library starts with (D-68): its source's,
 * except that a validated questionnaire which was unlocked and edited is no
 * longer "as published" — it is an adaptation of it, and says what it came from.
 */
export function provenanceForSave(
  prior: ProvenanceInput | null | undefined,
  source: { name: string; citation?: string | undefined; edited: boolean },
): ProvenanceInput {
  if (!prior) return { kind: "researcher_developed", confirmed: false };
  if (prior.kind === "validated" && source.edited) {
    const { adaptations: _ignored, confirmed: _c, confirmedBy: _b, confirmedAt: _a, ...rest } = prior;
    return { ...rest, kind: "validated_adapted", basedOn: prior.basedOn ?? (source.citation ? `${source.name}: ${source.citation}` : source.name), confirmed: false };
  }
  return structuredClone(prior);
}

/** The same record on every block of a piece, as saved. */
export function withProvenance(fragment: StudioFragment, record: ProvenanceInput): StudioFragment {
  return {
    ...fragment,
    blocks: fragment.blocks.map((b) => ({ ...b, definition: { ...b.definition, provenance: structuredClone(record) } as typeof b.definition })),
  };
}

