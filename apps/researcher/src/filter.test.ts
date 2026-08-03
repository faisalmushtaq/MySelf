import { describe, expect, it } from "vitest";
import { BLANK, applyFilters, distinctValues, sortRows, toCsv, type Row } from "./lib/filter.js";
import { byWave, individualChange, participantWaves, returningIds } from "./lib/longitudinal.js";

/**
 * Filtering is where a quiet bug does the most damage: a researcher reads a
 * count off the screen and puts it in a report, and nothing ever contradicts
 * it. So the rules that decide what a filter does with a missing value, and
 * whether the wave comparison uses returners only, are pinned here.
 */

const rows: Row[] = [
  { participant_id: "AA101BB", wave: 1, site: "LDS", ehi_sf_lq: 100, kss_q1: 3, complete: "yes", first_name: "Amara" },
  { participant_id: "AA101BB", wave: 2, site: "LDS", ehi_sf_lq: 75, kss_q1: null, complete: "yes", first_name: "Amara" },
  { participant_id: "CC205DD", wave: 1, site: "BFD", ehi_sf_lq: -100, kss_q1: 7, complete: "no", first_name: "Ben" },
  { participant_id: "EE309FF", wave: 1, site: "LDS", ehi_sf_lq: null, kss_q1: 5, complete: "yes", first_name: "Chloe" },
];

describe("column filters", () => {
  it("filters a number column by range", () => {
    const out = applyFilters(rows, { ehi_sf_lq: { kind: "range", min: 0 } });
    expect(out.map((r) => r["wave"])).toEqual([1, 2]);
  });

  it("leaves missing values out of a range unless asked for them", () => {
    // The row with no laterality quotient is not a zero and must not be
    // counted as one — but a researcher checking coverage needs to see it.
    expect(applyFilters(rows, { ehi_sf_lq: { kind: "range", min: -100, max: 100 } })).toHaveLength(3);
    expect(
      applyFilters(rows, { ehi_sf_lq: { kind: "range", min: -100, max: 100, includeBlank: true } }),
    ).toHaveLength(4);
  });

  it("filters a category column by the values present", () => {
    expect(applyFilters(rows, { site: { kind: "set", values: ["BFD"] } })).toHaveLength(1);
    expect(applyFilters(rows, { site: { kind: "set", values: ["LDS", "BFD"] } })).toHaveLength(4);
    // No selection means no filtering, not an empty table.
    expect(applyFilters(rows, { site: { kind: "set", values: [] } })).toHaveLength(4);
  });

  it("offers a blank as a value you can filter on", () => {
    const values = distinctValues(rows, "kss_q1");
    expect(values.some((v) => v.value === BLANK && v.count === 1)).toBe(true);
    expect(applyFilters(rows, { kss_q1: { kind: "set", values: [BLANK] } })).toHaveLength(1);
  });

  it("matches text case-insensitively on part of a value", () => {
    expect(applyFilters(rows, { first_name: { kind: "text", contains: "amar" } })).toHaveLength(2);
  });

  it("combines filters, and searches every column at once", () => {
    const out = applyFilters(
      rows,
      { site: { kind: "set", values: ["LDS"] }, complete: { kind: "set", values: ["yes"] } },
      "chloe",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!["participant_id"]).toBe("EE309FF");
  });
});

describe("sorting", () => {
  it("puts blanks last whichever way the column is sorted", () => {
    const down = sortRows(rows, { key: "ehi_sf_lq", direction: "desc" });
    expect(down[0]!["ehi_sf_lq"]).toBe(100);
    expect(down[down.length - 1]!["ehi_sf_lq"]).toBeNull();
    const up = sortRows(rows, { key: "ehi_sf_lq", direction: "asc" });
    expect(up[0]!["ehi_sf_lq"]).toBe(-100);
    expect(up[up.length - 1]!["ehi_sf_lq"]).toBeNull();
  });
});

describe("csv", () => {
  it("writes what is on screen, quoting anything that would break a cell", () => {
    const csv = toCsv(
      [
        { key: "participant_id", label: "Participant" },
        { key: "note", label: "Note" },
      ],
      [{ participant_id: "AA101BB", note: 'said "yes", twice' }],
    );
    expect(csv.split("\n")[0]).toBe("participant_id,note");
    expect(csv).toContain('"said ""yes"", twice"');
  });

  it("writes a missing value as empty, not as a zero", () => {
    const csv = toCsv([{ key: "ehi_sf_lq", label: "LQ" }], [{ ehi_sf_lq: null }]);
    expect(csv.split("\n")[1]).toBe("");
  });
});

describe("longitudinal helpers", () => {
  it("finds the people with more than one sitting", () => {
    expect(returningIds(rows)).toEqual(["AA101BB"]);
  });

  it("orders a person's sittings by wave", () => {
    expect(participantWaves(rows, "AA101BB").map((r) => r["wave"])).toEqual([1, 2]);
  });

  it("compares waves within the returning sample only", () => {
    // Wave 1 here has three sittings, but only one of those people came back.
    // Including the other two would mix change with drop-out.
    const waves = byWave(rows, "ehi_sf_lq");
    expect(waves.map((w) => [w.wave, w.n])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(waves[0]!.summary.mean).toBe(100);
  });

  it("reports individual change from first wave to last", () => {
    const change = individualChange(rows, "ehi_sf_lq");
    expect(change).toEqual([{ participantId: "AA101BB", from: 100, to: 75, change: -25 }]);
  });
});
