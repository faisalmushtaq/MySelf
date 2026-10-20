import type { LogicExpr } from "@myself/schema";
import { AnswerStore, evaluate, timeGridCandidates, timeGridCondition, type AnswerValue } from "@myself/engine";
import type { DeviceEvent } from "./ingest.js";

/**
 * Whether a sitting answered what it was required to answer. Rule set `completeness@1`.
 *
 * WRITTEN ONCE, HERE, AND READ BY BOTH SIDES. The researcher view counts "all required
 * answered" with this file, and the research dashboard (faisalmushtaq/MySelf-Dashboard)
 * vendors it verbatim and judges every sitting it summarises with it. Two copies of a
 * rule like this drift, and when they drift the two tools report different completion
 * rates for the same sittings with nothing on either screen to say why — which is how
 * this file came to exist. The dashboard's docs/03-completeness.md is the prose
 * definition; change the two together.
 *
 * Every question in the sitting's OWN release gets exactly one outcome. The difference
 * between "not answered", "hidden by valid branching", "never reached" and "cannot know"
 * is the whole point: counting fields in a document would call a participant without a
 * smartphone 40% incomplete for not answering questions about their social media.
 *
 * Four parts, in the order a sitting passes through them:
 *   1. `indexReleaseQuestions` — the release's questions, in the order and with the
 *      display conditions the participant app builds (apps/participant flatten.ts);
 *   2. `replaySitting` — the event log reduced to per-question facts;
 *   3. `validateAnswer` — whether a recorded value fits the question as that release
 *      defines it;
 *   4. `assessSitting` — one outcome per question, and the counts.
 */
export const RULES_VERSION = "completeness@2";

export type RequiredLevel = "hard" | "soft" | "optional";

// ── 1. The release's questions ─────────────────────────────────────────────

export interface OptionDef {
  code: number;
  label: string;
  /** substantive | decline | dont_know | not_applicable | other_specify */
  kind: string;
  /** The number the code stands for, where it is not the code itself (an age band's age). */
  value?: number;
}

/** One question as a particular release defines it. */
export interface ReleaseQuestion {
  /** Stable id: "<instrument>.<item>". */
  key: string;
  instrument: string;
  item: string;
  revision: number;
  /** The survey's own variable name, as stored. */
  variable: string;
  sectionKey: string;
  sectionTitle: string;
  /** Position among the release's questions, 0-based. */
  order: number;
  /** Participant-facing wording in this release (pipes left as placeholders). */
  text: string;
  /** The instrument's instructions, shown before its first question. */
  instructions?: string;
  responseType: string;
  required: RequiredLevel;
  allowDecline: boolean;
  identifying: boolean;
  /** Section ∧ component ∧ item conditions, as the participant's device builds them. */
  displayIf?: LogicExpr;
  scaleKey?: string;
  options?: OptionDef[];
  /** The limits an answer is judged against (min, max, pattern, fields …). */
  constraints: Record<string, unknown>;
  /** The item exactly as the release froze it, for a reader that needs more than this. */
  definition: Readonly<Record<string, unknown>>;
}

export interface ReleaseSection {
  key: string;
  title: string;
  order: number;
  conditional: boolean;
  questionKeys: string[];
}

export interface ReleaseQuestions {
  sections: ReleaseSection[];
  questions: ReleaseQuestion[];
  byKey: Map<string, ReleaseQuestion>;
  /** Every presentable unit key, including info screens, instructions and narratives. */
  unitKeys: Set<string>;
  /** Section of every presentable unit (for "current section" of a sitting). */
  unitSection: Map<string, string>;
  /** Presentation order of every unit, for drop-off ordering. */
  unitOrder: Map<string, number>;
}

/**
 * The parts of a release manifest the index reads.
 *
 * Structural rather than the schema's `ReleaseManifest`, so that the survey's own
 * strictly parsed manifest and the dashboard's tolerant reading of one (which passes
 * through fields it has not heard of) are both accepted as they are.
 */
export interface ManifestForQuestions {
  composition: {
    sections: readonly {
      key: string;
      title: string;
      displayIf?: unknown;
      components: readonly {
        kind: string;
        ref?: {
          instrument: string;
          version: string;
          variant?: string | undefined;
          language: string;
          informant?: string | undefined;
          readingLevel?: string | undefined;
        };
        displayIf?: unknown;
        protocol?: string;
      }[];
    }[];
  };
  instruments: Readonly<Record<string, unknown>>;
  scales: Readonly<Record<string, unknown>>;
}

/** Constraint fields copied from an item, for `validateAnswer`. */
const CONSTRAINT_KEYS = [
  "min",
  "max",
  "step",
  "integerOnly",
  "minChars",
  "maxChars",
  "pattern",
  "minSelections",
  "maxSelections",
  "rungs",
  "lowestValue",
  "minYear",
  "maxYear",
  "fields",
  // The address question's street search (r9.0.0, D-53): names the two keys a
  // chosen street adds beside the fields.
  "streetCheck",
  "statements",
  "groups",
  // A time grid's ceiling on one row, in minutes.
  "maxMinutesPerRow",
] as const;

const and = (a: LogicExpr | undefined, b: LogicExpr | undefined): LogicExpr | undefined => {
  if (a && b) return { op: "all", args: [a, b] };
  return a ?? b;
};

interface FrozenItem {
  key: string;
  revision?: number;
  variable: string;
  responseType: string;
  stem?: { text?: string };
  required?: RequiredLevel;
  allowDecline?: boolean;
  identifying?: boolean;
  displayIf?: LogicExpr;
  scale?: string;
}

interface FrozenInstrument {
  instrument: string;
  forms: { items: FrozenItem[]; instructions?: string }[];
}

/**
 * A time grid's rows-exist condition and candidate rows, from its source among the
 * questions already indexed. A source that is missing or after the grid is one the
 * publish gate refuses; read tolerantly, the grid then has no extra condition.
 */
function gridOf(
  definition: Record<string, unknown>,
  earlier: readonly ReleaseQuestion[],
  scales: Readonly<Record<string, unknown>>,
): { condition: LogicExpr; options: OptionDef[] } | undefined {
  const from = definition["rowsFrom"] as { instrument: string; item: string; revision: number; group?: string } | undefined;
  if (!from) return undefined;
  const source = earlier.find((q) => q.key === `${from.instrument}.${from.item}`);
  const raw = source?.scaleKey ? (scales[source.scaleKey] as { options?: unknown } | undefined)?.options : undefined;
  if (!source || !Array.isArray(raw)) return undefined;
  const options = raw as { code: number; label: string; kind?: string; position?: number }[];
  const groups = source.definition["groups"] as { key: string }[] | undefined;
  const sourceItem = { responseType: source.responseType, groups };
  return {
    condition: timeGridCondition(from, sourceItem, options),
    options: timeGridCandidates(options).map((o) => ({ code: o.code, label: o.label, kind: o.kind ?? "substantive" })),
  };
}

/**
 * The questions of one release, in the order a participant meets them.
 *
 * Walks sections → components → items with the same condition conjunction as
 * `flattenManifest` in the participant app, so "question 37" and "would this have been
 * shown" mean the same thing on the device, in the researcher view and in the dashboard.
 * `info` items, instrument instructions and narrative markers are presentable units but
 * not questions.
 */
export function indexReleaseQuestions(manifest: ManifestForQuestions): ReleaseQuestions {
  const scales = new Map<string, OptionDef[]>();
  for (const [key, value] of Object.entries(manifest.scales)) {
    const options = (value as { options?: unknown } | null)?.options;
    if (!Array.isArray(options)) continue;
    scales.set(
      key,
      (options as { code: number; label: string; kind?: string; value?: number }[]).map((o) => ({
        code: o.code,
        label: o.label,
        kind: o.kind ?? "substantive",
        ...(o.value !== undefined && o.value !== o.code ? { value: o.value } : {}),
      })),
    );
  }

  const sections: ReleaseSection[] = [];
  const questions: ReleaseQuestion[] = [];
  const unitKeys = new Set<string>();
  const unitSection = new Map<string, string>();
  const unitOrder = new Map<string, number>();
  let unitIndex = 0;

  const addUnit = (key: string, sectionKey: string) => {
    unitKeys.add(key);
    unitSection.set(key, sectionKey);
    if (!unitOrder.has(key)) unitOrder.set(key, unitIndex);
    unitIndex += 1;
  };

  manifest.composition.sections.forEach((sec, sectionOrder) => {
    const def: ReleaseSection = {
      key: sec.key,
      title: sec.title,
      order: sectionOrder,
      conditional: sec.displayIf !== undefined,
      questionKeys: [],
    };
    sections.push(def);
    for (const comp of sec.components) {
      if (comp.kind === "narrative" && comp.protocol) {
        addUnit(`${comp.protocol}.__narrative_${comp.protocol.replace(/^np\./, "")}`, sec.key);
        continue;
      }
      if ((comp.kind !== "instrument" && comp.kind !== "module") || !comp.ref) continue;
      const ref = comp.ref;
      const refKey = `${ref.instrument}@${ref.version}${ref.variant ? `+${ref.variant}` : ""}/${ref.language}/${ref.informant ?? "self"}/${ref.readingLevel ?? "standard"}`;
      const inst = manifest.instruments[refKey] as FrozenInstrument | undefined;
      const form = inst?.forms?.[0];
      if (!form) throw new Error(`manifest inconsistency: '${refKey}' is placed but not frozen`);
      const componentCondition = and(sec.displayIf as LogicExpr | undefined, comp.displayIf as LogicExpr | undefined);
      if (form.instructions) addUnit(`${ref.instrument}.__instructions_${ref.instrument}`, sec.key);
      for (const it of form.items) {
        const key = `${ref.instrument}.${it.key}`;
        addUnit(key, sec.key);
        if (it.responseType === "info") continue;
        const definition = it as unknown as Record<string, unknown>;
        // A time grid is asked only when its source gave it a row, exactly as
        // the device's walk conjoins it; its options are the rows it could have.
        const grid = it.responseType === "time_grid" ? gridOf(definition, questions, manifest.scales) : undefined;
        const displayIf = and(and(componentCondition, it.displayIf), grid?.condition);
        const constraints: Record<string, unknown> = {};
        for (const c of CONSTRAINT_KEYS) if (definition[c] !== undefined) constraints[c] = definition[c];
        const q: ReleaseQuestion = {
          key,
          instrument: ref.instrument,
          item: it.key,
          revision: it.revision ?? 1,
          variable: it.variable,
          sectionKey: sec.key,
          sectionTitle: sec.title,
          order: questions.length,
          text: it.stem?.text ?? "",
          ...(form.instructions ? { instructions: form.instructions } : {}),
          responseType: it.responseType,
          required: it.required ?? "soft",
          allowDecline: it.allowDecline ?? false,
          identifying: it.identifying ?? false,
          ...(displayIf ? { displayIf } : {}),
          ...(it.scale ? { scaleKey: it.scale } : {}),
          ...(it.scale && scales.has(it.scale) ? { options: scales.get(it.scale)! } : {}),
          ...(grid ? { options: grid.options } : {}),
          constraints,
          definition,
        };
        questions.push(q);
        def.questionKeys.push(key);
      }
    }
  });

  return {
    sections,
    questions,
    byKey: new Map(questions.map((q) => [q.key, q])),
    unitKeys,
    unitSection,
    unitOrder,
  };
}

// ── 2. The log, replayed ──────────────────────────────────────────────────

/**
 * Same rule as `ingest`'s replay: events in `seq` order, and the last statement about
 * an item wins — which is how the participant experienced it. Nothing here judges
 * completeness; it only records what happened. It records more than `ingest` needs
 * (presentations, drop-off, clocks), which is why it is its own pass.
 */

export type ResponseKind = "answered" | "skipped" | "declined";

export interface ItemFacts {
  key: string;
  /** Last response statement, or null when the item never received one. */
  response: ResponseKind | null;
  /** Raw recorded value (may be identifying or free text). */
  value: unknown;
  presentedCount: number;
  firstPresentedAt?: string;
  lastPresentedSeq?: number;
  respondedAt?: string;
  changed: boolean;
  tooFast: boolean;
  inconsistent: boolean;
  dwellMs?: number;
}

export interface ReplayResult {
  items: Map<string, ItemFacts>;
  /** The survey reached its end (`complete` flag or a `session.completed` event). */
  terminal: boolean;
  completedEvent: boolean;
  hasPresentationEvents: boolean;
  /** Latest device timestamp of any event. */
  lastActivityAt?: string;
  /** Latest device timestamp of a response event. */
  lastResponseAt?: string;
  firstEventAt?: string;
  durationMs?: number;
  foregroundMs?: number;
  wallClockMs?: number;
  resumedCount: number;
  reviewEdits: number;
  backNavigations: number;
  tooFastCount: number;
  inconsistentCount: number;
  eventCount: number;
  /** Events whose timestamp could not be parsed. */
  badTimestamps: number;
}

/** A sitting as far as the replay needs one: its log and its own completion flag. */
export interface LoggedSitting {
  events?: readonly DeviceEvent[] | undefined;
  complete?: boolean | undefined;
}

const isoOrUndefined = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
};

export function replaySitting(sitting: LoggedSitting): ReplayResult {
  const items = new Map<string, ItemFacts>();
  const at = (key: string): ItemFacts => {
    let f = items.get(key);
    if (!f) {
      f = { key, response: null, value: undefined, presentedCount: 0, changed: false, tooFast: false, inconsistent: false };
      items.set(key, f);
    }
    return f;
  };

  let completedEvent = false;
  let hasPresentationEvents = false;
  let durationMs: number | undefined;
  let foregroundMs: number | undefined;
  let resumedCount = 0;
  let reviewEdits = 0;
  let backNavigations = 0;
  let tooFastCount = 0;
  let inconsistentCount = 0;
  let badTimestamps = 0;
  let last: number | undefined;
  let first: number | undefined;
  let lastResponse: number | undefined;

  const ordered: DeviceEvent[] = [...(sitting.events ?? [])].sort((a, b) => a.seq - b.seq);
  for (const e of ordered) {
    const t = isoOrUndefined(e.tWall);
    if (t === undefined) badTimestamps += 1;
    else {
      last = last === undefined ? t : Math.max(last, t);
      first = first === undefined ? t : Math.min(first, t);
    }
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "item.presented": {
        hasPresentationEvents = true;
        if (!e.itemKey) break;
        const f = at(e.itemKey);
        f.presentedCount += 1;
        f.firstPresentedAt ??= e.tWall;
        f.lastPresentedSeq = e.seq;
        break;
      }
      case "response.recorded":
      case "response.changed": {
        if (!e.itemKey) break;
        const f = at(e.itemKey);
        // A second statement about an answered item is a change, whichever event
        // type the device used for it.
        if (e.type === "response.changed" || f.response === "answered") f.changed = true;
        f.response = "answered";
        f.value = p["value"];
        f.respondedAt = e.tWall;
        if ((p["timing"] as { tooFast?: boolean } | undefined)?.tooFast) f.tooFast = true;
        if (t !== undefined) lastResponse = lastResponse === undefined ? t : Math.max(lastResponse, t);
        break;
      }
      case "item.skipped":
      case "item.declined": {
        if (!e.itemKey) break;
        const f = at(e.itemKey);
        f.response = e.type === "item.skipped" ? "skipped" : "declined";
        f.value = undefined;
        f.respondedAt = e.tWall;
        if (t !== undefined) lastResponse = lastResponse === undefined ? t : Math.max(lastResponse, t);
        break;
      }
      case "item.left": {
        if (!e.itemKey) break;
        const total = p["totalDwellMs"];
        if (typeof total === "number") at(e.itemKey).dwellMs = total;
        break;
      }
      case "response.too_fast":
        tooFastCount += 1;
        if (e.itemKey) at(e.itemKey).tooFast = true;
        break;
      case "response.inconsistent":
        inconsistentCount += 1;
        if (e.itemKey) at(e.itemKey).inconsistent = true;
        break;
      case "review.edited":
        reviewEdits += 1;
        break;
      case "navigation.back":
        backNavigations += 1;
        break;
      case "session.resumed":
        resumedCount += 1;
        break;
      case "session.completed": {
        completedEvent = true;
        if (typeof p["totalMs"] === "number") durationMs = p["totalMs"] as number;
        if (typeof p["foregroundMs"] === "number") foregroundMs = p["foregroundMs"] as number;
        break;
      }
    }
  }

  return {
    items,
    terminal: sitting.complete === true || completedEvent,
    completedEvent,
    hasPresentationEvents,
    ...(last !== undefined ? { lastActivityAt: new Date(last).toISOString() } : {}),
    ...(lastResponse !== undefined ? { lastResponseAt: new Date(lastResponse).toISOString() } : {}),
    ...(first !== undefined ? { firstEventAt: new Date(first).toISOString() } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(foregroundMs !== undefined ? { foregroundMs } : {}),
    ...(first !== undefined && last !== undefined && last > first ? { wallClockMs: last - first } : {}),
    resumedCount,
    reviewEdits,
    backNavigations,
    tooFastCount,
    inconsistentCount,
    eventCount: ordered.length,
    badTimestamps,
  };
}

// ── 3. Whether a recorded value is a valid answer ─────────────────────────

/**
 * Whether a recorded value is a valid answer to this question AS THIS RELEASE DEFINES IT.
 *
 * `empty` distinguishes a legitimately empty answer the definition allows (a
 * multi-choice with no minimum and nothing ticked) from a missing one. `reason` is
 * shown to a researcher, so it says what is wrong in words.
 */
export interface ValidationResult {
  valid: boolean;
  empty: boolean;
  reason?: string;
}

const ok = (empty = false): ValidationResult => ({ valid: true, empty });
const bad = (reason: string): ValidationResult => ({ valid: false, empty: false, reason });

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const num = (c: Record<string, unknown>, k: string): number | undefined =>
  typeof c[k] === "number" ? (c[k] as number) : undefined;

function testPattern(pattern: unknown, text: string): boolean {
  if (typeof pattern !== "string") return true;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    // A pattern the reader cannot compile is not the participant's fault.
    return true;
  }
}

export function validateAnswer(
  q: Pick<ReleaseQuestion, "responseType" | "constraints" | "options">,
  value: unknown,
): ValidationResult {
  if (value === null || value === undefined || typeof value !== "object") {
    return bad("no value was recorded with the answer (corrupted)");
  }
  const v = value as Record<string, unknown>;
  const c = q.constraints;
  const codes = new Set((q.options ?? []).map((o) => o.code));

  switch (q.responseType) {
    case "single_choice": {
      if (v["kind"] !== "choice" || !isInt(v["code"])) return bad("expected a single option code");
      if (codes.size > 0 && !codes.has(v["code"])) return bad(`option code ${v["code"]} does not exist in this version`);
      return ok();
    }
    case "multi_choice": {
      if (v["kind"] !== "multi" || !Array.isArray(v["codes"])) return bad("expected a list of option codes");
      const list = v["codes"] as unknown[];
      if (!list.every(isInt)) return bad("option codes must be whole numbers");
      const unknown = (list as number[]).filter((x) => codes.size > 0 && !codes.has(x));
      if (unknown.length > 0) return bad(`option code(s) ${unknown.join(", ")} do not exist in this version`);
      const min = num(c, "minSelections") ?? 0;
      const max = num(c, "maxSelections");
      if (list.length < min) return bad(`at least ${min} selection(s) required`);
      if (max !== undefined && list.length > max) return bad(`at most ${max} selection(s) allowed`);
      return ok(list.length === 0);
    }
    case "slider":
    case "numeric": {
      if (v["kind"] !== "number" || typeof v["value"] !== "number" || !Number.isFinite(v["value"])) {
        return bad("expected a number");
      }
      const n = v["value"] as number;
      const min = num(c, "min");
      const max = num(c, "max");
      if (min !== undefined && n < min) return bad(`${n} is below the minimum ${min}`);
      if (max !== undefined && n > max) return bad(`${n} is above the maximum ${max}`);
      if (q.responseType === "numeric" && c["integerOnly"] !== false && !Number.isInteger(n)) {
        return bad(`${n} is not a whole number`);
      }
      return ok();
    }
    case "ladder": {
      if (v["kind"] !== "number" || !isInt(v["value"])) return bad("expected a rung number");
      const low = num(c, "lowestValue") ?? 1;
      const rungs = num(c, "rungs");
      const n = v["value"] as number;
      if (n < low || (rungs !== undefined && n > low + rungs - 1)) return bad(`rung ${n} is outside the ladder`);
      return ok();
    }
    case "date": {
      if (v["kind"] !== "date" || typeof v["iso"] !== "string" || Number.isNaN(Date.parse(v["iso"] as string))) {
        return bad("expected a date");
      }
      const year = new Date(v["iso"] as string).getUTCFullYear();
      const minY = num(c, "minYear");
      const maxY = num(c, "maxYear");
      if (minY !== undefined && year < minY) return bad(`year ${year} is before ${minY}`);
      if (maxY !== undefined && year > maxY) return bad(`year ${year} is after ${maxY}`);
      return ok();
    }
    case "text_short":
    case "text_long": {
      if (v["kind"] !== "text" || typeof v["value"] !== "string") return bad("expected text");
      const text = v["value"] as string;
      const min = num(c, "minChars") ?? 0;
      const max = num(c, "maxChars");
      if (text.length < min) return bad(`shorter than ${min} characters`);
      if (max !== undefined && text.length > max) return bad(`longer than ${max} characters`);
      if (!testPattern(c["pattern"], text)) return bad("does not match the expected format");
      return ok(text.trim().length === 0);
    }
    case "form_fields": {
      if (v["kind"] !== "fields" || typeof v["values"] !== "object" || v["values"] === null) return bad("expected form fields");
      const values = v["values"] as Record<string, unknown>;
      const fields = (Array.isArray(c["fields"]) ? c["fields"] : []) as { key: string; required?: boolean; pattern?: string }[];
      for (const f of fields) {
        const raw = values[f.key];
        if (raw !== undefined && typeof raw !== "string") return bad(`field ${f.key} is not text`);
        if (f.required && (!raw || raw.trim().length === 0)) return bad(`required field ${f.key} is empty`);
        // Judged on the trimmed value, as the device judges it: "LS6 2AA " is a postcode.
        if (raw && raw.trim().length > 0 && !testPattern(f.pattern, raw.trim())) return bad(`field ${f.key} does not match its format`);
      }
      const known = new Set(fields.map((f) => f.key));
      // A street chosen from the survey's list is recorded beside the fields,
      // under the keys the item's street check names (r9.0.0 on, D-53).
      const street = c["streetCheck"] as { areaKey?: unknown; districtKey?: unknown } | undefined;
      for (const k of [street?.areaKey, street?.districtKey]) if (typeof k === "string") known.add(k);
      const stray = Object.keys(values).filter((k) => known.size > 0 && !known.has(k));
      if (stray.length > 0) return bad(`unknown field(s) ${stray.join(", ")}`);
      return ok(Object.values(values).every((x) => typeof x !== "string" || x.trim().length === 0));
    }
    case "rank_group": {
      if (v["kind"] !== "group_rank" || typeof v["assignments"] !== "object" || v["assignments"] === null) {
        return bad("expected a grouping");
      }
      const groups = new Set(
        ((Array.isArray(c["groups"]) ? c["groups"] : []) as { key: string }[]).map((g) => g.key),
      );
      for (const [code, a] of Object.entries(v["assignments"] as Record<string, { group?: unknown }>)) {
        if (codes.size > 0 && !codes.has(Number(code))) return bad(`option code ${code} does not exist in this version`);
        if (groups.size > 0 && !groups.has(String(a?.group))) return bad(`group ${String(a?.group)} does not exist`);
      }
      return ok(Object.keys(v["assignments"] as object).length === 0);
    }
    case "time_grid": {
      // Judged against every row the grid could have: which of them this sitting
      // was shown depends on another answer, and ingest files the rest as not presented.
      if (v["kind"] !== "time_grid" || typeof v["minutes"] !== "object" || v["minutes"] === null) {
        return bad("expected minutes for each row");
      }
      const max = num(c, "maxMinutesPerRow") ?? 24 * 60;
      const entries = Object.entries(v["minutes"] as Record<string, unknown>);
      for (const [code, n] of entries) {
        if (codes.size > 0 && !codes.has(Number(code))) return bad(`row ${code} does not exist in this version`);
        if (n === null) continue;
        if (!isInt(n) || n < 0) return bad(`row ${code} is not a whole number of minutes`);
        if (n > max) return bad(`row ${code} is more than ${max} minutes`);
      }
      return ok(entries.every(([, n]) => n === null));
    }
    case "checkbox_set": {
      if (v["kind"] !== "checkboxes" || !Array.isArray(v["checked"])) return bad("expected ticked statements");
      const statements = (Array.isArray(c["statements"]) ? c["statements"] : []) as { key: string }[];
      const known = new Set(statements.map((s) => s.key));
      const stray = (v["checked"] as unknown[]).filter((k) => typeof k !== "string" || (known.size > 0 && !known.has(k)));
      if (stray.length > 0) return bad("a ticked statement does not exist in this version");
      return ok((v["checked"] as unknown[]).length === 0);
    }
    default:
      // A response type this reader does not know: record it as given rather
      // than calling a participant's answer invalid because the reader is old.
      return ok();
  }
}

// ── 4. The assessment ─────────────────────────────────────────────────────

export const OUTCOMES = [
  "answered",
  "declined",
  "invalid",
  "skipped",
  "no_response",
  "not_reached",
  "eligible_not_shown",
  "hidden_branching",
  "answered_hidden",
  "undetermined",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Outcomes that count as a missing answer to a required question. */
export const MISSING: ReadonlySet<Outcome> = new Set(["invalid", "skipped", "no_response", "not_reached", "eligible_not_shown"]);
/** Outcomes that satisfy a required question. */
export const RESOLVED: ReadonlySet<Outcome> = new Set(["answered", "declined"]);
/** Outcomes removed from every denominator. */
export const EXCLUDED: ReadonlySet<Outcome> = new Set(["hidden_branching", "answered_hidden", "undetermined"]);

export type Eligibility = "yes" | "no" | "unknown";

export interface QuestionOutcome {
  key: string;
  outcome: Outcome;
  eligibility: Eligibility;
  shown: boolean;
  presentedCount: number;
  /** Counts as required under the rules in force (independent of eligibility). */
  requiredLevel: boolean;
  missing: boolean;
  resolved: boolean;
  /** An answer the definition allows to be empty, and it is. */
  emptyValue: boolean;
  invalidReason?: string;
  /** Raw value. Identifying and free-text values must not be shown from here. */
  value?: unknown;
  respondedAt?: string;
  changed: boolean;
  tooFast: boolean;
  inconsistent: boolean;
  dwellMs?: number;
}

export interface SectionResult {
  key: string;
  title: string;
  required: number;
  resolved: number;
  eligible: number;
  answered: number;
  reached: boolean;
  /** False when no question in the section applied (e.g. a skipped-by-logic section). */
  applicable: boolean;
  completion: number | null;
}

export interface Counts {
  questions: number;
  eligible: number;
  shown: number;
  answered: number;
  declined: number;
  invalid: number;
  skipped: number;
  noResponse: number;
  notReached: number;
  eligibleNotShown: number;
  hiddenBranching: number;
  answeredHidden: number;
  undetermined: number;
  required: number;
  requiredResolved: number;
  requiredMissing: number;
  requiredUndetermined: number;
}

export interface Assessment {
  rulesVersion: string;
  releaseKnown: boolean;
  terminal: boolean;
  hasResponses: boolean;
  outcomes: QuestionOutcome[];
  counts: Counts;
  /** 0..1, or null when not applicable / unavailable. */
  requiredCompletion: number | null;
  answeredRate: number | null;
  estimated: boolean;
  estimateReasons: string[];
  sections: SectionResult[];
  missingRequiredKeys: string[];
  invalidKeys: string[];
  /** Last question shown (the drop-off point for an unfinished sitting). */
  lastPresentedKey?: string;
  /** Section of the last presentable unit shown. */
  finalSectionKey?: string;
  /** Item keys in the log that this release does not define. */
  unknownItemKeys: string[];
}

const emptyCounts = (): Counts => ({
  questions: 0,
  eligible: 0,
  shown: 0,
  answered: 0,
  declined: 0,
  invalid: 0,
  skipped: 0,
  noResponse: 0,
  notReached: 0,
  eligibleNotShown: 0,
  hiddenBranching: 0,
  answeredHidden: 0,
  undetermined: 0,
  required: 0,
  requiredResolved: 0,
  requiredMissing: 0,
  requiredUndetermined: 0,
});

/**
 * Three-valued (Kleene) evaluation of a display condition.
 *
 * A leaf that reads a question whose final state is not yet known — the sitting
 * has not finished and that question has no response — is `unknown`. Everything
 * else is decided by the survey engine's own `evaluate()` on that leaf, so a known
 * answer is judged exactly as the device judged it. `all`/`any`/`not` combine with
 * the usual short-circuits: `any(true, unknown)` is true, `all(false, unknown)` is false.
 */
function evaluate3(expr: LogicExpr, store: AnswerStore, unknownKeys: ReadonlySet<string>, asOf: Date | undefined): Eligibility {
  switch (expr.op) {
    case "all": {
      let sawUnknown = false;
      for (const a of expr.args) {
        const r = evaluate3(a, store, unknownKeys, asOf);
        if (r === "no") return "no";
        if (r === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : "yes";
    }
    case "any": {
      let sawUnknown = false;
      for (const a of expr.args) {
        const r = evaluate3(a, store, unknownKeys, asOf);
        if (r === "yes") return "yes";
        if (r === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : "no";
    }
    case "not": {
      const r = evaluate3(expr.arg, store, unknownKeys, asOf);
      return r === "unknown" ? "unknown" : r === "yes" ? "no" : "yes";
    }
    default: {
      const key = `${expr.target.item.instrument}.${expr.target.item.item}`;
      if (unknownKeys.has(key)) return "unknown";
      return evaluate(expr, store, asOf) ? "yes" : "no";
    }
  }
}

export interface AssessOptions {
  /** Which `required` levels count as required. Both apps default to hard and soft. */
  requiredLevels: readonly RequiredLevel[];
  /**
   * When the sitting started (ISO). Age conditions are judged on this day, as the
   * device judged them (D-51); without it they are false, as on the device.
   */
  sittingStart?: string | null | undefined;
}

/**
 * Assess one sitting against its own release.
 *
 * `release` is null when the sitting's release is not known to the reader; the result
 * then says so (`releaseKnown: false`, completeness null) rather than guessing by
 * reading it through another release.
 */
export function assessSitting(replay: ReplayResult, release: ReleaseQuestions | null, options: AssessOptions): Assessment {
  const hasResponses = [...replay.items.values()].some((f) => f.response !== null);
  if (!release) {
    return {
      rulesVersion: RULES_VERSION,
      releaseKnown: false,
      terminal: replay.terminal,
      hasResponses,
      outcomes: [],
      counts: emptyCounts(),
      requiredCompletion: null,
      answeredRate: null,
      estimated: false,
      estimateReasons: [],
      sections: [],
      missingRequiredKeys: [],
      invalidKeys: [],
      unknownItemKeys: [],
    };
  }

  // The answer state the device's walker would see, built up in survey order as
  // each question is judged: answered items with their values, skips and
  // declines as statuses — and nothing from a question that is hidden, so a
  // hidden question's answer never opens a branch below it (completeness@2,
  // the cascading rule the walker and ingest use).
  const started = options.sittingStart ? new Date(options.sittingStart) : undefined;
  const asOf = started && !Number.isNaN(started.getTime()) ? started : undefined;
  const store = new AnswerStore();
  const record = (f: ItemFacts) => {
    if (!f.response) return;
    const [instrument = "", item = ""] = f.key.split(".");
    const ref = { instrument, item, revision: 1 };
    if (f.response === "answered") store.set(ref, { status: "answered", value: f.value as AnswerValue });
    else store.set(ref, { status: f.response });
  };

  // Questions whose final state is still open: the sitting has not finished and
  // they have no response. A condition reading one of these cannot be decided.
  const unknownKeys = new Set<string>();
  if (!replay.terminal) {
    for (const q of release.questions) {
      if (!replay.items.get(q.key)?.response) unknownKeys.add(q.key);
    }
  }

  const required = new Set(options.requiredLevels);
  const outcomes: QuestionOutcome[] = [];
  const counts = emptyCounts();
  const missingRequiredKeys: string[] = [];
  const invalidKeys: string[] = [];
  const estimateReasons = new Set<string>();
  if (!replay.hasPresentationEvents && hasResponses) estimateReasons.add("no_presentation_events");

  for (const q of release.questions) {
    const f = replay.items.get(q.key);
    const eligibility: Eligibility = q.displayIf ? evaluate3(q.displayIf, store, unknownKeys, asOf) : "yes";
    if (f && eligibility !== "no") record(f);
    const presentedCount = f?.presentedCount ?? 0;
    const shown = presentedCount > 0 || (!replay.hasPresentationEvents && (f?.response ?? null) !== null);
    let outcome: Outcome;
    let emptyValue = false;
    let invalidReason: string | undefined;

    if (f?.response === "answered") {
      if (eligibility === "no") outcome = "answered_hidden";
      else {
        const check = validateAnswer(q, f.value);
        if (check.valid) {
          outcome = "answered";
          emptyValue = check.empty;
        } else {
          outcome = "invalid";
          invalidReason = check.reason;
        }
      }
    } else if (f?.response === "declined") {
      outcome = eligibility === "no" ? "answered_hidden" : "declined";
    } else if (f?.response === "skipped") {
      outcome = eligibility === "no" ? "hidden_branching" : "skipped";
    } else if (shown) {
      // Seen, so it applied at the time; if a later change hid it, it no longer counts.
      outcome = eligibility === "no" ? "hidden_branching" : "no_response";
    } else if (eligibility === "no") {
      outcome = "hidden_branching";
    } else if (eligibility === "unknown") {
      outcome = "undetermined";
    } else {
      outcome = replay.terminal ? "eligible_not_shown" : "not_reached";
    }

    const requiredLevel = required.has(q.required);
    const missing = requiredLevel && MISSING.has(outcome);
    const resolved = RESOLVED.has(outcome);
    outcomes.push({
      key: q.key,
      outcome,
      // Seen or answered means it applied at the time, even if the condition now
      // reads a question that is still open.
      eligibility: eligibility === "unknown" && (shown || f?.response) ? "yes" : eligibility,
      shown,
      presentedCount,
      requiredLevel,
      missing,
      resolved,
      emptyValue,
      ...(invalidReason ? { invalidReason } : {}),
      ...(f && f.response === "answered" ? { value: f.value } : {}),
      ...(f?.respondedAt ? { respondedAt: f.respondedAt } : {}),
      changed: f?.changed ?? false,
      tooFast: f?.tooFast ?? false,
      inconsistent: f?.inconsistent ?? false,
      ...(f?.dwellMs !== undefined ? { dwellMs: f.dwellMs } : {}),
    });

    counts.questions += 1;
    if (shown) counts.shown += 1;
    if (!EXCLUDED.has(outcome)) counts.eligible += 1;
    switch (outcome) {
      case "answered": counts.answered += 1; break;
      case "declined": counts.declined += 1; break;
      case "invalid": counts.invalid += 1; invalidKeys.push(q.key); break;
      case "skipped": counts.skipped += 1; break;
      case "no_response": counts.noResponse += 1; break;
      case "not_reached": counts.notReached += 1; break;
      case "eligible_not_shown": counts.eligibleNotShown += 1; break;
      case "hidden_branching": counts.hiddenBranching += 1; break;
      case "answered_hidden": counts.answeredHidden += 1; break;
      case "undetermined": counts.undetermined += 1; break;
    }
    if (requiredLevel) {
      if (outcome === "undetermined") {
        counts.requiredUndetermined += 1;
        estimateReasons.add("undetermined_eligibility");
      } else if (!EXCLUDED.has(outcome)) {
        counts.required += 1;
        if (resolved) counts.requiredResolved += 1;
        if (missing) {
          counts.requiredMissing += 1;
          missingRequiredKeys.push(q.key);
        }
      }
    }
  }

  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  const sections: SectionResult[] = release.sections.map((s) => {
    let req = 0;
    let res = 0;
    let eligible = 0;
    let answered = 0;
    let reached = false;
    for (const key of s.questionKeys) {
      const o = byKey.get(key)!;
      if (o.shown || o.resolved || o.outcome === "skipped") reached = true;
      if (!EXCLUDED.has(o.outcome)) eligible += 1;
      if (o.outcome === "answered") answered += 1;
      if (o.requiredLevel && !EXCLUDED.has(o.outcome)) {
        req += 1;
        if (o.resolved) res += 1;
      }
    }
    return {
      key: s.key,
      title: s.title,
      required: req,
      resolved: res,
      eligible,
      answered,
      reached,
      applicable: eligible > 0,
      completion: req > 0 ? res / req : null,
    };
  });

  // Drop-off: the last question shown, in presentation order of the log.
  let lastPresentedKey: string | undefined;
  let lastSeq = -1;
  let finalSectionKey: string | undefined;
  let finalSeq = -1;
  for (const f of replay.items.values()) {
    if (f.lastPresentedSeq === undefined) continue;
    if (release.byKey.has(f.key) && f.lastPresentedSeq > lastSeq) {
      lastSeq = f.lastPresentedSeq;
      lastPresentedKey = f.key;
    }
    if (release.unitSection.has(f.key) && f.lastPresentedSeq > finalSeq) {
      finalSeq = f.lastPresentedSeq;
      finalSectionKey = release.unitSection.get(f.key);
    }
  }
  if (!replay.hasPresentationEvents) {
    // Legacy logs: the furthest question with a response stands in.
    let best = -1;
    for (const f of replay.items.values()) {
      const order = release.unitOrder.get(f.key);
      if (f.response && order !== undefined && order > best) {
        best = order;
        if (release.byKey.has(f.key)) lastPresentedKey = f.key;
        finalSectionKey = release.unitSection.get(f.key);
      }
    }
  }

  const unknownItemKeys = [...replay.items.keys()].filter(
    (k) => !release.unitKeys.has(k) && !k.includes(".__"),
  );

  return {
    rulesVersion: RULES_VERSION,
    releaseKnown: true,
    terminal: replay.terminal,
    hasResponses,
    outcomes,
    counts,
    requiredCompletion: counts.required > 0 ? counts.requiredResolved / counts.required : null,
    answeredRate: counts.eligible > 0 ? counts.answered / counts.eligible : null,
    estimated: estimateReasons.size > 0,
    estimateReasons: [...estimateReasons],
    sections,
    missingRequiredKeys,
    invalidKeys,
    ...(lastPresentedKey ? { lastPresentedKey } : {}),
    ...(finalSectionKey ? { finalSectionKey } : {}),
    unknownItemKeys,
  };
}
