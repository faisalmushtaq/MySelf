import { describe, expect, it } from "vitest";
import { DEMONSTRATION, sourceOf, supersedes } from "./lib/db.js";

/**
 * Which copy of a sitting wins.
 *
 * Devices upload a sitting while it is still being answered, so the study's copy
 * grows: pulled at four hundred events on Tuesday, complete at nine hundred on
 * Wednesday. Both ways of getting this wrong are silent — a partial sitting left
 * in the analysis, or a complete one replaced by a checkpoint of itself — so both
 * directions are tested rather than just the one that happens most.
 */

const withEvents = (n: number) => ({ events: Array.from({ length: n }, (_, i) => i) });

describe("a sitting pulled from the study", () => {
  it("replaces a shorter copy, which is what a finished sitting does to its checkpoint", () => {
    expect(supersedes(withEvents(900), withEvents(400))).toBe(true);
  });

  it("leaves an identical copy alone, so pulling twice changes nothing", () => {
    expect(supersedes(withEvents(900), withEvents(900))).toBe(false);
  });

  it("never replaces a longer copy — that is truncation arriving by the other road", () => {
    expect(supersedes(withEvents(400), withEvents(900))).toBe(false);
  });

  it("does not treat an empty pull as superseding anything", () => {
    expect(supersedes(withEvents(0), withEvents(1))).toBe(false);
  });
});

describe("where a stored sitting came from", () => {
  // The dashboard counts what the study's database holds. A sitting that only ever
  // arrived here in a file is invisible to it, so the Overview says how many there are.
  it("is the study when it was pulled, or when a pull found the study holds it too", () => {
    expect(sourceOf({ source: "study" })).toBe("study");
    expect(sourceOf({ source: "ipad-3.json", receivedAt: "2026-09-02T08:00:00.000Z" })).toBe("study");
  });

  it("is a file when only a file ever brought it", () => {
    expect(sourceOf({ source: "ipad-3.json" })).toBe("file");
  });

  it("is demonstration data when it was made up", () => {
    expect(sourceOf({ source: DEMONSTRATION })).toBe("demonstration");
  });
});
