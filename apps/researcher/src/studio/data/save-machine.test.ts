import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  backoffMs,
  initialSaveMachine,
  isDirty,
  statusOf,
  step,
  wakeAt,
  type RemoteDraft,
  type SaveEffect,
  type SaveEvent,
  type SaveMachine,
} from "./save-machine.js";

const remote = (revision: number, content = `rev${revision}`, byEmail = "other@example.org"): RemoteDraft => ({
  revision,
  content,
  byUid: byEmail === "me@example.org" ? "me" : "them",
  byEmail,
  at: 1_000,
});

/** Run events in order, collecting every effect. */
function run(events: SaveEvent[], from: SaveMachine = initialSaveMachine(true)) {
  let state = from;
  const effects: SaveEffect[] = [];
  for (const e of events) {
    const r = step(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const loadedAt = (revision: number, online = true) => run([{ type: "loaded", remote: remote(revision) }], initialSaveMachine(online)).state;

describe("when the draft is saved", () => {
  it("waits for a pause in typing before saving", () => {
    const s = run([{ type: "edit", now: 0 }], loadedAt(3)).state;
    expect(wakeAt(s)).toBe(SAVE_DEBOUNCE_MS);
    expect(step(s, { type: "tick", now: SAVE_DEBOUNCE_MS - 1 }).effects).toEqual([]);
    expect(step(s, { type: "tick", now: SAVE_DEBOUNCE_MS }).effects).toEqual([{ type: "save", baseRevision: 3 }]);
  });

  it("each change pushes the save back, so a run of keystrokes is one save", () => {
    const s = run(
      [
        { type: "edit", now: 0 },
        { type: "edit", now: 500 },
        { type: "edit", now: 1000 },
      ],
      loadedAt(1),
    ).state;
    expect(wakeAt(s)).toBe(1000 + SAVE_DEBOUNCE_MS);
  });

  it("never lets somebody typing continuously go more than the maximum wait without a save", () => {
    const events: SaveEvent[] = [];
    for (let t = 0; t <= SAVE_MAX_WAIT_MS + 2000; t += 400) events.push({ type: "edit", now: t });
    const s = run(events, loadedAt(1)).state;
    expect(wakeAt(s)).toBe(SAVE_MAX_WAIT_MS);
  });

  it("saves against the revision it loaded and moves on by one", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "tick", now: SAVE_DEBOUNCE_MS },
        { type: "save_succeeded", revision: 8, now: 2000 },
      ],
      loadedAt(7),
    );
    expect(r.effects).toEqual([{ type: "save", baseRevision: 7 }]);
    expect(r.state.baseRevision).toBe(8);
    expect(isDirty(r.state)).toBe(false);
    expect(statusOf(r.state)).toEqual({ kind: "saved", at: 2000 });
  });

  it("keeps a change made while a save was in flight as unsaved, and saves it next", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "tick", now: SAVE_DEBOUNCE_MS },
        { type: "edit", now: 1500 },
        { type: "save_succeeded", revision: 2, now: 1600 },
      ],
      loadedAt(1),
    );
    expect(isDirty(r.state)).toBe(true);
    expect(statusOf(r.state).kind).toBe("unsaved");
    expect(step(r.state, { type: "tick", now: 1500 + SAVE_DEBOUNCE_MS }).effects).toEqual([{ type: "save", baseRevision: 2 }]);
  });

  it("Save now while a save is in flight saves again as soon as it lands", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "tick", now: SAVE_DEBOUNCE_MS },
        { type: "edit", now: 1300 },
        { type: "save_now", now: 1310 },
        { type: "save_succeeded", revision: 2, now: 1400 },
      ],
      loadedAt(1),
    );
    expect(r.effects).toEqual([
      { type: "save", baseRevision: 1 },
      { type: "save", baseRevision: 2 },
    ]);
  });

  it("does nothing on Save now when there is nothing to save", () => {
    expect(step(loadedAt(1), { type: "save_now", now: 0 }).effects).toEqual([]);
  });

  it("treats a save that found nothing to write as saved", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 10 },
        { type: "save_skipped", now: 20 },
      ],
      loadedAt(4),
    );
    expect(r.state.baseRevision).toBe(4);
    expect(statusOf(r.state).kind).toBe("saved");
  });
});

describe("somebody else’s save", () => {
  it("ignores our own save coming back through the listener", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 1 },
        { type: "save_succeeded", revision: 6, now: 2 },
        { type: "remote", remote: remote(6, "mine", "me@example.org"), now: 3 },
      ],
      loadedAt(5),
    );
    expect(r.effects.filter((e) => e.type === "adopt")).toEqual([]);
    expect(r.state.conflict).toBeNull();
  });

  it("ignores our echo even when it arrives before the transaction reports back", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 1 },
        { type: "remote", remote: remote(6, "mine", "me@example.org"), now: 2 },
        { type: "save_succeeded", revision: 6, now: 3 },
      ],
      loadedAt(5),
    );
    expect(r.effects).toEqual([{ type: "save", baseRevision: 5 }]);
    expect(r.state.conflict).toBeNull();
    expect(r.state.deferred).toBeNull();
  });

  it("ignores a stale snapshot from before the revision we hold", () => {
    expect(step(loadedAt(9), { type: "remote", remote: remote(8), now: 0 }).effects).toEqual([]);
  });

  it("is adopted quietly when there is nothing unsaved here", () => {
    const r = step(loadedAt(2), { type: "remote", remote: remote(3), now: 0 });
    expect(r.effects).toEqual([{ type: "adopt", remote: remote(3), reason: "remote" }]);
    expect(r.state.baseRevision).toBe(3);
  });

  it("becomes a conflict when there is unsaved work here, and nothing is written", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "remote", remote: remote(3), now: 100 },
        { type: "tick", now: 100 + SAVE_DEBOUNCE_MS * 10 },
        { type: "save_now", now: 100 + SAVE_DEBOUNCE_MS * 10 },
      ],
      loadedAt(2),
    );
    expect(r.effects).toEqual([]);
    expect(statusOf(r.state)).toEqual({ kind: "conflict", theirs: remote(3) });
    expect(wakeAt(r.state)).toBeNull();
  });

  it("is detected by the save transaction when the listener has not caught up", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 1 },
        { type: "save_conflict", theirs: remote(3), now: 2 },
      ],
      loadedAt(2),
    );
    expect(r.state.conflict).toEqual(remote(3));
    expect(r.state.inFlight).toBeNull();
    expect(r.state.baseRevision).toBe(2);
  });

  it("keeps the newest of theirs when more saves arrive during a conflict", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "remote", remote: remote(3), now: 1 },
        { type: "remote", remote: remote(4), now: 2 },
      ],
      loadedAt(2),
    );
    expect(r.state.conflict?.revision).toBe(4);
  });

  it("someone else’s save that lands while ours is in flight turns into a conflict, not an adoption", () => {
    const r = run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 1 },
        { type: "remote", remote: remote(3), now: 2 },
        { type: "save_conflict", theirs: remote(3), now: 3 },
      ],
      loadedAt(2),
    );
    expect(r.effects.some((e) => e.type === "adopt")).toBe(false);
    expect(r.state.conflict?.revision).toBe(3);
  });
});

describe("resolving a conflict", () => {
  const inConflict = () =>
    run(
      [
        { type: "edit", now: 0 },
        { type: "remote", remote: remote(5), now: 1 },
      ],
      loadedAt(4),
    ).state;

  it("keep mine saves this tab’s draft on top of theirs as the next revision", () => {
    const r = step(inConflict(), { type: "resolve", choice: "keep_mine", now: 2 });
    expect(r.effects).toEqual([{ type: "save", baseRevision: 5 }]);
    expect(r.state.conflict).toBeNull();
    const saved = step(r.state, { type: "save_succeeded", revision: 6, now: 3 });
    expect(saved.state.baseRevision).toBe(6);
    expect(isDirty(saved.state)).toBe(false);
  });

  it("take theirs adopts their version and drops this tab’s unsaved changes", () => {
    const r = step(inConflict(), { type: "resolve", choice: "take_theirs", now: 2 });
    expect(r.effects).toEqual([{ type: "adopt", remote: remote(5), reason: "take_theirs" }]);
    expect(r.state.baseRevision).toBe(5);
    expect(isDirty(r.state)).toBe(false);
    expect(statusOf(r.state).kind).toBe("saved");
  });

  it("ignores edits while the conflict is open", () => {
    const s = inConflict();
    expect(step(s, { type: "edit", now: 5 }).state.edits).toBe(s.edits);
  });
});

describe("when saving fails", () => {
  const pending = (online = true) =>
    run(
      [
        { type: "edit", now: 0 },
        { type: "save_now", now: 1 },
      ],
      loadedAt(1, online),
    ).state;

  it("waits for the connection to return when offline, then saves straight away", () => {
    const offline = run([{ type: "offline", now: 2 }, { type: "save_failed", failure: { kind: "offline" }, now: 3 }], pending()).state;
    expect(statusOf(offline).kind).toBe("offline");
    expect(wakeAt(offline)).toBeNull();
    const back = step(offline, { type: "online", now: 10_000 });
    expect(back.effects).toEqual([{ type: "save", baseRevision: 1 }]);
  });

  it("does not try to save while the browser says it is offline", () => {
    const s = run([{ type: "edit", now: 0 }], loadedAt(1, false)).state;
    expect(wakeAt(s)).toBeNull();
    expect(statusOf(s).kind).toBe("offline");
    expect(step(s, { type: "online", now: 50 }).state.online).toBe(true);
  });

  it("retries by backoff when the server is unreachable but the browser thinks it is online", () => {
    const s = step(pending(), { type: "save_failed", failure: { kind: "offline" }, now: 100 }).state;
    expect(wakeAt(s)).toBe(100 + backoffMs(1));
  });

  it("backs off exponentially, capped, after other failures, and shows a Retry", () => {
    let s = pending();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      s = step(s, { type: "save_failed", failure: { kind: "other", message: "The draft couldn’t be saved." }, now: 0 }).state;
      waits.push(wakeAt(s)!);
      s = step(s, { type: "tick", now: wakeAt(s)! }).state;
    }
    expect(waits.slice(0, 4)).toEqual([2000, 4000, 8000, 16000]);
    expect(Math.max(...waits)).toBe(BACKOFF_MAX_MS);
    const failed = step(s, { type: "save_failed", failure: { kind: "other", message: "nope" }, now: 0 }).state;
    expect(statusOf(failed)).toMatchObject({ kind: "error", message: "nope" });
  });

  it("a person pressing Retry tries at once, whatever the backoff", () => {
    const s = step(pending(), { type: "save_failed", failure: { kind: "other", message: "x" }, now: 0 }).state;
    expect(step(s, { type: "save_now", now: 1 }).effects).toEqual([{ type: "save", baseRevision: 1 }]);
  });

  it("asks who the person is now when the rules refuse, and does not retry by itself", () => {
    const r = step(pending(), {
      type: "save_failed",
      failure: { kind: "permission", message: "You no longer have permission to edit this survey." },
      now: 0,
    });
    expect(r.effects).toEqual([{ type: "refresh_session" }]);
    expect(wakeAt(r.state)).toBeNull();
    expect(statusOf(r.state)).toMatchObject({ kind: "error", message: "You no longer have permission to edit this survey." });
  });

  it("clears a size failure on the next change, so a smaller draft is tried", () => {
    const s = step(pending(), { type: "save_failed", failure: { kind: "too_large", message: "big" }, now: 0 }).state;
    expect(wakeAt(s)).toBeNull();
    const edited = step(s, { type: "edit", now: 10 }).state;
    expect(edited.failure).toBeNull();
    expect(wakeAt(edited)).toBe(10 + SAVE_DEBOUNCE_MS);
  });

  it("a successful save clears the failure count", () => {
    let s = step(pending(), { type: "save_failed", failure: { kind: "other", message: "x" }, now: 0 }).state;
    s = step(s, { type: "save_now", now: 1 }).state;
    s = step(s, { type: "save_succeeded", revision: 2, now: 2 }).state;
    expect(s.failures).toBe(0);
    expect(statusOf(s).kind).toBe("saved");
  });
});
