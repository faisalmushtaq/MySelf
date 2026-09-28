import { wakeAt, type SaveMachine } from "./save-machine.js";

/**
 * The one timer the save engine needs: wake the machine with a `tick` when
 * wakeAt says a save (or a retry) is due.
 *
 * Kept out of the hook so it can be tested with a fake clock. The subtlety it
 * exists for: a timer can fire a moment before `Date.now()` reaches the time
 * it was set for (the wall clock and the timer clock are different clocks, and
 * the wall clock can be put back). Ticked with the wall clock's reading, the
 * machine would treat the tick as early and change nothing — and no state
 * change means no re-render, so a timer armed only from a render would never
 * be armed again, and the save would wait for the next keystroke. The timer
 * firing is itself the proof that its delay has passed, so the tick says it is
 * at least the time the timer was set for. (A tick's time is only compared
 * with the wake-up time; nothing records it.)
 */

export interface TimerHost {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

/** Arm the timer for `getState()`'s next wake-up. Returns the cancel function. */
export function armSaveTimer(host: TimerHost, getState: () => SaveMachine, tick: (now: number) => void): () => void {
  let id: number | null = null;
  const arm = (due: number) => {
    id = host.setTimeout(() => fire(due), Math.max(0, due - host.now()));
  };
  const fire = (due: number) => {
    id = null;
    const before = getState();
    tick(Math.max(host.now(), due));
    // Defensive: if the machine did not move and still wants waking later,
    // wait for that rather than for a render that will not come.
    if (getState() !== before) return;
    const again = wakeAt(before);
    if (again !== null && again > due) arm(again);
  };
  const due = wakeAt(getState());
  if (due !== null) arm(due);
  return () => {
    if (id !== null) host.clearTimeout(id);
    id = null;
  };
}
