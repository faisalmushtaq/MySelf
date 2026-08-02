import { describe, expect, it } from "vitest";
import { scoringDefinition } from "@myself/schema";
import { executeScoring, type ItemValues } from "./executor.js";
import { allScoring, scoreEhiSf, scoreSdq25S } from "./definitions.js";

const sdq = scoringDefinition.parse(scoreSdq25S);
const ehi = scoringDefinition.parse(scoreEhiSf);

const sdqAll = (code: number): ItemValues =>
  Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`q${i + 1}`, code]));

describe("scoring definitions", () => {
  it("all 6 definitions parse and none claims verification", () => {
    for (const d of allScoring) {
      const parsed = scoringDefinition.parse(d);
      expect(parsed.verified, parsed.key).toBe(false); // nothing approved until sources checked
    }
  });
});

describe("SDQ scoring (canonical 0-2 codes)", () => {
  it("hand-worked example: all items rated 2", () => {
    // Reverse items 7,11,14,21,25 become 0; worked by hand in the test plan.
    const { outputs } = executeScoring(sdq, sdqAll(2));
    expect(outputs["emotional"]).toBe(10);
    expect(outputs["conduct"]).toBe(8);
    expect(outputs["hyperactivity"]).toBe(6);
    expect(outputs["peer"]).toBe(6);
    expect(outputs["prosocial"]).toBe(10);
    expect(outputs["total_difficulties"]).toBe(30);
  });

  it("all-zero answers give zero difficulties, full reverse credit", () => {
    const { outputs } = executeScoring(sdq, sdqAll(0));
    // Reverse items become 2 → conduct (q7r) = 2, hyperactivity (q21r,q25r) = 4, peer (q11r,q14r) = 4
    expect(outputs["emotional"]).toBe(0);
    expect(outputs["conduct"]).toBe(2);
    expect(outputs["hyperactivity"]).toBe(4);
    expect(outputs["peer"]).toBe(4);
    expect(outputs["total_difficulties"]).toBe(10);
  });

  it("prorates a subscale with 3 of 5 answered (standard SDQ rule)", () => {
    const input = sdqAll(1);
    input["q3"] = null; // emotional item missing
    input["q8"] = null; // emotional item missing
    const { outputs, warnings } = executeScoring(sdq, input);
    expect(outputs["emotional"]).toBe(5); // mean 1 across 3 valid → 1*5
    expect(warnings).toHaveLength(0);
  });

  it("returns null and a warning when fewer than 3 of 5 answered", () => {
    const input = sdqAll(1);
    input["q3"] = null;
    input["q8"] = null;
    input["q13"] = null;
    const { outputs, warnings } = executeScoring(sdq, input);
    expect(outputs["emotional"]).toBeNull();
    expect(outputs["total_difficulties"]).toBeNull(); // depends on the missing subscale
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("raw input is never mutated", () => {
    const input = sdqAll(2);
    executeScoring(sdq, input);
    expect(input["q7"]).toBe(2); // reverse happened on a working copy only
  });
});

describe("EHI-SF laterality quotient", () => {
  it("all 'Always right' (canonical code 1) gives LQ +100", () => {
    const { outputs } = executeScoring(ehi, { writing: 1, throwing: 1, toothbrush: 1, spoon: 1 });
    expect(outputs["lq"]).toBe(100);
  });

  it("mixed preferences average correctly", () => {
    const { outputs } = executeScoring(ehi, { writing: 1, throwing: 2, toothbrush: 3, spoon: 5 });
    // 100 + 50 + 0 - 100 = 50 / 4 = 12.5
    expect(outputs["lq"]).toBe(12.5);
  });

  it("any missing task voids the LQ (minValid 4)", () => {
    const { outputs } = executeScoring(ehi, { writing: 1, throwing: 1, toothbrush: 1, spoon: null });
    expect(outputs["lq"]).toBeNull();
  });

  it("out-of-map value is nulled with a warning, not silently kept", () => {
    const { outputs, warnings } = executeScoring(ehi, { writing: 9, throwing: 1, toothbrush: 1, spoon: 1 });
    expect(outputs["lq"]).toBeNull();
    expect(warnings.some((w) => w.includes("recode"))).toBe(true);
  });
});
