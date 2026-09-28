/**
 * Crash protection for unsaved work.
 *
 * A save is at most a few seconds behind the typing, but a tab can still be
 * reloaded, crash or be navigated away from inside that window — and while
 * offline the window is as long as the outage. So the unsaved working copy is
 * also kept in sessionStorage: it survives a reload of the same tab and dies
 * with it, which is the right lifetime on the shared github.io origin (docs/16
 * §8), where nothing about a survey should outlive the tab.
 *
 * A backup belongs to one person and one survey. Somebody who signs out and
 * hands the tab to a colleague must not have their unsaved work offered to the
 * colleague as the colleague's own.
 *
 * A backup is only ever offered back as it was taken. If the saved draft has
 * moved on since (somebody else saved, or this tab's save landed after all),
 * applying it would overwrite newer work, so it is offered as a download
 * instead and never applied.
 */

export interface DraftBackup {
  surveyId: string;
  /** Whose unsaved work this is. */
  uid: string;
  /** The saved revision the unsaved work was based on. */
  baseRevision: number;
  /** The unsaved working copy, as StudioDraft JSON. */
  content: string;
  /** When the backup was taken (ms since the epoch). */
  savedAt: number;
}

/** Which backup: one per person per survey. */
export interface BackupSlot {
  surveyId: string;
  uid: string;
}

/** The subset of Storage used, so tests can pass a Map-backed stand-in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const BACKUP_PREFIX = "myself-studio:unsaved:";

export function backupKey(slot: BackupSlot): string {
  return `${BACKUP_PREFIX}${slot.uid}:${slot.surveyId}`;
}

/** The backup in a slot, or null if there is none or it is not one of ours. */
export function readBackup(storage: StorageLike | null, slot: BackupSlot): DraftBackup | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(backupKey(slot));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Partial<DraftBackup> | null;
    if (
      !b ||
      b.surveyId !== slot.surveyId ||
      b.uid !== slot.uid ||
      typeof b.baseRevision !== "number" ||
      !Number.isInteger(b.baseRevision) ||
      typeof b.content !== "string" ||
      typeof b.savedAt !== "number"
    ) {
      return null;
    }
    return { surveyId: b.surveyId, uid: b.uid, baseRevision: b.baseRevision, content: b.content, savedAt: b.savedAt };
  } catch {
    return null;
  }
}

/** Keep a backup. False when the browser refused (private mode, quota) — never throws. */
export function writeBackup(storage: StorageLike | null, backup: DraftBackup): boolean {
  if (!storage) return false;
  try {
    storage.setItem(backupKey(backup), JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
}

export function clearBackup(storage: StorageLike | null, slot: BackupSlot): void {
  if (!storage) return;
  try {
    storage.removeItem(backupKey(slot));
  } catch {
    // Nothing to do: a backup that cannot be removed is offered once more on reload, and is harmless.
  }
}

/**
 * What to do with a backup found when the draft loads.
 *
 * - `none`: nothing to offer (no backup, somebody else's, or identical to what is saved).
 * - `recoverable`: taken against the revision that is saved now, so applying it
 *   loses nothing of anybody else's.
 * - `stale`: the draft has been saved since; offer it only as a download.
 */
export function assessBackup(
  backup: DraftBackup | null,
  current: { surveyId: string; uid: string; revision: number; content: string },
): "none" | "recoverable" | "stale" {
  if (!backup || backup.surveyId !== current.surveyId || backup.uid !== current.uid) return "none";
  if (backup.content === current.content) return "none";
  return backup.baseRevision === current.revision ? "recoverable" : "stale";
}

/**
 * Whether a backup found `recoverable` when the draft loaded may STILL be put
 * back. assessBackup answers once, at load; the draft can move on after that
 * (a colleague's save adopted, this tab's own saves), and putting back a copy
 * taken against an older revision would then silently overwrite the newer
 * work — as an ordinary edit, with no conflict to stop it. So it is
 * recoverable only while the working copy is still based on the revision the
 * backup was taken against, and only for someone who can edit.
 */
export function currentRecoveryKind(
  assessed: "recoverable" | "stale",
  backupBaseRevision: number,
  currentBaseRevision: number,
  readOnly: boolean,
): "recoverable" | "stale" {
  return assessed === "recoverable" && !readOnly && backupBaseRevision === currentBaseRevision ? "recoverable" : "stale";
}

/** sessionStorage, or null where the browser will not give it (a sandboxed frame, some private modes). */
export function sessionStore(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
