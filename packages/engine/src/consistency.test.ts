import { describe, expect, it } from "vitest";
import type { ItemDefinition, ResponseScale, ScaleOption } from "@myself/schema";
import { AnswerStore } from "./answers.js";
import { ageInYears, checkConsistency, visibleOptions } from "./consistency.js";

/**
 * Cross-checks and option limits let one answer constrain another. Both fail
 * open by design, so the tests that matter most are the ones proving they do:
 * a rule that cannot be evaluated must never block anyone or quietly narrow
 * what they are allowed to say.
 */

const dobRef = { instrument: "ybm_identity", item: "dob", revision: 1 };

const monthScale: ResponseScale = {
  key: "scale.month_12",
  version: "1.0.0",
  name: "Calendar month",
  direction: "ascending",
  options: Array.from({ length: 12 }, (_, i) => ({
    code: i + 1,
    label: `M${i + 1}`,
    value: i + 1,
    kind: "substantive" as const,
    textEntry: false,
  })),
};

const monthItem: ItemDefinition = {
  responseType: "single_choice",
  key: "ps_birth_month",
  revision: 1,
  variable: "ps_birth_month",
  stem: { text: "The month you were born" },
  required: "hard",
  allowDecline: false,
  identifying: false,
  scale: "scale.month_12",
  scaleVersion: "1.0.0",
  presentation: "compact",
  spectrumReverse: false,
  autoAdvance: true,
  crossChecks: [
    { kind: "matches_month_of_date", against: dobRef, message: "That's not the month in your date of birth." },
  ],
};

const withDob = (iso: string): AnswerStore => {
  const store = new AnswerStore();
  store.set(dobRef, { status: "answered", value: { kind: "date", iso } });
  return store;
};

describe("age in whole years", () => {
  it("counts a birthday that has passed", () => {
    expect(ageInYears("2011-04-15", new Date("2026-08-02T12:00:00"))).toBe(15);
  });

  it("does not count a birthday still to come this year", () => {
    expect(ageInYears("2011-11-15", new Date("2026-08-02T12:00:00"))).toBe(14);
  });

  it("counts the birthday itself", () => {
    expect(ageInYears("2011-08-02", new Date("2026-08-02T12:00:00"))).toBe(15);
  });

  it("rejects an unusable date rather than inventing an age", () => {
    expect(ageInYears("not-a-date", new Date())).toBeNull();
  });
});

describe("cross-checks", () => {
  it("accepts a month that agrees with the date of birth", () => {
    const store = withDob("2011-04-15");
    expect(checkConsistency(monthItem, { kind: "choice", code: 4 }, monthScale, store)).toBeNull();
  });

  it("catches a month that contradicts the date of birth", () => {
    const store = withDob("2011-04-15");
    expect(checkConsistency(monthItem, { kind: "choice", code: 9 }, monthScale, store)).toBe(
      "That's not the month in your date of birth.",
    );
  });

  it("allows anything when there is nothing to check against", () => {
    // Date of birth skipped or not yet reached: a rule that cannot be
    // evaluated must not become an obstacle.
    expect(checkConsistency(monthItem, { kind: "choice", code: 9 }, monthScale, new AnswerStore())).toBeNull();
  });

  it("allows anything when the earlier answer is not a usable date", () => {
    const store = new AnswerStore();
    store.set(dobRef, { status: "answered", value: { kind: "date", iso: "rubbish" } });
    expect(checkConsistency(monthItem, { kind: "choice", code: 9 }, monthScale, store)).toBeNull();
  });

  it("ignores an item with no cross-checks", () => {
    const plain = { ...monthItem, crossChecks: undefined } as ItemDefinition;
    expect(checkConsistency(plain, { kind: "choice", code: 9 }, monthScale, withDob("2011-04-15"))).toBeNull();
  });
});

describe("option limits", () => {
  const ages: ScaleOption[] = [
    { code: 1, label: "Younger than 5", value: 4, kind: "substantive", textEntry: false },
    ...Array.from({ length: 21 }, (_, i) => ({
      code: i + 2,
      label: String(i + 5),
      value: i + 5,
      kind: "substantive" as const,
      textEntry: false,
    })),
    { code: 99, label: "I'm not sure", kind: "dont_know" as const, textEntry: false },
  ];
  const limit = { kind: "at_most_age_now" as const, from: dobRef };
  const now = new Date("2026-08-02T12:00:00");

  it("offers no age above the participant's own", () => {
    const kept = visibleOptions(limit, ages, withDob("2011-04-15"), now); // 15 years old
    const numeric = kept.map((o) => o.value).filter((v): v is number => v !== undefined);
    expect(Math.max(...numeric)).toBe(15);
    expect(kept.map((o) => o.label)).not.toContain("16");
    expect(kept.map((o) => o.label)).toContain("15");
  });

  it("keeps the escape option, which claims no age at all", () => {
    const kept = visibleOptions(limit, ages, withDob("2011-04-15"), now);
    expect(kept.map((o) => o.label)).toContain("I'm not sure");
  });

  it("keeps 'Younger than 5' for a young participant", () => {
    const kept = visibleOptions(limit, ages, withDob("2022-01-10"), now); // 4 years old
    expect(kept.map((o) => o.label)).toEqual(["Younger than 5", "I'm not sure"]);
  });

  it("offers everything when there is no date of birth to work from", () => {
    expect(visibleOptions(limit, ages, new AnswerStore(), now)).toHaveLength(ages.length);
  });

  it("offers everything rather than nothing if the rule would empty the list", () => {
    // An implausible date slipping through must not leave a participant with
    // no substantive option at all.
    const store = new AnswerStore();
    store.set(dobRef, { status: "answered", value: { kind: "date", iso: "2026-08-01" } });
    expect(visibleOptions(limit, ages, store, now)).toHaveLength(ages.length);
  });

  it("changes nothing when the item declares no limit", () => {
    expect(visibleOptions(undefined, ages, withDob("2011-04-15"), now)).toHaveLength(ages.length);
  });
});
