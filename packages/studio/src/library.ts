import type { FragmentOrigin, ImportRecord, Issue, StudioDraft, StudioFragment } from "./contract.js";
import type { ReservedIds } from "./history.js";
import type { LockedOptions } from "./locked.js";

/**
 * The item library (D-57, docs/16 §12): taking pieces out of one survey and
 * adding them to another, the validated questionnaires as pieces, the
 * vouchers that let a copied questionnaire through its locks, and saved
 * modules' update notices.
 *
 * Everything here is a pure function of drafts and pieces, as in ops.ts: the
 * editor and the server ask the same questions through the same functions.
 *
 * CONTRACT FIRST. The signatures below are what the Studio's screens and the
 * functions are built against; the bodies are being written to docs/16 §12.
 */

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

/**
 * The piece a selection makes, self-contained: its definitions trimmed to the
 * chosen questions, every option list, scoring and file they use, block
 * conditions only where they test questions inside the piece.
 *
 * Throws StudioOpError ("invalid") for questions picked from a validated
 * questionnaire (only the whole one can be taken) or from more than one block.
 */
export function fragmentFromDraft(source: StudioDraft, selection: PieceSelection, origin: FragmentOrigin): StudioFragment {
  void source;
  void selection;
  void origin;
  throw new Error("fragmentFromDraft: not implemented yet");
}

/** Whether a question may be picked on its own (editable blocks only), and if not, why. */
export function pickable(source: StudioDraft, itemKey: string): { ok: true } | { ok: false; reason: string } {
  void source;
  void itemKey;
  throw new Error("pickable: not implemented yet");
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
}

/** The validated questionnaires, as the shelf lists them, for one language (en-GB). */
export function validatedCatalogue(language?: string): ValidatedEntry[] {
  void language;
  throw new Error("validatedCatalogue: not implemented yet");
}

/** A validated questionnaire as a piece, frozen exactly as a release freezes it (`freezeRelease`). */
export function validatedFragment(refKey: string): StudioFragment {
  void refKey;
  throw new Error("validatedFragment: not implemented yet");
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
  /** The section the piece went into. */
  sectionKey: string;
}

/**
 * Add a piece to a draft by the rules of docs/16 §12.3: IDs and variables
 * kept, renamed only on a clash; already-there questions skipped; option
 * lists shared, added or renamed; conditions kept only when they still test
 * something; files carried; provenance recorded in `draft.imports`.
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
  void draft;
  void fragment;
  void target;
  void opts;
  throw new Error("insertFragment: not implemented yet");
}

/** A one-paragraph summary of an insert for the editor's toast, in plain words. */
export function describeInsert(report: InsertReport): string {
  void report;
  throw new Error("describeInsert: not implemented yet");
}

// ---------------------------------------------------------------------------
// Vouchers: why a copied questionnaire is the licensed one (docs/16 §12.4)
// ---------------------------------------------------------------------------

/** The releases a draft names as sources, deduplicated, at most MAX_IMPORTED_RELEASES (the rest are reported). */
export function importedReleases(draft: StudioDraft): { releases: { study: string; hash: string }[]; overLimit: number } {
  void draft;
  throw new Error("importedReleases: not implemented yet");
}

/**
 * The reference definitions locked content may match, as `validateDraft`'s
 * `reference`, `referenceScales` and `referenceScoring`: the validated
 * questionnaires (when `library` is true) and the locked instruments of the
 * given releases (each already verified against its hash, as drafts).
 */
export function lockVouchers(sources: { releases: StudioDraft[]; library: boolean }): Required<LockedOptions> {
  void sources;
  throw new Error("lockVouchers: not implemented yet");
}

// ---------------------------------------------------------------------------
// Saved modules (docs/16 §12.6)
// ---------------------------------------------------------------------------

/** Why a piece cannot be saved as a module (locked or protected content, too large, malformed); empty when it can. */
export function moduleProblems(fragment: StudioFragment): Issue[] {
  void fragment;
  throw new Error("moduleProblems: not implemented yet");
}

/** The canonical JSON a module version stores, and its `sha256:` hash. */
export async function moduleContent(fragment: StudioFragment): Promise<{ content: string; contentHash: string }> {
  void fragment;
  throw new Error("moduleContent: not implemented yet");
}

/** How many questions a piece holds. */
export function questionCount(fragment: StudioFragment): number {
  void fragment;
  throw new Error("questionCount: not implemented yet");
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
  void draft;
  void latest;
  throw new Error("pendingModuleUpdates: not implemented yet");
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

/** What updating a module copy would do, question by question, three ways (docs/16 §12.6). Changes nothing. */
export function planModuleUpdate(draft: StudioDraft, importId: string, older: StudioFragment, newer: StudioFragment): ModuleUpdatePlan {
  void draft;
  void importId;
  void older;
  void newer;
  throw new Error("planModuleUpdate: not implemented yet");
}

/** Apply `planModuleUpdate` as one draft edit; the import record moves to the newer version. */
export function updateFromModule(
  draft: StudioDraft,
  importId: string,
  older: StudioFragment,
  newer: StudioFragment,
  opts: InsertOptions,
): { draft: StudioDraft; plan: ModuleUpdatePlan } {
  void draft;
  void importId;
  void older;
  void newer;
  void opts;
  throw new Error("updateFromModule: not implemented yet");
}

/** "Not now": record that this version of the module was seen and not taken. */
export function dismissModuleUpdate(draft: StudioDraft, importId: string, version: number): { draft: StudioDraft } {
  void draft;
  void importId;
  void version;
  throw new Error("dismissModuleUpdate: not implemented yet");
}

/** The import records whose questions a version still asks, trimmed to those questions, for `VersionDoc.imports`. */
export function importsForVersion(draft: StudioDraft): ImportRecord[] {
  void draft;
  throw new Error("importsForVersion: not implemented yet");
}

/** Where a question in the draft was copied from, if it was. */
export function provenanceOf(draft: StudioDraft, itemKey: string): { record: ImportRecord; sourceKey: string } | null {
  void draft;
  void itemKey;
  throw new Error("provenanceOf: not implemented yet");
}
