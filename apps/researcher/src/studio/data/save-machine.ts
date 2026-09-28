/**
 * When to save the draft, and what to do when saving goes wrong — docs/16 §5.5,
 * risk R10.
 *
 * Every decision is made here, in a pure reducer with no clock, no timers and
 * no Firebase, so each one can be tested on its own: the hook around it
 * (draft-editor.ts) only carries out the effects this returns and reports back
 * what happened. The rules it enforces:
 *
 * - A save happens 1.2 s after the last change, or at the latest 8 s after the
 *   first unsaved one, so somebody typing continuously is never more than a few
 *   seconds of work away from the server.
 * - A save is a transaction against the revision this tab last saw. If anyone
 *   saved since, nothing is written and the editor is shown both versions: a
 *   draft is NEVER silently overwritten, and never silently merged.
 * - Our own save echoing back from the listener is not someone else's change.
 *   Revisions only ever go up by one per save, so anything at or below the
 *   revision this tab is based on is ignored.
 * - Someone else's save is adopted quietly if this tab has nothing unsaved,
 *   and becomes a conflict if it has.
 * - Offline, nothing is attempted until the connection returns; other failures
 *   back off exponentially, capped, so a broken connection is not hammered.
 *
 * Local edits are counted rather than compared: `edits` goes up on every
 * change and `savedEdits` records how many a successful save covered, so a
 * change made while a save is in flight is still unsaved when it lands.
 */

export const SAVE_DEBOUNCE_MS = 1200;
export const SAVE_MAX_WAIT_MS = 8000;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;

/** A saved draft as the listener or a transaction read it. */
export interface RemoteDraft {
  revision: number;
  content: string;
  byUid: string | null;
  byEmail: string | null;
  /** Milliseconds since the epoch, or null while the server time is pending. */
  at: number | null;
}

export type SaveFailure =
  /** No connection. Retried when it returns (or by backoff if the browser thinks it is online). */
  | { kind: "offline" }
  /** The rules refused the write: the person's access changed. Not retried by itself. */
  | { kind: "permission"; message: string }
  /** Bigger than the rules accept. Retrying the same content cannot help. */
  | { kind: "too_large"; message: string }
  /** The draft document has gone. */
  | { kind: "missing"; message: string }
  | { kind: "other"; message: string };

export interface SaveMachine {
  /** The first snapshot has arrived and the editor holds a working copy. */
  loaded: boolean;
  /** The saved revision the working copy is based on. */
  baseRevision: number;
  /** Local changes made, ever. */
  edits: number;
  /** How many of those the server has (by saving, or by the editor adopting a remote version). */
  savedEdits: number;
  /** The save in progress: which edits it carries and the revision it expects. */
  inFlight: { edits: number; baseRevision: number } | null;
  firstUnsavedAt: number | null;
  lastEditAt: number | null;
  /** Save as soon as possible rather than after the idle delay. */
  saveRequested: boolean;
  online: boolean;
  failure: SaveFailure | null;
  /** Consecutive failures, for the backoff. */
  failures: number;
  /** When to try again after a failure; null to wait for a person (or the connection). */
  retryAt: number | null;
  /** Someone else's save, when it collided with unsaved work here. */
  conflict: RemoteDraft | null;
  /** The newest remote save seen while ours was in flight, dealt with once ours settles. */
  deferred: RemoteDraft | null;
  savedAt: number | null;
}

export type SaveEvent =
  | { type: "loaded"; remote: RemoteDraft }
  | { type: "edit"; now: number }
  | { type: "tick"; now: number }
  | { type: "save_now"; now: number }
  | { type: "save_succeeded"; revision: number; now: number }
  /** Nothing needed writing: the working copy is byte-for-byte what is saved. */
  | { type: "save_skipped"; now: number }
  | { type: "save_conflict"; theirs: RemoteDraft; now: number }
  | { type: "save_failed"; failure: SaveFailure; now: number }
  | { type: "remote"; remote: RemoteDraft; now: number }
  | { type: "online"; now: number }
  | { type: "offline"; now: number }
  | { type: "resolve"; choice: "keep_mine" | "take_theirs"; now: number };

export type SaveEffect =
  /** Run the save transaction for the current working copy against this revision. */
  | { type: "save"; baseRevision: number }
  /** Replace the working copy with this saved version (history is cleared by the caller). */
  | { type: "adopt"; remote: RemoteDraft; reason: "remote" | "take_theirs" }
  /** Ask the server who this person is now — their access may have changed. */
  | { type: "refresh_session" };

export interface Step {
  state: SaveMachine;
  effects: SaveEffect[];
}

export function initialSaveMachine(online: boolean): SaveMachine {
  return {
    loaded: false,
    baseRevision: 0,
    edits: 0,
    savedEdits: 0,
    inFlight: null,
    firstUnsavedAt: null,
    lastEditAt: null,
    saveRequested: false,
    online,
    failure: null,
    failures: 0,
    retryAt: null,
    conflict: null,
    deferred: null,
    savedAt: null,
  };
}

export function isDirty(s: SaveMachine): boolean {
  return s.edits !== s.savedEdits;
}

/** 2 s, 4 s, 8 s … capped at a minute. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * When the hook should next wake the machine with a `tick`, or null for "only
 * when something happens". Never earlier than a save is due.
 */
export function wakeAt(s: SaveMachine): number | null {
  if (!s.loaded || s.inFlight || s.conflict || !isDirty(s)) return null;
  if (s.failure) return s.retryAt;
  if (!s.online) return null;
  if (s.saveRequested) return 0;
  const idle = (s.lastEditAt ?? 0) + SAVE_DEBOUNCE_MS;
  const cap = (s.firstUnsavedAt ?? 0) + SAVE_MAX_WAIT_MS;
  return Math.min(idle, cap);
}

function newest(a: RemoteDraft | null, b: RemoteDraft): RemoteDraft {
  return a && a.revision >= b.revision ? a : b;
}

function startSave(s: SaveMachine): Step {
  if (!s.loaded || s.inFlight || s.conflict || !isDirty(s)) return { state: { ...s, saveRequested: false }, effects: [] };
  return {
    state: { ...s, inFlight: { edits: s.edits, baseRevision: s.baseRevision }, saveRequested: false, retryAt: null },
    effects: [{ type: "save", baseRevision: s.baseRevision }],
  };
}

/** Someone else's save, with nothing of ours in flight. */
function onRemote(s: SaveMachine, remote: RemoteDraft): Step {
  if (remote.revision <= s.baseRevision) return { state: s, effects: [] };
  if (s.conflict) return { state: { ...s, conflict: newest(s.conflict, remote) }, effects: [] };
  if (!isDirty(s)) {
    return {
      state: {
        ...s,
        baseRevision: remote.revision,
        failure: null,
        failures: 0,
        retryAt: null,
        firstUnsavedAt: null,
        lastEditAt: null,
        saveRequested: false,
      },
      effects: [{ type: "adopt", remote, reason: "remote" }],
    };
  }
  return { state: { ...s, conflict: remote, saveRequested: false, retryAt: null }, effects: [] };
}

/** After a save settles: deal with anything that arrived meanwhile, then any save asked for meanwhile. */
function afterSettle(s: SaveMachine, effects: SaveEffect[]): Step {
  let state = s;
  const out = [...effects];
  if (state.deferred) {
    const deferred = state.deferred;
    state = { ...state, deferred: null };
    const r = onRemote(state, deferred);
    state = r.state;
    out.push(...r.effects);
  }
  if (state.saveRequested && !state.conflict && !state.failure) {
    const r = startSave(state);
    state = r.state;
    out.push(...r.effects);
  }
  return { state, effects: out };
}

export function step(s: SaveMachine, event: SaveEvent): Step {
  switch (event.type) {
    case "loaded": {
      if (s.loaded) return step(s, { type: "remote", remote: event.remote, now: 0 });
      return { state: { ...s, loaded: true, baseRevision: event.remote.revision }, effects: [] };
    }

    case "edit": {
      if (!s.loaded || s.conflict) return { state: s, effects: [] };
      // A new change is a new attempt for failures that retrying the same
      // content could not fix; the backoff for the others still stands.
      const clears = s.failure && (s.failure.kind === "too_large" || s.failure.kind === "permission" || s.failure.kind === "missing");
      return {
        state: {
          ...s,
          edits: s.edits + 1,
          lastEditAt: event.now,
          firstUnsavedAt: s.firstUnsavedAt ?? event.now,
          ...(clears ? { failure: null, retryAt: null } : {}),
        },
        effects: [],
      };
    }

    case "tick": {
      const due = wakeAt(s);
      if (due === null || event.now < due) return { state: s, effects: [] };
      return startSave(s);
    }

    case "save_now": {
      if (!s.loaded || s.conflict || !isDirty(s)) return { state: s, effects: [] };
      if (s.inFlight) return { state: { ...s, saveRequested: true }, effects: [] };
      // Asked for by a person (Ctrl+S, Retry, before publishing): try now,
      // whatever the backoff or the browser's idea of being online says.
      return startSave({ ...s, failure: null, retryAt: null });
    }

    case "save_succeeded": {
      if (!s.inFlight) return { state: s, effects: [] };
      const savedEdits = s.inFlight.edits;
      const stillDirty = s.edits !== savedEdits;
      return afterSettle(
        {
          ...s,
          baseRevision: event.revision,
          savedEdits,
          inFlight: null,
          failure: null,
          failures: 0,
          retryAt: null,
          savedAt: event.now,
          firstUnsavedAt: stillDirty ? event.now : null,
          lastEditAt: stillDirty ? s.lastEditAt : null,
        },
        [],
      );
    }

    case "save_skipped": {
      if (!s.inFlight) return { state: s, effects: [] };
      const savedEdits = s.inFlight.edits;
      const stillDirty = s.edits !== savedEdits;
      return afterSettle(
        {
          ...s,
          savedEdits,
          inFlight: null,
          failure: null,
          failures: 0,
          retryAt: null,
          savedAt: s.savedAt ?? event.now,
          firstUnsavedAt: stillDirty ? event.now : null,
          lastEditAt: stillDirty ? s.lastEditAt : null,
        },
        [],
      );
    }

    case "save_conflict": {
      if (!s.inFlight) return { state: s, effects: [] };
      const theirs = s.deferred ? newest(s.deferred, event.theirs) : event.theirs;
      return {
        state: { ...s, inFlight: null, deferred: null, conflict: theirs, saveRequested: false, failure: null, retryAt: null },
        effects: [],
      };
    }

    case "save_failed": {
      if (!s.inFlight) return { state: s, effects: [] };
      const failures = s.failures + 1;
      const f = event.failure;
      const retryAt =
        f.kind === "offline"
          ? s.online
            ? event.now + backoffMs(failures)
            : null
          : f.kind === "other"
            ? event.now + backoffMs(failures)
            : null;
      const effects: SaveEffect[] = f.kind === "permission" ? [{ type: "refresh_session" }] : [];
      return afterSettle({ ...s, inFlight: null, failure: f, failures, retryAt, saveRequested: false }, effects);
    }

    case "remote": {
      if (!s.loaded) return { state: { ...s, loaded: true, baseRevision: event.remote.revision }, effects: [] };
      if (s.inFlight) {
        // Ours is in flight: this is either its echo or someone else's save
        // that will make ours fail as a conflict. Either way, wait and see.
        return { state: { ...s, deferred: s.deferred ? newest(s.deferred, event.remote) : event.remote }, effects: [] };
      }
      return onRemote(s, event.remote);
    }

    case "online": {
      const wasOffline = s.failure?.kind === "offline";
      const next: SaveMachine = {
        ...s,
        online: true,
        ...(wasOffline ? { failure: null, retryAt: null } : {}),
        saveRequested: s.saveRequested || (wasOffline && isDirty(s)),
      };
      if (next.saveRequested && !next.inFlight) return startSave(next);
      return { state: next, effects: [] };
    }

    case "offline":
      return { state: { ...s, online: false }, effects: [] };

    case "resolve": {
      const theirs = s.conflict;
      if (!theirs) return { state: s, effects: [] };
      if (event.choice === "keep_mine") {
        // Rebase: this tab's draft goes on top of theirs as the next revision.
        // Theirs stays in the audit trail; it is not merged into ours.
        return startSave({ ...s, conflict: null, baseRevision: theirs.revision, failure: null, retryAt: null, saveRequested: true });
      }
      return {
        state: {
          ...s,
          conflict: null,
          baseRevision: theirs.revision,
          savedEdits: s.edits,
          failure: null,
          failures: 0,
          retryAt: null,
          firstUnsavedAt: null,
          lastEditAt: null,
          saveRequested: false,
        },
        effects: [{ type: "adopt", remote: theirs, reason: "take_theirs" }],
      };
    }
  }
}

export type SaveStatus =
  | { kind: "saved"; at: number | null }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "offline" }
  | { kind: "error"; message: string; retryAt: number | null }
  | { kind: "conflict"; theirs: RemoteDraft };

/** What the editor shows. The hook turns `conflict` into the contract's SaveState by parsing theirs. */
export function statusOf(s: SaveMachine): SaveStatus {
  if (s.conflict) return { kind: "conflict", theirs: s.conflict };
  if (s.inFlight) return { kind: "saving" };
  if (!s.online || s.failure?.kind === "offline") return { kind: "offline" };
  if (s.failure) return { kind: "error", message: s.failure.message, retryAt: s.retryAt };
  if (isDirty(s)) return { kind: "unsaved" };
  return { kind: "saved", at: s.savedAt };
}
