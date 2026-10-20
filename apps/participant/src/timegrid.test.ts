import { describe, expect, it } from "vitest";
import { AnswerStore, type PresentableUnit } from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";
import { describeAnswer } from "./components/ReviewScreen.js";
import { SUPPORTED_ENGINE_VERSIONS } from "./lib/releases.js";
import { gridRowsFor } from "./lib/timegrid.js";

/**
 * The time grid's rows as the survey screen draws them, and its answer as the
 * review reads it back. Made-up apps throughout.
 */

const scale: ResponseScale = {
  key: "scale.apps",
  version: "1.0.0",
  name: "Apps",
  direction: "unordered",
  options: [
    { code: 1, label: "Alpha", kind: "substantive", textEntry: false },
    { code: 2, label: "Bravo", kind: "substantive", textEntry: false },
    { code: 3, label: "Charlie", kind: "substantive", textEntry: false },
  ],
};
const base = { revision: 1, required: "soft", allowDecline: false, identifying: false } as const;
const owned: ItemDefinition = {
  ...base,
  responseType: "rank_group",
  key: "owned",
  variable: "apps_owned",
  stem: { text: "Which apps?" },
  scale: "scale.apps",
  scaleVersion: "1.0.0",
  groups: [
    { key: "have", label: "Have", ranked: true },
    { key: "dont_have", label: "Don't have", ranked: false },
  ],
};
const grid: ItemDefinition = {
  ...base,
  responseType: "time_grid",
  key: "grid",
  variable: "app_minutes",
  stem: { text: "How long on each?" },
  rowsFrom: { instrument: "apps", item: "owned", revision: 1, group: "have" },
};
const units: PresentableUnit[] = [
  { instrument: "apps", sectionKey: "s", item: owned },
  { instrument: "apps", sectionKey: "s", item: grid },
];
const scales = new Map([[scale.key, scale]]);

describe("a time grid on the device", () => {
  it("draws a row for each app in 'have', in the order they were ranked", () => {
    const answers = new AnswerStore();
    answers.set(
      { instrument: "apps", item: "owned", revision: 1 },
      { status: "answered", value: { kind: "group_rank", assignments: { 1: { group: "have", rank: 2 }, 2: { group: "dont_have" }, 3: { group: "have", rank: 1 } } } },
    );
    expect(gridRowsFor(grid, units, scales, answers).rows).toEqual([
      { code: 3, label: "Charlie" },
      { code: 1, label: "Alpha" },
    ]);
  });

  it("draws no rows before the apps question is answered", () => {
    expect(gridRowsFor(grid, units, scales, new AnswerStore()).rows).toEqual([]);
  });

  it("reads an answer back with the apps' names and their totals", () => {
    const { scale: names } = gridRowsFor(grid, units, scales, new AnswerStore());
    expect(describeAnswer({ kind: "time_grid", minutes: { 3: 85, 1: null } }, names)).toBe("Charlie 1 h 25 min");
    expect(describeAnswer({ kind: "time_grid", minutes: { 1: null } }, names)).toBeNull();
  });

  it("renders the engine that introduced it", () => {
    expect(SUPPORTED_ENGINE_VERSIONS).toContain("0.5.0");
  });
});
