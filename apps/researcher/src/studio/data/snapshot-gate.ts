/**
 * What to do with a snapshot of the draft document — the one decision in the
 * listener that is not the save machine's.
 *
 * The working copy must START from what the server says, never from the local
 * cache. A save is a transaction, and transactions do not update the cache;
 * so after "Save and leave" (or any save whose echo had not arrived when the
 * listener was dropped) the cache can still hold the revision before it.
 * Coming back to the survey, the listener's first snapshot is then that stale
 * revision, the editor opens editable on it, and the real latest save — often
 * the person's own — arrives as a CONFLICT with whatever they typed meanwhile.
 * On a slow or dropped connection that window is seconds long.
 *
 * Offline with nothing cached, the first snapshot says the document does not
 * exist (from the cache). That is "not known yet", not "this survey has no
 * draft", so it waits too.
 *
 * Once the working copy has started, every snapshot goes to the machine,
 * which ignores anything at or below the revision it holds.
 */

export type SnapshotAction = "wait" | "missing" | "load" | "remote";

export function snapshotAction(snap: { exists: boolean; fromCache: boolean }, loaded: boolean): SnapshotAction {
  if (loaded) return snap.exists ? "remote" : "wait";
  if (snap.fromCache) return "wait";
  return snap.exists ? "load" : "missing";
}
