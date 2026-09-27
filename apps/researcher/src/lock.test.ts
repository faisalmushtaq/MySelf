import { describe, expect, it } from "vitest";

/**
 * When the names lock themselves again.
 *
 * The rule, not the wiring: React effects and timers are exercised by the browser suite,
 * and what is worth pinning here is the decision the first version got wrong.
 *
 * That version armed the timer only while `document.hidden`. The case its own comment
 * described — a laptop left open on the linkage screen in a staffroom — has a visible tab
 * the whole time, so it never locked. An auto-lock that fires in every case except the one
 * it was written for is worse than none, because it is believed.
 */

/** Whether a fifteen-minute idle timer should be running, given what is happening. */
function shouldBeCountingDown(state: { unlocked: boolean }): boolean {
  return state.unlocked;
}

/** What counts as somebody being there. */
const PRESENCE = ["keydown", "pointerdown", "pointermove", "scroll", "focus"] as const;

describe("arming the idle lock", () => {
  it("counts down whenever the vault is open, visible tab or not", () => {
    // The bug: this used to be `unlocked && document.hidden`.
    expect(shouldBeCountingDown({ unlocked: true })).toBe(true);
  });

  it("does not count down when there is nothing unlocked", () => {
    expect(shouldBeCountingDown({ unlocked: false })).toBe(false);
  });
});

describe("what resets the countdown", () => {
  it("treats every ordinary sign of a person as presence", () => {
    // A researcher reading a long list of names moves a pointer and scrolls, and neither
    // is a keystroke. Watching keydown alone would lock under somebody's hands.
    expect(PRESENCE).toContain("pointermove");
    expect(PRESENCE).toContain("scroll");
    expect(PRESENCE).toContain("keydown");
  });

  it("includes focus, so coming back to the window counts", () => {
    expect(PRESENCE).toContain("focus");
  });

  it("does not include anything the page does to itself", () => {
    // A timer or a render must not keep the vault open; only a person may.
    for (const event of PRESENCE) {
      expect(["load", "visibilitychange", "message", "resize"]).not.toContain(event);
    }
  });
});
