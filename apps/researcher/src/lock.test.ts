import { describe, expect, it } from "vitest";
import { IDLE_LOCK_MS, PRESENCE_EVENTS } from "./lib/idle.js";

/**
 * When the names lock themselves again.
 *
 * These assertions import the rule the component actually uses. The first version of this
 * file declared its own copy of the list and asserted against that, so reverting the
 * component to the broken timer left every test green — a test that cannot fail is worse
 * than no test, because it is counted.
 *
 * The rule itself exists because of two failures. The component originally armed the
 * countdown only while `document.hidden`, so the case its own comment described — a laptop
 * left open on this screen in a staffroom — never locked at all. Then, once it was an idle
 * timer, re-arming on `visibilitychange` EXTENDED the window: hide the tab at fourteen
 * minutes and the countdown restarts, so half an hour of real absence leaves the names on
 * screen.
 */

describe("what counts as somebody being there", () => {
  it("includes reading, not only typing", () => {
    // Working through a list of names involves neither a keystroke nor a click. A lock
    // that fired under somebody's hands would be worked around rather than tolerated.
    expect(PRESENCE_EVENTS).toContain("pointermove");
    expect(PRESENCE_EVENTS).toContain("scroll");
  });

  it("includes coming back to the window", () => {
    expect(PRESENCE_EVENTS).toContain("focus");
  });

  it("excludes visibilitychange, because re-arming on it extends the window", () => {
    // The second bug. Hiding the tab is the absence of presence, not an event.
    expect(PRESENCE_EVENTS).not.toContain("visibilitychange");
  });

  it("excludes anything the page does to itself", () => {
    // A timer, a render or a message must not keep the names open; only a person may.
    for (const event of ["load", "message", "resize", "DOMContentLoaded", "visibilitychange"]) {
      expect(PRESENCE_EVENTS).not.toContain(event);
    }
  });
});

describe("how long it waits", () => {
  it("is fifteen minutes", () => {
    expect(IDLE_LOCK_MS).toBe(15 * 60 * 1000);
  });

  it("is long enough not to lock under somebody working", () => {
    // Shorter and a researcher reading a list learns to leave it unlocked, which is worse
    // than a longer timer.
    expect(IDLE_LOCK_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it("is short enough to matter over a lunch break", () => {
    expect(IDLE_LOCK_MS).toBeLessThanOrEqual(20 * 60 * 1000);
  });
});
