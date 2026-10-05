import { describe, expect, it } from "vitest";
import type { AuditDoc, VersionDoc } from "@myself/studio";
import {
  csvCell,
  livePeriods,
  PROVENANCE_COLUMNS,
  provenanceCsv,
  provenanceDocument,
  provenanceFilename,
  provenanceRows,
  releaseMyStory,
} from "./provenance.js";

/** A server time, the way the Web SDK hands one back. */
const at = (iso: string) => ({ seconds: Date.parse(iso) / 1000, nanoseconds: 0 });

const version = (v: Partial<VersionDoc> & Pick<VersionDoc, "version" | "hash">): VersionDoc => ({
  surveyId: "ybm_nd2026_standard",
  releaseKey: `ybm_nd2026_standard_r${v.version.replace(/\./g, "_")}`,
  engineVersion: "0.2.0",
  releaseNote: "",
  changeSummary: null,
  bump: null,
  itemKeys: [],
  variables: [],
  source: "studio",
  draftRevision: 1,
  basedOnVersion: null,
  authors: [],
  publishedAt: at("2026-10-01T09:00:00Z"),
  publishedBy: "u_pub",
  publishedByEmail: "pat.publisher@example.org",
  manifestPublishedAt: "2026-10-01T09:00:00.000Z",
  ...v,
});

const row = (action: AuditDoc["action"], when: string, subject: string, detail: Record<string, unknown> = {}): AuditDoc => ({
  at: at(when),
  actor: "u_pub",
  actorEmail: "pat.publisher@example.org",
  action,
  surveyId: "ybm_nd2026_standard",
  subject,
  detail,
});

const H8 = `sha256:${"8".repeat(64)}`;
const H9 = `sha256:${"9".repeat(64)}`;
const H10 = `sha256:${"a".repeat(64)}`;

const versions: VersionDoc[] = [
  version({
    version: "8.0.0",
    hash: H8,
    source: "repository",
    publishedBy: "repository",
    publishedByEmail: null,
    publishedAt: at("2026-09-29T18:46:00Z"),
    releaseNote: "Published before the Studio, from the project's releases folder.",
    draftRevision: null,
  }),
  version({
    version: "9.0.0",
    hash: H9,
    engineVersion: "0.4.0",
    basedOnVersion: "8.0.0",
    authors: ["ed.editor@example.org"],
    releaseNote: "Adds MyStory at the end.",
    changeSummary: {
      bump: "major",
      entries: [{ kind: "mystory.added", bump: "major", breaking: false, message: "MyStory added (np.phone_wellbeing@0.1.1)." }],
      counts: { added: 0, removed: 0, archived: 0, changed: 0, moved: 0 },
    },
    bump: "major",
    publishedAt: at("2026-10-01T09:00:00Z"),
  }),
  version({
    version: "10.0.0",
    hash: H10,
    basedOnVersion: "8.0.0",
    authors: ["ed.editor@example.org", "ada.admin@example.org"],
    releaseNote: "=HYPERLINK(\"http://example.test\",\"Back to r8\")",
    changeSummary: {
      bump: "major",
      entries: [{ kind: "mystory.removed", bump: "major", breaking: false, message: "MyStory removed (np.phone_wellbeing@0.1.1)." }],
      counts: { added: 0, removed: 0, archived: 0, changed: 0, moved: 0 },
    },
    bump: "major",
    publishedAt: at("2026-10-03T09:00:00Z"),
  }),
];

const audit: AuditDoc[] = [
  row("survey.imported", "2026-09-30T08:00:00Z", "ybm_nd2026_standard", { imported: ["8.0.0"], active: "8.0.0", createdSurvey: true }),
  row("draft.edited", "2026-09-30T10:00:00Z", "ybm_nd2026_standard"),
  row("version.published", "2026-10-01T09:00:00Z", "9.0.0", { version: "9.0.0", hash: H9 }),
  row("version.activated", "2026-10-02T09:00:00Z", "8.0.0", { version: "8.0.0", hash: H8, reason: "MyStory would not load in school" }),
  row("draft.restored", "2026-10-02T10:00:00Z", "8.0.0", { version: "8.0.0", hash: H8 }),
  // A second set-up run creates nothing, and says nothing about what is live.
  row("survey.imported", "2026-10-02T11:00:00Z", "ybm_nd2026_standard", { imported: [], active: "8.0.0", createdSurvey: false }),
  row("version.published", "2026-10-03T09:00:00Z", "10.0.0", { version: "10.0.0", hash: H10 }),
];

const withStory = { composition: { sections: [{ components: [{ kind: "module" }] }, { components: [{ kind: "narrative", protocol: "np.phone_wellbeing", protocolVersion: "0.1.1" }] }] } };
const without = { composition: { sections: [{ components: [{ kind: "module" }] }] } };

const rows = provenanceRows({
  versions,
  live: { version: "10.0.0", hash: H10 },
  audit: [...audit].reverse(),
  releases: new Map<string, unknown>([
    [H8, without],
    [H9, withStory],
    [H10, without],
  ]),
  sittings: { [H8]: { complete: 120, partial: 4 }, [H9]: { complete: 7, partial: 1 } },
});

describe("the provenance of a survey's versions", () => {
  it("has one row per version, newest first, with what the version record says", () => {
    expect(rows.map((r) => r.version)).toEqual(["10.0.0", "9.0.0", "8.0.0"]);
    expect(rows[1]).toMatchObject({
      releaseKey: "ybm_nd2026_standard_r9_0_0",
      hash: H9,
      engineVersion: "0.4.0",
      status: "previous",
      source: "studio",
      authors: ["ed.editor@example.org"],
      publisher: "pat.publisher@example.org",
      publishedAt: "2026-10-01T09:00:00.000Z",
      basedOn: "8.0.0",
      restoredFrom: null,
      releaseNote: "Adds MyStory at the end.",
      changeSummary: ["MyStory added (np.phone_wellbeing@0.1.1)."],
      requiredBump: "major",
      chosenBump: "major",
      mystory: { on: true, protocol: "np.phone_wellbeing@0.1.1" },
      sittings: { complete: 7, partial: 1 },
    });
    expect(rows[0]!.status).toBe("live");
    expect(rows[2]).toMatchObject({ source: "repository", publisher: "repository", requiredBump: null, chosenBump: null, mystory: { on: false, protocol: null } });
  });

  it("says which version was restored into the draft before a version was published", () => {
    expect(rows[0]!.restoredFrom).toBe("8.0.0");
  });

  it("lists every period a version was live, from the set-up, each publish and each “make live again”", () => {
    expect(rows.find((r) => r.version === "8.0.0")!.livePeriods).toEqual([
      { from: "2026-09-30T08:00:00.000Z", to: "2026-10-01T09:00:00.000Z", how: "set up from the live survey", by: "pat.publisher@example.org" },
      { from: "2026-10-02T09:00:00.000Z", to: "2026-10-03T09:00:00.000Z", how: "made live again", by: "pat.publisher@example.org" },
    ]);
    expect(rows[1]!.livePeriods).toEqual([{ from: "2026-10-01T09:00:00.000Z", to: "2026-10-02T09:00:00.000Z", how: "published", by: "pat.publisher@example.org" }]);
    expect(rows[0]!.livePeriods).toEqual([{ from: "2026-10-03T09:00:00.000Z", to: null, how: "published", by: "pat.publisher@example.org" }]);
    expect(livePeriods([]).size).toBe(0);
  });

  it("leaves what it could not read empty, rather than guessing", () => {
    const unread = provenanceRows({ versions, live: null, audit: [], releases: new Map(), sittings: null });
    expect(unread[0]).toMatchObject({ mystory: null, sittings: null, livePeriods: [], restoredFrom: null, status: "previous" });
    expect(releaseMyStory(null)).toBeNull();
  });
});

describe("the provenance as a spreadsheet", () => {
  const csv = provenanceCsv(rows);
  const lines = csv.slice(1).split("\r\n");

  it("is UTF-8 with a byte-order mark, a header row and CRLF lines", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(PROVENANCE_COLUMNS.join(","));
    expect(lines).toHaveLength(rows.length + 2);
    expect(lines.at(-1)).toBe("");
  });

  it("writes each version's row in the column order", () => {
    expect(lines[2]).toBe(
      [
        "9.0.0",
        "ybm_nd2026_standard_r9_0_0",
        H9,
        "0.4.0",
        "previous",
        "studio",
        "ed.editor@example.org",
        "pat.publisher@example.org",
        "2026-10-01T09:00:00.000Z",
        "8.0.0",
        "",
        "Adds MyStory at the end.",
        "MyStory added (np.phone_wellbeing@0.1.1).",
        "major",
        "major",
        "on",
        "np.phone_wellbeing@0.1.1",
        "7",
        "1",
        "2026-10-01T09:00:00.000Z to 2026-10-02T09:00:00.000Z (published)",
      ].join(","),
    );
  });

  it("never lets a cell run as a formula when the file is opened", () => {
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://example.test"",""Back to r8"")"`);
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) expect(csvCell(`${start}1+1`).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell("1+1")).toBe("1+1");
    expect(csvCell('say "hi", then go\nhome')).toBe('"say ""hi"", then go\nhome"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });
});

describe("the provenance as JSON", () => {
  it("names itself, the survey and what is live, and carries every row", () => {
    const doc = provenanceDocument(rows, {
      study: "ybm",
      surveyId: "ybm_nd2026_standard",
      title: "Yorkshire Brain Map",
      live: { version: "10.0.0", hash: H10 },
      exportedAt: new Date("2026-10-04T12:00:00Z"),
    });
    expect(doc).toMatchObject({
      format: "myself-studio-provenance",
      formatVersion: 1,
      study: "ybm",
      surveyId: "ybm_nd2026_standard",
      exportedAt: "2026-10-04T12:00:00.000Z",
      live: { version: "10.0.0", hash: H10 },
    });
    expect(doc.versions).toEqual(rows);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
    expect(provenanceFilename("ybm_nd2026_standard", new Date("2026-10-04T12:00:00Z"), "csv")).toBe("ybm_nd2026_standard-provenance-2026-10-04.csv");
  });
});
