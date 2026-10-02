import { createHash } from "node:crypto";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { paths } from "@myself/firebase";
import { diffDrafts, parseDraft, type StudioDraft, type Unlock } from "@myself/studio";
import { auditRow, type AuditActor } from "./audit.js";

/**
 * The draft's activity log: who edited what, written by a trigger (docs/16 §5.8).
 *
 * Editors save the draft straight to Firestore, under the rules, a revision
 * at a time — every few seconds while somebody is typing. One audit row per
 * save would bury everything else in the log, so saves are COALESCED: one row
 * per editor per ten-minute window, listing every question they changed in
 * it. An unlock of a protected module is different — it is an acknowledgement
 * somebody made on the record — so each gets a row of its own.
 *
 * AT-LEAST-ONCE, SO IDEMPOTENT. Firestore may deliver one write's event more
 * than once. A row is therefore a set, not a tally: question IDs are unioned,
 * the revision range is a min and a max, the times are the saves' own server
 * timestamps (never "now"), and nothing counts, so delivering the same event
 * twice leaves the row exactly as once did.
 *
 * WHO is the draft's `updatedBy` / `updatedByEmail`, which the rules force to
 * be the saver's own uid and list key, never the unlock record's own `by`,
 * which is text the editor's browser wrote.
 *
 * A draft that cannot be read is recorded as an edit that could not be listed,
 * and logged. It is never thrown over: a trigger that throws on bad content
 * would fail the same way on every delivery, and the log would lose the edit.
 */

export const EDIT_WINDOW_MS = 10 * 60 * 1000;

/** At most this many question IDs on one row; a longer list is marked truncated. */
export const MAX_KEYS_PER_ROW = 300;

/**
 * At most this many `draft.unlocked` rows from one save. A survey has a
 * handful of protected modules, so a real save never comes near it. The limit
 * is there because `unlocked` is text the editor's browser wrote: without it,
 * one save carrying thousands of made-up entries would have this trigger read
 * and create thousands of rows in a single transaction — burying the real
 * record, and past Firestore's commit limits failing the whole event, the
 * save's own `draft.edited` row with it, so the save would never be attributed
 * to anybody. Entries past the limit are named on the edit row instead
 * (`unlocksNotRowed`).
 */
export const MAX_UNLOCK_ROWS_PER_SAVE = 25;

export function editWindow(ms: number): number {
  return Math.floor(ms / EDIT_WINDOW_MS);
}

export function editRowId(surveyId: string, uid: string, window: number): string {
  return `${surveyId}_draft_${uid}_${window}`;
}

/** The row an unlock gets. Deterministic, so a redelivered event finds it already written. */
export function unlockRowId(surveyId: string, instrument: string, revision: number): string {
  // The instrument key is text from the draft; hashed so it can never shape the path.
  const digest = createHash("sha256").update(instrument).digest("hex").slice(0, 16);
  return `${surveyId}_unlock_${revision}_${digest}`;
}

/** The fields of a draft document the trigger reads. */
export interface DraftSide {
  content?: unknown;
  revision?: unknown;
  updatedBy?: unknown;
  updatedByEmail?: unknown;
  updatedAt?: unknown;
}

export interface UnlockGained {
  instrument: string;
  reason: string;
  /** What the editor's browser wrote; recorded, never used as the actor. */
  claimedBy: string | null;
  claimedAt: string | null;
}

export type DraftWrite =
  | { kind: "ignore"; why: string }
  | {
      kind: "edit";
      editor: AuditActor;
      fromRevision: number;
      toRevision: number;
      /** Millisecond time of the save (its server timestamp), or null when the document had none. */
      atMs: number | null;
      itemKeys: string[];
      sections: string[];
      changes: string[];
      aspects: string[];
      /** Unlocks gained, each to get its own row: at most MAX_UNLOCK_ROWS_PER_SAVE. */
      unlocks: UnlockGained[];
      /** Instruments unlocked beyond that limit, named on the edit row instead. */
      unlocksNotRowed: string[];
      unparsable: boolean;
    };

function millisOf(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  const t = value as { toMillis?: () => number } | null;
  return t && typeof t.toMillis === "function" ? t.toMillis() : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function readDraft(content: unknown): StudioDraft | null {
  if (typeof content !== "string") return null;
  try {
    return parseDraft(content);
  } catch {
    return null;
  }
}

function unlocksGained(before: StudioDraft["unlocked"] | undefined, after: StudioDraft["unlocked"] | undefined): UnlockGained[] {
  const was = before ?? {};
  const now = after ?? {};
  const out: UnlockGained[] = [];
  for (const instrument of Object.keys(now)) {
    const entry = now[instrument] as Partial<Unlock> | undefined;
    const previous = Object.prototype.hasOwnProperty.call(was, instrument) ? was[instrument] : undefined;
    if (previous && JSON.stringify(previous) === JSON.stringify(entry)) continue;
    out.push({
      instrument: instrument.slice(0, 200),
      reason: text(entry?.reason, 2_000) ?? "",
      claimedBy: text(entry?.by, 200),
      claimedAt: text(entry?.at, 64),
    });
  }
  return out;
}

/** The unlocks that get rows of their own, and the names of any past the limit. */
function splitUnlocks(gained: UnlockGained[]): { unlocks: UnlockGained[]; unlocksNotRowed: string[] } {
  return {
    unlocks: gained.slice(0, MAX_UNLOCK_ROWS_PER_SAVE),
    unlocksNotRowed: gained.slice(MAX_UNLOCK_ROWS_PER_SAVE, MAX_UNLOCK_ROWS_PER_SAVE + MAX_KEYS_PER_ROW).map((u) => u.instrument),
  };
}

/**
 * What a write to the draft document amounts to. Pure: the whole decision,
 * without Firestore, so the tests can put every kind of write through it.
 */
export function describeDraftWrite(before: DraftSide | undefined, after: DraftSide | undefined): DraftWrite {
  // Created (a new survey, the import) or removed: functions do both, and
  // audit them themselves.
  if (!before || !after) return { kind: "ignore", why: "created or deleted" };
  // Only provenance moved — the publish setting `basedOn`. Not an edit.
  if (before.content === after.content && before.revision === after.revision) return { kind: "ignore", why: "content unchanged" };

  const uid = typeof after.updatedBy === "string" && after.updatedBy ? after.updatedBy : "unknown";
  const email = typeof after.updatedByEmail === "string" && after.updatedByEmail ? after.updatedByEmail : null;
  const toRevision = typeof after.revision === "number" ? after.revision : 0;
  const fromRevision = typeof before.revision === "number" ? before.revision : toRevision;
  const base = {
    kind: "edit" as const,
    editor: { uid, email },
    fromRevision,
    toRevision,
    atMs: millisOf(after.updatedAt),
  };

  const unlisted = { ...base, itemKeys: [], sections: [], changes: [], aspects: [], unlocks: [], unlocksNotRowed: [], unparsable: true };
  const was = readDraft(before.content);
  const now = readDraft(after.content);
  // With nothing readable to compare against, every unlock the new draft
  // carries is recorded: a repeated acknowledgement is harmless, a lost one
  // is not.
  if (!now) return unlisted;
  // Worked out before, and apart from, the comparison of the two drafts: an
  // acknowledgement on the record must not be lost because the diff of the
  // rest of the draft could not be made.
  const unlocks = splitUnlocks(unlocksGained(was?.unlocked ?? {}, now.unlocked));
  if (!was) return { ...unlisted, ...unlocks };

  try {
    const itemKeys: string[] = [];
    const sections: string[] = [];
    const changes: string[] = [];
    const aspects: string[] = [];
    const add = (list: string[], value: string | undefined) => {
      if (value && !list.includes(value)) list.push(value);
    };
    for (const entry of diffDrafts(was, now).entries) {
      if (entry.itemKey) add(itemKeys, entry.itemKey);
      else add(sections, entry.sectionKey);
      add(changes, entry.kind);
      for (const aspect of entry.aspects ?? []) add(aspects, aspect);
    }
    return { ...base, itemKeys, sections, changes, aspects, ...unlocks, unparsable: false };
  } catch {
    // Both documents parsed but could not be compared: a shape the model
    // never anticipated. Recorded, not thrown over.
    return { ...unlisted, ...unlocks };
  }
}

/** A coalesced row as stored: what `mergeEditRow` reads back and writes. */
export interface EditRowDetail {
  itemKeys: string[];
  sections: string[];
  changes: string[];
  aspects: string[];
  fromRevision: number;
  toRevision: number;
  firstAt: Timestamp | null;
  unparsable: boolean;
  truncated: boolean;
  /** Present only when some save's unlocks were past MAX_UNLOCK_ROWS_PER_SAVE: those instruments. */
  unlocksNotRowed?: string[];
}

function union(a: unknown, b: string[]): string[] {
  const out = Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

function earliest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (!a) return b;
  if (!b) return a;
  return a.toMillis() <= b.toMillis() ? a : b;
}

function latest(a: Timestamp | null, b: Timestamp | null): Timestamp | null {
  if (!a) return b;
  if (!b) return a;
  return a.toMillis() >= b.toMillis() ? a : b;
}

/**
 * One save folded into the editor's row for its window. Commutative and
 * idempotent: folding the same save twice, or two saves in either order, gives
 * the same row.
 */
export function mergeEditRow(
  existing: { detail?: Partial<EditRowDetail> | null; at?: unknown } | null,
  write: Extract<DraftWrite, { kind: "edit" }>,
): { subject: string; at: Timestamp | null; detail: EditRowDetail } {
  const was = existing?.detail ?? {};
  const at = write.atMs === null ? null : Timestamp.fromMillis(write.atMs);
  let itemKeys = union(was.itemKeys, write.itemKeys);
  const truncated = was.truncated === true || itemKeys.length > MAX_KEYS_PER_ROW;
  itemKeys = itemKeys.slice(0, MAX_KEYS_PER_ROW);
  const firstAt = earliest(was.firstAt instanceof Timestamp ? was.firstAt : null, at);
  const lastAt = latest(existing?.at instanceof Timestamp ? existing.at : null, at);
  const detail: EditRowDetail = {
    itemKeys,
    sections: union(was.sections, write.sections).slice(0, MAX_KEYS_PER_ROW),
    changes: union(was.changes, write.changes),
    aspects: union(was.aspects, write.aspects),
    fromRevision: typeof was.fromRevision === "number" ? Math.min(was.fromRevision, write.fromRevision) : write.fromRevision,
    toRevision: typeof was.toRevision === "number" ? Math.max(was.toRevision, write.toRevision) : write.toRevision,
    firstAt,
    unparsable: was.unparsable === true || write.unparsable,
    truncated,
  };
  const notRowed = union(was.unlocksNotRowed, write.unlocksNotRowed).slice(0, MAX_KEYS_PER_ROW);
  if (notRowed.length > 0) detail.unlocksNotRowed = notRowed;
  // The Studio's activity list reads the question IDs from the subject.
  return { subject: itemKeys.join(", "), at: lastAt, detail };
}

/**
 * Record one write to a survey's draft. The Firestore half of the trigger:
 * the coalesced edit row, any unlock rows, and the editor added to the
 * survey's `draftEditors` — all in one transaction, so a redelivered event
 * reads what the first delivery wrote.
 */
export async function recordDraftWrite(
  db: Firestore,
  params: { study: string; surveyId: string; docId: string },
  before: DraftSide | undefined,
  after: DraftSide | undefined,
  eventTime: string,
): Promise<DraftWrite> {
  const { study, surveyId, docId } = params;
  if (docId !== "current") return { kind: "ignore", why: "not the current draft" };
  const write = describeDraftWrite(before, after);
  if (write.kind === "ignore") return write;
  if (write.unparsable) {
    logger.warn("studio draft trigger: a saved draft could not be read, so its changes were not listed", {
      study,
      surveyId,
      revision: write.toRevision,
    });
  }
  const edit = write;
  const atMs = edit.atMs ?? Date.parse(eventTime);
  const window = editWindow(Number.isFinite(atMs) ? atMs : Date.now());
  const auditPath = paths.studioAudit(study);
  const rowRef = db.doc(`${auditPath}/${editRowId(surveyId, edit.editor.uid, window)}`);
  const surveyRef = db.doc(paths.studioSurvey(study, surveyId));
  const unlockRefs = edit.unlocks.map((u) => db.doc(`${auditPath}/${unlockRowId(surveyId, u.instrument, edit.toRevision)}`));
  // An edit already inside a published version belongs to that version's
  // authors; an event arriving after the publish must not add its editor to
  // the next one's.
  const publishedSince = db
    .collection(paths.studioVersions(study, surveyId))
    .where("draftRevision", ">=", edit.toRevision)
    .limit(1);

  await db.runTransaction(async (tx) => {
    const [row, survey, ...unlockSnaps] = await tx.getAll(rowRef, surveyRef, ...unlockRefs);
    const published = await tx.get(publishedSince);

    const merged = mergeEditRow(row!.exists ? (row!.data() as { detail?: Partial<EditRowDetail>; at?: unknown }) : null, edit);
    const base = auditRow("draft.edited", edit.editor, surveyId, merged.subject, merged.detail as unknown as Record<string, unknown>);
    tx.set(rowRef, { ...base, at: merged.at ?? FieldValue.serverTimestamp() });

    edit.unlocks.forEach((u, i) => {
      if (unlockSnaps[i]!.exists) return;
      const unlockRow = auditRow("draft.unlocked", edit.editor, surveyId, u.instrument, {
        reason: u.reason,
        revision: edit.toRevision,
        claimedBy: u.claimedBy,
        claimedAt: u.claimedAt,
      });
      tx.create(unlockRefs[i]!, edit.atMs === null ? unlockRow : { ...unlockRow, at: Timestamp.fromMillis(edit.atMs) });
    });

    const editorKey = edit.editor.email ?? `uid:${edit.editor.uid}`;
    if (survey!.exists && published.empty) tx.update(surveyRef, { draftEditors: FieldValue.arrayUnion(editorKey) });
  });
  return write;
}
