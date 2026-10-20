import { describe, expect, it } from "vitest";
import type { ItemDefinition, ReleaseManifest } from "@myself/schema";
import { AnswerStore } from "./answers.js";
import { flattenManifest } from "./flatten.js";
import {
  checkTimeGrid,
  formatMinutes,
  readTimeEntry,
  splitMinutes,
  timeGridCondition,
  timeGridRows,
  timeGridValues,
} from "./timegrid.js";
import { computeVisibility } from "./walker.js";

// Made-up apps; the codes deliberately do not follow display order.
const options = [
  { code: 3, label: "Alpha", position: 1 },
  { code: 1, label: "Bravo", position: 2 },
  { code: 2, label: "Charlie", position: 3 },
  { code: 9, label: "None of these", kind: "not_applicable", position: 4 },
];
const rankSource = { responseType: "rank_group", groups: [{ key: "have" }, { key: "dont_have" }] };
const multiSource = { responseType: "multi_choice" };
const fromRank = { instrument: "apps", item: "owned", revision: 1, group: "have" };
const fromMulti = { instrument: "apps", item: "ticked", revision: 1 };

describe("time grid rows", () => {
  it("lists the options placed in the group, in the source's display order when the group is not ranked", () => {
    const answer = {
      kind: "group_rank" as const,
      assignments: { 1: { group: "have", rank: 1 }, 2: { group: "dont_have" }, 3: { group: "have", rank: 2 } },
    };
    expect(timeGridRows(fromRank, rankSource, options, answer)).toEqual([
      { code: 3, label: "Alpha" },
      { code: 1, label: "Bravo" },
    ]);
  });

  it("lists a ranked group's options in the participant's order", () => {
    const ranked = { responseType: "rank_group", groups: [{ key: "have", ranked: true }, { key: "dont_have" }] };
    const answer = {
      kind: "group_rank" as const,
      assignments: { 1: { group: "have", rank: 1 }, 2: { group: "have", rank: 3 }, 3: { group: "have", rank: 2 } },
    };
    expect(timeGridRows(fromRank, ranked, options, answer).map((r) => r.label)).toEqual(["Bravo", "Alpha", "Charlie"]);
  });

  it("lists ticked options for a multiple choice, never 'none of these'", () => {
    const answer = { kind: "multi" as const, codes: [2, 9] };
    expect(timeGridRows(fromMulti, multiSource, options, answer)).toEqual([{ code: 2, label: "Charlie" }]);
  });

  it("has no rows when the source was not answered", () => {
    expect(timeGridRows(fromRank, rankSource, options, undefined)).toEqual([]);
  });
});

describe("time grid entry", () => {
  it("reads hours and minutes into a total", () => {
    expect(readTimeEntry("1", "25", 1440)).toEqual({ minutes: 85 });
    expect(readTimeEntry("2", "", 1440)).toEqual({ minutes: 120 });
    expect(readTimeEntry("", "40", 1440)).toEqual({ minutes: 40 });
    expect(readTimeEntry(" ", "", 1440)).toEqual({ minutes: null });
  });

  it("refuses what cannot be a time on one day", () => {
    expect(readTimeEntry("1.5", "", 1440).error).toMatch(/whole numbers/);
    expect(readTimeEntry("-1", "", 1440).error).toMatch(/whole numbers/);
    expect(readTimeEntry("25", "", 1440).error).toMatch(/0 and 24/);
    expect(readTimeEntry("1", "60", 1440)).toMatchObject({ error: expect.stringMatching(/0 and 59/), field: "minutes" });
    expect(readTimeEntry("24", "1", 1440).error).toMatch(/no more than 24 h/);
    expect(readTimeEntry("3", "0", 120).error).toMatch(/no more than 2 h/);
  });

  it("reads totals back as a person would say them", () => {
    expect(formatMinutes(85)).toBe("1 h 25 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(180)).toBe("3 h");
    expect(formatMinutes(0)).toBe("0 min");
    expect(splitMinutes(85)).toEqual({ hours: "1", minutes: "25" });
    expect(splitMinutes(null)).toEqual({ hours: "", minutes: "" });
  });
});

describe("time grid answers", () => {
  const rows = [{ code: 3 }, { code: 1 }];

  it("accepts empty rows, and is complete only when every row has a value", () => {
    expect(checkTimeGrid({}, rows, { kind: "time_grid", minutes: { 3: 30, 1: null } })).toMatchObject({
      ok: true,
      complete: false,
      empty: false,
    });
    expect(checkTimeGrid({}, rows, { kind: "time_grid", minutes: { 3: 30, 1: 0 } })).toMatchObject({ ok: true, complete: true });
    expect(checkTimeGrid({}, rows, { kind: "time_grid", minutes: {} })).toMatchObject({ ok: true, empty: true });
  });

  it("rejects a row that was not shown, a fraction, or more than the ceiling", () => {
    expect(checkTimeGrid({}, rows, { kind: "time_grid", minutes: { 2: 10 } }).ok).toBe(false);
    expect(checkTimeGrid({}, rows, { kind: "time_grid", minutes: { 3: 1.5 } }).ok).toBe(false);
    expect(checkTimeGrid({ maxMinutesPerRow: 60 }, rows, { kind: "time_grid", minutes: { 3: 61 } }).ok).toBe(false);
    expect(checkTimeGrid({}, rows, { kind: "number", value: 3 }).ok).toBe(false);
  });

  it("stores one variable per shown row", () => {
    expect(timeGridValues("app_minutes", rows, { kind: "time_grid", minutes: { 3: 85 } })).toEqual({
      app_minutes_3: 85,
      app_minutes_1: null,
    });
  });
});

describe("time grid visibility", () => {
  const ref = { instrument: "apps", item: "owned", revision: 1 };

  it("is shown only once something is in the group", () => {
    const condition = timeGridCondition(fromRank, rankSource, options);
    const units = [{ instrument: "apps", item: { key: "grid" }, displayIf: condition }];
    const store = new AnswerStore();
    expect(computeVisibility(units, store).visible).toEqual([false]);
    store.set(ref, { status: "answered", value: { kind: "group_rank", assignments: { 1: { group: "dont_have" } } } });
    expect(computeVisibility(units, store).visible).toEqual([false]);
    store.set(ref, { status: "answered", value: { kind: "group_rank", assignments: { 1: { group: "have", rank: 1 } } } });
    expect(computeVisibility(units, store).visible).toEqual([true]);
  });

  it("is never shown for a rank_group source without a group", () => {
    const condition = timeGridCondition({ ...fromRank, group: undefined }, rankSource, options);
    const store = new AnswerStore();
    store.set(ref, { status: "answered", value: { kind: "group_rank", assignments: { 1: { group: "have" } } } });
    expect(computeVisibility([{ instrument: "apps", item: { key: "grid" }, displayIf: condition }], store).visible).toEqual([false]);
  });
});

describe("flattening a release with a time grid", () => {
  const base = {
    revision: 1,
    required: "soft" as const,
    allowDecline: false,
    identifying: false,
  };
  const owned: ItemDefinition = {
    ...base,
    responseType: "rank_group",
    key: "owned",
    variable: "apps_owned",
    stem: { text: "Which apps?" },
    scale: "scale.apps",
    scaleVersion: "1.0.0",
    groups: [
      { key: "have", label: "Have", ranked: false },
      { key: "dont_have", label: "Don't have", ranked: false },
    ],
  };
  const grid: ItemDefinition = {
    ...base,
    responseType: "time_grid",
    key: "grid",
    variable: "app_minutes",
    stem: { text: "How long?" },
    rowsFrom: fromRank,
  };
  const manifest = (items: ItemDefinition[]) =>
    ({
      composition: {
        sections: [
          {
            key: "s",
            title: "S",
            components: [
              {
                kind: "module",
                ref: { instrument: "apps", version: "1.0", language: "en-GB", informant: "self", readingLevel: "standard" },
              },
            ],
          },
        ],
      },
      instruments: { "apps@1.0/en-GB/self/standard": { instrument: "apps", forms: [{ items }] } },
      scales: { "scale.apps": { options } },
    }) as unknown as ReleaseManifest;

  it("conjoins the has-rows condition onto the grid", () => {
    const { units } = flattenManifest(manifest([owned, grid]));
    expect(units[0]!.displayIf).toBeUndefined();
    expect(units[1]!.displayIf).toEqual(timeGridCondition(fromRank, rankSource, options));
  });

  it("refuses a grid asked before its source", () => {
    expect(() => flattenManifest(manifest([grid, owned]))).toThrow(/not asked before it/);
  });
});
