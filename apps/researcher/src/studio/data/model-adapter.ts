import { liveQuestions, type Bump, type ChangeEntry, type ChangeKind, type ChangeSummary, type StudioDraft } from "@myself/studio";
import type { ReleaseManifest } from "@myself/schema";
import type { VersionDoc } from "./types.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TEMPORARY ADAPTER — replace the bodies below with re-exports once the model
 * branches (studio/model-ops, studio/model-validate) are merged:
 *
 *   export { diffDrafts, manifestIndex, publishedScaleCodes, reservedFrom } from "@myself/studio";
 *
 * The platform calls the model only through this file, so switching is this
 * one edit. The fallbacks are deliberately simple and conservative: they keep
 * the Versions page and the published context working in the meantime, and
 * they are NOT the diff or index the server uses to decide a version bump.
 * The signatures are the ones agreed for packages/studio/src/{diff,history}.ts:
 *
 *   diffDrafts(before: StudioDraft | null, after: StudioDraft): ChangeSummary
 *   manifestIndex(manifest): { itemKeys: string[]; variables: string[] }
 *   reservedFrom(versions): { itemKeys: Set<string>; variables: Set<string> }
 *   publishedScaleCodes(manifests): Map<scaleKey, Map<code, label>>
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** TEMPORARY fallback. Every question ID and variable any of these versions published. */
export function reservedFrom(versions: readonly Pick<VersionDoc, "itemKeys" | "variables">[]): {
  itemKeys: Set<string>;
  variables: Set<string>;
} {
  const itemKeys = new Set<string>();
  const variables = new Set<string>();
  for (const v of versions) {
    for (const k of v.itemKeys ?? []) itemKeys.add(k);
    for (const k of v.variables ?? []) variables.add(k);
  }
  return { itemKeys, variables };
}

/** TEMPORARY fallback. The question IDs and variables a release administers. */
export function manifestIndex(manifest: ReleaseManifest): { itemKeys: string[]; variables: string[] } {
  const draft = draftOfManifest(manifest);
  const live = draft ? liveQuestions(draft) : [];
  return {
    itemKeys: [...new Set(live.map((q) => q.itemKey))],
    variables: [...new Set(live.map((q) => q.item.variable))],
  };
}

/** TEMPORARY fallback. Every option code each scale has published, with its label (latest label wins). */
export function publishedScaleCodes(manifests: readonly ReleaseManifest[]): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const m of manifests) {
    for (const [key, scale] of Object.entries(m.scales ?? {})) {
      const codes = out.get(key) ?? new Map<number, string>();
      const options = (scale as { options?: { code?: unknown; label?: unknown }[] } | null)?.options ?? [];
      for (const o of options) if (typeof o.code === "number") codes.set(o.code, typeof o.label === "string" ? o.label : "");
      out.set(key, codes);
    }
  }
  return out;
}

function draftOfManifest(manifest: ReleaseManifest): StudioDraft | null {
  // A structural view is enough for walking the placements; avoids importing
  // extractDraft's full re-parse for what is only an index.
  return {
    format: "myself-studio-draft",
    formatVersion: 1,
    surveyId: manifest.composition.key,
    composition: manifest.composition as StudioDraft["composition"],
    instruments: manifest.instruments as StudioDraft["instruments"],
    scales: manifest.scales as StudioDraft["scales"],
    scoring: manifest.scoring as StudioDraft["scoring"],
    archived: [],
    retiredCodes: {},
    unlocked: {},
    notes: {},
  };
}

// ── diff (TEMPORARY fallback) ──────────────────────────────────────────────

const BUMP_ORDER: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

/** Question fields, grouped into the aspects a change summary names. */
const ASPECTS: Record<string, string> = {
  stem: "wording",
  lede: "wording",
  moreInfo: "wording",
  hint: "hint",
  responseType: "type",
  scale: "options",
  scaleVersion: "options",
  required: "required",
  allowDecline: "required",
  displayIf: "conditions",
  crossChecks: "validation",
  validation: "validation",
  limitOptions: "options",
  variable: "variable",
  identifying: "identifying",
  presentation: "presentation",
};
const BREAKING = new Set(["type", "options", "variable", "identifying"]);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function entry(kind: ChangeKind, bump: Bump, message: string, extra: Partial<ChangeEntry> = {}): ChangeEntry {
  return { kind, bump, breaking: false, message, ...extra };
}

/**
 * TEMPORARY fallback diff: which questions and sections were added, removed,
 * moved or changed, and a conservative bump (anything touching questions is
 * major, as docs/16 §5.1 says). The real diff also compares scales, scoring and
 * option codes in detail.
 */
export function diffDrafts(before: StudioDraft | null, after: StudioDraft): ChangeSummary {
  const entries: ChangeEntry[] = [];
  const afterQ = liveQuestions(after);
  const beforeQ = before ? liveQuestions(before) : [];
  const bMap = new Map(beforeQ.map((q) => [q.itemKey, q]));
  const aMap = new Map(afterQ.map((q) => [q.itemKey, q]));
  const archivedNow = new Set(after.archived.map((a) => a.itemKey));

  for (const q of afterQ) {
    const old = bMap.get(q.itemKey);
    if (!old) {
      entries.push(entry("question.added", "major", `Added ${q.itemKey}`, { itemKey: q.itemKey, sectionKey: q.sectionKey }));
      continue;
    }
    if (old.sectionKey !== q.sectionKey) {
      entries.push(
        entry("question.moved", "major", `Moved ${q.itemKey} from ${old.sectionKey} to ${q.sectionKey}`, {
          itemKey: q.itemKey,
          sectionKey: q.sectionKey,
        }),
      );
    }
    const aspects = new Set<string>();
    const oldItem = old.item as unknown as Record<string, unknown>;
    const newItem = q.item as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(oldItem), ...Object.keys(newItem)])) {
      if (key === "revision") continue;
      if (!same(oldItem[key], newItem[key])) aspects.add(ASPECTS[key] ?? "details");
    }
    const scaleKey = typeof newItem["scale"] === "string" ? (newItem["scale"] as string) : null;
    if (scaleKey && before && !same(before.scales[scaleKey], after.scales[scaleKey])) aspects.add("options");
    if (aspects.size > 0) {
      const list = [...aspects];
      entries.push(
        entry("question.changed", "major", `Changed ${q.itemKey}: ${list.join(", ")}`, {
          itemKey: q.itemKey,
          sectionKey: q.sectionKey,
          aspects: list,
          breaking: list.some((a) => BREAKING.has(a)),
        }),
      );
    }
  }
  for (const q of beforeQ) {
    if (aMap.has(q.itemKey)) continue;
    const archived = archivedNow.has(q.itemKey);
    entries.push(
      entry(archived ? "question.archived" : "question.removed", "major", `${archived ? "Archived" : "Removed"} ${q.itemKey}`, {
        itemKey: q.itemKey,
        sectionKey: q.sectionKey,
      }),
    );
  }

  // Order within the questions that stayed.
  const keptBefore = beforeQ.filter((q) => aMap.has(q.itemKey)).map((q) => q.itemKey);
  const keptAfter = afterQ.filter((q) => bMap.has(q.itemKey)).map((q) => q.itemKey);
  if (keptBefore.join("|") !== keptAfter.join("|") && !entries.some((e) => e.kind === "question.moved")) {
    entries.push(entry("question.reordered", "major", "Changed the order of questions"));
  }

  // Sections.
  const bSections = before?.composition.sections ?? [];
  const aSections = after.composition.sections;
  const bSec = new Map(bSections.map((s) => [s.key, s]));
  const aSec = new Map(aSections.map((s) => [s.key, s]));
  for (const s of aSections) {
    const old = bSec.get(s.key);
    if (!old) entries.push(entry("section.added", "major", `Added section “${s.title}”`, { sectionKey: s.key }));
    else if (old.title !== s.title || !same(old.displayIf, s.displayIf)) {
      const conditions = !same(old.displayIf, s.displayIf);
      entries.push(
        entry("section.changed", conditions ? "major" : "minor", `Changed section “${s.title}”`, {
          sectionKey: s.key,
          aspects: [old.title !== s.title ? "title" : null, conditions ? "conditions" : null].filter((x): x is string => !!x),
        }),
      );
    }
  }
  for (const s of bSections) {
    if (!aSec.has(s.key)) entries.push(entry("section.removed", "major", `Removed section “${s.title}”`, { sectionKey: s.key }));
  }
  const bOrder = bSections.map((s) => s.key).filter((k) => aSec.has(k));
  const aOrder = aSections.map((s) => s.key).filter((k) => bSec.has(k));
  if (bOrder.join("|") !== aOrder.join("|")) entries.push(entry("section.reordered", "major", "Changed the order of sections"));

  // Screens and settings.
  if (before) {
    const bc = before.composition as unknown as Record<string, unknown>;
    const ac = after.composition as unknown as Record<string, unknown>;
    const WELCOME = ["participantCode", "studyLabel", "contact"];
    if (WELCOME.some((k) => !same(bc[k], ac[k]))) {
      entries.push(entry("welcome.changed", "minor", "Changed the start screen"));
    }
    if (!same(bc["screens"], ac["screens"])) entries.push(entry("completion.changed", "minor", "Changed the finish screens"));
    const settingKeys = Object.keys({ ...bc, ...ac }).filter(
      (k) => !["sections", "screens", ...WELCOME].includes(k) && !same(bc[k], ac[k]),
    );
    if (settingKeys.length > 0) {
      entries.push(entry("settings.changed", "patch", `Changed survey settings: ${settingKeys.join(", ")}`, { aspects: settingKeys }));
    }
  }

  const counts = {
    added: entries.filter((e) => e.kind === "question.added").length,
    removed: entries.filter((e) => e.kind === "question.removed").length,
    archived: entries.filter((e) => e.kind === "question.archived").length,
    changed: entries.filter((e) => e.kind === "question.changed").length,
    moved: entries.filter((e) => e.kind === "question.moved").length,
  };
  const bump = entries.reduce<Bump | null>((acc, e) => (acc === null || BUMP_ORDER[e.bump] > BUMP_ORDER[acc] ? e.bump : acc), null);
  return { bump, entries, counts };
}
