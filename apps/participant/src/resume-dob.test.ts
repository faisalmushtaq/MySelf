import { describe, expect, it } from "vitest";
import type { PresentableUnit } from "@myself/engine";
import type { RecordedAnswer } from "./lib/db.js";
import { DOB_MAX_ATTEMPTS, dobMatches, dobUnit, resumeRule, tryDob, unitKey } from "./lib/dob.js";
import { BUILT_IN } from "./lib/releases.js";
import { buildRuntime } from "./lib/runtime.js";

/**
 * Who may carry on an unfinished sitting (lib/dob.ts): a code alone is not
 * enough once the sitting holds anything about the person.
 */
const t0 = new Date("2026-10-17T09:00:00Z");
const answers = (entries: [string, RecordedAnswer][]) => new Map(entries);
const DOB = "ybm_identity.dob";

describe("the date-of-birth question", () => {
  it("is found in the built-in release as ybm_identity.dob", () => {
    const runtime = buildRuntime(BUILT_IN.manifest, "built-in");
    const unit = dobUnit(runtime.flattened.units);
    expect(unit && unitKey(unit)).toBe(DOB);
  });

  it("is only ever an identifying date item", () => {
    const unit = (key: string, identifying: boolean, responseType = "date") =>
      ({ instrument: "x", item: { key, identifying, responseType, variable: key } }) as unknown as PresentableUnit;
    expect(dobUnit([unit("visit", false), unit("name", true, "text_short")])).toBeUndefined();
    expect(unitKey(dobUnit([unit("other", true), unit("dob", true)])!)).toBe("x.dob");
    expect(unitKey(dobUnit([unit("born", true)])!)).toBe("x.born");
  });
});

describe("matching a date of birth", () => {
  it("is the same calendar day, and nothing looser", () => {
    expect(dobMatches("2012-05-14", "2012-05-14")).toBe(true);
    expect(dobMatches("2012-05-14T00:00:00.000Z", "2012-05-14")).toBe(true);
    expect(dobMatches("2012-05-14", " 2012-05-14 ")).toBe(true);
    expect(dobMatches("2012-05-14", "2012-05-15")).toBe(false);
    expect(dobMatches("2012-05-14", "2012-14-05")).toBe(false);
    expect(dobMatches("2012-05-14", "2011-05-14")).toBe(false);
    expect(dobMatches("2012-05-14", "")).toBe(false);
    expect(dobMatches("", "")).toBe(false);
  });
});

describe("which sittings a code may carry on", () => {
  it("asks for the date of birth of a sitting that holds one", () => {
    const rule = resumeRule(
      answers([
        ["ybm_identity.first_name", { status: "answered", value: { kind: "text", value: "Sam" } }],
        [DOB, { status: "answered", value: { kind: "date", iso: "2012-05-14" } }],
      ]),
      DOB,
    );
    expect(rule).toEqual({ kind: "verify", dob: "2012-05-14" });
  });

  it("carries on, as before, a sitting with nothing answered on it", () => {
    expect(resumeRule(answers([]), DOB)).toEqual({ kind: "open" });
    expect(resumeRule(answers([["ybm_consent.intro", { status: "skipped" }]]), DOB)).toEqual({ kind: "open" });
  });

  it("never carries on a sitting with answers but no date of birth: a new one starts", () => {
    const named = answers([["ybm_identity.first_name", { status: "answered", value: { kind: "text", value: "Sam" } }]]);
    expect(resumeRule(named, DOB)).toEqual({ kind: "fresh" });
    // Declining the date is not a date to check against.
    expect(resumeRule(new Map([...named, [DOB, { status: "declined" }]]), DOB)).toEqual({ kind: "fresh" });
    // A survey with no date-of-birth question at all.
    expect(resumeRule(named, undefined)).toEqual({ kind: "fresh" });
  });
});

describe("wrong dates of birth", () => {
  it("are counted, and the third locks the code on this iPad", () => {
    let guard = null as ReturnType<typeof tryDob>["guard"];
    for (let i = 1; i < DOB_MAX_ATTEMPTS; i += 1) {
      const attempt = tryDob("2012-05-14", "2012-05-15", guard, t0);
      expect(attempt).toMatchObject({ kind: "refused", triesLeft: DOB_MAX_ATTEMPTS - i });
      guard = attempt.guard;
    }
    const last = tryDob("2012-05-14", "2010-01-01", guard, t0);
    expect(last.kind).toBe("locked");
    expect(last.guard?.lockedAt).toBe(t0.toISOString());

    // Locked: even the right date is refused, until staff allow the code again.
    expect(tryDob("2012-05-14", "2012-05-14", last.guard, t0).kind).toBe("locked");
  });

  it("are forgotten once the right date is given", () => {
    const one = tryDob("2012-05-14", "2012-05-15", null, t0);
    const right = tryDob("2012-05-14", "2012-05-14", one.guard, t0);
    expect(right).toEqual({ kind: "accepted", guard: null });
  });
});
