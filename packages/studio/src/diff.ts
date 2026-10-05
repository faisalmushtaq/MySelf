import { compareVersions } from "@myself/release/gate";
import { assessmentDraft, canonicalJson, instrumentVersion, itemDefinition, moduleDefinition, responseScale, scaleOption } from "@myself/schema";
import type { Bump, ChangeEntry, ChangeKind, ChangeSummary, StudioDraft } from "./contract.js";
import { instrumentLabel, joinAnd, questionLabel, truncateText } from "./locked.js";
import { isMyStorySection, myStoryOf, sameProtocol } from "./mystory.js";
import { liveQuestions, placements, type LiveQuestion } from "./walk.js";

/**
 * What changed between two versions of a survey, and the version number that
 * change needs (docs/16 §5.1, docs/06 §3).
 *
 * The summary is what a publisher reads before pressing Publish and what is
 * stored with the version, so each entry names the question in the words a
 * researcher knows it by. The bump rule is the psychometric one, not the
 * software one: anything that could change what a participant reads or chooses,
 * or how an answer is coded, is MAJOR — two versions whose data cannot be
 * pooled without a comparability argument are different instruments. Text a
 * participant sees outside the questions is MINOR; metadata only, PATCH.
 */

const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

function maxBump(a: Bump | null, b: Bump | null): Bump | null {
  if (!a) return b;
  if (!b) return a;
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

/** The bump each aspect of a question change needs on its own. */
const ASPECT_BUMP: Record<string, Bump> = {
  wording: "major",
  help: "minor",
  options: "major",
  coding: "major",
  type: "major",
  required: "major",
  decline: "major",
  logic: "major",
  validation: "major",
  identifying: "major",
  presentation: "major",
  notes: "patch",
};

/** Changes that alter how existing answers are coded or compared. */
const BREAKING_ASPECTS = new Set(["coding", "type", "identifying"]);

const ASPECT_PHRASES: Record<string, string> = {
  wording: "wording",
  help: "help text",
  options: "answer options",
  coding: "coding",
  type: "question type",
  required: "required setting",
  decline: "“Prefer not to say” setting",
  logic: "display logic",
  validation: "answer limits",
  identifying: "identifying setting",
  presentation: "layout",
  notes: "researcher notes",
};

const ASPECT_ORDER = Object.keys(ASPECT_BUMP);

// ---------------------------------------------------------------------------
// Question comparison
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list<T = Loose>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Schema defaults applied, so a default written out is not mistaken for a change. */
function normaliseItem(item: unknown): Loose {
  const parsed = itemDefinition.safeParse(item);
  return (parsed.success ? parsed.data : item ?? {}) as Loose;
}

function normaliseOption(option: unknown): Loose {
  const parsed = scaleOption.safeParse(option);
  return (parsed.success ? parsed.data : option ?? {}) as Loose;
}

/** Which field of an item belongs to which aspect. Fields not listed count as layout. */
const FIELD_ASPECT: Record<string, string> = {
  stem: "wording",
  lede: "wording",
  moreInfo: "wording",
  minLabel: "wording",
  maxLabel: "wording",
  topLabel: "wording",
  bottomLabel: "wording",
  unitLabel: "wording",
  hint: "help",
  responseType: "type",
  variable: "coding",
  lowestValue: "coding",
  required: "required",
  allowDecline: "decline",
  displayIf: "logic",
  crossChecks: "logic",
  limitOptions: "logic",
  min: "validation",
  max: "validation",
  step: "validation",
  integerOnly: "validation",
  minChars: "validation",
  maxChars: "validation",
  pattern: "validation",
  patternHint: "validation",
  minSelections: "validation",
  maxSelections: "validation",
  minYear: "validation",
  maxYear: "validation",
  minAgeYears: "validation",
  maxAgeYears: "validation",
  rungs: "options",
  identifying: "identifying",
  presentation: "presentation",
  spectrumReverse: "presentation",
  autoAdvance: "presentation",
  showValue: "presentation",
  illustration: "presentation",
  media: "presentation",
  image: "presentation",
  researcherNote: "notes",
  reportingCategory: "notes",
  a11yNote: "notes",
  legacyVariable: "notes",
  revision: "notes",
};

/** Compared separately: the ID is the same by construction, the scale is compared by its options. */
const STRUCTURED_FIELDS = new Set(["key", "scale", "scaleVersion", "statements", "fields", "groups"]);

function scaleOf(draft: StudioDraft | null, item: Loose): Loose | null {
  const key = item["scale"];
  if (!draft || typeof key !== "string") return null;
  const scale = draft.scales?.[key];
  return isObject(scale) ? scale : null;
}

/** Options by code, in display order. */
function optionsOf(scale: Loose | null): { order: number[]; byCode: Map<number, Loose> } {
  const options = list(scale?.["options"]).map(normaliseOption);
  const positioned = options
    .map((o, i) => ({ o, at: typeof o["position"] === "number" ? (o["position"] as number) : i + 1 }))
    .sort((a, b) => a.at - b.at)
    .map(({ o }) => o);
  return {
    order: positioned.map((o) => o["code"] as number),
    byCode: new Map(positioned.map((o) => [o["code"] as number, o])),
  };
}

function compareOptions(beforeScale: Loose | null, afterScale: Loose | null, aspects: Set<string>): void {
  if (!beforeScale && !afterScale) return;
  const a = optionsOf(beforeScale);
  const b = optionsOf(afterScale);
  for (const [code, option] of a.byCode) {
    const now = b.byCode.get(code);
    if (!now) {
      // A code that has been answered and now means nothing: recorded answers
      // under it are orphaned from the current instrument.
      aspects.add("coding");
      continue;
    }
    if (option["label"] !== now["label"]) aspects.add("options");
    for (const field of ["kind", "textEntry", "illustration", "description", "value"]) {
      if (!same(option[field], now[field])) aspects.add("options");
    }
    if (!same(option["legacyCode"], now["legacyCode"])) aspects.add("coding");
    if (!same(option["codeLabel"], now["codeLabel"])) aspects.add("notes");
  }
  for (const code of b.byCode.keys()) if (!a.byCode.has(code)) aspects.add("options");
  // The same answer now recorded under a different code.
  const codeByLabel = new Map([...a.byCode].map(([code, o]) => [String(o["label"]), code]));
  for (const [code, option] of b.byCode) {
    const was = codeByLabel.get(String(option["label"]));
    if (was !== undefined && was !== code) aspects.add("coding");
  }
  const common = (order: number[], other: Map<number, Loose>) => order.filter((c) => other.has(c));
  if (!same(common(a.order, b.byCode), common(b.order, a.byCode))) aspects.add("options");
  if (!same(beforeScale?.["direction"], afterScale?.["direction"])) aspects.add("coding");
}

/** Structured lists (statements, fields, groups), split into what each part of an entry means. */
function compareParts(before: unknown, after: unknown, parts: Record<string, string>, aspects: Set<string>): void {
  const a = list(before);
  const b = list(after);
  const project = (entries: Loose[], fields: string[]) => entries.map((e) => fields.map((f) => (isObject(e) ? e[f] : undefined)));
  const byAspect = new Map<string, string[]>();
  for (const [field, aspect] of Object.entries(parts)) byAspect.set(aspect, [...(byAspect.get(aspect) ?? []), field]);
  if (a.length !== b.length) aspects.add(parts["key"] ?? "coding");
  for (const [aspect, fields] of byAspect) {
    if (!same(project(a, fields), project(b, fields))) aspects.add(aspect);
  }
  // Anything else an entry carries.
  const known = new Set(Object.keys(parts));
  const rest = (entries: Loose[]) => entries.map((e) => (isObject(e) ? Object.fromEntries(Object.entries(e).filter(([k]) => !known.has(k))) : e));
  if (!same(rest(a), rest(b))) aspects.add("presentation");
}

/**
 * The aspects of a question that differ between two versions. `scalesSame`
 * memoises scale comparisons across a whole diff: one scale is often shared by
 * dozens of questions.
 */
export function questionAspects(
  before: unknown,
  after: unknown,
  beforeDraft: StudioDraft | null,
  afterDraft: StudioDraft,
  scalesSame: Map<string, boolean> = new Map(),
): string[] {
  // Most questions are untouched between two versions; comparing them as they
  // stand is far cheaper than normalising them through the schema first.
  if (same(before, after)) {
    const key = (before as Loose | null)?.["scale"];
    if (typeof key !== "string") return [];
    let unchanged = scalesSame.get(key);
    if (unchanged === undefined) {
      unchanged = same(scaleOf(beforeDraft, before as Loose), scaleOf(afterDraft, after as Loose));
      scalesSame.set(key, unchanged);
    }
    if (unchanged) return [];
  }
  const a = normaliseItem(before);
  const b = normaliseItem(after);
  const aspects = new Set<string>();
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (STRUCTURED_FIELDS.has(field)) continue;
    if (!same(a[field], b[field])) aspects.add(FIELD_ASPECT[field] ?? "presentation");
  }
  compareParts(a["statements"], b["statements"], { key: "coding", text: "wording", required: "validation" }, aspects);
  compareParts(a["fields"], b["fields"], { key: "coding", label: "wording", kind: "validation", required: "validation", maxChars: "validation", pattern: "validation", patternHint: "validation" }, aspects);
  compareParts(a["groups"], b["groups"], { key: "coding", label: "wording", ranked: "validation" }, aspects);
  if (a["scale"] !== undefined || b["scale"] !== undefined) compareOptions(scaleOf(beforeDraft, a), scaleOf(afterDraft, b), aspects);
  return ASPECT_ORDER.filter((x) => aspects.has(x));
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * The elements of `after` that belong to a longest common subsequence with
 * `before`. Everything else is what moved: inserting one question leaves every
 * other question in the subsequence, so only real moves are reported.
 */
function stableInOrder(before: string[], after: string[]): Set<string> {
  const n = before.length;
  const m = after.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      keep.add(after[j]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

interface Side {
  draft: StudioDraft | null;
  first: Map<string, LiveQuestion>;
  order: LiveQuestion[];
  archived: Set<string>;
  sections: Map<string, { index: number; section: Loose }>;
  sectionOrder: string[];
}

function sideOf(draft: StudioDraft | null): Side {
  const first = new Map<string, LiveQuestion>();
  const order: LiveQuestion[] = [];
  const sections = new Map<string, { index: number; section: Loose }>();
  const sectionOrder: string[] = [];
  if (draft) {
    for (const q of liveQuestions(draft)) {
      if (first.has(q.itemKey)) continue;
      first.set(q.itemKey, q);
      order.push(q);
    }
    list(draft.composition.sections).forEach((section, index) => {
      if (!isObject(section) || typeof section["key"] !== "string" || sections.has(section["key"])) return;
      // MyStory's section is MyStory, and is compared as that (`diffMyStory`).
      if (isMyStorySection(section as Parameters<typeof isMyStorySection>[0])) return;
      sections.set(section["key"], { index, section });
      sectionOrder.push(section["key"]);
    });
  }
  const archived = new Set(list(draft?.archived).map((a) => String(a["itemKey"])));
  return { draft, first, order, archived, sections, sectionOrder };
}

function sectionName(side: Side, key: string): string {
  const title = side.sections.get(key)?.section["title"];
  return typeof title === "string" && title.trim() ? `“${truncateText(title, 40)}”` : `“${key}”`;
}

function entry(kind: ChangeKind, bump: Bump, message: string, extra: Partial<ChangeEntry> = {}, breaking = false): ChangeEntry {
  return { kind, bump, breaking, message, ...extra };
}

/** Normalised composition, so defaults spelled out are not changes. */
function normaliseComposition(draft: StudioDraft | null): Loose {
  if (!draft) return {};
  const parsed = assessmentDraft.safeParse(draft.composition);
  return (parsed.success ? parsed.data : draft.composition) as Loose;
}

const WELCOME_ASPECTS: { path: (c: Loose) => unknown; name: string; bump: Bump; breaking?: boolean }[] = [
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["pattern"], name: "code format", bump: "major" },
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["variable"], name: "code reporting label", bump: "major", breaking: true },
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["label"], name: "code label", bump: "minor" },
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["hint"], name: "code hint", bump: "minor" },
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["instructions"], name: "code instructions", bump: "minor" },
  { path: (c) => (c["participantCode"] as Loose | undefined)?.["placeholder"], name: "code example", bump: "minor" },
  { path: (c) => (c["participantCode"] === undefined ? "absent" : "present"), name: "participant code", bump: "major" },
  { path: (c) => c["studyLabel"], name: "study label", bump: "minor" },
  { path: (c) => c["contact"], name: "contact details", bump: "minor" },
];

/** Survey-wide settings: what each is called, and whether participants see it. */
const SETTINGS: Record<string, { name: string; bump: Bump }> = {
  key: { name: "the survey ID", bump: "major" },
  study: { name: "the study", bump: "major" },
  title: { name: "the survey title (researcher-facing)", bump: "patch" },
  notes: { name: "the survey notes", bump: "patch" },
  allowBackNavigation: { name: "whether participants can go back", bump: "minor" },
  progressIndicator: { name: "the progress indicator", bump: "minor" },
  resumption: { name: "what happens when a participant comes back", bump: "minor" },
  effort: { name: "the skip and pacing prompts", bump: "minor" },
  language: { name: "the survey language", bump: "minor" },
  readingLevel: { name: "the reading level", bump: "minor" },
  ageBand: { name: "the age group", bump: "minor" },
  offline: { name: "the offline settings", bump: "patch" },
};
const HANDLED_COMPOSITION = new Set(["sections", "screens", "participantCode", "studyLabel", "contact"]);

function diffWelcome(a: Loose, b: Loose, out: ChangeEntry[]): void {
  const changed = WELCOME_ASPECTS.filter((w) => !same(w.path(a), w.path(b)));
  // "participant code added/removed" already implies the rest.
  const shown = changed.some((w) => w.name === "participant code") ? changed.filter((w) => w.name === "participant code") : changed;
  if (shown.length === 0) return;
  const bump = shown.reduce<Bump | null>((acc, w) => maxBump(acc, w.bump), null)!;
  out.push(
    entry("welcome.changed", bump, `Changed the start screen: the ${joinAnd(shown.map((w) => w.name))}.`, { aspects: shown.map((w) => w.name) }, shown.some((w) => w.breaking)),
  );
}

function diffScreens(a: Loose, b: Loose, out: ChangeEntry[]): void {
  const before = isObject(a["screens"]) ? a["screens"] : {};
  const after = isObject(b["screens"]) ? b["screens"] : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    const name = key === "finish" ? "the finishing screen" : key === "review" ? "the review screen" : `the screen “${key}”`;
    const verb = before[key] === undefined ? "Added" : after[key] === undefined ? "Removed" : "Changed";
    out.push(entry("completion.changed", "minor", `${verb} ${name}.`, { aspects: [key] }));
  }
}

function diffSettings(a: Loose, b: Loose, out: ChangeEntry[]): void {
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (HANDLED_COMPOSITION.has(field) || same(a[field], b[field])) continue;
    const setting = SETTINGS[field] ?? { name: `the setting “${field}”`, bump: "minor" as Bump };
    out.push(entry("settings.changed", setting.bump, `Changed ${setting.name}.`, { aspects: [field] }));
  }
}

function diffSections(a: Side, b: Side, out: ChangeEntry[]): void {
  for (const key of b.sectionOrder) {
    if (!a.sections.has(key)) out.push(entry("section.added", "major", `Added the section ${sectionName(b, key)}.`, { sectionKey: key }));
  }
  for (const key of a.sectionOrder) {
    if (!b.sections.has(key)) out.push(entry("section.removed", "major", `Removed the section ${sectionName(a, key)}.`, { sectionKey: key }));
  }
  for (const key of b.sectionOrder) {
    const before = a.sections.get(key)?.section;
    const after = b.sections.get(key)?.section;
    if (!before || !after) continue;
    const aspects: string[] = [];
    let bump: Bump | null = null;
    if (!same(before["title"], after["title"])) {
      aspects.push("title");
      bump = maxBump(bump, "minor");
    }
    if (!same(before["displayIf"], after["displayIf"])) {
      aspects.push("logic");
      bump = maxBump(bump, "major");
    }
    if (!same(before["transition"], after["transition"])) {
      aspects.push("transition");
      bump = maxBump(bump, "minor");
    }
    if (!same(before["randomiseComponents"] ?? false, after["randomiseComponents"] ?? false)) {
      aspects.push("presentation");
      bump = maxBump(bump, "major");
    }
    if (!bump) continue;
    const message =
      aspects.length === 1 && aspects[0] === "title"
        ? `Renamed the section ${sectionName(a, key)} to ${sectionName(b, key)}.`
        : aspects.length === 1 && aspects[0] === "logic"
          ? `Changed when the section ${sectionName(b, key)} is shown.`
          : `Changed the ${joinAnd(aspects.map((x) => (x === "logic" ? "display logic" : x === "presentation" ? "order of its blocks" : x)))} of the section ${sectionName(b, key)}.`;
    out.push(entry("section.changed", bump, message, { sectionKey: key, aspects }));
  }
  const commonBefore = a.sectionOrder.filter((k) => b.sections.has(k));
  const commonAfter = b.sectionOrder.filter((k) => a.sections.has(k));
  const stable = stableInOrder(commonBefore, commonAfter);
  for (const key of commonAfter) {
    if (!stable.has(key)) out.push(entry("section.reordered", "major", `Moved the section ${sectionName(b, key)} to a different point in the survey.`, { sectionKey: key }));
  }
}

/**
 * MyStory (docs/16 §10.1): switched on or off, or running another protocol.
 *
 * Each is MAJOR. Participants meet a conversation that was not there, or one
 * that asks them different things, and the narrative data of two versions is
 * not comparable without an argument that it is. A protocol is named by its
 * `key@version`, which is what the summary says.
 */
function diffMyStory(before: StudioDraft | null, after: StudioDraft, out: ChangeEntry[]): void {
  const a = before ? myStoryOf(before) : null;
  const b = myStoryOf(after);
  if (!a && !b) return;
  if (!a && b) {
    out.push(entry("mystory.added", "major", `MyStory added (${b.id}).`, { sectionKey: b.sectionKey }));
    return;
  }
  if (a && !b) {
    out.push(entry("mystory.removed", "major", `MyStory removed (${a.id}).`, { sectionKey: a.sectionKey }));
    return;
  }
  if (!a || !b) return;
  if (a.id !== b.id) {
    out.push(entry("mystory.changed", "major", `MyStory protocol changed from ${a.id} to ${b.id}.`, { sectionKey: b.sectionKey, aspects: ["protocol"] }));
  } else if (!sameProtocol(a.definition, b.definition)) {
    out.push(entry("mystory.changed", "major", `MyStory protocol ${b.id} changed, keeping its version.`, { sectionKey: b.sectionKey, aspects: ["protocol"] }));
  }
  const sectionOf = (draft: StudioDraft, index: number) => (list(draft.composition.sections)[index] ?? {}) as Loose;
  const was = sectionOf(before!, a.sectionIndex);
  const now = sectionOf(after, b.sectionIndex);
  if (!same(was["title"], now["title"])) {
    out.push(entry("mystory.changed", "minor", `Renamed MyStory's section to “${truncateText(String(now["title"] ?? ""), 40)}”.`, { sectionKey: b.sectionKey, aspects: ["title"] }));
  }
  if (!same(was["displayIf"], now["displayIf"])) {
    out.push(entry("mystory.changed", "major", "Changed when MyStory is shown.", { sectionKey: b.sectionKey, aspects: ["logic"] }));
  }
}

/**
 * The composition with MyStory's connectivity setting set aside, when MyStory
 * was switched on or off: switching it says that much on its own, and the
 * setting means nothing without it.
 */
function withoutStoryConnectivity(c: Loose): Loose {
  const offline = c["offline"];
  if (!isObject(offline) || !("narrativeConnectivity" in offline)) return c;
  const { narrativeConnectivity: _set, ...rest } = offline;
  return { ...c, offline: rest };
}

function diffQuestions(a: Side, b: Side, out: ChangeEntry[], counts: ChangeSummary["counts"]): void {
  const moved = new Set<string>();
  const scalesSame = new Map<string, boolean>();
  for (const q of b.order) {
    const label = questionLabel(q.itemKey, q.item);
    const before = a.first.get(q.itemKey);
    if (!before) {
      const restored = a.archived.has(q.itemKey);
      out.push(
        entry(restored ? "question.restored" : "question.added", "major", `${restored ? "Restored" : "Added"} ${label} in the section ${sectionName(b, q.sectionKey)}.`, {
          itemKey: q.itemKey,
          sectionKey: q.sectionKey,
        }),
      );
      counts.added += 1;
      continue;
    }
    if (before.sectionKey !== q.sectionKey) {
      moved.add(q.itemKey);
      counts.moved += 1;
      out.push(
        entry("question.moved", "major", `Moved ${label} from the section ${sectionName(a, before.sectionKey)} to ${sectionName(b, q.sectionKey)}.`, {
          itemKey: q.itemKey,
          sectionKey: q.sectionKey,
        }),
      );
    }
    const aspects = questionAspects(before.item, q.item, a.draft, b.draft!, scalesSame);
    if (aspects.length > 0) {
      counts.changed += 1;
      const bump = aspects.reduce<Bump | null>((acc, x) => maxBump(acc, ASPECT_BUMP[x] ?? "major"), null)!;
      out.push(
        entry(
          "question.changed",
          bump,
          `Changed the ${joinAnd(aspects.map((x) => ASPECT_PHRASES[x] ?? x))} of ${label}.`,
          { itemKey: q.itemKey, sectionKey: q.sectionKey, aspects },
          aspects.some((x) => BREAKING_ASPECTS.has(x)),
        ),
      );
    }
  }

  // Reordering within a section. A question that changed section is already
  // reported as moved, and a section moved as a whole is reported once as a
  // section, so neither makes every question in it look reordered.
  for (const sectionKey of b.sectionOrder) {
    const stayed = (side: Side) =>
      side.order
        .filter((q) => q.sectionKey === sectionKey && !moved.has(q.itemKey) && a.first.has(q.itemKey) && b.first.has(q.itemKey))
        .map((q) => q.itemKey);
    const before = stayed(a);
    const after = stayed(b);
    const stable = stableInOrder(before, after);
    for (const key of after) {
      if (stable.has(key)) continue;
      const q = b.first.get(key)!;
      counts.moved += 1;
      out.push(
        entry("question.reordered", "major", `Changed the position of ${questionLabel(key, q.item)} within the section ${sectionName(b, sectionKey)}.`, {
          itemKey: key,
          sectionKey,
        }),
      );
    }
  }

  for (const q of a.order) {
    if (b.first.has(q.itemKey)) continue;
    const label = questionLabel(q.itemKey, q.item);
    if (b.archived.has(q.itemKey)) {
      counts.archived += 1;
      out.push(entry("question.archived", "major", `Archived ${label}. Its ID and reporting label stay reserved.`, { itemKey: q.itemKey, sectionKey: q.sectionKey }));
    } else {
      counts.removed += 1;
      out.push(entry("question.removed", "major", `Removed ${label}. Its ID and reporting label stay reserved.`, { itemKey: q.itemKey, sectionKey: q.sectionKey }));
    }
  }
}

/** Block-level changes: when a block is shown, per-block answer rules, and what an instrument says before its questions. */
function diffBlocks(a: Side, b: Side, out: ChangeEntry[]): void {
  const blocks = (side: Side) => {
    const map = new Map<string, { component: Loose; label: string }>();
    if (!side.draft) return map;
    const seen = new Map<string, number>();
    for (const p of placements(side.draft)) {
      const n = (seen.get(`${p.sectionKey}:${p.instrument}`) ?? 0) + 1;
      seen.set(`${p.sectionKey}:${p.instrument}`, n);
      const component = list(side.draft.composition.sections[p.sectionIndex]?.components)[p.componentIndex] ?? {};
      map.set(`${p.sectionKey}:${p.instrument}:${n}`, { component, label: instrumentLabel(p.def, p.instrument) });
    }
    return map;
  };
  const before = blocks(a);
  const after = blocks(b);
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) continue;
    const sectionKey = key.slice(0, key.indexOf(":"));
    if (!same(was.component["displayIf"], now.component["displayIf"])) {
      out.push(entry("section.changed", "major", `Changed when the block ${now.label} is shown in the section ${sectionName(b, sectionKey)}.`, { sectionKey, aspects: ["logic"] }));
    }
    if (!same(was.component["overrides"], now.component["overrides"])) {
      out.push(
        entry("section.changed", "major", `Changed whether answers are required in the block ${now.label} in the section ${sectionName(b, sectionKey)}.`, {
          sectionKey,
          aspects: ["required"],
        }),
      );
    }
  }

  // Instrument definitions, questions set aside (they are compared one by one).
  const defs = (draft: StudioDraft | null) => {
    const map = new Map<string, Loose>();
    for (const def of Object.values(draft?.instruments ?? {})) {
      const d = def as unknown as Loose;
      if (isObject(d) && typeof d["instrument"] === "string" && !map.has(d["instrument"])) map.set(d["instrument"], d);
    }
    return map;
  };
  const normaliseDef = (def: Loose) => {
    const parsed = (def["kind"] === "module" ? moduleDefinition : instrumentVersion).safeParse(def);
    return (parsed.success ? parsed.data : def) as Loose;
  };
  const beforeDefs = defs(a.draft);
  for (const [instrument, rawNow] of defs(b.draft)) {
    const rawWas = beforeDefs.get(instrument);
    if (!rawWas || same(rawWas, rawNow)) continue;
    const was = normaliseDef(rawWas);
    const now = normaliseDef(rawNow);
    const label = instrumentLabel(now, instrument);
    const form = (d: Loose) => (list(d["forms"])[0] ?? {}) as Loose;
    if (!same(form(was)["instructions"], form(now)["instructions"]) || !same(form(was)["label"], form(now)["label"])) {
      out.push(entry("settings.changed", "major", `Changed the introduction shown before ${label}.`, { aspects: ["wording"] }));
    }
    const scoringFields = ["scoringKey", "subscales", "reverseScoredItems", "missingDataRule"];
    if (scoringFields.some((f) => !same(was[f], now[f]))) {
      out.push(entry("settings.changed", "major", `Changed how ${label} is scored.`, { aspects: ["scoring"] }, true));
    }
    const rest = (d: Loose) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== "forms" && !scoringFields.includes(k)));
    const formRest = (d: Loose) => Object.fromEntries(Object.entries(form(d)).filter(([k]) => !["items", "instructions", "label"].includes(k)));
    if (!same(rest(was), rest(now)) || !same(formRest(was), formRest(now))) {
      out.push(entry("settings.changed", "patch", `Updated the details recorded about ${label}.`, { aspects: ["notes"] }));
    }
  }

  // Scoring rules and scale metadata live in their own registries.
  const beforeScoring = a.draft?.scoring ?? {};
  for (const [key, rules] of Object.entries(b.draft?.scoring ?? {})) {
    if (key in beforeScoring && !same(beforeScoring[key], rules)) {
      out.push(entry("settings.changed", "major", `Changed the scoring rules “${key}”.`, { aspects: ["scoring"] }, true));
    }
  }
  const beforeScales = a.draft?.scales ?? {};
  for (const [key, scale] of Object.entries(b.draft?.scales ?? {})) {
    const was = beforeScales[key];
    if (!was || same(was, scale)) continue;
    const meta = (s: unknown) => {
      const parsed = responseScale.safeParse(s);
      const d = (parsed.success ? parsed.data : s) as Loose;
      return { name: d["name"], version: d["version"], scoringNote: d["scoringNote"] };
    };
    if (!same(meta(was), meta(scale))) {
      out.push(entry("settings.changed", "patch", `Updated the details recorded about the answer options “${key}”.`, { aspects: ["notes"] }));
    }
  }
}

function summarise(before: StudioDraft | null, after: StudioDraft): ChangeSummary {
  const a = sideOf(before);
  const b = sideOf(after);
  const entries: ChangeEntry[] = [];
  const counts: ChangeSummary["counts"] = { added: 0, removed: 0, archived: 0, changed: 0, moved: 0 };
  const ca = normaliseComposition(before);
  const cb = normaliseComposition(after);
  if (before) diffWelcome(ca, cb, entries);
  diffSections(a, b, entries);
  diffQuestions(a, b, entries, counts);
  diffMyStory(before, after, entries);
  if (before) {
    diffBlocks(a, b, entries);
    diffScreens(ca, cb, entries);
    const toggled = !myStoryOf(before) !== !myStoryOf(after);
    diffSettings(toggled ? withoutStoryConnectivity(ca) : ca, toggled ? withoutStoryConnectivity(cb) : cb, entries);
  }
  return { bump: suggestBump({ entries }), entries, counts };
}

/**
 * Everything that changed from `before` (the published version the draft
 * started from; null for a survey never published) to `after`. Never throws:
 * a draft too malformed to compare is summarised as one MAJOR change, the only
 * safe assumption about a change nobody could describe.
 */
export function diffDrafts(before: StudioDraft | null, after: StudioDraft): ChangeSummary {
  try {
    return summarise(before, after);
  } catch (error) {
    return {
      bump: "major",
      entries: [
        entry(
          "settings.changed",
          "major",
          `The changes could not be listed (${error instanceof Error ? error.message : String(error)}), so they are treated as a major change.`,
        ),
      ],
      counts: { added: 0, removed: 0, archived: 0, changed: 0, moved: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Version numbers
// ---------------------------------------------------------------------------

/** The smallest bump that covers every change, or null when nothing changed. */
export function suggestBump(summary: Pick<ChangeSummary, "entries">): Bump | null {
  return summary.entries.reduce<Bump | null>((acc, e) => maxBump(acc, e.bump), null);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version.startsWith("r") ? version.slice(1) : version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * The next version after `latest` for a bump; "1.0.0" for a survey's first
 * version. `latest` is the highest version ever published, so a number is never
 * reused even after a rollback. Throws on a `latest` that is not a version: that
 * is a corrupted store, not something to paper over with a guess.
 */
export function nextVersion(latest: string | null, bump: Bump): string {
  if (latest === null) return "1.0.0";
  const v = parseVersion(latest);
  if (!v) throw new RangeError(`“${latest}” is not a version number (MAJOR.MINOR.PATCH).`);
  const [major, minor, patch] = v;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The lowest version a publisher may choose for changes needing `bump`. */
export function minimumVersion(latest: string | null, bump: Bump): string {
  return nextVersion(latest, bump);
}

export type VersionCheck = { ok: true } | { ok: false; reason: "not_semver" | "not_greater" | "bump_too_small"; minimum: string };

/**
 * Whether a publisher's chosen version is allowed: a well-formed version, above
 * every version already published, and at least the bump the changes need. A
 * larger bump than needed is always allowed; a smaller one never is.
 *
 * `required` null (nothing changed) still needs a new number: a version is
 * never reused, so the minimum is the next patch.
 */
export function checkChosenVersion(latest: string | null, chosen: string, required: Bump | null): VersionCheck {
  const minimum = minimumVersion(latest, required ?? "patch");
  if (!SEMVER.test(chosen)) return { ok: false, reason: "not_semver", minimum };
  if (latest !== null && compareVersions(chosen, latest.startsWith("r") ? latest.slice(1) : latest) <= 0) {
    return { ok: false, reason: "not_greater", minimum };
  }
  if (compareVersions(chosen, minimum) < 0) return { ok: false, reason: "bump_too_small", minimum };
  return { ok: true };
}
