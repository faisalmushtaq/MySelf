import { canonicalJson, instrumentVersion, moduleDefinition, responseScale, scoringDefinition } from "@myself/schema";
import type { InstrumentOrModule, ScaleInput, ScoringInput, StudioDraft } from "./contract.js";

/**
 * What the Studio may not change (docs/16 §4.4).
 *
 * A licensed, validated instrument is administered exactly as licensed: its
 * wording, options, codes, question order, types, keys, variables and scoring
 * are the instrument, and a reworded SDQ is no longer the SDQ — its scores stop
 * being comparable with every published norm, and the licence no longer covers
 * it. Only the things around it may change: where it sits, when it is shown,
 * whether answers are required, help text and layout.
 *
 * The consent and identity modules are protected rather than locked: they are
 * the study's own, so they can change, but only after someone has recorded why
 * (an ethics or linkage acknowledgement), because the consent wording is
 * ethics-approved and the identity items are what participant linkage rests on.
 *
 * Both are enforced by comparing the draft with the published version it
 * started from. The comparison is over a canonical fingerprint, so key order or
 * a default spelled out in one and left implicit in the other is never mistaken
 * for a change.
 */

/** Per-question fields a locked instrument may change: none of them alters what the instrument measures. */
export const LOCKED_ALLOWED_FIELDS = [
  "required",
  "allowDecline",
  "hint",
  "presentation",
  "a11yNote",
  "researcherNote",
  "reportingCategory",
] as const;

/**
 * Per-question fields a protected module may change without an unlock.
 *
 * Narrower than the locked list on purpose: making consent optional, or letting
 * a participant decline a linkage item, changes what the ethics approval and
 * the participant code rely on, so it needs the same acknowledgement as a
 * change of wording.
 */
// Researcher-facing notes only, exactly as the editing operations allow
// (model.ts ALLOWED_FIELDS_BY_TIER.protected). Help text and presentation are
// participant-visible, so on ethics-approved or linkage text they need the
// unlock too — and this, run on the server at publish, is the check that
// holds even for a draft written without going through the operations.
export const PROTECTED_ALLOWED_FIELDS = ["researcherNote", "reportingCategory"] as const;

/** Study modules that need an unlock before their content changes. */
export const PROTECTED_INSTRUMENTS: readonly string[] = ["ybm_intro_consent", "ybm_identity"];

/**
 * The four `ybm_identity` questions ingest derives the participant code from
 * (packages/store/src/ingest.ts, `secretParts`). Removing one, or changing its
 * key, type or variable, silently stops every later sitting linking to the
 * earlier ones — so no unlock permits it.
 */
export const LINKAGE_ITEM_KEYS: readonly string[] = [
  "ybm_identity.ps_mother_initials",
  "ybm_identity.ps_house_digit",
  "ybm_identity.ps_birth_month",
  "ybm_identity.ps_postcode_letters",
];

export type EditTier = "locked" | "protected" | "editable";

/**
 * Whether a protected module has been unlocked (docs/16 §4.4).
 *
 * The unlock is what records the ethics or linkage acknowledgement, so only a
 * real record counts: an entry that is null, has no reason, or names another
 * module is not one. (Review fix: any own key used to count, so a draft
 * carrying `unlocked: { ybm_intro_consent: null }` passed as unlocked.)
 */
export function isUnlocked(unlocked: StudioDraft["unlocked"] | undefined, instrument: string): boolean {
  if (!unlocked || typeof unlocked !== "object" || !Object.prototype.hasOwnProperty.call(unlocked, instrument)) return false;
  const record = (unlocked as Record<string, unknown>)[instrument];
  if (!record || typeof record !== "object") return false;
  const r = record as { instrument?: unknown; reason?: unknown };
  if (typeof r.reason !== "string" || r.reason.trim() === "") return false;
  return r.instrument === undefined || r.instrument === instrument;
}

/**
 * The tier an instrument is edited under, judged from this definition alone.
 * Anything whose licence does not say plainly that the wording may be modified
 * is locked — including a definition too malformed to say, which fails closed.
 *
 * The draft's copy is written by the editor, so on its own this is not enough
 * to decide what must stay unchanged: see `lockedTest`, which also consults the
 * published version and the library.
 */
export function editTier(def: unknown, unlocked: StudioDraft["unlocked"] | undefined): EditTier {
  if (!def || typeof def !== "object") return "editable";
  const d = def as { instrument?: unknown; licence?: { modifiable?: unknown } };
  if (d.licence?.modifiable !== "yes") return "locked";
  const key = typeof d.instrument === "string" ? d.instrument : "";
  if (PROTECTED_INSTRUMENTS.includes(key) && !isUnlocked(unlocked, key)) return "protected";
  return "editable";
}

function instrumentKeyOf(def: unknown): string | null {
  const key = (def as { instrument?: unknown } | null | undefined)?.instrument;
  return typeof key === "string" ? key : null;
}

function licenceLocked(def: unknown): boolean {
  return !!def && typeof def === "object" && (def as { licence?: { modifiable?: unknown } }).licence?.modifiable !== "yes";
}

/**
 * Which of a draft's definitions are locked.
 *
 * A licence is a fact about the instrument, recorded in the version that was
 * published and in the instrument library — not something an editor can grant
 * by editing the draft's own copy. So a definition is locked when its own
 * licence says so, or when the published version holds a locked definition at
 * the same reference, or the published version or the library holds a locked
 * definition of the same instrument (at any version).
 *
 * (Review fix: the tier used to be read from the draft's copy only, so setting
 * `licence.modifiable: "yes"` on the draft's SDQ — or on a copy of it at a new
 * version — switched every locked-content check off and let it be reworded.)
 */
export function lockedTest(
  baseline: StudioDraft | undefined,
  reference?: Record<string, unknown>,
): (def: unknown, refKey: string, unlocked: StudioDraft["unlocked"] | undefined) => boolean {
  const refKeys = new Set<string>();
  const instruments = new Set<string>();
  for (const [refKey, def] of Object.entries(baseline?.instruments ?? {})) {
    if (!licenceLocked(def)) continue;
    refKeys.add(refKey);
    const key = instrumentKeyOf(def);
    if (key) instruments.add(key);
  }
  for (const def of Object.values(reference ?? {})) {
    const key = instrumentKeyOf(def);
    if (key && licenceLocked(def)) instruments.add(key);
  }
  return (def, refKey, unlocked) => {
    if (editTier(def, unlocked) === "locked" || refKeys.has(refKey)) return true;
    const key = instrumentKeyOf(def);
    return key !== null && instruments.has(key);
  };
}

// ---------------------------------------------------------------------------
// Wording helpers shared by validation and the change summary
// ---------------------------------------------------------------------------

/** Collapse whitespace and cut to a length a message can carry. */
export function truncateText(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** “Question text…” (instrument.key), or just the ID when there is no text. */
export function questionLabel(itemKey: string, item: unknown): string {
  const stem = (item as { stem?: { text?: unknown } } | null | undefined)?.stem?.text;
  const text = typeof stem === "string" ? truncateText(stem) : "";
  return text ? `“${text}” (${itemKey})` : itemKey;
}

/** “SDQ” (sdq25_s): the short name researchers know an instrument by. */
export function instrumentLabel(def: unknown, fallbackKey = ""): string {
  const d = (def ?? {}) as { abbreviation?: unknown; name?: unknown; instrument?: unknown };
  const key = typeof d.instrument === "string" ? d.instrument : fallbackKey;
  const name = typeof d.abbreviation === "string" && d.abbreviation ? d.abbreviation : typeof d.name === "string" ? d.name : "";
  return name ? `“${name}” (${key})` : key || "this instrument";
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

/**
 * The definition as the release would freeze it: schema defaults applied and
 * unknown keys dropped, exactly as `freezeRelease` parses it. A definition the
 * schema rejects is fingerprinted as it stands — validation reports why it is
 * rejected, and a broken definition must never compare equal to a sound one.
 */
function normaliseDef(def: unknown): Loose {
  const kind = (def as { kind?: unknown } | null)?.kind;
  const parsed = (kind === "module" ? moduleDefinition : instrumentVersion).safeParse(def);
  return (parsed.success ? parsed.data : def) as Loose;
}

function normaliseScale(scale: unknown): unknown {
  const parsed = responseScale.safeParse(scale);
  return parsed.success ? parsed.data : scale;
}

function normaliseScoring(scoring: unknown): unknown {
  const parsed = scoringDefinition.safeParse(scoring);
  return parsed.success ? parsed.data : scoring;
}

function withoutFields(item: unknown, allowed: readonly string[]): Loose {
  if (!item || typeof item !== "object") return {};
  const out: Loose = { ...(item as Loose) };
  for (const field of allowed) delete out[field];
  return out;
}

function formsOf(def: Loose): Loose[] {
  return Array.isArray(def["forms"]) ? (def["forms"] as Loose[]) : [];
}

function itemsOf(form: Loose | undefined): Loose[] {
  return form && Array.isArray(form["items"]) ? (form["items"] as Loose[]) : [];
}

function stripped(def: Loose, allowed: readonly string[]): Loose {
  return {
    ...def,
    forms: formsOf(def).map((form) => ({ ...form, items: itemsOf(form).map((item) => withoutFields(item, allowed)) })),
  };
}

/**
 * Canonical JSON of an instrument definition with the fields a locked
 * instrument may change removed from every question. Two definitions with the
 * same fingerprint administer the same instrument.
 */
export function lockedFingerprint(def: InstrumentOrModule | unknown, allowed: readonly string[] = LOCKED_ALLOWED_FIELDS): string {
  return canonicalJson(stripped(normaliseDef(def), allowed));
}

// ---------------------------------------------------------------------------
// Differences from the published version
// ---------------------------------------------------------------------------

export type LockedChange =
  /** The instrument is in the draft but not in the version it started from. */
  | "introduced"
  /** A protected module that was published is no longer in the draft. */
  | "removed"
  /** Instrument-level content: name, instructions, licence, scoring rules. */
  | "definition"
  | "question"
  | "question_added"
  | "question_removed"
  | "order"
  | "scale"
  | "scoring";

export interface LockedDifference {
  instrument: string;
  refKey: string;
  /** The question at fault, when the difference is inside one. */
  itemKey?: string;
  change: LockedChange;
  message: string;
}

/** What a changed field is called in a message. */
const FIELD_NAMES: Record<string, string> = {
  stem: "wording",
  lede: "wording",
  moreInfo: "wording",
  statements: "statements",
  fields: "fields",
  groups: "groups",
  scale: "answer options",
  scaleVersion: "answer options",
  responseType: "question type",
  variable: "reporting label",
  key: "ID",
  revision: "revision",
  displayIf: "display condition",
  crossChecks: "consistency check",
  limitOptions: "option limit",
  identifying: "identifying setting",
  required: "required setting",
  allowDecline: "“Prefer not to say” setting",
  minLabel: "labels",
  maxLabel: "labels",
  topLabel: "labels",
  bottomLabel: "labels",
  unitLabel: "unit",
};

function changedFields(a: Loose, b: Loose): string[] {
  const names = new Set<string>();
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonicalJson(a[field]) !== canonicalJson(b[field])) names.add(FIELD_NAMES[field] ?? field);
  }
  return [...names];
}

interface CompareOptions {
  tier: "locked" | "protected";
  allowed: readonly string[];
}

function compareDefinitions(
  refKey: string,
  draftDef: unknown,
  baseDef: unknown,
  draft: StudioDraft,
  baseline: StudioDraft,
  options: CompareOptions,
): LockedDifference[] {
  const out: LockedDifference[] = [];
  const now = normaliseDef(draftDef);
  const then = normaliseDef(baseDef);
  const instrument = typeof now["instrument"] === "string" ? (now["instrument"] as string) : refKey;
  const name = instrumentLabel(now, instrument);
  const why =
    options.tier === "locked"
      ? `${name} is a licensed, validated instrument, so it must be administered exactly as published`
      : `${name} is protected (ethics-approved consent, or the details participant linkage relies on), so it can only change after it has been unlocked with a recorded reason`;
  const fix =
    options.tier === "locked"
      ? "Undo the change. You can still move the block, show it conditionally, change whether answers are required, and edit help text and layout."
      : "Undo the change, or unlock the module and record why the change is needed.";

  if (canonicalJson(stripped(now, options.allowed)) !== canonicalJson(stripped(then, options.allowed))) {
    // Instrument-level content, questions set aside.
    const shell = (d: Loose) => ({ ...d, forms: formsOf(d).map((f) => ({ ...f, items: [] })) });
    if (canonicalJson(shell(now)) !== canonicalJson(shell(then))) {
      out.push({
        instrument,
        refKey,
        change: "definition",
        message: `The details of ${name} (such as its instructions or scoring) differ from the published version. ${why}. ${fix}`,
      });
    }

    const nowItems = itemsOf(formsOf(now)[0]);
    const thenItems = itemsOf(formsOf(then)[0]);
    const nowByKey = new Map(nowItems.map((i) => [String(i["key"]), i]));
    const thenByKey = new Map(thenItems.map((i) => [String(i["key"]), i]));

    for (const item of thenItems) {
      const key = String(item["key"]);
      if (!nowByKey.has(key)) {
        out.push({
          instrument,
          refKey,
          itemKey: `${instrument}.${key}`,
          change: "question_removed",
          message: `${questionLabel(`${instrument}.${key}`, item)} has been removed from ${name}. ${why}. ${
            options.tier === "locked" ? "Put the question back, or remove the whole instrument instead." : fix
          }`,
        });
      }
    }
    for (const item of nowItems) {
      const key = String(item["key"]);
      const itemKey = `${instrument}.${key}`;
      const before = thenByKey.get(key);
      if (!before) {
        out.push({
          instrument,
          refKey,
          itemKey,
          change: "question_added",
          message: `${questionLabel(itemKey, item)} has been added to ${name}. ${why}. ${
            options.tier === "locked" ? "Add the question to one of the study's own modules instead." : fix
          }`,
        });
        continue;
      }
      const a = withoutFields(item, options.allowed);
      const b = withoutFields(before, options.allowed);
      if (canonicalJson(a) !== canonicalJson(b)) {
        const fields = changedFields(a, b);
        out.push({
          instrument,
          refKey,
          itemKey,
          change: "question",
          message: `The ${joinAnd(fields)} of ${questionLabel(itemKey, item)} ${fields.length > 1 ? "have" : "has"} changed since the published version. ${why}. ${fix}`,
        });
      }
    }

    const common = (items: Loose[], other: Map<string, Loose>) =>
      items.map((i) => String(i["key"])).filter((k) => other.has(k));
    if (common(nowItems, thenByKey).join("\u0000") !== common(thenItems, nowByKey).join("\u0000")) {
      out.push({
        instrument,
        refKey,
        change: "order",
        message: `The order of the questions in ${name} differs from the published version. ${why}. ${fix}`,
      });
    }
  }

  // The answer options live in the scale registry, not the instrument, so a
  // relabelled SDQ option would pass the instrument comparison untouched.
  const seen = new Set<string>();
  for (const item of itemsOf(formsOf(now)[0])) {
    const scaleKey = item["scale"];
    if (typeof scaleKey !== "string" || seen.has(scaleKey)) continue;
    seen.add(scaleKey);
    const before = baseline.scales?.[scaleKey];
    if (!before) continue; // a scale the item did not use before is already reported as a question change
    if (canonicalJson(normaliseScale(draft.scales?.[scaleKey])) !== canonicalJson(normaliseScale(before))) {
      out.push({
        instrument,
        refKey,
        itemKey: `${instrument}.${String(item["key"])}`,
        change: "scale",
        message: `The answer options of ${name} (${scaleKey}) differ from the published version. ${why}. ${fix}`,
      });
    }
  }

  const scoringKey = now["scoringKey"];
  if (typeof scoringKey === "string" && baseline.scoring?.[scoringKey]) {
    if (canonicalJson(normaliseScoring(draft.scoring?.[scoringKey])) !== canonicalJson(normaliseScoring(baseline.scoring[scoringKey]))) {
      out.push({
        instrument,
        refKey,
        change: "scoring",
        message: `The scoring rules of ${name} (${scoringKey}) differ from the published version. ${why}. ${fix}`,
      });
    }
  }
  return out;
}

export interface LockedOptions {
  /**
   * Known-good definitions of validated instruments — the instrument library —
   * keyed by reference string, each frozen to the one form its reference
   * resolves to (as a manifest stores it). A locked instrument the baseline
   * lacks is accepted when it matches one of these exactly, and its answer
   * options and scoring rules match too: that is adding a licensed instrument
   * as licensed, not editing one.
   */
  reference?: Record<string, InstrumentOrModule>;
  /**
   * The library's answer options by scale key, for instruments accepted through
   * `reference`. Where a scale is missing here the published version's copy is
   * used; where neither has it, the options cannot be vouched for and the
   * instrument is refused.
   */
  referenceScales?: Record<string, ScaleInput>;
  /** The library's scoring rules by key; used like `referenceScales`. */
  referenceScoring?: Record<string, ScoringInput>;
}

/**
 * The answer options and scoring rules of a locked instrument accepted through
 * the library, checked against the library (or, failing that, the published
 * version). The instrument definition alone does not carry them — they live in
 * the draft's scale and scoring registries — so without this a library SDQ
 * could be added with relabelled options or emptied scoring. (Review fix.)
 */
function introducedRegistries(
  refKey: string,
  def: unknown,
  draft: StudioDraft,
  baseline: StudioDraft,
  options: LockedOptions,
): LockedDifference[] {
  const out: LockedDifference[] = [];
  const now = normaliseDef(def);
  const instrument = typeof now["instrument"] === "string" ? (now["instrument"] as string) : refKey;
  const name = instrumentLabel(now, instrument);
  const seen = new Set<string>();
  for (const item of itemsOf(formsOf(now)[0])) {
    const scaleKey = item["scale"];
    if (typeof scaleKey !== "string" || seen.has(scaleKey)) continue;
    seen.add(scaleKey);
    const expected = options.referenceScales?.[scaleKey] ?? baseline.scales?.[scaleKey];
    if (expected === undefined) {
      out.push({
        instrument,
        refKey,
        itemKey: `${instrument}.${String(item["key"])}`,
        change: "scale",
        message: `The answer options of ${name} (${scaleKey}) can't be checked against the instrument library, so they can't be shown to be the licensed ones. Add the instrument again from the library.`,
      });
    } else if (canonicalJson(normaliseScale(draft.scales?.[scaleKey])) !== canonicalJson(normaliseScale(expected))) {
      out.push({
        instrument,
        refKey,
        itemKey: `${instrument}.${String(item["key"])}`,
        change: "scale",
        message: `The answer options of ${name} (${scaleKey}) differ from the licensed version in the instrument library. Validated instruments must be used exactly as licensed; add it again from the library.`,
      });
    }
  }
  const scoringKey = now["scoringKey"];
  if (typeof scoringKey === "string") {
    const expected = options.referenceScoring?.[scoringKey] ?? baseline.scoring?.[scoringKey];
    if (expected === undefined) {
      out.push({
        instrument,
        refKey,
        change: "scoring",
        message: `The scoring rules of ${name} (${scoringKey}) can't be checked against the instrument library. Add the instrument again from the library.`,
      });
    } else if (canonicalJson(normaliseScoring(draft.scoring?.[scoringKey])) !== canonicalJson(normaliseScoring(expected))) {
      out.push({
        instrument,
        refKey,
        change: "scoring",
        message: `The scoring rules of ${name} (${scoringKey}) differ from the licensed version in the instrument library. Add it again from the library.`,
      });
    }
  }
  return out;
}

/**
 * Every way the draft's locked instruments differ from the published version
 * it started from. Also reports a locked instrument the baseline does not have:
 * nothing in the draft vouches for its content, so it cannot be introduced by
 * editing. Which instruments are locked is decided by `lockedTest`, never by
 * the draft's own copy alone.
 */
export function lockedDifferences(draft: StudioDraft, baseline: StudioDraft, options: LockedOptions = {}): LockedDifference[] {
  const out: LockedDifference[] = [];
  const isLocked = lockedTest(baseline, options.reference);
  for (const [refKey, def] of Object.entries(draft.instruments ?? {})) {
    if (!isLocked(def, refKey, draft.unlocked)) continue;
    const base = baseline.instruments?.[refKey];
    if (base) {
      out.push(...compareDefinitions(refKey, def, base, draft, baseline, { tier: "locked", allowed: LOCKED_ALLOWED_FIELDS }));
      continue;
    }
    const known = options.reference?.[refKey];
    if (known && lockedFingerprint(def) === lockedFingerprint(known)) {
      out.push(...introducedRegistries(refKey, def, draft, baseline, options));
      continue;
    }
    const name = instrumentLabel(def, refKey);
    out.push({
      instrument: String((def as { instrument?: unknown }).instrument ?? refKey),
      refKey,
      change: "introduced",
      message: known
        ? `${name} differs from the licensed version in the instrument library. Validated instruments must be used exactly as licensed; add it again from the library.`
        : `${name} is a licensed, validated instrument that is not in the published version this draft started from, and nothing shows its content is the licensed one. Validated instruments can only be added unchanged from the instrument library.`,
    });
  }
  return out;
}

/**
 * Every way the draft's protected modules differ from the published version,
 * for modules that have not been unlocked. A protected module that was
 * published and is now missing is reported too: taking out the consent module
 * is the largest change to it there is.
 */
export function protectedDifferences(draft: StudioDraft, baseline: StudioDraft): LockedDifference[] {
  const out: LockedDifference[] = [];
  const draftByInstrument = new Map<string, string>();
  for (const [refKey, def] of Object.entries(draft.instruments ?? {})) {
    const instrument = (def as { instrument?: unknown } | null)?.instrument;
    if (typeof instrument === "string") draftByInstrument.set(instrument, refKey);
    // By name, not by the draft's licence: a protected module whose copy has
    // been re-licensed is still the consent or identity module. (Review fix.)
    if (typeof instrument !== "string" || !PROTECTED_INSTRUMENTS.includes(instrument) || isUnlocked(draft.unlocked, instrument)) continue;
    const base = baseline.instruments?.[refKey];
    if (base) {
      out.push(...compareDefinitions(refKey, def, base, draft, baseline, { tier: "protected", allowed: PROTECTED_ALLOWED_FIELDS }));
    } else {
      out.push({
        instrument: String(instrument ?? refKey),
        refKey,
        change: "introduced",
        message: `${instrumentLabel(def, refKey)} is protected and is not in the published version this draft started from. Unlock it and record why before adding it.`,
      });
    }
  }
  for (const [refKey, base] of Object.entries(baseline.instruments ?? {})) {
    const instrument = (base as { instrument?: unknown } | null)?.instrument;
    if (typeof instrument !== "string" || !PROTECTED_INSTRUMENTS.includes(instrument)) continue;
    if (draftByInstrument.has(instrument)) continue;
    if (isUnlocked(draft.unlocked, instrument)) continue;
    out.push({
      instrument,
      refKey,
      change: "removed",
      message: `${instrumentLabel(base, instrument)} is protected and has been removed from the survey. Put it back, or unlock it and record why it is being removed.`,
    });
  }
  return out;
}
