import { describe, expect, it } from "vitest";
import { safeToForget } from "./lib/db.js";
import type { SessionRow } from "./lib/db.js";

/**
 * What an iPad is allowed to forget.
 *
 * The only delete in the participant app, and the only one whose failure is both
 * silent and permanent: a sitting cleared before the study had it is gone, and
 * nothing downstream would ever show a gap. So the rule is tested from the wrong
 * side of every clause rather than just the happy one.
 *
 * It matters that this exists at all. Without a delete, the alternative is
 * clearing Safari's data — which destroys the AES device key along with it and
 * makes every sitting NOT yet handed over permanently unreadable. The blunt
 * instrument is the one that loses data; this is the one that does not.
 */

const held = (over: Partial<Pick<SessionRow, "state" | "eventCount">> = {}) => ({
  state: "synced_verified" as SessionRow["state"],
  eventCount: 900,
  ...over,
});

describe("clearing a sitting off a device", () => {
  it("allows one the study confirmed, with a receipt that matches", () => {
    expect(safeToForget(held(), { events: 900 })).toBe(true);
  });

  it("refuses one with no receipt, however its state reads", () => {
    // A state written by some other path is not a confirmation.
    expect(safeToForget(held(), undefined)).toBe(false);
  });

  it("refuses one whose receipt is short of what the device holds", () => {
    // The confirmation was for a smaller version of this sitting. This is the
    // checkpoint case: confirmed at 400 events, then the child answered more.
    expect(safeToForget(held({ eventCount: 900 }), { events: 400 })).toBe(false);
  });

  it("refuses one whose receipt claims more than the device holds", () => {
    // The two disagree about what this sitting is. Never the moment to delete.
    expect(safeToForget(held({ eventCount: 400 }), { events: 900 })).toBe(false);
  });

  for (const state of ["in_progress", "awaiting_sync", "syncing", "sync_failed", "quarantined"] as const) {
    it(`refuses a sitting that is ${state.replace("_", " ")}, receipt or not`, () => {
      expect(safeToForget(held({ state }), { events: 900 })).toBe(false);
    });
  }

  it("refuses a quarantined sitting in particular, because it is evidence", () => {
    // The study refused it and kept both copies for a person to compare. The
    // device's copy is half of that comparison.
    expect(safeToForget(held({ state: "quarantined" }), { events: 900 })).toBe(false);
  });
});
