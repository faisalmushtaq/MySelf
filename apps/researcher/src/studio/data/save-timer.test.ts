import { describe, expect, it } from "vitest";
import { SAVE_DEBOUNCE_MS, initialSaveMachine, step, type RemoteDraft, type SaveEffect, type SaveEvent, type SaveMachine } from "./save-machine.js";
import { armSaveTimer, type TimerHost } from "./save-timer.js";

/**
 * A fake clock whose timers can be made to fire a little before the wall
 * clock says they are due — what a browser does when the timer clock and
 * Date.now() disagree, or the wall clock is put back.
 */
function fakeHost(skewMs: number) {
  let wall = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const host: TimerHost = {
    now: () => wall,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: wall + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  };
  /** Run timers until none is left or `until` is reached. */
  const runUntil = (until: number) => {
    for (let guard = 0; guard < 100; guard++) {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > until) break;
      timers.delete(due[0]);
      // The timer fires at its time, but the wall clock reads a little behind.
      wall = Math.max(wall, due[1].at - skewMs);
      due[1].fn();
    }
    wall = Math.max(wall, until);
  };
  return { host, runUntil, pending: () => timers.size };
}

const loaded: RemoteDraft = { revision: 1, content: "c", byUid: null, byEmail: null, at: null };

function machineWithEdit(): SaveMachine {
  let s = step(initialSaveMachine(true), { type: "loaded", remote: loaded }).state;
  s = step(s, { type: "edit", now: 0 }).state;
  return s;
}

describe("the save timer", () => {
  it("saves when the debounce is up", () => {
    const { host, runUntil } = fakeHost(0);
    let state = machineWithEdit();
    const effects: SaveEffect[] = [];
    const tick = (now: number) => {
      const r = step(state, { type: "tick", now } satisfies SaveEvent);
      state = r.state;
      effects.push(...r.effects);
    };
    armSaveTimer(host, () => state, tick);
    runUntil(SAVE_DEBOUNCE_MS);
    expect(effects).toEqual([{ type: "save", baseRevision: 1 }]);
  });

  it("still saves when the timer fires a moment before the wall clock says it is due", () => {
    const { host, runUntil } = fakeHost(1);
    let state = machineWithEdit();
    const effects: SaveEffect[] = [];
    const tick = (now: number) => {
      const r = step(state, { type: "tick", now });
      state = r.state;
      effects.push(...r.effects);
    };
    armSaveTimer(host, () => state, tick);
    // Without re-arming, the early tick changes nothing, nothing re-renders,
    // and the save waits for the next keystroke.
    runUntil(SAVE_DEBOUNCE_MS + 50);
    expect(effects).toEqual([{ type: "save", baseRevision: 1 }]);
  });

  it("is cancelled cleanly", () => {
    const { host, runUntil, pending } = fakeHost(0);
    let state = machineWithEdit();
    const effects: SaveEffect[] = [];
    const cancel = armSaveTimer(host, () => state, (now) => {
      const r = step(state, { type: "tick", now });
      state = r.state;
      effects.push(...r.effects);
    });
    cancel();
    expect(pending()).toBe(0);
    runUntil(SAVE_DEBOUNCE_MS * 2);
    expect(effects).toEqual([]);
  });

  it("arms nothing when nothing is due", () => {
    const { host, pending } = fakeHost(0);
    const state = step(initialSaveMachine(true), { type: "loaded", remote: loaded }).state;
    armSaveTimer(host, () => state, () => undefined);
    expect(pending()).toBe(0);
  });
});
