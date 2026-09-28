import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { doc, onSnapshot, runTransaction, serverTimestamp } from "firebase/firestore";
import { paths } from "@myself/firebase";
import {
  DraftFormatError,
  MAX_DRAFT_CHARS,
  atLeast,
  parseDraft,
  serialiseDraft,
  type DraftDoc,
  type StudioDraft,
} from "@myself/studio";
import { STUDY, studioFirebase } from "../firebase.js";
import { downloadText, toMillis, versionLabel } from "../format.js";
import { useToast } from "../ui/toast.js";
import { assessBackup, clearBackup, currentRecoveryKind, readBackup, sessionStore, writeBackup, type DraftBackup } from "./backup.js";
import { landedAttempt, rememberAttempt, type SaveAttempt } from "./own-writes.js";
import { snapshotAction } from "./snapshot-gate.js";
import { takeRestoreIntent } from "./restore-intent.js";
import { classifySaveError, codeOf, readErrorMessage } from "./errors.js";
import { record, redo, redoLabel, replace, startHistory, undo, undoLabel, type History } from "./history.js";
import { NOT_CONNECTED } from "./live.js";
import { armSaveTimer } from "./save-timer.js";
import {
  initialSaveMachine,
  isDirty,
  statusOf,
  step,
  type RemoteDraft,
  type SaveEffect,
  type SaveEvent,
  type SaveFailure,
  type SaveMachine,
} from "./save-machine.js";
import { ruleEmail, useStudioSession } from "./session.js";
import type { DraftEditor, SaveState } from "./types.js";

/**
 * The working draft of one survey, saved to Firestore as it is edited.
 *
 * Every decision about WHEN to save and what a failure or someone else's save
 * means is made by the pure machine in save-machine.ts. This hook only moves
 * data: it listens to the draft document, runs the save transaction the
 * machine asks for, and reports back. See docs/16 §5.5 and risk R10.
 */

export interface DraftRecovery {
  /** `recoverable`: can be put back as it was. `stale`: the draft moved on; download only. */
  kind: "recoverable" | "stale";
  savedAt: Date;
}

/** The draft editor plus what the platform around it needs (not part of the screens' contract). */
export interface DraftSession {
  editor: DraftEditor;
  /** Unsaved work found from before this page was loaded, if any. */
  recovery: DraftRecovery | null;
  recover: () => void;
  discardRecovery: () => void;
  downloadRecovery: () => void;
  /** The listener stopped (e.g. access changed); this subscribes again. */
  listenerError: string | null;
  reconnect: () => void;
  /** Save now; resolves true when nothing is left unsaved. Never rejects. */
  flush: () => Promise<boolean>;
  /** Why "Save and leave" cannot work at the moment, or null. */
  cannotSave: string | null;
}

function remoteOf(d: DraftDoc): RemoteDraft {
  return {
    revision: d.revision,
    content: d.content,
    byUid: d.updatedBy ?? null,
    byEmail: d.updatedByEmail ?? null,
    at: toMillis(d.updatedAt),
  };
}

function tryParse(content: string): { draft: StudioDraft } | { error: string } {
  try {
    return { draft: parseDraft(content) };
  } catch (error) {
    return { error: error instanceof DraftFormatError ? error.message : "The stored draft couldn’t be read." };
  }
}

/** At most one "Updated by …" toast per person in this long. */
const UPDATE_TOAST_GAP_MS = 30_000;

type Outcome = { kind: "saved"; revision: number } | { kind: "conflict"; theirs: RemoteDraft } | { kind: "missing" };

export function useDraftSession(surveyId: string): DraftSession {
  const fb = studioFirebase();
  const session = useStudioSession();
  const toast = useToast();
  const canEdit = atLeast(session.role, "editor");

  const [status, setStatus] = useState<DraftEditor["status"]>(fb ? "loading" : "error");
  const [loadError, setLoadError] = useState<string | null>(fb ? null : NOT_CONNECTED);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [basedOn, setBasedOn] = useState<DraftEditor["basedOn"]>(null);
  const [attempt, setAttempt] = useState(0);
  const [recovery, setRecovery] = useState<{ kind: "recoverable" | "stale"; backup: DraftBackup } | null>(null);

  // The history and the machine live in refs as well as state: two changes in
  // one tick must each start from the other's result, and the effects the
  // machine asks for must act on its newest state, not the last render's.
  const historyRef = useRef<History | null>(null);
  const [history, setHistoryState] = useState<History | null>(null);
  const setHistory = useCallback((h: History | null) => {
    historyRef.current = h;
    setHistoryState(h);
  }, []);
  const machineRef = useRef<SaveMachine>(initialSaveMachine(typeof navigator === "undefined" ? true : navigator.onLine));
  const [machine, setMachine] = useState<SaveMachine>(machineRef.current);
  /**
   * The content of a revision known to be saved, so an unchanged draft is not
   * written again. Qualified by its revision: the skip applies only when the
   * save is against that same revision, so a record that has fallen behind
   * costs one redundant write, never a skipped one.
   */
  const savedRef = useRef<{ revision: number; content: string } | null>(null);
  /** The writes this tab attempted most recently (own-writes.ts). */
  const attemptsRef = useRef<SaveAttempt[]>([]);
  const waitersRef = useRef<(() => void)[]>([]);
  const lastUpdateToastRef = useRef<{ title: string; at: number } | null>(null);

  const ctx = useRef({ uid: session.user?.uid ?? null, email: ruleEmail(session.user), refresh: session.refresh, toast });
  ctx.current = { uid: session.user?.uid ?? null, email: ruleEmail(session.user), refresh: session.refresh, toast };

  const runRef = useRef<(effect: SaveEffect) => void>(() => undefined);

  const dispatch = useCallback((event: SaveEvent) => {
    const { state, effects } = step(machineRef.current, event);
    machineRef.current = state;
    setMachine(state);
    if (!state.inFlight && waitersRef.current.length > 0) {
      const waiters = waitersRef.current;
      waitersRef.current = [];
      for (const w of waiters) w();
    }
    for (const effect of effects) runRef.current(effect);
  }, []);

  const adopt = useCallback(
    (remote: RemoteDraft, reason: "remote" | "take_theirs") => {
      const parsed = tryParse(remote.content);
      if ("error" in parsed) {
        setStatus("error");
        setLoadError(`The latest saved draft can’t be opened: ${parsed.error}`);
        return;
      }
      savedRef.current = { revision: remote.revision, content: remote.content };
      const intent = reason === "remote" ? takeRestoreIntent(surveyId, remote.revision) : null;
      const h = historyRef.current;
      if (intent && h) {
        // This tab asked for the restore: keep it undoable, so what was in
        // the draft before can be brought back.
        setHistory(record(h, parsed.draft, `Restore ${versionLabel(intent.version)}`, Date.now()));
        return;
      }
      setHistory(replace(parsed.draft));
      if (reason === "remote") {
        const mine = remote.byUid !== null && remote.byUid === ctx.current.uid;
        const title = mine ? "Updated from your other tab" : `Updated by ${remote.byEmail ?? "someone else"}`;
        // A colleague who is typing saves every few seconds. One toast per
        // person per half-minute says so, instead of a stream of them (each
        // also read out by a screen reader).
        const now = Date.now();
        const last = lastUpdateToastRef.current;
        if (!last || last.title !== title || now - last.at >= UPDATE_TOAST_GAP_MS) {
          lastUpdateToastRef.current = { title, at: now };
          ctx.current.toast.info(title, "The draft now shows the latest saved version.");
        }
      }
    },
    [surveyId, setHistory],
  );

  const save = useCallback(
    async (baseRevision: number) => {
      const now = () => Date.now();
      const fail = (failure: SaveFailure) => queueMicrotask(() => dispatch({ type: "save_failed", failure, now: now() }));
      const h = historyRef.current;
      const { uid, email } = ctx.current;
      if (!fb || !h || !uid) {
        fail({ kind: "other", message: "You’re not signed in, so the draft can’t be saved." });
        return;
      }
      const content = serialiseDraft(h.present);
      const saved = savedRef.current;
      if (saved && saved.revision === baseRevision && saved.content === content) {
        queueMicrotask(() => dispatch({ type: "save_skipped", now: now() }));
        return;
      }
      if (content.length > MAX_DRAFT_CHARS) {
        fail({
          kind: "too_large",
          message: `The draft is too big to save (${content.length.toLocaleString("en-GB")} characters; the limit is ${MAX_DRAFT_CHARS.toLocaleString("en-GB")}). Archive or remove something, and it will save.`,
        });
        return;
      }
      const ref = doc(fb.db, paths.studioDraft(STUDY, surveyId));
      // Remembered before the transaction runs, so a retry of this very
      // transaction (after its first commit landed unacknowledged) knows its
      // own write when it reads it.
      attemptsRef.current = rememberAttempt(attemptsRef.current, {
        baseRevision,
        content,
        edits: machineRef.current.inFlight?.edits ?? machineRef.current.edits,
      });
      try {
        const outcome = await runTransaction<Outcome>(fb.db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) return { kind: "missing" };
          const current = snap.data() as DraftDoc;
          let base = baseRevision;
          if (current.revision !== baseRevision) {
            const mine = landedAttempt(attemptsRef.current, current, uid);
            if (!mine || mine.baseRevision !== baseRevision) return { kind: "conflict", theirs: remoteOf(current) };
            // Not somebody else: an earlier save of ours that landed without
            // its answer. Nothing to write if it is this very content;
            // otherwise the rest of our work goes on top of it.
            if (current.content === content) return { kind: "saved", revision: current.revision };
            base = current.revision;
          }
          // Exactly the fields the rules allow an editor to change
          // (DRAFT_CLIENT_FIELDS): anything more and the whole write is refused.
          tx.update(ref, {
            content,
            revision: base + 1,
            updatedAt: serverTimestamp(),
            updatedBy: uid,
            updatedByEmail: email,
          });
          return { kind: "saved", revision: base + 1 };
        });
        if (outcome.kind === "saved") {
          savedRef.current = { revision: outcome.revision, content };
          dispatch({ type: "save_succeeded", revision: outcome.revision, now: now() });
        } else if (outcome.kind === "conflict") {
          dispatch({ type: "save_conflict", theirs: outcome.theirs, now: now() });
        } else {
          dispatch({
            type: "save_failed",
            failure: { kind: "missing", message: "This survey’s draft is no longer there. Reload the page to see what happened." },
            now: now(),
          });
        }
      } catch (error) {
        const c = classifySaveError(error);
        const failure: SaveFailure =
          c.kind === "offline"
            ? { kind: "offline" }
            : c.kind === "permission"
              ? { kind: "permission", message: c.message }
              : { kind: "other", message: c.message };
        dispatch({ type: "save_failed", failure, now: now() });
      }
    },
    [fb, surveyId, dispatch],
  );

  runRef.current = (effect: SaveEffect) => {
    if (effect.type === "save") void save(effect.baseRevision);
    else if (effect.type === "adopt") adopt(effect.remote, effect.reason);
    else void ctx.current.refresh();
  };

  // ── The draft document ──────────────────────────────────────────────────
  useEffect(() => {
    if (!fb) return;
    const ref = doc(fb.db, paths.studioDraft(STUDY, surveyId));
    return onSnapshot(
      ref,
      // Metadata changes too: a cached snapshot that the server then confirms
      // unchanged arrives only as a metadata change, and the working copy
      // waits for exactly that confirmation (snapshot-gate.ts).
      { includeMetadataChanges: true },
      (snap) => {
        setListenerError(null);
        const action = snapshotAction({ exists: snap.exists(), fromCache: snap.metadata.fromCache }, machineRef.current.loaded);
        if (action === "wait") return;
        if (action === "missing") {
          setStatus("missing");
          return;
        }
        const data = snap.data() as DraftDoc;
        setBasedOn((prev) => (prev?.version === data.basedOn?.version && prev?.hash === data.basedOn?.hash ? prev : (data.basedOn ?? null)));
        if (action === "remote") {
          // Our own save whose answer never came back is not someone else's.
          const mine = landedAttempt(attemptsRef.current, data, ctx.current.uid);
          const remote: RemoteDraft = mine ? { ...remoteOf(data), landedEdits: mine.edits } : remoteOf(data);
          dispatch({ type: "remote", remote, now: Date.now() });
          if (mine && machineRef.current.baseRevision === remote.revision) {
            savedRef.current = { revision: remote.revision, content: remote.content };
          }
          return;
        }
        const remote = remoteOf(data);
        const parsed = tryParse(data.content);
        if ("error" in parsed) {
          setStatus("error");
          setLoadError(parsed.error);
          return;
        }
        savedRef.current = { revision: data.revision, content: data.content };
        setHistory(startHistory(parsed.draft));
        dispatch({ type: "loaded", remote });
        setStatus("ready");
        setLoadError(null);
        const uid = ctx.current.uid ?? "";
        const backup = uid ? readBackup(sessionStore(), { surveyId, uid }) : null;
        const kind = assessBackup(backup, { surveyId, uid, revision: data.revision, content: data.content });
        if (backup && kind !== "none") setRecovery({ kind, backup });
      },
      (error) => {
        const message = readErrorMessage(error, "this survey’s draft");
        if (machineRef.current.loaded) setListenerError(message);
        else {
          setStatus("error");
          setLoadError(message);
        }
        if (codeOf(error)?.endsWith("permission-denied")) void ctx.current.refresh();
      },
    );
  }, [fb, surveyId, attempt, dispatch, setHistory]);

  // ── The save timer ──────────────────────────────────────────────────────
  // Re-armed on every change of state. A timer that fires a moment before
  // the wall clock says it is due still counts as due (save-timer.ts):
  // otherwise the tick changes nothing, nothing re-renders, and the save
  // waits for the next keystroke.
  useEffect(
    () =>
      armSaveTimer(
        {
          now: () => Date.now(),
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (id) => window.clearTimeout(id),
        },
        () => machineRef.current,
        (now) => dispatch({ type: "tick", now }),
      ),
    [machine, dispatch],
  );

  // ── Connection ──────────────────────────────────────────────────────────
  useEffect(() => {
    const up = () => dispatch({ type: "online", now: Date.now() });
    const down = () => dispatch({ type: "offline", now: Date.now() });
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [dispatch]);

  // ── Crash protection ────────────────────────────────────────────────────
  const dirty = isDirty(machine);
  const uid = session.user?.uid ?? "";
  useEffect(() => {
    if (!history || !machine.loaded || !uid) return;
    const store = sessionStore();
    if (!dirty) {
      // Saved: the backup has done its job. Unless one from before the reload
      // is still waiting for a decision — that is the only copy of it.
      if (!recovery) clearBackup(store, { surveyId, uid });
      return;
    }
    const base = machine.baseRevision;
    const t = window.setTimeout(
      () => writeBackup(store, { surveyId, uid, baseRevision: base, content: serialiseDraft(history.present), savedAt: Date.now() }),
      400,
    );
    return () => window.clearTimeout(t);
  }, [history, dirty, machine.loaded, machine.baseRevision, recovery, surveyId, uid]);

  useEffect(() => {
    const keep = () => {
      const s = machineRef.current;
      const h = historyRef.current;
      if (h && s.loaded && isDirty(s) && uid) {
        writeBackup(sessionStore(), { surveyId, uid, baseRevision: s.baseRevision, content: serialiseDraft(h.present), savedAt: Date.now() });
      }
    };
    window.addEventListener("pagehide", keep);
    return () => {
      window.removeEventListener("pagehide", keep);
      // Leaving the survey inside the Studio unmounts this: keep the copy the
      // leave prompt promised.
      keep();
    };
  }, [surveyId, uid]);

  // ── Editing ─────────────────────────────────────────────────────────────
  const readOnly = !canEdit || machine.conflict !== null || status !== "ready";
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Reads refs only, so the callbacks below can stay stable across renders.
  const editable = () => !readOnlyRef.current && !machineRef.current.conflict && machineRef.current.loaded;

  const apply = useCallback(
    (change: (draft: StudioDraft) => StudioDraft, label: string) => {
      const h = historyRef.current;
      if (!h || !editable()) return;
      // Outside any state updater, so an operation's error reaches the caller
      // and the draft is left exactly as it was.
      const next = change(h.present);
      if (next === h.present) return;
      setHistory(record(h, next, label, Date.now()));
      dispatch({ type: "edit", now: Date.now() });
    },
    [dispatch, setHistory],
  );

  const doUndo = useCallback(() => {
    const h = historyRef.current;
    if (!h || !editable()) return;
    const next = undo(h);
    if (next === h) return;
    setHistory(next);
    dispatch({ type: "edit", now: Date.now() });
  }, [dispatch, setHistory]);

  const doRedo = useCallback(() => {
    const h = historyRef.current;
    if (!h || !editable()) return;
    const next = redo(h);
    if (next === h) return;
    setHistory(next);
    dispatch({ type: "edit", now: Date.now() });
  }, [dispatch, setHistory]);

  const saveNow = useCallback(
    () =>
      new Promise<void>((resolve) => {
        dispatch({ type: "save_now", now: Date.now() });
        if (!machineRef.current.inFlight) resolve();
        else waitersRef.current.push(resolve);
      }),
    [dispatch],
  );

  const flush = useCallback(async () => {
    await saveNow();
    const s = machineRef.current;
    return !isDirty(s) && !s.conflict;
  }, [saveNow]);

  const resolveConflict = useCallback(
    (choice: "keep_mine" | "take_theirs") => {
      const theirs = machineRef.current.conflict;
      // Keeping mine rebases onto their revision, so theirs is now what is
      // saved: an unchanged-draft check must compare against it, not against
      // this tab's last save, or "nothing to write" could leave theirs in place.
      if (choice === "keep_mine" && theirs) savedRef.current = { revision: theirs.revision, content: theirs.content };
      dispatch({ type: "resolve", choice, now: Date.now() });
    },
    [dispatch],
  );

  // Ctrl/Cmd+S saves now instead of saving the web page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow]);

  // ── What the screens see ────────────────────────────────────────────────
  const conflict = machine.conflict;
  const theirs = useMemo(() => (conflict ? tryParse(conflict.content) : null), [conflict]);

  const saveState = useMemo<SaveState>(() => {
    const s = statusOf(machine);
    switch (s.kind) {
      case "saved":
        return { kind: "saved", at: s.at !== null ? new Date(s.at) : null };
      case "error":
        return { kind: "error", message: s.message, retryAt: s.retryAt !== null ? new Date(s.retryAt) : null };
      case "conflict":
        if (!theirs || "error" in theirs) {
          return {
            kind: "error",
            message: `Someone else saved a version of this draft that can’t be opened here${theirs && "error" in theirs ? ` (${theirs.error})` : ""}. Reload the page.`,
            retryAt: null,
          };
        }
        return {
          kind: "conflict",
          theirs: {
            draft: theirs.draft,
            revision: s.theirs.revision,
            by: s.theirs.byEmail,
            at: s.theirs.at !== null ? new Date(s.theirs.at) : null,
          },
        };
      default:
        return s;
    }
  }, [machine, theirs]);

  const editor = useMemo<DraftEditor>(
    () => ({
      status,
      error: loadError,
      draft: history?.present ?? null,
      revision: machine.baseRevision,
      basedOn,
      save: saveState,
      readOnly,
      hasUnsavedChanges: dirty,
      apply,
      undo: doUndo,
      redo: doRedo,
      canUndo: !readOnly && (history?.past.length ?? 0) > 0,
      canRedo: !readOnly && (history?.future.length ?? 0) > 0,
      undoLabel: history ? undoLabel(history) : null,
      redoLabel: history ? redoLabel(history) : null,
      saveNow,
      resolveConflict,
    }),
    [status, loadError, history, machine.baseRevision, basedOn, saveState, readOnly, dirty, apply, doUndo, doRedo, saveNow, resolveConflict],
  );

  // ── Recovery ────────────────────────────────────────────────────────────
  const recover = useCallback(() => {
    if (!recovery) return;
    // Checked again now, not only at load: if the draft has been saved since
    // (by anyone), putting the copy back would overwrite that save unseen.
    if (currentRecoveryKind(recovery.kind, recovery.backup.baseRevision, machineRef.current.baseRevision, readOnlyRef.current) !== "recoverable") {
      return;
    }
    const parsed = tryParse(recovery.backup.content);
    if ("error" in parsed) {
      ctx.current.toast.error("The unsaved copy couldn’t be read", parsed.error);
      return;
    }
    apply(() => parsed.draft, "Recover unsaved changes");
    setRecovery(null);
    ctx.current.toast.success("Unsaved changes recovered", "They’re being saved now.");
  }, [recovery, apply]);

  const discardRecovery = useCallback(() => {
    if (!recovery) return;
    const store = sessionStore();
    // Only remove it if what is stored is still that copy: this tab may since
    // have written a backup of its own work under the same key.
    const slot = { surveyId, uid: recovery.backup.uid };
    if (readBackup(store, slot)?.content === recovery.backup.content) clearBackup(store, slot);
    setRecovery(null);
  }, [recovery, surveyId]);

  const downloadRecovery = useCallback(() => {
    if (!recovery) return;
    const stamp = new Date(recovery.backup.savedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadText(recovery.backup.content, `${surveyId}-unsaved-draft-${stamp}.json`);
  }, [recovery, surveyId]);

  const online = machine.online;
  const cannotSave = machine.conflict
    ? "Someone else saved this draft while you were editing. Choose which version to keep before leaving."
    : !online
      ? "You’re offline, so your changes can’t be saved right now."
      : !canEdit
        ? "Your account can’t save changes to this survey."
        : null;

  return {
    editor,
    recovery: recovery
      ? {
          kind: currentRecoveryKind(recovery.kind, recovery.backup.baseRevision, machine.baseRevision, readOnly),
          savedAt: new Date(recovery.backup.savedAt),
        }
      : null,
    recover,
    discardRecovery,
    downloadRecovery,
    listenerError,
    reconnect: () => setAttempt((a) => a + 1),
    flush,
    cannotSave,
  };
}

/** The working draft of one survey. See useDraftSession for the platform's extra controls. */
export function useDraftEditor(surveyId: string): DraftEditor {
  return useDraftSession(surveyId).editor;
}
