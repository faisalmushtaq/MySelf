import { describe, expect, it } from "vitest";
import type { ResponseScale } from "@myself/schema";
import { describeAnswer } from "./components/ReviewScreen.js";

/**
 * The review is only useful if an answer reads back as the participant gave
 * it. A row that says "3" or "[object Object]" is worse than no review: it
 * invites someone to confirm something they cannot actually check.
 */

const scale: ResponseScale = {
  key: "scale.demo",
  version: "1.0.0",
  name: "Demo",
  direction: "ascending",
  options: [
    { code: 1, label: "Never", kind: "substantive", textEntry: false },
    { code: 2, label: "Sometimes", kind: "substantive", textEntry: false },
    { code: 9, label: "Prefer not to say", kind: "decline", textEntry: false },
  ],
};

describe("reading an answer back", () => {
  it("shows the words that were chosen, not the code", () => {
    expect(describeAnswer({ kind: "choice", code: 2 }, scale)).toBe("Sometimes");
    expect(describeAnswer({ kind: "multi", codes: [1, 9] }, scale)).toBe("Never, Prefer not to say");
  });

  it("falls back to the code when the scale cannot be resolved", () => {
    // Better a number than nothing: the participant can still tell the
    // researcher which row looked wrong.
    expect(describeAnswer({ kind: "choice", code: 2 }, undefined)).toBe("2");
  });

  it("writes a date the way a person would say it", () => {
    expect(describeAnswer({ kind: "date", iso: "2011-04-15" }, undefined)).toBe("15 April 2011");
  });

  it("joins the parts of a multi-field answer", () => {
    expect(describeAnswer({ kind: "fields", values: { a: "JA", b: "1", c: "" } }, undefined)).toBe("JA · 1");
  });

  it("puts a ranked group in the order it was ranked", () => {
    const ranked = describeAnswer(
      { kind: "group_rank", assignments: { 2: { group: "have", rank: 2 }, 1: { group: "have", rank: 1 } } },
      scale,
    );
    expect(ranked).toBe("Never, Sometimes");
  });

  it("treats an empty answer as blank rather than as an answer", () => {
    expect(describeAnswer(undefined, scale)).toBeNull();
    expect(describeAnswer({ kind: "text", value: "   " }, undefined)).toBeNull();
    expect(describeAnswer({ kind: "fields", values: { a: "" } }, undefined)).toBeNull();
    expect(describeAnswer({ kind: "multi", codes: [] }, scale)).toBeNull();
  });
});
