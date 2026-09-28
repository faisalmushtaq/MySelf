import {
  ABSOLUTE_MAX_AGE_YEARS,
  assessmentDraft,
  canonicalJson,
  instrumentVersion,
  moduleDefinition,
  responseScale,
  scoringDefinition,
} from "@myself/schema";
import type {
  ArchivedQuestion,
  InstrumentOrModule,
  Issue,
  IssueLocation,
  ScaleInput,
  ScoringInput,
  Severity,
  StudioDraft,
} from "./contract.js";
import { DRAFT_FORMAT, DRAFT_FORMAT_VERSION } from "./contract.js";
import { previewRelease, type PreviewRelease } from "./draft.js";
import type { ReservedIds } from "./history.js";
import {
  instrumentLabel,
  isUnlocked,
  LINKAGE_ITEM_KEYS,
  lockedDifferences,
  lockedTest,
  protectedDifferences,
  questionLabel,
  truncateText,
  type LockedDifference,
  type LockedOptions,
} from "./locked.js";
import { formOf, liveQuestions, placements, type LiveQuestion, type Placement } from "./walk.js";

/**
 * Studio validation: everything that would make a draft wrong to publish, and
 * the things worth a second look, each located precisely enough for the editor
 * to jump to it and phrased so a researcher knows what to do.
 *
 * The same function runs in the editor on every keystroke (debounced) and in
 * the publishing function before `buildRelease`, so what the researcher sees
 * while editing is exactly what the server will refuse. Two consequences:
 *
 * - it must never throw. A half-edited or corrupted draft is exactly what it
 *   exists to describe, so every family of checks is isolated and a failure
 *   inside one becomes an issue rather than an exception;
 * - it never drops a publish-gate refusal. The gate is the last word on what
 *   can be released, so each of its failures is reported even where one of the
 *   Studio's own, friendlier checks already says the same thing.
 */

export interface ValidationContext {
  /** Question IDs and variables used by any published version of this survey. */
  reserved?: ReservedIds;
  /** The published version this draft started from, as a draft (`extractDraft`). */
  baseline?: StudioDraft;
  /** Scale key → option code → label, across every published version (`publishedScaleCodes`). */
  publishedScaleCodes?: Map<string, Map<number, string>>;
  /**
   * Known-good definitions of validated instruments (the instrument library),
   * keyed by reference string and frozen to one form each: a locked instrument
   * the baseline lacks is accepted when it matches one exactly and its answer
   * options and scoring match `referenceScales` / `referenceScoring` (or the
   * baseline's copies). With no baseline — a survey never published — every
   * locked instrument is held to these, when they are given.
   */
  reference?: Record<string, InstrumentOrModule>;
  /** The library's answer options by scale key (see `reference`). */
  referenceScales?: Record<string, ScaleInput>;
  /** The library's scoring rules by key (see `reference`). */
  referenceScoring?: Record<string, ScoringInput>;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The response types the participant app renders, validates, stores and reports (item.ts). */
const RESPONSE_TYPES = new Set([
  "info",
  "single_choice",
  "multi_choice",
  "slider",
  "ladder",
  "numeric",
  "date",
  "text_short",
  "text_long",
  "form_fields",
  "rank_group",
  "checkbox_set",
]);

const SCALED_TYPES = new Set(["single_choice", "multi_choice", "rank_group"]);
const FREE_TEXT_TYPES = new Set(["text_short", "text_long", "form_fields"]);

/** The questions ingest routes to the identity store by variable (packages/store/src/ingest.ts). */
const IDENTITY_VARIABLES = new Set(["first_name", "last_name", "dob"]);
const LINKAGE = new Set(LINKAGE_ITEM_KEYS);

const SLUG = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** A stem this long is a passage; the lede exists so the question itself stays short. */
const LONG_STEM_CHARS = 600;

/**
 * Which checks can ever be true of each kind of answer, mirroring
 * `@myself/engine` evaluate.ts. A check outside this list is not an error the
 * engine reports — it is simply always false, so the question it governs
 * silently never appears.
 */
const OPS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  single_choice: new Set(["answered", "not_empty", "selected", "not_selected", "eq", "ne", "gt", "gte", "lt", "lte"]),
  multi_choice: new Set(["answered", "selected", "not_selected"]),
  rank_group: new Set(["answered", "in_group"]),
  checkbox_set: new Set(["answered"]),
  slider: new Set(["answered", "not_empty", "eq", "ne", "gt", "gte", "lt", "lte"]),
  numeric: new Set(["answered", "not_empty", "eq", "ne", "gt", "gte", "lt", "lte"]),
  ladder: new Set(["answered", "not_empty", "eq", "ne", "gt", "gte", "lt", "lte"]),
  date: new Set(["answered", "not_empty", "eq", "ne"]),
  text_short: new Set(["answered", "not_empty", "eq", "ne"]),
  text_long: new Set(["answered", "not_empty", "eq", "ne"]),
  form_fields: new Set(["answered", "not_empty"]),
  info: new Set(),
};
const NUMBER_VALUED = new Set(["single_choice", "slider", "numeric", "ladder"]);
const STRING_VALUED = new Set(["date", "text_short", "text_long"]);
const LOGIC_OPS = new Set(["all", "any", "not", ...Object.values(OPS_BY_TYPE).flatMap((s) => [...s]), "in_group"]);

const OP_PHRASES: Record<string, string> = {
  answered: "was answered",
  not_empty: "has an answer",
  selected: "has a particular option chosen",
  not_selected: "does not have a particular option chosen",
  in_group: "has an option sorted into a particular group",
  eq: "equals a value",
  ne: "differs from a value",
  gt: "is more than a value",
  gte: "is at least a value",
  lt: "is less than a value",
  lte: "is at most a value",
};

const TYPE_NAMES: Record<string, string> = {
  single_choice: "single-choice",
  multi_choice: "multiple-choice",
  rank_group: "sorting",
  checkbox_set: "statement checklist",
  slider: "slider",
  numeric: "number",
  ladder: "ladder",
  date: "date",
  text_short: "short-text",
  text_long: "long-text",
  form_fields: "form",
  info: "information",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function hasText(display: unknown): boolean {
  return isObject(display) && hasString(display["text"]);
}

function isSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SLUG.test(value);
}

function isVariable(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && SLUG.test(value);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function list<T = Loose>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

interface LocationParts {
  sectionKey?: string | undefined;
  itemKey?: string | undefined;
  refKey?: string | undefined;
  field?: string | undefined;
  optionCode?: number | undefined;
}

function at(kind: IssueLocation["kind"], parts: LocationParts = {}): IssueLocation {
  const out: IssueLocation = { kind };
  if (parts.sectionKey !== undefined) out.sectionKey = parts.sectionKey;
  if (parts.itemKey !== undefined) out.itemKey = parts.itemKey;
  if (parts.refKey !== undefined) out.refKey = parts.refKey;
  if (parts.field !== undefined) out.field = parts.field;
  if (parts.optionCode !== undefined) out.optionCode = parts.optionCode;
  return out;
}

function questionAt(q: LiveQuestion, field?: string): IssueLocation {
  return at("question", { itemKey: q.itemKey, refKey: q.refKey, sectionKey: q.sectionKey, field });
}

function optionAt(q: LiveQuestion, code: number | undefined, field = "options"): IssueLocation {
  return at("option", { itemKey: q.itemKey, refKey: q.refKey, sectionKey: q.sectionKey, field, optionCode: code });
}

function blockAt(p: Placement, field?: string): IssueLocation {
  return at("block", { sectionKey: p.sectionKey, refKey: p.refKey, field });
}

class Collector {
  readonly issues: Issue[] = [];

  add(severity: Severity, code: string, message: string, location: IssueLocation): void {
    this.issues.push({ severity, code, message, location });
  }

  error(code: string, message: string, location: IssueLocation): void {
    this.add("error", code, message, location);
  }

  warn(code: string, message: string, location: IssueLocation): void {
    this.add("warning", code, message, location);
  }

  /**
   * Run one family of checks in isolation. A family that trips over malformed
   * data reports that it could not finish; the others still run.
   */
  run(family: string, check: () => void): void {
    try {
      check();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.error(
        "draft.check_failed",
        `Part of the survey could not be checked (${family}: ${detail}). This usually means part of the draft is malformed — see the other problems listed, or undo the last change.`,
        at("survey"),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The draft as validation sees it
// ---------------------------------------------------------------------------

interface Model {
  draft: StudioDraft;
  ctx: ValidationContext;
  /** False when the sections could not be walked; see `buildModel`. */
  walked: boolean;
  places: Placement[];
  live: LiveQuestion[];
  /** First administration of each question — the one every check is about. */
  first: Map<string, LiveQuestion>;
  firstList: LiveQuestion[];
  archived: Map<string, ArchivedQuestion>;
  /** Every question defined in the draft's instruments, placed or not. */
  defined: Set<string>;
  /** Scale key → the first live question using it, and how many use it. */
  scaleUse: Map<string, { owner: LiveQuestion; count: number }>;
  baseFirst: Map<string, LiveQuestion>;
  preview: PreviewRelease;
  sectionTitle(key: string): string;
  /** Whether a draft definition is a locked (licensed) instrument — see `lockedTest`. */
  isLocked: ReturnType<typeof lockedTest>;
}

function firstOccurrences(live: LiveQuestion[]): Map<string, LiveQuestion> {
  const first = new Map<string, LiveQuestion>();
  for (const q of live) if (!first.has(q.itemKey)) first.set(q.itemKey, q);
  return first;
}

/** The first form of a definition, or null when there is none to read. */
function safeForm(def: unknown): ReturnType<typeof formOf> {
  try {
    return formOf(def as InstrumentOrModule);
  } catch {
    return null;
  }
}

/**
 * Walk the draft. Returns the model with `walked: false` when the sections
 * cannot be walked at all: then only the publish gate and the schema can say
 * anything useful, and checks that count questions per section would only add
 * noise ("every section is empty") to the one real problem.
 */
function buildModel(draft: StudioDraft, ctx: ValidationContext, c: Collector): Model {
  let places: Placement[] = [];
  let live: LiveQuestion[] = [];
  let walked = true;
  try {
    places = placements(draft);
    live = liveQuestions(draft);
  } catch (error) {
    walked = false;
    places = [];
    live = [];
    c.error(
      "draft.malformed",
      `The survey's sections could not be read (${error instanceof Error ? error.message : String(error)}). See the other problems listed, undo the last change, or restore the draft from a published version.`,
      at("survey"),
    );
  }
  const first = firstOccurrences(live);
  const archived = new Map<string, ArchivedQuestion>();
  for (const a of list<ArchivedQuestion>(draft.archived)) if (isObject(a) && typeof a.itemKey === "string") archived.set(a.itemKey, a);
  const defined = new Set<string>();
  for (const def of Object.values(draft.instruments)) {
    const instrument = (def as { instrument?: unknown } | null)?.instrument;
    for (const item of list(safeForm(def)?.items)) if (isObject(item)) defined.add(`${String(instrument)}.${String(item["key"])}`);
  }
  let baseFirst = new Map<string, LiveQuestion>();
  if (ctx.baseline) {
    try {
      baseFirst = firstOccurrences(liveQuestions(ctx.baseline));
    } catch {
      c.error(
        "baseline.unreadable",
        "The published version this draft started from could not be read, so changes to protected and licensed content cannot be checked. Reload the draft; if this persists, restore it from a published version.",
        at("survey"),
      );
    }
  }
  const titles = new Map<string, string>();
  for (const s of list(draft.composition.sections)) {
    if (isObject(s) && typeof s["key"] === "string") titles.set(s["key"], typeof s["title"] === "string" ? s["title"] : "");
  }
  return {
    draft,
    ctx,
    walked,
    places,
    live,
    first,
    firstList: [...first.values()],
    archived,
    defined,
    scaleUse: new Map(),
    baseFirst,
    preview: previewRelease(draft),
    sectionTitle: (key) => {
      const title = titles.get(key);
      return title ? `“${truncateText(title, 40)}”` : `“${key}”`;
    },
    isLocked: lockedTest(ctx.baseline, ctx.reference),
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Placeholders and pipes in one piece of participant-facing text. */
function checkPipes(
  m: Model,
  c: Collector,
  display: unknown,
  where: string,
  location: IssueLocation,
  /** Position a piped answer must come before; Infinity for text shown after every question. */
  before: number,
): void {
  if (!isObject(display) || typeof display["text"] !== "string") return;
  const text = display["text"];
  const pipes = isObject(display["pipes"]) ? display["pipes"] : {};
  const used = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    used.add(name);
    if (!(name in pipes)) {
      c.error(
        "pipe.unresolved",
        `${where} contains {${name}}, but nothing says what to put there, so participants would see “{${name}}” as it stands. Remove it, or set it to insert an earlier answer.`,
        location,
      );
    }
  }
  for (const [name, raw] of Object.entries(pipes)) {
    if (!used.has(name)) {
      c.error(
        "pipe.unused",
        `${where} is set up to insert something as {${name}}, but the text no longer contains {${name}}. Put {${name}} back where it should appear, or remove the insertion.`,
        location,
      );
    }
    const pipe = isObject(raw) ? raw : {};
    if (pipe["kind"] === "item_answer" || pipe["kind"] === "item_text_entry") {
      const ref = isObject(pipe["item"]) ? pipe["item"] : null;
      const key = ref ? `${String(ref["instrument"])}.${String(ref["item"])}` : null;
      const target = key ? m.first.get(key) : undefined;
      if (!key) {
        c.error("pipe.target_missing", `${where} inserts an answer as {${name}} but doesn't say which question it comes from. Choose the question.`, location);
      } else if (!target) {
        c.error(
          "pipe.target_missing",
          `${where} inserts the answer to “${key}” as {${name}}, but that question is not in the survey${m.archived.has(key) ? " (it has been archived)" : ""}. Choose another question, or remove the insertion.`,
          location,
        );
      } else if (target.position >= before) {
        c.warn(
          "pipe.target_later",
          `${where} inserts the answer to ${questionLabel(key, target.item)} as {${name}}, but that question is asked later, so participants will see ${
            typeof pipe["fallback"] === "string" ? `the fallback “${pipe["fallback"]}”` : `“{${name}}”`
          } instead. Move the question earlier, or insert a different answer.`,
          location,
        );
      }
    }
    if (pipe["kind"] === "score" && (typeof pipe["scoringKey"] !== "string" || !m.draft.scoring[pipe["scoringKey"]])) {
      c.error(
        "pipe.score_missing",
        `${where} inserts a score as {${name}}, but the scoring rules “${String(pipe["scoringKey"] ?? "")}” are not in the survey. Choose a score the survey calculates, or remove the insertion.`,
        location,
      );
    }
  }
}

function checkQuestion(m: Model, c: Collector, q: LiveQuestion): void {
  const item = q.item as unknown as Loose;
  const type = item["responseType"];
  const label = () => questionLabel(q.itemKey, item);
  const isInfo = type === "info";

  if (!hasText(item["stem"])) {
    c.error(
      "question.text_missing",
      isInfo
        ? `The information block ${q.itemKey} has no text. Type what participants should read, or delete the block.`
        : `The question ${q.itemKey} has no text. Type the question participants will see, or delete it.`,
      questionAt(q, "stem"),
    );
  }
  if (!isSlug(q.key)) {
    c.error(
      "question.key_invalid",
      `The ID “${q.key}” of ${label()} can't be used. IDs start with a lowercase letter and contain only lowercase letters, numbers and underscores (at most 64 characters).`,
      questionAt(q, "key"),
    );
  }
  if (!isVariable(item["variable"])) {
    c.error(
      "question.variable_invalid",
      `The reporting label “${String(item["variable"] ?? "")}” of ${label()} can't be used. It becomes a column name in the data, so it must start with a lowercase letter, contain only lowercase letters, numbers and underscores, and be at most 32 characters.`,
      questionAt(q, "variable"),
    );
  }
  if (typeof type !== "string" || !RESPONSE_TYPES.has(type)) {
    c.error(
      "question.type_unsupported",
      `${label()} has the answer type “${String(type)}”, which the survey app cannot show. Change it to one of the supported question types.`,
      questionAt(q, "responseType"),
    );
    return;
  }

  // Answer options come from a scale in the registry; the per-scale checks run
  // once per scale, below, so a problem with a shared scale is reported once.
  let optionCount = 0;
  if (SCALED_TYPES.has(type)) {
    const scaleKey = item["scale"];
    const scale = typeof scaleKey === "string" ? m.draft.scales[scaleKey] : undefined;
    if (!scale || typeof scaleKey !== "string") {
      c.error(
        "question.scale_missing",
        `The answer options of ${label()} can't be found (scale “${String(scaleKey ?? "")}”), so there would be nothing to choose from. Choose or create a set of options.`,
        questionAt(q, "scale"),
      );
    } else {
      optionCount = list(scale.options).length;
      const use = m.scaleUse.get(scaleKey);
      if (use) use.count += 1;
      else m.scaleUse.set(scaleKey, { owner: q, count: 1 });
    }
  }

  checkLimits(c, q, item, type, optionCount, label);

  const where = isInfo ? "This information block" : "This question";
  checkPipes(m, c, item["stem"], `The text of ${q.itemKey}`, questionAt(q, "stem"), q.position);
  checkPipes(m, c, item["lede"], `The text under ${q.itemKey}`, questionAt(q, "lede"), q.position);
  if (isObject(item["moreInfo"])) {
    checkPipes(m, c, item["moreInfo"]["body"], `The “more information” text of ${q.itemKey}`, questionAt(q, "moreInfo"), q.position);
  }
  if (type === "checkbox_set") {
    for (const s of list(item["statements"])) {
      if (isObject(s)) checkPipes(m, c, s["text"], `A statement of ${q.itemKey}`, questionAt(q, "statements"), q.position);
    }
  }

  // Warnings: things that publish fine but are probably not what was meant.
  if (type === "slider" && (!hasString(item["minLabel"]) || !hasString(item["maxLabel"]))) {
    c.warn(
      "question.slider_labels_missing",
      `The slider ${label()} has no label at ${!hasString(item["minLabel"]) && !hasString(item["maxLabel"]) ? "either end" : "one end"}. Label both ends (for example “None” and “All”) so the scale makes sense to everyone, including people using a screen reader.`,
      questionAt(q, !hasString(item["minLabel"]) ? "minLabel" : "maxLabel"),
    );
  }
  if (type === "ladder" && (!hasString(item["topLabel"]) || !hasString(item["bottomLabel"]))) {
    c.warn(
      "question.ladder_labels_missing",
      `The ladder ${label()} has no label at ${!hasString(item["topLabel"]) && !hasString(item["bottomLabel"]) ? "the top or the bottom" : "one end"}. Say who is at the top and who is at the bottom, so the picture makes sense to everyone, including people using a screen reader.`,
      questionAt(q, !hasString(item["topLabel"]) ? "topLabel" : "bottomLabel"),
    );
  }
  const stem = isObject(item["stem"]) && typeof item["stem"]["text"] === "string" ? item["stem"]["text"] : "";
  if (stem.length > LONG_STEM_CHARS && !hasText(item["lede"])) {
    c.warn(
      "question.stem_long",
      `${where} is ${stem.length} characters long. Long questions are hard to read, especially for younger participants: keep the question short and move the explanation into the text shown under it.`,
      questionAt(q, "stem"),
    );
  }
  if (FREE_TEXT_TYPES.has(type) && item["identifying"] !== true) {
    c.warn(
      "question.free_text_identifying",
      `${label()} lets participants type anything, so it may collect identifying information such as names or places. Mark it identifying if it asks for personal details — its answers are then kept out of the research data — or ask participants in the question not to include names.`,
      questionAt(q, "identifying"),
    );
  }
  if (isInfo && item["required"] === "hard") {
    c.warn(
      "question.info_required",
      `The information block ${label()} is marked as must-answer, but there is nothing to answer, so the setting is ignored. Set it to optional to avoid confusion.`,
      questionAt(q, "required"),
    );
  }
  // Not for the linkage items: a participant code is derived only from all four
  // (identity.ts), so for them "must answer" is the design, not an oversight.
  if (!isInfo && item["identifying"] === true && item["required"] === "hard" && !LINKAGE.has(q.itemKey)) {
    c.warn(
      "question.identifying_required",
      `${label()} collects identifying information and must be answered to carry on, so a participant who does not want to give it cannot finish the survey. Check that this matches your ethics approval and what participants are told.`,
      questionAt(q, "required"),
    );
  }
}

function checkLimits(c: Collector, q: LiveQuestion, item: Loose, type: string, optionCount: number, label: () => string): void {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  switch (type) {
    case "slider": {
      const min = num(item["min"]);
      const max = num(item["max"]);
      const step = item["step"] === undefined ? 1 : num(item["step"]);
      if (min === undefined || max === undefined || min >= max) {
        c.error(
          "limits.slider_range",
          `The slider ${label()} runs from ${String(item["min"])} to ${String(item["max"])}. The lowest value must be a number below the highest.`,
          questionAt(q, "min"),
        );
      } else if (step === undefined || step <= 0 || step > max - min) {
        c.error(
          "limits.slider_step",
          `The slider ${label()} moves in steps of ${String(item["step"])}, which doesn't fit its range of ${min} to ${max}. Use a step above 0 and no larger than ${max - min}.`,
          questionAt(q, "step"),
        );
      }
      break;
    }
    case "numeric": {
      const min = num(item["min"]);
      const max = num(item["max"]);
      if (min !== undefined && max !== undefined && min > max) {
        c.error(
          "limits.numeric_range",
          `${label()} accepts numbers from ${min} to ${max}, which no number can satisfy. Make the smallest allowed number no larger than the largest.`,
          questionAt(q, "min"),
        );
      }
      break;
    }
    case "text_short":
    case "text_long": {
      const maxChars = num(item["maxChars"]);
      if (item["maxChars"] !== undefined && (maxChars === undefined || maxChars < 1)) {
        c.error(
          "limits.max_chars",
          `${label()} allows at most ${String(item["maxChars"])} characters, so nothing could be typed. Allow at least 1.`,
          questionAt(q, "maxChars"),
        );
      }
      if (type === "text_short" && typeof item["pattern"] === "string" && !compiles(item["pattern"])) {
        c.error(
          "question.pattern_invalid",
          `The answer format of ${label()} (“${item["pattern"]}”) is not a valid pattern, so no answer could be checked against it. Correct the pattern or remove it.`,
          questionAt(q, "pattern"),
        );
      }
      break;
    }
    case "multi_choice": {
      const max = item["maxSelections"];
      const n = num(max);
      if (max !== undefined && (n === undefined || n < 1 || (optionCount > 0 && n > optionCount))) {
        c.error(
          "limits.max_selections",
          `${label()} allows up to ${String(max)} choices, but it has ${optionCount} options. Allow between 1 and ${Math.max(optionCount, 1)} choices, or remove the limit.`,
          questionAt(q, "maxSelections"),
        );
      }
      break;
    }
    case "ladder": {
      const rungs = item["rungs"];
      if (!Number.isInteger(rungs) || (rungs as number) < 2) {
        c.error("limits.ladder_rungs", `The ladder ${label()} has ${String(rungs)} rungs. A ladder needs at least 2.`, questionAt(q, "rungs"));
      }
      break;
    }
    case "date": {
      const minAge = item["minAgeYears"];
      const maxAge = item["maxAgeYears"];
      for (const [field, value] of [
        ["minAgeYears", minAge],
        ["maxAgeYears", maxAge],
      ] as const) {
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > ABSOLUTE_MAX_AGE_YEARS)) {
          c.error(
            "limits.age_range",
            `${label()} has an age limit of ${String(value)} years. Age limits must be whole numbers from 0 to ${ABSOLUTE_MAX_AGE_YEARS}.`,
            questionAt(q, field),
          );
        }
      }
      if (typeof minAge === "number" && typeof maxAge === "number" && minAge > maxAge) {
        c.error(
          "limits.age_range",
          `${label()} accepts ages from ${minAge} to ${maxAge} years, which no date can satisfy. Make the youngest age no older than the oldest.`,
          questionAt(q, "minAgeYears"),
        );
      }
      const minYear = num(item["minYear"]);
      const maxYear = num(item["maxYear"]);
      if (minYear !== undefined && maxYear !== undefined && minYear > maxYear) {
        c.error(
          "limits.year_range",
          `${label()} accepts years from ${minYear} to ${maxYear}, which no date can satisfy. Make the earliest year no later than the latest.`,
          questionAt(q, "minYear"),
        );
      }
      break;
    }
    case "form_fields": {
      const fields = list(item["fields"]);
      if (fields.length === 0) {
        c.error("limits.fields_missing", `The form ${label()} has no fields to fill in. Add at least one field.`, questionAt(q, "fields"));
      }
      const keys = new Set<string>();
      for (const f of fields) {
        const key = isObject(f) ? f["key"] : undefined;
        const field = `fields.${String(key)}`;
        if (!isObject(f)) continue;
        if (!isSlug(key)) {
          c.error(
            "question.field_key_invalid",
            `A field of ${label()} has the ID “${String(key ?? "")}”, which can't be used. Field IDs start with a lowercase letter and contain only lowercase letters, numbers and underscores.`,
            questionAt(q, field),
          );
        } else if (keys.has(key)) {
          c.error("question.field_key_duplicate", `Two fields of ${label()} have the ID “${key}”. Give each field its own ID.`, questionAt(q, field));
        } else keys.add(key);
        if (!hasString(f["label"])) {
          c.error("question.field_label_missing", `The field “${String(key)}” of ${label()} has no label. Say what should be typed there.`, questionAt(q, field));
        }
        if (typeof f["pattern"] === "string" && !compiles(f["pattern"])) {
          c.error(
            "question.pattern_invalid",
            `The answer format of the field “${String(key)}” of ${label()} (“${f["pattern"]}”) is not a valid pattern. Correct the pattern or remove it.`,
            questionAt(q, field),
          );
        }
        const fieldMax = num(f["maxChars"]);
        if (f["maxChars"] !== undefined && (fieldMax === undefined || fieldMax < 1)) {
          c.error("limits.max_chars", `The field “${String(key)}” of ${label()} allows no characters. Allow at least 1.`, questionAt(q, field));
        }
      }
      break;
    }
    case "rank_group": {
      const groups = list(item["groups"]);
      if (groups.length < 2) {
        c.error(
          "limits.groups_too_few",
          `${label()} sorts options into ${groups.length} group${groups.length === 1 ? "" : "s"}. Sorting needs at least 2 groups.`,
          questionAt(q, "groups"),
        );
      }
      const keys = new Set<string>();
      for (const g of groups) {
        if (!isObject(g)) continue;
        const key = g["key"];
        if (!isSlug(key)) {
          c.error("question.group_key_invalid", `A group of ${label()} has the ID “${String(key ?? "")}”, which can't be used.`, questionAt(q, "groups"));
        } else if (keys.has(key)) {
          c.error("question.group_key_duplicate", `Two groups of ${label()} have the ID “${key}”. Give each group its own ID.`, questionAt(q, "groups"));
        } else keys.add(key);
        if (!hasString(g["label"])) {
          c.error("question.group_label_missing", `The group “${String(key)}” of ${label()} has no label. Say what the group means.`, questionAt(q, "groups"));
        }
      }
      break;
    }
    case "checkbox_set": {
      const statements = list(item["statements"]);
      if (statements.length === 0) {
        c.error("limits.statements_missing", `${label()} has no statements to agree to. Add at least one statement.`, questionAt(q, "statements"));
      }
      const keys = new Set<string>();
      for (const s of statements) {
        if (!isObject(s)) continue;
        const key = s["key"];
        if (!isSlug(key)) {
          c.error("question.statement_key_invalid", `A statement of ${label()} has the ID “${String(key ?? "")}”, which can't be used.`, questionAt(q, "statements"));
        } else if (keys.has(key)) {
          c.error("question.statement_key_duplicate", `Two statements of ${label()} have the ID “${key}”. Give each statement its own ID.`, questionAt(q, "statements"));
        } else keys.add(key);
        if (!hasText(s["text"])) {
          c.error("question.statement_text_missing", `The statement “${String(key)}” of ${label()} has no text. Type the statement, or delete it.`, questionAt(q, "statements"));
        }
      }
      break;
    }
  }
}

/** Answer options, checked once per scale and reported at the first question that uses it. */
function checkScales(m: Model, c: Collector): void {
  const uses = [...m.scaleUse.entries()].sort((a, b) => a[1].owner.position - b[1].owner.position);
  for (const [scaleKey, { owner, count }] of uses) {
    const scale = m.draft.scales[scaleKey] as unknown as Loose;
    const options = list(scale["options"]);
    const whose = `${questionLabel(owner.itemKey, owner.item)}${count > 1 ? ` (and ${count - 1} other question${count > 2 ? "s" : ""} using the same options)` : ""}`;

    if (options.length < 2) {
      c.error(
        "options.too_few",
        `${whose} has ${options.length === 0 ? "no options" : "only one option"} to choose from. Add at least two options.`,
        questionAt(owner, "options"),
      );
    }
    const retired = new Map<number, { label: string }>();
    for (const r of list(m.draft.retiredCodes?.[scaleKey])) if (isObject(r) && typeof r["code"] === "number") retired.set(r["code"], { label: String(r["label"] ?? "") });
    const codes = new Map<number, string>();
    for (const option of options) {
      if (!isObject(option)) continue;
      const code = option["code"];
      const label = typeof option["label"] === "string" ? option["label"] : "";
      if (typeof code !== "number" || !Number.isInteger(code)) {
        c.error(
          "options.code_invalid",
          `An option of ${whose} (“${truncateText(label, 30)}”) has the value “${String(code)}”. Option values must be whole numbers.`,
          optionAt(owner, undefined),
        );
        continue;
      }
      if (!hasString(label)) {
        c.error("options.label_missing", `Option ${code} of ${whose} has no label. Type what participants will see, or delete the option.`, optionAt(owner, code));
      }
      const clash = codes.get(code);
      if (clash !== undefined) {
        c.error(
          "options.duplicate_value",
          `Two options of ${whose} have the value ${code} (“${truncateText(clash, 30)}” and “${truncateText(label, 30)}”), so their answers could not be told apart in the data. Give each option its own value.`,
          optionAt(owner, code),
        );
      } else codes.set(code, label);
      const old = retired.get(code);
      if (old && old.label.trim() !== label.trim()) {
        c.error(
          "options.code_retired",
          `The value ${code} of ${whose} was used for “${truncateText(old.label, 30)}” in a published version and has been retired, so it can't now mean “${truncateText(label, 30)}”: recorded answers would mean two things. Give this option a new value.`,
          optionAt(owner, code),
        );
      }
    }

    // Changes to a scale participants have already answered.
    const published = m.ctx.publishedScaleCodes?.get(scaleKey);
    if (published) {
      for (const [code, label] of codes) {
        const was = published.get(code);
        if (was === undefined) {
          c.warn(
            "options.added",
            `“${truncateText(label, 30)}” (value ${code}) is new to options of ${whose} that participants have already answered. Earlier participants could not choose it, so compare answers across versions with care.`,
            optionAt(owner, code),
          );
        } else if (was !== label) {
          c.warn(
            "options.relabelled",
            `Answers already recorded as ${code} for ${whose} meant “${truncateText(was, 40)}”; this option now reads “${truncateText(label, 40)}”. If the meaning has changed, add a new option with a new value instead, so old and new answers are not mixed.`,
            optionAt(owner, code),
          );
        }
      }
    }
    const baseScale = m.ctx.baseline ? (m.ctx.baseline.scales?.[scaleKey] as unknown as Loose | undefined) : undefined;
    const reference: Map<number, string> | undefined = m.ctx.baseline
      ? baseScale
        ? new Map(list(baseScale["options"]).filter(isObject).map((o) => [o["code"] as number, String(o["label"] ?? "")]))
        : undefined
      : published
        ? new Map([...published].filter(([code]) => !retired.has(code)))
        : undefined;
    for (const [code, label] of reference ?? []) {
      if (!codes.has(code)) {
        c.warn(
          "options.removed",
          `The option “${truncateText(label, 40)}” (value ${code}) has been removed from ${whose}. Answers already recorded as ${code} keep their meaning, and the value will not be reused.`,
          optionAt(owner, code),
        );
      }
    }
  }
}

function checkDuplicatesAndReservations(m: Model, c: Collector): void {
  // Two questions with one key inside one definition.
  const defDuplicates = new Set<string>();
  for (const [refKey, def] of Object.entries(m.draft.instruments)) {
    const instrument = String((def as { instrument?: unknown } | null)?.instrument ?? "");
    const seen = new Set<string>();
    for (const item of list(safeForm(def)?.items)) {
      if (!isObject(item)) continue;
      const key = String(item["key"]);
      if (seen.has(key)) {
        defDuplicates.add(`${instrument}.${key}`);
        c.error(
          "question.key_duplicate",
          `Two questions in ${instrumentLabel(def, instrument)} have the ID “${key}”. Each question needs its own ID so its answers are stored separately; give one of them a different ID.`,
          at("question", { itemKey: `${instrument}.${key}`, refKey, field: "key" }),
        );
      }
      seen.add(key);
    }
  }

  const administered = new Map<string, LiveQuestion>();
  const variables = new Map<string, LiveQuestion>();
  for (const q of m.live) {
    const prior = administered.get(q.itemKey);
    if (prior) {
      if (!defDuplicates.has(q.itemKey)) {
        c.error(
          "question.administered_twice",
          `${questionLabel(q.itemKey, q.item)} is asked twice: in ${m.sectionTitle(prior.sectionKey)} and again in ${m.sectionTitle(q.sectionKey)}. A question can be asked only once, or its two answers would share one column in the data. Remove one of the two.`,
          questionAt(q),
        );
      }
      continue;
    }
    administered.set(q.itemKey, q);
    const variable = (q.item as { variable?: unknown }).variable;
    if (isVariable(variable)) {
      const other = variables.get(variable);
      if (other) {
        c.error(
          "question.variable_duplicate",
          `${questionLabel(q.itemKey, q.item)} has the reporting label “${variable}”, which ${questionLabel(other.itemKey, other.item)} also uses. Each question needs its own label, so its answers get their own column in the data.`,
          questionAt(q, "variable"),
        );
      } else variables.set(variable, q);
    }
  }

  // IDs and variables are locked once published and reserved forever after.
  const reserved = m.ctx.reserved;
  const byVariable = new Map<string, Set<string>>();
  for (const [itemKey, vars] of reserved?.variablesByItem ?? []) {
    for (const v of vars) {
      const set = byVariable.get(v) ?? new Set<string>();
      set.add(itemKey);
      byVariable.set(v, set);
    }
  }
  for (const q of m.firstList) {
    const key = q.itemKey;
    const variable = (q.item as { variable?: unknown }).variable;
    if (typeof variable !== "string") continue;
    const base = m.baseFirst.get(key);
    const archived = m.archived.get(key);
    const publishedVars = reserved?.variablesByItem?.get(key);
    // Linkage items have their own, stricter check below.
    const linkage = LINKAGE.has(key) && !!base;
    const label = () => questionLabel(key, q.item);

    const publishedAs = base
      ? (base.item as { variable?: unknown }).variable
      : publishedVars && !publishedVars.has(variable)
        ? [...publishedVars][0]
        : undefined;
    if (!linkage && typeof publishedAs === "string" && publishedAs !== variable) {
      c.error(
        "question.variable_locked",
        `The reporting label of ${label()} was “${publishedAs}” when it was published, and published labels can't change: answers already collected are stored under “${publishedAs}”. Change it back to “${publishedAs}”.`,
        questionAt(q, "variable"),
      );
    } else if (reserved?.itemKeys.has(key) && !base && !archived && !publishedVars) {
      c.error(
        "question.key_reserved",
        `The ID “${key}” was used by a question in an earlier published version. IDs are never reused, so earlier answers keep their meaning; give ${label()} a different ID.`,
        questionAt(q, "key"),
      );
    }
    if (reserved?.variables.has(variable)) {
      const owners = byVariable.get(variable);
      const same = owners
        ? owners.has(key)
        : (base?.item as { variable?: unknown } | undefined)?.variable === variable ||
          (archived?.item as { variable?: unknown } | undefined)?.variable === variable;
      if (!same) {
        c.error(
          "question.variable_reserved",
          `The reporting label “${variable}” of ${label()} was used by ${
            owners ? `a different question (${[...owners].join(", ")})` : "a different question"
          } in an earlier published version. Labels are never reused, so the two questions' answers can't be mixed up; choose a different label.`,
          questionAt(q, "variable"),
        );
      }
    }
  }
}

/** Every leaf of a condition, with malformed nodes reported. */
function conditionLeaves(expr: unknown, bad: string[], out: Loose[] = []): Loose[] {
  if (!isObject(expr)) {
    bad.push("a part of the condition is empty");
    return out;
  }
  const op = expr["op"];
  if (op === "all" || op === "any") {
    const args = list<unknown>(expr["args"]);
    if (args.length === 0) bad.push(`“${op === "all" ? "all of" : "any of"}” has nothing in it`);
    for (const a of args) conditionLeaves(a, bad, out);
  } else if (op === "not") {
    conditionLeaves(expr["arg"], bad, out);
  } else if (typeof op === "string" && LOGIC_OPS.has(op)) {
    out.push(expr);
  } else {
    bad.push(`“${String(op)}” is not a check the survey app knows`);
  }
  return out;
}

interface ConditionSubject {
  /** "The display condition of “…” (x.y)". */
  what: string;
  /** "this question", "this section", "this block". */
  shown: string;
  location: IssueLocation;
  /** The administered position the condition is evaluated at. */
  bind: number;
}

function checkTarget(m: Model, c: Collector, s: ConditionSubject, ref: unknown): LiveQuestion | null {
  const r = isObject(ref) ? ref : null;
  if (!r || typeof r["instrument"] !== "string" || typeof r["item"] !== "string") {
    c.error("logic.invalid", `${s.what} doesn't say which question it depends on. Choose a question, or remove the condition.`, s.location);
    return null;
  }
  const key = `${r["instrument"]}.${r["item"]}`;
  const target = m.first.get(key);
  if (!target) {
    const archived = m.archived.get(key);
    c.error(
      "logic.target_missing",
      archived
        ? `${s.what} depends on ${questionLabel(key, archived.item)}, which has been archived. Restore that question, or change the condition.`
        : m.defined.has(key)
          ? `${s.what} depends on “${key}”, which isn't placed in any section. Place it before ${s.shown}, or change the condition.`
          : `${s.what} depends on “${key}”, which doesn't exist in this survey. Change the condition, or remove it.`,
      s.location,
    );
    return null;
  }
  if (target.position >= s.bind) {
    const tl = questionLabel(key, target.item);
    c.error(
      "logic.target_later",
      target.position === s.bind && s.shown === "this question"
        ? `${s.what} depends on its own answer, which can't be known before it is shown. Make it depend on an earlier question.`
        : `${s.what} depends on ${tl}, which is asked ${target.position === s.bind ? "at the same point" : "later"}. A condition can only use answers given before it: move ${tl} earlier, or change the condition.`,
      s.location,
    );
  }
  return target;
}

function scaleCodes(m: Model, target: LiveQuestion): Set<number> | null {
  const scaleKey = (target.item as { scale?: unknown }).scale;
  const scale = typeof scaleKey === "string" ? m.draft.scales[scaleKey] : undefined;
  if (!scale) return null;
  return new Set(list(scale.options).filter(isObject).map((o) => o["code"] as number));
}

function checkCondition(m: Model, c: Collector, s: ConditionSubject, expr: unknown): void {
  const bad: string[] = [];
  const leaves = conditionLeaves(expr, bad);
  for (const problem of bad) c.error("logic.invalid", `${s.what} is incomplete: ${problem}. Finish the condition, or remove it.`, s.location);
  for (const leaf of leaves) {
    const op = String(leaf["op"]);
    const t = isObject(leaf["target"]) ? leaf["target"] : null;
    const target = checkTarget(m, c, s, t?.["item"]);
    if (!target) continue;
    const tl = questionLabel(target.itemKey, target.item);
    const type = String((target.item as { responseType?: unknown }).responseType);
    if (type === "info") {
      c.error("logic.operator_incompatible", `${s.what} depends on ${tl}, which is an information block with no answer. Choose a question instead.`, s.location);
      continue;
    }
    const allowed = OPS_BY_TYPE[type];
    if (allowed && !allowed.has(op)) {
      c.error(
        "logic.operator_incompatible",
        `${s.what} checks whether ${tl} ${OP_PHRASES[op] ?? op}, which can never be true of a ${TYPE_NAMES[type] ?? type} question, so ${s.shown} would never be shown. Choose a different check.`,
        s.location,
      );
      continue;
    }
    const code = leaf["code"];
    if ((op === "selected" || op === "not_selected" || op === "in_group") && typeof code === "number") {
      const codes = scaleCodes(m, target);
      if (codes && !codes.has(code)) {
        c.error("logic.option_missing", `${s.what} refers to option ${code} of ${tl}, which has no such option. Choose one of its options.`, s.location);
      }
    }
    if (op === "in_group") {
      const groups = new Set(list((target.item as { groups?: unknown }).groups).filter(isObject).map((g) => g["key"]));
      if (!groups.has(leaf["group"])) {
        c.error("logic.option_missing", `${s.what} refers to the group “${String(leaf["group"])}” of ${tl}, which has no such group. Choose one of its groups.`, s.location);
      }
    }
    if (op === "eq" || op === "ne") {
      const value = leaf["value"];
      if (NUMBER_VALUED.has(type) && typeof value !== "number") {
        c.error("logic.value_invalid", `${s.what} compares ${tl} with “${String(value)}”, but its answers are numbers. Compare it with a number.`, s.location);
      } else if (STRING_VALUED.has(type) && typeof value !== "string") {
        c.error("logic.value_invalid", `${s.what} compares ${tl} with ${String(value)}, but its answers are text. Compare it with text.`, s.location);
      } else if (type === "single_choice" && typeof value === "number") {
        const codes = scaleCodes(m, target);
        if (codes && !codes.has(value)) {
          c.error("logic.option_missing", `${s.what} refers to option ${value} of ${tl}, which has no such option. Choose one of its options.`, s.location);
        }
      }
    }
    if (op === "not_empty" && type === "form_fields") {
      const fields = new Set(list((target.item as { fields?: unknown }).fields).filter(isObject).map((f) => f["key"]));
      if (!fields.has(t?.["part"])) {
        c.error("logic.part_missing", `${s.what} needs to say which field of ${tl} to check. Choose one of its fields.`, s.location);
      }
    }
    if ((op === "selected" || op === "in_group") && (target.item as { required?: unknown }).required === "optional") {
      c.warn(
        "logic.depends_on_optional",
        `${s.what} needs a particular answer to ${tl}, which is optional: anyone who skips it will never see ${s.shown}. If that is intended, ignore this.`,
        s.location,
      );
    }
  }
}

function checkReference(m: Model, c: Collector, s: ConditionSubject, ref: unknown, needs: "date", what: string): void {
  const target = checkTarget(m, c, s, ref);
  if (!target) return;
  const type = (target.item as { responseType?: unknown }).responseType;
  if (type !== needs) {
    c.error(
      "logic.operator_incompatible",
      `${s.what} ${what}, so it needs a date question, but ${questionLabel(target.itemKey, target.item)} is a ${TYPE_NAMES[String(type)] ?? String(type)} question. Choose a date question.`,
      s.location,
    );
  }
}

function checkLogic(m: Model, c: Collector): void {
  // Item conditions, consistency checks and option limits bind at the item.
  for (const q of m.firstList) {
    const item = q.item as unknown as Loose;
    const label = questionLabel(q.itemKey, item);
    if (item["displayIf"] !== undefined) {
      checkCondition(m, c, { what: `The display condition of ${label}`, shown: "this question", location: questionAt(q, "displayIf"), bind: q.position }, item["displayIf"]);
    }
    for (const check of list(item["crossChecks"])) {
      if (!isObject(check)) continue;
      checkReference(
        m,
        c,
        { what: `The consistency check on ${label}`, shown: "this question", location: questionAt(q, "crossChecks"), bind: q.position },
        check["against"],
        "date",
        "compares the answer with the month of a date",
      );
    }
    if (item["responseType"] === "single_choice" && isObject(item["limitOptions"])) {
      checkReference(
        m,
        c,
        { what: `The option limit on ${label}`, shown: "this question", location: questionAt(q, "limitOptions"), bind: q.position },
        item["limitOptions"]["from"],
        "date",
        "works out the participant's age",
      );
    }
  }
  // Block and section conditions bind at the first question they govern,
  // which is where the participant app first evaluates them.
  const firstInPlacement = new Map<string, number>();
  const firstInSection = new Map<number, number>();
  for (const q of m.live) {
    const pk = `${q.sectionIndex}:${q.componentIndex}`;
    if (!firstInPlacement.has(pk)) firstInPlacement.set(pk, q.position);
    if (!firstInSection.has(q.sectionIndex)) firstInSection.set(q.sectionIndex, q.position);
  }
  list(m.draft.composition.sections).forEach((section, sectionIndex) => {
    if (!isObject(section)) return;
    const key = String(section["key"]);
    const bind = firstInSection.get(sectionIndex);
    if (section["displayIf"] !== undefined && bind !== undefined) {
      checkCondition(
        m,
        c,
        { what: `The condition on the section ${m.sectionTitle(key)}`, shown: "this section", location: at("section", { sectionKey: key, field: "displayIf" }), bind },
        section["displayIf"],
      );
    }
  });
  for (const p of m.places) {
    const component = list(m.draft.composition.sections[p.sectionIndex]?.components)[p.componentIndex];
    const bind = firstInPlacement.get(`${p.sectionIndex}:${p.componentIndex}`);
    if (!isObject(component) || component["displayIf"] === undefined || bind === undefined) continue;
    checkCondition(
      m,
      c,
      { what: `The condition on the block ${instrumentLabel(p.def, p.instrument)}`, shown: "this block", location: blockAt(p, "displayIf"), bind },
      component["displayIf"],
    );
  }
}

function checkSections(m: Model, c: Collector): void {
  const keys = new Set<string>();
  const titles = new Map<string, string>();
  list(m.draft.composition.sections).forEach((section, index) => {
    if (!isObject(section)) {
      c.error("section.malformed", `Section ${index + 1} can't be read. Delete it and add it again.`, at("survey", { field: `sections.${index}` }));
      return;
    }
    const key = section["key"];
    const sectionKey = typeof key === "string" ? key : String(index);
    const title = section["title"];
    if (!isSlug(key)) {
      c.error(
        "section.key_invalid",
        `The section ID “${String(key ?? "")}” can't be used. Section IDs start with a lowercase letter and contain only lowercase letters, numbers and underscores.`,
        at("section", { sectionKey, field: "key" }),
      );
    } else if (keys.has(key)) {
      c.error("section.key_duplicate", `Two sections have the ID “${key}”. Give each section its own ID.`, at("section", { sectionKey, field: "key" }));
    } else keys.add(key);

    if (!hasString(title)) {
      c.error("section.title_missing", `The section “${sectionKey}” has no title. Give it the heading participants will see.`, at("section", { sectionKey, field: "title" }));
    } else {
      const norm = title.trim().toLowerCase();
      const other = titles.get(norm);
      if (other !== undefined) {
        c.warn(
          "section.title_duplicate",
          `The sections “${other}” and “${sectionKey}” are both called “${truncateText(title, 40)}”. Participants see section titles in the progress bar, so give each a distinct title.`,
          at("section", { sectionKey, field: "title" }),
        );
      } else titles.set(norm, sectionKey);
    }

    const components = list(section["components"]);
    const questions = m.live.filter((q) => q.sectionIndex === index).length;
    // A narrative is a step participants take. A "screen" component is not:
    // neither the freeze nor the participant app shows anything for it, so a
    // section holding only screens is as empty as one holding nothing.
    // (Review fix: screens used to count as content.)
    const other = components.filter((comp) => isObject(comp) && comp["kind"] === "narrative").length;
    if (questions === 0 && other === 0) {
      c.error(
        "section.empty",
        `The section ${m.sectionTitle(sectionKey)} has no questions, so participants would see an empty section. Add questions to it, or delete it.`,
        at("section", { sectionKey, field: "components" }),
      );
    }
  });
}

function checkPlacements(m: Model, c: Collector): void {
  for (const p of m.places) {
    if (!p.def) {
      c.error(
        "block.instrument_missing",
        `A block in the section ${m.sectionTitle(p.sectionKey)} refers to “${p.refKey}”, which is not in the survey. Remove the block, or add its questions back.`,
        blockAt(p),
      );
      continue;
    }
    if (!p.form) {
      c.error(
        "block.form_missing",
        `The block ${instrumentLabel(p.def, p.instrument)} in the section ${m.sectionTitle(p.sectionKey)} has no questions in the survey's language and reading level. Remove the block, or choose a version that has.`,
        blockAt(p),
      );
      continue;
    }
    for (const key of p.missing) {
      c.error(
        "block.item_missing",
        `The block ${instrumentLabel(p.def, p.instrument)} in the section ${m.sectionTitle(p.sectionKey)} lists the question “${key}”, which ${p.instrument} doesn't have. Remove it from the block.`,
        at("block", { sectionKey: p.sectionKey, refKey: p.refKey, itemKey: `${p.instrument}.${key}`, field: "items" }),
      );
    }
    if (p.subset) {
      const seen = new Set<string>();
      for (const key of p.subset) {
        if (seen.has(key)) {
          c.error(
            "question.administered_twice",
            `The block ${instrumentLabel(p.def, p.instrument)} in the section ${m.sectionTitle(p.sectionKey)} lists “${p.instrument}.${key}” twice. A question can be asked only once; remove the repeat.`,
            at("block", { sectionKey: p.sectionKey, refKey: p.refKey, itemKey: `${p.instrument}.${key}`, field: "items" }),
          );
        }
        seen.add(key);
      }
    }
  }

  // Every question defined must be asked somewhere: a question the editor
  // forgot to place is not something to drop silently at publish time.
  const liveKeys = new Set(m.live.map((q) => q.itemKey));
  for (const [refKey, def] of Object.entries(m.draft.instruments)) {
    const instrument = String((def as { instrument?: unknown } | null)?.instrument ?? "");
    const items = list(safeForm(def)?.items).filter(isObject);
    const unplaced = items.filter((i) => !liveKeys.has(`${instrument}.${String(i["key"])}`));
    if (items.length > 0 && unplaced.length === items.length) {
      c.error(
        "block.unplaced",
        `${instrumentLabel(def, instrument)} isn't placed in any section, so none of its ${items.length} question${items.length === 1 ? "" : "s"} would be asked. Place it in a section, or remove it from the survey.`,
        at("block", { refKey }),
      );
      continue;
    }
    for (const item of unplaced) {
      const itemKey = `${instrument}.${String(item["key"])}`;
      c.error(
        "question.unplaced",
        `${questionLabel(itemKey, item)} isn't placed in any section, so it would never be asked. Place it in a section, or archive it.`,
        at("question", { itemKey, refKey }),
      );
    }

    // A licensed instrument is administered whole, in its own order. Whether it
    // is licensed is not the draft's copy's say alone (see `lockedTest`).
    if (!m.isLocked(def, refKey, m.draft.unlocked)) continue;
    const ps = m.places.filter((p) => p.refKey === refKey && p.form);
    if (ps.length > 1) {
      c.error(
        "locked.split",
        `${instrumentLabel(def, instrument)} is a licensed, validated instrument and must be asked as one block, but it is placed in ${ps.length} places. Keep it in one place.`,
        blockAt(ps[1]!, "items"),
      );
    } else if (ps[0]?.subset) {
      const order = list(ps[0].form?.items).map((i) => (i as { key?: unknown }).key);
      if (ps[0].subset.join("\u0000") !== order.join("\u0000")) {
        c.error(
          "locked.order_changed",
          `${instrumentLabel(def, instrument)} is a licensed, validated instrument, so all of its questions must be asked in their published order. Put its questions back in order, and include every one.`,
          blockAt(ps[0], "items"),
        );
      }
    }
  }
}

function checkWelcome(m: Model, c: Collector): void {
  const code = m.draft.composition.participantCode as unknown;
  if (!isObject(code)) {
    c.error(
      "welcome.code_missing",
      "The start screen has no participant code. Participants begin by typing the code the research team gives them: set its format, a hint and a label.",
      at("welcome", { field: "participantCode" }),
    );
    return;
  }
  const pattern = code["pattern"];
  if (!hasString(pattern) || !compiles(pattern)) {
    c.error(
      "welcome.code_pattern_invalid",
      hasString(pattern)
        ? `The participant code format (“${pattern}”) is not a valid pattern, so no code could be accepted. Correct the format.`
        : "The participant code has no format, so any text at all would be accepted as a code. Set the format the research team's codes follow.",
      at("welcome", { field: "participantCode.pattern" }),
    );
  }
  if (code["label"] !== undefined && !hasString(code["label"])) {
    c.error(
      "welcome.code_label_missing",
      "The participant code box has no label. Say what should be typed there, for example “Your study code”.",
      at("welcome", { field: "participantCode.label" }),
    );
  }
  if (!hasString(code["hint"])) {
    c.error(
      "welcome.code_hint_missing",
      "The participant code has no hint. Describe the format so participants can tell a mistyped code, for example “Three letters then four numbers”.",
      at("welcome", { field: "participantCode.hint" }),
    );
  }
  const variable = code["variable"];
  if (variable !== undefined) {
    if (!isVariable(variable)) {
      c.error(
        "welcome.code_variable_invalid",
        `The participant code's reporting label “${String(variable)}” can't be used. It must start with a lowercase letter, contain only lowercase letters, numbers and underscores, and be at most 32 characters.`,
        at("welcome", { field: "participantCode.variable" }),
      );
    } else {
      const clash = m.firstList.find((q) => (q.item as { variable?: unknown }).variable === variable);
      if (clash) {
        c.error(
          "welcome.code_variable_duplicate",
          `The participant code is stored as “${variable}”, which ${questionLabel(clash.itemKey, clash.item)} also uses. Choose a different label for one of them.`,
          at("welcome", { field: "participantCode.variable" }),
        );
      }
    }
  }
}

function checkCompletion(m: Model, c: Collector): void {
  const screens = isObject(m.draft.composition.screens) ? (m.draft.composition.screens as Loose) : {};
  const finish = screens["finish"];
  if (!isObject(finish)) {
    c.error(
      "completion.finish_missing",
      "The survey has no finishing screen, so participants would not be told they are done. Add a thank-you message.",
      at("completion", { field: "screens.finish" }),
    );
  } else if (!hasText(finish["body"])) {
    c.error(
      "completion.body_missing",
      "The finishing screen has no message. Type what participants see when they finish, for example a thank-you.",
      at("completion", { field: "screens.finish.body" }),
    );
  }
  for (const [key, screen] of Object.entries(screens)) {
    if (!isObject(screen)) continue;
    const name = key === "finish" ? "The finishing screen" : key === "review" ? "The review screen" : `The screen “${key}”`;
    checkPipes(m, c, screen["title"], `${name}'s heading`, at("completion", { field: `screens.${key}.title` }), Number.POSITIVE_INFINITY);
    checkPipes(m, c, screen["body"], `${name}'s message`, at("completion", { field: `screens.${key}.body` }), Number.POSITIVE_INFINITY);
  }
}

function checkIdentity(m: Model, c: Collector): void {
  for (const q of m.firstList) {
    const item = q.item as unknown as Loose;
    if ((IDENTITY_VARIABLES.has(String(item["variable"])) || LINKAGE.has(q.itemKey)) && item["identifying"] !== true) {
      c.error(
        "identity.not_identifying",
        `${questionLabel(q.itemKey, item)} asks for personal details that identify a participant, but it is not marked identifying, so the answers would go into the research data. Mark it identifying.`,
        questionAt(q, "identifying"),
      );
    }
  }
}

/** Where a locked or protected difference is, as precisely as the draft allows. */
function differenceAt(m: Model, d: LockedDifference): IssueLocation {
  if (d.itemKey) {
    const q = m.first.get(d.itemKey);
    return q ? questionAt(q) : at("question", { itemKey: d.itemKey, refKey: d.refKey });
  }
  const p = m.places.find((pl) => pl.refKey === d.refKey);
  return p ? blockAt(p) : at("block", { refKey: d.refKey });
}

/** A published version with nothing in it: what a survey never published is compared with. */
function nothingPublished(draft: StudioDraft): StudioDraft {
  return {
    format: DRAFT_FORMAT,
    formatVersion: DRAFT_FORMAT_VERSION,
    surveyId: draft.surveyId,
    composition: { ...draft.composition, sections: [] },
    instruments: {},
    scales: {},
    scoring: {},
    archived: [],
    retiredCodes: {},
    unlocked: {},
    notes: {},
  };
}

/** The answer options of a question, as code → label, or null when it has none. */
function optionMap(draft: StudioDraft, item: Loose): string | null {
  const key = item["scale"];
  if (typeof key !== "string") return null;
  const scale = draft.scales?.[key] as unknown as Loose | undefined;
  return canonicalJson(list(scale?.["options"]).map((o) => (isObject(o) ? [o["code"], o["label"]] : o)));
}

function checkAgainstBaseline(m: Model, c: Collector): void {
  const lockedOptions: LockedOptions = {};
  if (m.ctx.reference) lockedOptions.reference = m.ctx.reference;
  if (m.ctx.referenceScales) lockedOptions.referenceScales = m.ctx.referenceScales;
  if (m.ctx.referenceScoring) lockedOptions.referenceScoring = m.ctx.referenceScoring;
  const baseline = m.ctx.baseline;
  if (!baseline) {
    // A survey never published has nothing to compare with, but a licensed
    // instrument in it must still be the library's, unchanged. Only checkable
    // when the library is given; without it (a quick check in the editor)
    // nothing here can be said. (Review fix: previously skipped entirely, so a
    // first publish could carry a reworded licensed instrument.)
    if (m.ctx.reference) {
      for (const d of lockedDifferences(m.draft, nothingPublished(m.draft), lockedOptions)) c.error(`locked.${d.change}`, d.message, differenceAt(m, d));
    }
    return;
  }
  for (const d of lockedDifferences(m.draft, baseline, lockedOptions)) c.error(`locked.${d.change}`, d.message, differenceAt(m, d));
  for (const d of protectedDifferences(m.draft, baseline)) c.error(`protected.${d.change}`, d.message, differenceAt(m, d));

  // Participant linkage: no unlock permits breaking it.
  const unlocked = isUnlocked(m.draft.unlocked, "ybm_identity");
  for (const key of LINKAGE_ITEM_KEYS) {
    const before = m.baseFirst.get(key);
    if (!before) continue;
    const now = m.first.get(key);
    const label = questionLabel(key, before.item);
    if (!now) {
      c.error(
        "linkage.removed",
        `${label} is one of the four answers the participant code is made from, and it has been ${m.archived.has(key) ? "archived" : "removed"}. Without it, later sittings can't be linked to earlier ones. Put it back.`,
        at("question", { itemKey: key, refKey: before.refKey }),
      );
      continue;
    }
    const was = before.item as unknown as Loose;
    const is = now.item as unknown as Loose;
    if (was["responseType"] !== is["responseType"]) {
      c.error(
        "linkage.type_changed",
        `${label} is one of the four answers the participant code is made from, so its question type can't change: a different kind of answer would produce a different code. Change it back.`,
        questionAt(now, "responseType"),
      );
    }
    if (was["variable"] !== is["variable"]) {
      c.error(
        "linkage.variable_changed",
        `${label} is one of the four answers the participant code is made from, so its reporting label must stay “${String(was["variable"])}”. Change it back.`,
        questionAt(now, "variable"),
      );
    } else if (unlocked) {
      const notes = new Set(["researcherNote", "a11yNote", "reportingCategory"]);
      const strip = (x: Loose) => Object.fromEntries(Object.entries(x).filter(([k]) => !notes.has(k)));
      // The options count too: ingest builds the code from the birth month's
      // option *code*, so recoding its options changes every later code as
      // surely as changing the question does. (Review fix: docs/16 R5 says any
      // other change warns, and a recoded scale used to pass silently.)
      if (canonicalJson(strip(was)) !== canonicalJson(strip(is)) || optionMap(baseline, was) !== optionMap(m.draft, is)) {
        c.warn(
          "linkage.changed",
          `${label} is one of the four answers the participant code is made from, and it has changed. If participants now answer it differently, their codes will no longer match earlier sittings. Check the change with whoever manages participant linkage.`,
          questionAt(now),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The publish gate and the schema
// ---------------------------------------------------------------------------

const GATE_RULES: { re: RegExp; code: string; plain: string }[] = [
  { re: /^unresolved narrative protocol /, code: "gate.narrative_unresolved", plain: "A narrative component refers to a protocol that is not available." },
  { re: /^narrative protocol /, code: "gate.narrative", plain: "A narrative component can't be published as it stands." },
  { re: /^unresolved (instrument|module) reference /, code: "gate.reference_unresolved", plain: "A block refers to questions that are not in the survey." },
  { re: /^licence gate: /, code: "gate.licence", plain: "An instrument's licence does not allow it to be used." },
  { re: /^no form of /, code: "gate.form_missing", plain: "An instrument has no version in the survey's language and reading level." },
  { re: /^section '[^']+' places /, code: "gate.subset_missing", plain: "A block lists a question its instrument doesn't have." },
  { re: /^section '[^']+' lists .* twice/, code: "gate.subset_repeated", plain: "A block lists the same question twice." },
  { re: / is administered more than once/, code: "gate.administered_twice", plain: "A question is asked more than once." },
  { re: /^duplicate variable /, code: "gate.variable_duplicate", plain: "Two questions share a reporting label." },
  { re: /^unresolved scale /, code: "gate.scale_unresolved", plain: "A question's answer options can't be found." },
  { re: /^pipe '[^']+' declared but placeholder absent/, code: "gate.pipe_unused", plain: "An inserted answer is set up, but its placeholder is missing from the text." },
  { re: /^pipe '[^']+' on .* lacks an item reference/, code: "gate.pipe_item_missing", plain: "An inserted answer doesn't say which question it comes from." },
  { re: /^unresolved placeholder /, code: "gate.placeholder_unresolved", plain: "Some text contains a placeholder that nothing fills in." },
  { re: /^scoring definition /, code: "gate.scoring_missing", plain: "An instrument's scoring rules are missing." },
  { re: /^duplicate section keys/, code: "gate.section_keys_duplicate", plain: "Two sections have the same ID." },
  { re: /which is not in this release$/, code: "gate.dependency_missing", plain: "A condition or check refers to a question that is not in the survey." },
  { re: /which is asked later/, code: "gate.dependency_later", plain: "A condition or check depends on a question asked later." },
  { re: /^this composition needs engine /, code: "gate.engine_version", plain: "The survey uses features newer than its release declares." },
];

const DOTTED_ITEM = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function gateLocation(m: Model, failure: string): IssueLocation {
  // "duplicate variable 'v' (in 'a' and 'b')": the question in b is the newcomer.
  const variable = /^duplicate variable '([^']+)' \(in '[^']+' and '([^']+)'\)/.exec(failure);
  if (variable) {
    const q = m.firstList.find((x) => x.instrument === variable[2] && (x.item as { variable?: unknown }).variable === variable[1]);
    if (q) return questionAt(q, "variable");
  }
  const candidates: string[] = [];
  const owner = /^([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*):/.exec(failure);
  if (owner) candidates.push(owner[1]!);
  for (const match of failure.matchAll(/ on ([a-z][a-z0-9_]*)\/([a-z][a-z0-9_]*)/g)) candidates.push(`${match[1]}.${match[2]}`);
  for (const match of failure.matchAll(/'([^']+)'/g)) if (DOTTED_ITEM.test(match[1]!)) candidates.push(match[1]!);
  for (const key of candidates) {
    const q = m.first.get(key);
    if (q) return questionAt(q);
    if (m.defined.has(key)) {
      const instrument = key.slice(0, key.indexOf("."));
      const p = m.places.find((pl) => pl.instrument === instrument);
      return at("question", { itemKey: key, ...(p ? { refKey: p.refKey, sectionKey: p.sectionKey } : {}) });
    }
  }
  const section = /section '([^']+)'/.exec(failure);
  if (section) return at("section", { sectionKey: section[1]! });
  for (const match of failure.matchAll(/'([a-z][a-z0-9_]*)(?:@[^']*)?'/g)) {
    const p = m.places.find((pl) => pl.instrument === match[1]);
    if (p) return blockAt(p);
  }
  return at("survey");
}

function checkGate(m: Model, c: Collector): void {
  for (const failure of m.preview.failures) {
    const rule = GATE_RULES.find((r) => r.re.test(failure));
    c.error(
      rule?.code ?? "gate.failure",
      `${rule?.plain ?? "The publish check refused the survey."} Publishing would be refused with: “${failure}”.`,
      gateLocation(m, failure),
    );
  }
}

type ZodIssueLike = { path: (string | number)[]; message: string };

function zodIssues(result: { success: boolean; error?: { issues: ZodIssueLike[] } }): ZodIssueLike[] {
  return result.success ? [] : (result.error?.issues ?? []);
}

/**
 * Where the schema rejects the draft, field by field — only needed when the
 * release could not be frozen at all, and only for what the checks above did
 * not already say more plainly.
 */
function checkSchema(m: Model, c: Collector): void {
  if (!m.preview.error) return;
  const found: { location: IssueLocation; detail: string }[] = [];
  const draft = m.draft;
  const sections = list(draft.composition.sections);

  for (const zi of zodIssues(assessmentDraft.safeParse(draft.composition))) {
    const [head, index, sub, subIndex, ...rest] = zi.path;
    const detail = `${zi.path.join(".") || "survey"}: ${zi.message}`;
    if (head === "sections" && typeof index === "number") {
      const sectionKey = String((sections[index] as Loose | undefined)?.["key"] ?? index);
      if (sub === "components" && typeof subIndex === "number") {
        const p = m.places.find((pl) => pl.sectionIndex === index && pl.componentIndex === subIndex);
        found.push({ location: p ? blockAt(p, rest.join(".") || undefined) : at("block", { sectionKey, field: rest.join(".") || undefined }), detail });
      } else {
        found.push({ location: at("section", { sectionKey, field: sub === undefined ? undefined : String(sub) }), detail });
      }
    } else if (head === "participantCode" || head === "studyLabel" || head === "contact") {
      found.push({ location: at("welcome", { field: zi.path.join(".") }), detail });
    } else if (head === "screens") {
      found.push({ location: at("completion", { field: zi.path.join(".") }), detail });
    } else {
      found.push({ location: at("survey", { field: zi.path.join(".") || undefined }), detail });
    }
  }

  for (const [refKey, def] of Object.entries(draft.instruments)) {
    const schema = (def as { kind?: unknown } | null)?.kind === "module" ? moduleDefinition : instrumentVersion;
    const instrument = String((def as { instrument?: unknown } | null)?.instrument ?? "");
    for (const zi of zodIssues(schema.safeParse(def))) {
      const [head, formIndex, sub, itemIndex, field] = zi.path;
      const detail = `${zi.path.join(".")}: ${zi.message}`;
      if (head === "forms" && sub === "items" && typeof formIndex === "number" && typeof itemIndex === "number") {
        const raw = list(list<Loose>((def as unknown as Loose)["forms"])[formIndex]?.["items"])[itemIndex];
        const itemKey = `${instrument}.${String(isObject(raw) ? raw["key"] : itemIndex)}`;
        const q = m.first.get(itemKey);
        const f = field === undefined ? undefined : String(field);
        found.push({ location: q ? questionAt(q, f) : at("question", { itemKey, refKey, field: f }), detail });
      } else {
        const p = m.places.find((pl) => pl.refKey === refKey);
        found.push({ location: p ? blockAt(p, zi.path.join(".")) : at("block", { refKey, field: zi.path.join(".") }), detail });
      }
    }
  }

  for (const [scaleKey, scale] of Object.entries(draft.scales)) {
    const owner = m.scaleUse.get(scaleKey)?.owner ?? m.firstList.find((q) => (q.item as { scale?: unknown }).scale === scaleKey);
    for (const zi of zodIssues(responseScale.safeParse(scale))) {
      const detail = `${scaleKey}.${zi.path.join(".")}: ${zi.message}`;
      if (!owner) {
        found.push({ location: at("survey", { field: `scales.${scaleKey}` }), detail });
        continue;
      }
      const [head, index] = zi.path;
      const option = head === "options" && typeof index === "number" ? list<Loose>((scale as unknown as Loose)["options"])[index] : undefined;
      const code = isObject(option) && typeof option["code"] === "number" ? option["code"] : undefined;
      found.push({ location: code === undefined ? questionAt(owner, "options") : optionAt(owner, code), detail });
    }
  }
  for (const [scoringKey, scoring] of Object.entries(draft.scoring)) {
    for (const zi of zodIssues(scoringDefinition.safeParse(scoring))) {
      found.push({ location: at("survey", { field: `scoring.${scoringKey}` }), detail: `${scoringKey}.${zi.path.join(".")}: ${zi.message}` });
    }
  }

  // Say each thing once: a field the checks above already explained needs no
  // second, more technical message.
  const where = (l: IssueLocation) => [l.kind, l.itemKey, l.refKey, l.sectionKey, l.field?.split(".")[0], l.optionCode].join("|");
  const explained = new Set(c.issues.filter((i) => i.severity === "error").map((i) => where(i.location)));
  const said = new Set<string>();
  for (const { location, detail } of found) {
    const key = `${where(location)}|${detail}`;
    if (explained.has(where(location)) || said.has(key)) continue;
    said.add(key);
    c.error(
      "schema.invalid",
      `Part of the survey is not in a form the survey app can use (${detail}). Correct it, or undo the last change.`,
      location,
    );
  }
  if (found.length === 0) {
    c.error(
      "draft.unreadable",
      `The survey could not be prepared for publishing: ${m.preview.error}. Undo the last change; if this persists, restore the draft from a published version.`,
      at("survey"),
    );
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Every problem with a draft. Errors block publishing; warnings are shown and
 * can be published over. Never throws.
 */
export function validateDraft(draft: StudioDraft, ctx: ValidationContext = {}): Issue[] {
  const c = new Collector();
  if (
    !isObject(draft) ||
    !isObject(draft.composition) ||
    !Array.isArray(draft.composition.sections) ||
    !isObject(draft.instruments) ||
    !isObject(draft.scales) ||
    !isObject(draft.scoring)
  ) {
    c.error(
      "draft.malformed",
      "This draft is missing part of the survey (its sections, questions, answer options or scoring), so it can't be checked or published. Restore it from a published version.",
      at("survey"),
    );
    return c.issues;
  }
  let model: Model;
  try {
    model = buildModel(draft, ctx, c);
  } catch (error) {
    // Only reachable through something buildModel did not anticipate; the
    // gate and the schema can still speak for the draft.
    c.error(
      "draft.malformed",
      `The survey could not be read (${error instanceof Error ? error.message : String(error)}). Undo the last change, or restore the draft from a published version.`,
      at("survey"),
    );
    const preview = previewRelease(draft);
    for (const failure of preview.failures) c.error("gate.failure", `Publishing would be refused with: “${failure}”.`, at("survey"));
    if (preview.error) c.error("schema.invalid", `Part of the survey is not in a form the survey app can use (${preview.error}).`, at("survey"));
    return c.issues;
  }
  if (model.walked) {
    c.run("welcome screen", () => checkWelcome(model, c));
    c.run("sections", () => checkSections(model, c));
    c.run("blocks", () => checkPlacements(model, c));
    for (const q of model.firstList) c.run(`question ${q.itemKey}`, () => checkQuestion(model, c, q));
    c.run("answer options", () => checkScales(model, c));
    c.run("IDs and reporting labels", () => checkDuplicatesAndReservations(model, c));
    c.run("conditions", () => checkLogic(model, c));
    c.run("identifying questions", () => checkIdentity(model, c));
    c.run("published content", () => checkAgainstBaseline(model, c));
    c.run("finishing screen", () => checkCompletion(model, c));
  }
  c.run("publish check", () => checkGate(model, c));
  c.run("schema", () => checkSchema(model, c));
  return c.issues;
}

export function summariseIssues(issues: Issue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** Whether anything stops the draft being published. */
export function hasBlockingIssues(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** The issues located at one question (its options included). */
export function issuesFor(issues: Issue[], itemKey: string): Issue[] {
  return issues.filter((i) => i.location.itemKey === itemKey);
}
