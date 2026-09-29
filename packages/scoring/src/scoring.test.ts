import { describe, expect, it } from "vitest";
import { scoringDefinition } from "@myself/schema";
import { executeScoring, type ItemValues } from "./executor.js";
import { allScoring, scoreEhiSf, scoreSdq25S, scoreStai5, scoreSwemwbs } from "./definitions.js";
import { scoringItemKeys, scoringReferenceProblems } from "./references.js";

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

describe("SWEMWBS and STAI-5 read their real item keys (D-49)", () => {
  const swemwbs = scoringDefinition.parse(scoreSwemwbs);
  const stai5 = scoringDefinition.parse(scoreStai5);
  const swemwbsItems = ["optimistic", "useful", "relaxed", "problems", "thinking", "close", "mind"];
  const staiItems = ["upset", "frightened", "nervous", "jittery", "confused"];

  it("SWEMWBS: seven answers 'Some of the time' (3) sum to a raw total of 21", () => {
    const input = Object.fromEntries(swemwbsItems.map((k) => [k, 3]));
    expect(executeScoring(swemwbs, input).outputs["raw_total"]).toBe(21);
  });

  it("SWEMWBS: a missing item leaves the raw total blank (all seven required)", () => {
    const input: ItemValues = Object.fromEntries(swemwbsItems.map((k) => [k, 4]));
    input["mind"] = null;
    expect(executeScoring(swemwbs, input).outputs["raw_total"]).toBeNull();
  });

  it("STAI-5: 1 + 2 + 3 + 4 + 1 = 11", () => {
    const input = Object.fromEntries(staiItems.map((k, i) => [k, [1, 2, 3, 4, 1][i]!]));
    expect(executeScoring(stai5, input).outputs["state_anxiety"]).toBe(11);
  });

  it("the 1.0.0 definitions' q1… keys no longer score anything, so a wrong key cannot pass silently", () => {
    const old = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q${i + 1}`, 3]));
    expect(executeScoring(swemwbs, old).outputs["raw_total"]).toBeNull();
  });
});

describe("scoring references", () => {
  const items = [{ key: "a" }, { key: "b" }, { key: "info", responseType: "info" }];

  it("accept items and earlier outputs", () => {
    const def = { instrument: "x", steps: [{ op: "sum" as const, items: ["a", "b"], output: "ab", minValid: 2, prorate: false }, { op: "sum" as const, items: ["ab"], output: "total", minValid: 1, prorate: false }] };
    expect(scoringReferenceProblems(def, items)).toEqual([]);
  });

  it("name an item the instrument does not have, an output used before it exists, and an information screen", () => {
    const def = {
      instrument: "x",
      steps: [
        { op: "sum" as const, items: ["a", "q1", "later"], output: "s", minValid: 1, prorate: false },
        { op: "mean" as const, items: ["info"], output: "later", minValid: 1 },
      ],
    };
    expect(scoringReferenceProblems(def, items)).toEqual([
      "step 1 reads 'q1', which is neither a question of 'x' nor an earlier output",
      "step 1 reads 'later', which is neither a question of 'x' nor an earlier output",
      "step 2 reads 'info', which is an information screen, not a question",
    ]);
  });

  it("check a lookup or classify input too", () => {
    const def = { instrument: "x", steps: [{ op: "classify" as const, input: "missing", bands: [{ label: "l", min: 0, max: 1 }], output: "band" }] };
    expect(scoringReferenceProblems(def, items)).toHaveLength(1);
  });
});

describe("the items a definition reads (S7)", () => {
  it("are its questions, never the outputs of its earlier steps", () => {
    expect(scoringItemKeys(sdq).sort()).toEqual(Array.from({ length: 25 }, (_, i) => `q${i + 1}`).sort());
    expect(scoringItemKeys(scoringDefinition.parse(allScoring.find((d) => d.key === "score.rcads25")))).not.toContain("depression");
    expect(scoringItemKeys(ehi)).toEqual(["writing", "throwing", "toothbrush", "spoon"]);
  });

  it("filled from the answers alone, let a total add up its subscales", () => {
    const answers = Object.fromEntries(scoringItemKeys(sdq).map((k) => [k, 1]));
    const out = executeScoring(sdq, answers).outputs;
    expect(out["total_difficulties"]).toBe((out["emotional"] as number) + (out["conduct"] as number) + (out["hyperactivity"] as number) + (out["peer"] as number));
    // Handing in a blank under a subscale's name is what hid it (the old reading).
    expect(executeScoring(sdq, { ...answers, emotional: null }).outputs["total_difficulties"]).toBeNull();
  });
});
