import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import { buildBidsExport } from "./bids.js";
import { assessSitting, indexReleaseQuestions, replaySitting, validateAnswer } from "./completeness.js";
import { ingest, type DeviceEvent, type DeviceSession } from "./ingest.js";
import { wideTable } from "./summary.js";

/**
 * A time grid through ingest, the completeness rules and the exports.
 *
 * r7.0.0 with one extra module placed straight after the social-media battery:
 * a grid of minutes for each app the participant put in "have". Every value
 * below is made up.
 */

const base: ReleaseManifest = releaseManifest.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json", import.meta.url)), "utf8"),
  ),
);

const gridRef = { instrument: "test_app_time", version: "1.0", language: "en-GB", informant: "self" as const, readingLevel: "standard" as const };
const manifest: ReleaseManifest = (() => {
  const m = structuredClone(base);
  m.instruments["test_app_time@1.0/en-GB/self/standard"] = {
    instrument: "test_app_time",
    version: "1.0",
    name: "Time on each app",
    forms: [
      {
        language: "en-GB",
        items: [
          {
            responseType: "time_grid",
            key: "minutes_per_app",
            revision: 1,
            variable: "app_minutes",
            stem: { text: "On a typical day, how much time do you usually spend on each of the following apps?" },
            required: "soft",
            allowDecline: false,
            identifying: false,
            rowsFrom: { instrument: "ybm_social_media", item: "apps_owned", revision: 1, group: "have" },
          },
        ],
      },
    ],
  };
  const section = m.composition.sections.find((s) => s.key === "social_media")!;
  section.components.splice(1, 0, { kind: "module", ref: gridRef });
  return m;
})();

let seq = 0;
const ev = (type: string, itemKey?: string, payload?: Record<string, unknown>): DeviceEvent => ({
  seq: seq++,
  type,
  ...(itemKey ? { itemKey } : {}),
  ...(payload ? { payload } : {}),
  tWall: "2026-09-01T09:00:00.000Z",
  tMono: seq * 1000,
});
const answer = (itemKey: string, value: unknown) => ev("response.recorded", itemKey, { value });

// Facebook is code 1, Snapchat 2, Instagram 3 in scale.sm_platforms.
const owned = (have: number[]) => ({
  kind: "group_rank",
  assignments: Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((code) => [
      code,
      have.includes(code) ? { group: "have", rank: have.indexOf(code) + 1 } : { group: "dont_have" },
    ]),
  ),
});

function sitting(id: string, extra: DeviceEvent[], complete = true): DeviceSession {
  seq = 0;
  return {
    sessionId: id,
    studyCode: "NDC0042",
    releaseKey: manifest.release.key,
    releaseHash: manifest.hash ?? "sha256:test",
    startedAt: "2026-09-01T09:00:00.000Z",
    completedAt: "2026-09-01T09:15:00.000Z",
    complete,
    events: [
      ev("session.started", undefined, { val_id: "NDC0042" }),
      answer("ybm_identity.ps_mother_initials", { kind: "text", value: id.slice(0, 2).toUpperCase() }),
      answer("ybm_identity.ps_house_digit", { kind: "text", value: "4" }),
      answer("ybm_identity.ps_birth_month", { kind: "choice", code: 3 }),
      answer("ybm_identity.ps_postcode_letters", { kind: "text", value: "QQ" }),
      answer("ybm_smartphone.sm_use", { kind: "choice", code: 1 }),
      ...extra,
      ev("session.completed", undefined, { totalMs: 900_000 }),
    ],
  };
}

const rowsOf = (dataset: ReturnType<typeof ingest>["dataset"], sessionId: string) =>
  Object.fromEntries(
    dataset.responses
      .filter((r) => r.sessionId === sessionId && r.item === "minutes_per_app")
      .map((r) => [r.variable, { status: r.status, value: r.value }]),
  );

describe("a time grid in the dataset", () => {
  it("files one variable per app, minutes for the apps asked about and not presented for the rest", () => {
    const { dataset } = ingest(
      [
        sitting("aa", [
          answer("ybm_social_media.apps_owned", owned([3, 1])),
          answer("test_app_time.minutes_per_app", { kind: "time_grid", minutes: { 1: 85, 3: null } }),
        ]),
      ],
      { manifest, study: "ybm" },
    );
    const rows = rowsOf(dataset, "aa");
    expect(Object.keys(rows)).toHaveLength(11);
    expect(rows["app_minutes_1"]).toEqual({ status: "answered", value: 85 });
    // Shown and left empty is a skip, not a zero.
    expect(rows["app_minutes_3"]).toEqual({ status: "skipped", value: null });
    // An app they do not have was never asked about.
    expect(rows["app_minutes_2"]).toEqual({ status: "not_presented_branching", value: null });
    // The grid's own variable is never a column.
    expect(dataset.responses.some((r) => r.variable === "app_minutes")).toBe(false);
    // Counted once as an answered question, not once per row.
    expect(dataset.sessions[0]!.answeredCount).toBe(7);
  });

  it("files every row as not presented when the participant later moved every app to 'don't have'", () => {
    const { dataset } = ingest(
      [
        sitting("bb", [
          answer("ybm_social_media.apps_owned", owned([2])),
          answer("test_app_time.minutes_per_app", { kind: "time_grid", minutes: { 2: 30 } }),
          answer("ybm_social_media.apps_owned", owned([])),
        ]),
      ],
      { manifest, study: "ybm" },
    );
    const rows = rowsOf(dataset, "bb");
    expect(Object.values(rows).every((r) => r.status === "not_presented_branching" && r.value === null)).toBe(true);
  });

  it("keeps a skip of the whole grid as a skip for each row shown", () => {
    const { dataset } = ingest(
      [sitting("cc", [answer("ybm_social_media.apps_owned", owned([5])), ev("item.skipped", "test_app_time.minutes_per_app")])],
      { manifest, study: "ybm" },
    );
    const rows = rowsOf(dataset, "cc");
    expect(rows["app_minutes_5"]?.status).toBe("skipped");
    expect(rows["app_minutes_1"]?.status).toBe("not_presented_branching");
  });

  it("exports minutes as numbers, with an entry in the dictionary for each app", () => {
    const { dataset } = ingest(
      [
        sitting("dd", [
          answer("ybm_social_media.apps_owned", owned([4])),
          answer("test_app_time.minutes_per_app", { kind: "time_grid", minutes: { 4: 125 } }),
        ]),
      ],
      { manifest, study: "ybm" },
    );
    const files = buildBidsExport(dataset, { manifest, datasetName: "Test" });
    const tsv = files.find((f) => f.path === "phenotype/test_app_time.tsv")!.content.split("\n");
    const header = tsv[0]!.split("\t");
    const row = tsv[1]!.split("\t");
    expect(row[header.indexOf("app_minutes_4")]).toBe("125");
    expect(row[header.indexOf("app_minutes_1")]).toBe("n/a");
    expect(row[header.indexOf("app_minutes_1_status")]).toBe("not_presented_branching");
    const sidecar = JSON.parse(files.find((f) => f.path === "phenotype/test_app_time.json")!.content);
    expect(sidecar["app_minutes_4"]).toMatchObject({ Units: "minutes" });
    expect(sidecar["app_minutes_4"].Description).toMatch(/TikTok$/);
    expect(sidecar["app_minutes"]).toBeUndefined();

    const wide = wideTable(dataset);
    expect(wide.rows[0]!["app_minutes_4"]).toBe(125);
    expect(wide.columns.find((c) => c.key === "app_minutes_4")?.kind).toBe("number");
  });
});

describe("a time grid in the completeness rules", () => {
  const index = indexReleaseQuestions(manifest);
  const assess = (s: DeviceSession) =>
    assessSitting(replaySitting(s), index, { requiredLevels: ["hard", "soft"], sittingStart: s.startedAt });
  const outcome = (s: DeviceSession) => assess(s).outcomes.find((o) => o.key === "test_app_time.minutes_per_app")?.outcome;

  it("is hidden by branching when nothing is in the group, and asked otherwise", () => {
    expect(outcome(sitting("ee", [answer("ybm_social_media.apps_owned", owned([]))]))).toBe("hidden_branching");
    expect(
      outcome(
        sitting("ff", [
          answer("ybm_social_media.apps_owned", owned([1])),
          answer("test_app_time.minutes_per_app", { kind: "time_grid", minutes: { 1: 20 } }),
        ]),
      ),
    ).toBe("answered");
  });

  it("calls a value no device could record invalid", () => {
    const q = index.byKey.get("test_app_time.minutes_per_app")!;
    expect(q.options?.map((o) => o.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(validateAnswer(q, { kind: "time_grid", minutes: { 1: 20, 2: null } })).toEqual({ valid: true, empty: false });
    expect(validateAnswer(q, { kind: "time_grid", minutes: { 1: null } })).toEqual({ valid: true, empty: true });
    expect(validateAnswer(q, { kind: "time_grid", minutes: { 1: 1441 } }).valid).toBe(false);
    expect(validateAnswer(q, { kind: "time_grid", minutes: { 1: 2.5 } }).valid).toBe(false);
    expect(validateAnswer(q, { kind: "time_grid", minutes: { 99: 5 } }).valid).toBe(false);
  });
});
