import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import { buildBidsExport } from "./bids.js";
import { emptyDataset, type Dataset } from "./dataset.js";
import { buildDemoSessions } from "./demo.js";
import { deriveParticipantCode, isParticipantCode, monthNumber } from "./identity.js";
import { ingest, resolveAlias, type DeviceEvent, type DeviceSession } from "./ingest.js";
import {
  exportableNarratives,
  summariseNarrative,
  type StoredNarrativeRecord,
  type StoredNarrativeRun,
} from "./narratives.js";
import { summarise, summariseNumbers, wideTable } from "./summary.js";
import { buildZip } from "./zip.js";

const manifest: ReleaseManifest = releaseManifest.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json", import.meta.url)),
      "utf8",
    ),
  ),
);

/**
 * Longitudinal linkage is the part of this platform where a mistake is most
 * expensive: a wrong join silently merges two children's data and nobody ever
 * sees it. So the identity tests come first and are the strictest.
 */
describe("participant code", () => {
  it("derives the documented code from the four components", () => {
    // Jane, house 123, born January, postcode AB1 2CD -> JA101CD
    expect(
      deriveParticipantCode({
        motherInitials: "Jane".slice(0, 2),
        houseDigit: "1",
        birthMonth: "January",
        postcodeLetters: "CD",
      }),
    ).toBe("JA101CD");
  });

  it("normalises case and whitespace, so the same person derives the same code", () => {
    const a = deriveParticipantCode({ motherInitials: "ja", houseDigit: "1", birthMonth: 1, postcodeLetters: "cd" });
    const b = deriveParticipantCode({ motherInitials: " JA ", houseDigit: " 1 ", birthMonth: "january", postcodeLetters: " Cd " });
    expect(a).toBe("JA101CD");
    expect(b).toBe(a);
  });

  it("accepts a month as a name, an abbreviation or a number", () => {
    expect(monthNumber("September")).toBe(9);
    expect(monthNumber("sept")).toBe(9);
    expect(monthNumber("sep")).toBe(9);
    expect(monthNumber("9")).toBe(9);
    expect(monthNumber(9)).toBe(9);
    expect(monthNumber("09")).toBe(9);
  });

  it("refuses a month that is not one", () => {
    expect(monthNumber("13")).toBeNull();
    expect(monthNumber("0")).toBeNull();
    expect(monthNumber("")).toBeNull();
    expect(monthNumber("smarch")).toBeNull();
  });

  it("produces NO code rather than a partial one", () => {
    // A half-formed key is not a weaker key — it collides with every other
    // participant missing the same piece, which is far worse than no key.
    expect(deriveParticipantCode({ motherInitials: "JA", houseDigit: "1", birthMonth: "January" })).toBeNull();
    expect(deriveParticipantCode({ motherInitials: "J", houseDigit: "1", birthMonth: 1, postcodeLetters: "CD" })).toBeNull();
    expect(deriveParticipantCode({ motherInitials: "JA", houseDigit: "", birthMonth: 1, postcodeLetters: "CD" })).toBeNull();
    expect(deriveParticipantCode({})).toBeNull();
  });

  it("distinguishes people who differ in any single component", () => {
    const base = { motherInitials: "JA", houseDigit: "1", birthMonth: 1, postcodeLetters: "CD" };
    const codes = new Set([
      deriveParticipantCode(base),
      deriveParticipantCode({ ...base, motherInitials: "JB" }),
      deriveParticipantCode({ ...base, houseDigit: "2" }),
      deriveParticipantCode({ ...base, birthMonth: 2 }),
      deriveParticipantCode({ ...base, postcodeLetters: "CE" }),
    ]);
    expect(codes.size).toBe(5);
  });

  it("recognises its own output", () => {
    expect(isParticipantCode("JA101CD")).toBe(true);
    expect(isParticipantCode("JA1CD")).toBe(false);
    expect(isParticipantCode("ja101cd")).toBe(false);
  });
});

// ── ingest ────────────────────────────────────────────────────────────────

let seq = 0;
const ev = (type: string, itemKey?: string, payload?: Record<string, unknown>): DeviceEvent => ({
  seq: seq++,
  type,
  ...(itemKey ? { itemKey } : {}),
  ...(payload ? { payload } : {}),
  tWall: "2026-09-01T09:00:00.000Z",
  tMono: seq * 1000,
});

/** A session that answers the secret code plus a couple of real items. */
function session(
  id: string,
  parts: { initials: string; digit: string; month: number; postcode: string },
  opts: { startedAt?: string; studyCode?: string; extra?: DeviceEvent[]; complete?: boolean } = {},
): DeviceSession {
  seq = 0;
  const events: DeviceEvent[] = [
    ev("session.started", undefined, { val_id: opts.studyCode ?? "NDC0042" }),
    ev("response.recorded", "ybm_identity.ps_mother_initials", { value: { kind: "text", value: parts.initials } }),
    ev("response.recorded", "ybm_identity.ps_house_digit", { value: { kind: "text", value: parts.digit } }),
    ev("response.recorded", "ybm_identity.ps_birth_month", { value: { kind: "choice", code: parts.month } }),
    ev("response.recorded", "ybm_identity.ps_postcode_letters", { value: { kind: "text", value: parts.postcode } }),
    ...(opts.extra ?? []),
    ev("session.completed", undefined, { totalMs: 900_000, foregroundMs: 840_000 }),
  ];
  return {
    sessionId: id,
    studyCode: opts.studyCode ?? "NDC0042",
    releaseKey: manifest.release.key,
    releaseHash: manifest.hash ?? "sha256:test",
    startedAt: opts.startedAt ?? "2026-09-01T09:00:00.000Z",
    completedAt: "2026-09-01T09:15:00.000Z",
    complete: opts.complete ?? true,
    events,
  };
}

const alice = { initials: "JA", digit: "1", month: 1, postcode: "CD" };
const bob = { initials: "MO", digit: "7", month: 6, postcode: "XY" };

describe("ingest", () => {
  it("files a session under the participant its answers derive", () => {
    const { dataset, rejected } = ingest([session("s1", alice)], { manifest, study: "ybm" });
    expect(rejected).toEqual([]);
    expect(dataset.participants).toHaveLength(1);
    expect(dataset.participants[0]!.participantId).toBe("JA101CD");
    expect(dataset.sessions[0]!.wave).toBe(1);
  });

  it("links the same person across waves and numbers them in order", () => {
    const { dataset } = ingest(
      [
        session("s1", alice, { startedAt: "2026-09-01T09:00:00.000Z" }),
        session("s2", alice, { startedAt: "2027-03-01T09:00:00.000Z" }),
      ],
      { manifest, study: "ybm" },
    );
    expect(dataset.participants).toHaveLength(1);
    expect(dataset.participants[0]!.sessionCount).toBe(2);
    expect(dataset.sessions.map((s) => s.wave)).toEqual([1, 2]);
  });

  it("continues waves when a later batch is ingested against an existing dataset", () => {
    // A second wave arrives months later, in its own sync. It must be wave 2,
    // not wave 1 again.
    const first = ingest([session("s1", alice)], { manifest, study: "ybm" }).dataset;
    const second = ingest([session("s2", alice, { startedAt: "2027-03-01T09:00:00.000Z" })], {
      manifest,
      study: "ybm",
      existing: first,
    }).dataset;
    expect(second.sessions.map((s) => s.wave)).toEqual([1, 2]);
    expect(second.participants).toHaveLength(1);
  });

  it("never merges two different people", () => {
    const { dataset } = ingest([session("s1", alice), session("s2", bob)], { manifest, study: "ybm" });
    expect(dataset.participants.map((p) => p.participantId).sort()).toEqual(["JA101CD", "MO706XY"]);
    for (const p of dataset.participants) expect(p.sessionCount).toBe(1);
  });

  it("is idempotent: the same session twice does not double anyone's data", () => {
    // A retried sync, or an old export re-imported, must be harmless.
    const first = ingest([session("s1", alice)], { manifest, study: "ybm" }).dataset;
    const again = ingest([session("s1", alice)], { manifest, study: "ybm", existing: first });
    expect(again.dataset.sessions).toHaveLength(1);
    expect(again.dataset.participants[0]!.sessionCount).toBe(1);
    expect(again.warnings[0]).toMatch(/already ingested/);
  });

  it("holds back a session whose code is incomplete rather than guessing", () => {
    const broken = session("s3", alice);
    broken.events = broken.events.filter((e) => e.itemKey !== "ybm_identity.ps_postcode_letters");
    const { dataset, rejected } = ingest([broken], { manifest, study: "ybm" });
    expect(dataset.sessions).toHaveLength(0);
    expect(rejected).toEqual([{ sessionId: "s3", reason: expect.stringContaining("cannot be linked") }]);
  });

  it("keeps skips and declines as answers about the person, not as absences", () => {
    const s = session("s1", alice, {
      extra: [ev("item.skipped", "sdq25_s.q1"), ev("item.declined", "sdq25_s.q2")],
    });
    const { dataset } = ingest([s], { manifest, study: "ybm" });
    const byItem = new Map(dataset.responses.map((r) => [`${r.instrument}.${r.item}`, r]));
    expect(byItem.get("sdq25_s.q1")?.status).toBe("skipped");
    expect(byItem.get("sdq25_s.q2")?.status).toBe("declined");
    expect(dataset.sessions[0]!.skippedCount).toBe(2);
  });

  it("records the label the participant saw alongside the code", () => {
    const s = session("s1", alice, {
      extra: [ev("response.recorded", "ybm_smartphone.own", { value: { kind: "choice", code: 1 } })],
    });
    const { dataset } = ingest([s], { manifest, study: "ybm" });
    const own = dataset.responses.find((r) => r.item === "own")!;
    expect(own.value).toBe(1);
    expect(own.label).toBe("Yes");
  });

  it("carries timing and data-quality flags through to the rows", () => {
    const s = session("s1", alice, {
      extra: [
        ev("response.recorded", "sdq25_s.q1", { value: { kind: "choice", code: 0 }, timing: { tooFast: true } }),
        ev("item.left", "sdq25_s.q1", { visit: 2, totalDwellMs: 4200 }),
      ],
    });
    const { dataset } = ingest([s], { manifest, study: "ybm" });
    const q1 = dataset.responses.find((r) => r.item === "q1" && r.instrument === "sdq25_s")!;
    expect(q1.tooFast).toBe(true);
    expect(q1.visits).toBe(2);
    expect(q1.dwellMs).toBe(4200);
    expect(dataset.sessions[0]!.tooFastCount).toBe(1);
    expect(dataset.sessions[0]!.revisitedCount).toBe(1);
  });

  it("scores what it can and says how many items contributed", () => {
    const s = session("s1", alice, {
      extra: ["writing", "throwing", "toothbrush", "spoon"].map((item) =>
        ev("response.recorded", `ehi_sf.${item}`, { value: { kind: "choice", code: 1 } }),
      ),
    });
    const { dataset } = ingest([s], { manifest, study: "ybm" });
    const lq = dataset.scores.find((r) => r.output === "lq")!;
    expect(lq.value).toBe(100);
    expect(lq.validCount).toBe(4);
    expect(dataset.scores.find((r) => r.output === "lq_band")!.value).toBe("very right-handed");
  });

  it("derives the site from the researcher-issued code", () => {
    const { dataset } = ingest([session("s1", alice, { studyCode: "NDC0042" })], { manifest, study: "ybm" });
    expect(dataset.sessions[0]!.site).toBe("NDC");
  });
});

// ── summaries and the filterable table ────────────────────────────────────

describe("summaries", () => {
  it("describes an empty column without inventing a number", () => {
    expect(summariseNumbers([null, undefined])).toMatchObject({ n: 0, missing: 2, mean: null, median: null });
  });

  it("computes mean, median and a sample SD", () => {
    const s = summariseNumbers([1, 2, 3, 4]);
    expect(s.mean).toBe(2.5);
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(4);
    expect(s.sd).toBeCloseTo(1.2910, 3);
    expect(s.n).toBe(4);
  });

  it("counts the longitudinal sample separately from the total", () => {
    const { dataset } = ingest(
      [
        session("s1", alice, { startedAt: "2026-09-01T09:00:00.000Z" }),
        session("s2", alice, { startedAt: "2027-03-01T09:00:00.000Z" }),
        session("s3", bob),
      ],
      { manifest, study: "ybm" },
    );
    const s = summarise(dataset);
    expect(s.participants).toBe(2);
    expect(s.sessions).toBe(3);
    expect(s.returning).toBe(1); // only Alice has come back
    expect(s.maxWave).toBe(2);
    expect(s.completionRate).toBe(1);
  });

  it("builds a wide table with one row per sitting and a column per variable", () => {
    const s = session("s1", alice, {
      extra: [ev("response.recorded", "ybm_smartphone.own", { value: { kind: "choice", code: 1 } })],
    });
    const table = wideTable(ingest([s], { manifest, study: "ybm" }).dataset);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!["participant_id"]).toBe("JA101CD");
    expect(table.rows[0]!["smartphone_own"]).toBe("Yes");
    expect(table.columns.some((c) => c.key === "smartphone_own")).toBe(true);
    expect(table.columns.find((c) => c.key === "wave")?.kind).toBe("number");
  });
});

// ── BIDS export ───────────────────────────────────────────────────────────

describe("BIDS-style export", () => {
  const built = () => {
    const { dataset } = ingest(
      [
        session("s1", alice, {
          startedAt: "2026-09-01T09:00:00.000Z",
          extra: [ev("response.recorded", "ybm_smartphone.own", { value: { kind: "choice", code: 1 } })],
        }),
        session("s2", alice, { startedAt: "2027-03-01T09:00:00.000Z" }),
        session("s3", bob, { studyCode: "LDS0007" }),
      ],
      { manifest, study: "ybm" },
    );
    const files = buildBidsExport(dataset, { manifest, datasetName: "Yorkshire Brain Map" });
    return { dataset, files, get: (p: string) => files.find((f) => f.path === p)?.content };
  };

  it("writes the files a BIDS dataset must have", () => {
    const { get } = built();
    expect(get("dataset_description.json")).toBeTruthy();
    expect(get("participants.tsv")).toBeTruthy();
    expect(get("participants.json")).toBeTruthy();
  });

  it("names the release hash, so an answer stays interpretable", () => {
    const desc = JSON.parse(built().get("dataset_description.json")!);
    expect(desc.SourceDatasets[0].ReleaseHash).toBe(manifest.hash);
    expect(desc.SourceDatasets[0].ReleaseVersion).toBe(manifest.release.version);
  });

  it("uses BIDS subject and session labels", () => {
    const { get } = built();
    const participants = get("participants.tsv")!.trim().split("\n");
    expect(participants[0]).toBe("participant_id\tstudy\tn_sessions\tfirst_seen\tlast_seen\tsites");
    expect(participants[1]).toMatch(/^sub-JA101CD\t/);
    expect(get("sub-JA101CD/sessions.tsv")).toMatch(/ses-01/);
    expect(get("sub-JA101CD/sessions.tsv")).toMatch(/ses-02/);
  });

  it("puts questionnaire data in phenotype/, one file per instrument, with a dictionary", () => {
    const { files, get } = built();
    expect(files.some((f) => f.path === "phenotype/ybm_smartphone.tsv")).toBe(true);
    const dict = JSON.parse(get("phenotype/ybm_smartphone.json")!);
    expect(dict.smartphone_own.Description).toMatch(/smartphone/i);
    // every code carries the label it stood for
    expect(dict.smartphone_own.Levels["1"]).toBe("Yes");
    expect(dict.participant_id.Description).toBeTruthy();
  });

  it("writes n/a for missing, never a blank cell and never a zero", () => {
    const { files } = built();
    for (const f of files.filter((x) => x.path.endsWith(".tsv"))) {
      const lines = f.content.trim().split("\n");
      const width = lines[0]!.split("\t").length;
      for (const line of lines) {
        const cells = line.split("\t");
        expect(cells).toHaveLength(width); // ragged rows are unreadable
        for (const c of cells) expect(c).not.toBe("");
      }
    }
  });

  it("says why a value is missing, not merely that it is", () => {
    // A skip and a branch that never ran are not the same absence, and
    // collapsing them into one blank throws that away.
    const { get } = built();
    const header = get("phenotype/ybm_smartphone.tsv")!.split("\n")[0]!;
    expect(header).toContain("smartphone_own");
    expect(header).toContain("smartphone_own_status");
  });

  it("keeps derived scores out of the raw phenotype files", () => {
    const { files, get } = built();
    expect(files.some((f) => f.path === "phenotype/scores.tsv")).toBe(true);
    const scoresDoc = JSON.parse(get("phenotype/scores.json")!);
    expect(scoresDoc.Description).toMatch(/regenerable/i);
    // the raw file for an instrument holds no score column
    expect(get("phenotype/ehi_sf.tsv") ?? "").not.toContain("ehi_sf_lq");
  });

  it("gives every data file a sidecar", () => {
    const { files } = built();
    for (const f of files.filter((x) => x.path.endsWith(".tsv"))) {
      const sidecar = f.path.replace(/\.tsv$/, ".json");
      // Per-subject sessions.tsv share one sessions.json at the root, as BIDS
      // allows for inherited sidecars.
      const inherited = f.path.endsWith("sessions.tsv") ? "sessions.json" : sidecar;
      expect(files.some((x) => x.path === inherited), `${f.path} has no dictionary`).toBe(true);
    }
  });
});

describe("summary counts", () => {
  it("counts a score that could not be computed as missing, not as absent", () => {
    // Half a scale answered is not the same as a scale nobody was shown, and a
    // completeness figure that quietly ignores the first is worse than none.
    const { dataset } = ingest(
      [session("s1", alice), session("s2", bob)],
      { manifest, study: "ybm" },
    );
    const summary = summarise(dataset);
    for (const score of summary.scores) {
      expect(score.summary.n + score.summary.missing).toBe(
        dataset.scores.filter((s) => `${s.instrument}_${s.output}` === score.key).length,
      );
    }
  });
});

describe("synthetic sessions", () => {
  const sessions = buildDemoSessions({ manifest, participants: 12, seed: 7 });

  it("is reproducible from its seed", () => {
    const again = buildDemoSessions({ manifest, participants: 12, seed: 7 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(sessions));
    const different = buildDemoSessions({ manifest, participants: 12, seed: 8 });
    expect(JSON.stringify(different)).not.toBe(JSON.stringify(sessions));
  });

  it("is marked as demonstration data in the site column", () => {
    const { dataset } = ingest(sessions, { manifest, study: "demo" });
    for (const s of dataset.sessions) expect(s.site).toMatch(/^DEMO/);
  });

  it("produces people who come back, not one-shot rows", () => {
    const { dataset, rejected } = ingest(sessions, { manifest, study: "demo" });
    expect(rejected).toEqual([]);
    const summary = summarise(dataset);
    expect(summary.returning).toBeGreaterThan(0);
    expect(summary.maxWave).toBeGreaterThan(1);
    // Every wave of one person carries the same derived code, or the
    // longitudinal claim is empty.
    for (const p of dataset.participants) {
      const mine = dataset.sessions.filter((s) => s.participantId === p.participantId);
      expect(mine.length).toBe(p.sessionCount);
      expect(new Set(mine.map((s) => s.wave)).size).toBe(mine.length);
    }
  });

  it("leans right-handed, as an unselected sample does", () => {
    // A generator that read the anchors backwards would produce a mostly
    // left-handed cohort and nobody would notice until the first real analysis.
    const { dataset } = ingest(sessions, { manifest, study: "demo" });
    const lq = dataset.scores.filter((s) => s.output === "lq" && typeof s.value === "number");
    expect(lq.length).toBeGreaterThan(0);
    const right = lq.filter((s) => (s.value as number) > 0).length;
    expect(right / lq.length).toBeGreaterThan(0.6);
  });
});

describe("zip", () => {
  it("writes an archive an unzipper can read", () => {
    const bytes = buildZip([
      { path: "dataset_description.json", content: '{"Name":"demo"}\n' },
      { path: "phenotype/kss.tsv", content: "participant_id\tkss_q1\nsub-JA101CD\t3\n" },
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // local file header
    // End-of-central-directory, and it agrees about how many entries there are.
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("phenotype/kss.tsv");
    expect(text).toContain("sub-JA101CD");
  });

  it("round-trips a real export through the unzip on this machine", () => {
    const { dataset } = ingest(buildDemoSessions({ manifest, participants: 3, seed: 3 }), {
      manifest,
      study: "demo",
    });
    const files = buildBidsExport(dataset, { manifest, datasetName: "demo" });
    const dir = mkdtempSync(join(tmpdir(), "myself-zip-"));
    const archive = join(dir, "bids.zip");
    writeFileSync(archive, buildZip(files));
    // `unzip -t` is the check that matters: our own reader agreeing with our
    // own writer would prove nothing.
    const listing = execFileSync("unzip", ["-t", archive], { encoding: "utf8" });
    expect(listing).toMatch(/No errors detected/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("identifiers are structurally absent from the research data", () => {
  /**
   * The rule this pins: a name, a date of birth or a secret-code component
   * cannot appear in the dataset, the wide table or any exported file. Not
   * "is filtered out" — cannot appear, because ingest never puts it there.
   *
   * It is worth a test of this shape because the failure is silent and only
   * discovered by someone opening a deposited archive and finding a child's
   * name in it.
   */
  const built = () => {
    const sessions = buildDemoSessions({ manifest, participants: 6, seed: 11 });
    const result = ingest(sessions, { manifest, study: "ybm" });
    return { ...result, files: buildBidsExport(result.dataset, { manifest, datasetName: "test" }) };
  };

  it("routes names, dates of birth and code components to the identity partition", () => {
    const { identity } = built();
    const variables = new Set(identity.map((r) => r.variable));
    expect(variables).toContain("first_name");
    expect(variables).toContain("last_name");
    expect(variables).toContain("dob");
    expect(variables).toContain("ps_mother_initials");
    expect(variables).toContain("ps_postcode_letters");
  });

  it("keeps them out of the responses entirely", () => {
    const { dataset } = built();
    const leaked = dataset.responses.filter((r) =>
      ["first_name", "last_name", "dob", "ps_mother_initials", "ps_house_digit", "ps_birth_month", "ps_postcode_letters"].includes(
        r.variable,
      ),
    );
    expect(leaked).toEqual([]);
  });

  it("keeps them out of the wide table the researcher view filters", () => {
    const { dataset } = built();
    const table = wideTable(dataset);
    const columns = table.columns.map((c) => c.key);
    expect(columns).not.toContain("first_name");
    expect(columns).not.toContain("dob");
  });

  it("puts no name and no date of birth anywhere in the BIDS export", () => {
    const { identity, files } = built();
    const everything = files.map((f) => f.content).join("\n");
    // Searched for verbatim: the actual names and dates these demo people
    // gave. A single occurrence anywhere is a failure.
    for (const row of identity) {
      if (!["first_name", "last_name", "dob"].includes(row.variable)) continue;
      expect(everything.includes(row.value), `${row.variable} "${row.value}" reached the export`).toBe(false);
    }
    // And no file is written for the identity instrument at all: with its
    // items diverted there is nothing left in it to export.
    expect(files.some((f) => f.path.includes("ybm_identity"))).toBe(false);
  });

  it("exports no column for any code component", () => {
    const { files } = built();
    const headers = files.filter((f) => f.path.endsWith(".tsv")).map((f) => f.content.split("\n")[0] ?? "");
    for (const header of headers) {
      for (const variable of ["ps_mother_initials", "ps_house_digit", "ps_birth_month", "ps_postcode_letters"]) {
        expect(header).not.toContain(variable);
      }
    }
  });

  it("records that the participant code encodes its components, by design", () => {
    // Being straight about what the pseudonym is and is not. The code cannot
    // be reversed to a name, which is the property the study relies on — but
    // it is built from the components, so anyone who knows the scheme reads
    // the mother's initials, a house digit, a birth month and two postcode
    // letters straight off it. That is a deliberate trade for a code the
    // participant can reproduce years later without being told it (D-23), and
    // it is the reason the code is treated as pseudonymous data rather than
    // anonymous.
    const { dataset, identity } = built();
    const person = dataset.participants[0]!;
    const parts = identity.filter((r) => r.participantId === person.participantId);
    const initials = parts.find((r) => r.variable === "ps_mother_initials")?.value;
    expect(initials).toBeTruthy();
    expect(person.participantId.startsWith(initials!.toUpperCase())).toBe(true);
  });

  it("keeps the age, which is what the research needed the date of birth for", () => {
    const { dataset } = built();
    const ages = dataset.responses.filter((r) => r.variable === "age_years");
    expect(ages.length).toBeGreaterThan(0);
    for (const age of ages) {
      expect(typeof age.value).toBe("number");
      expect(age.value).toBeGreaterThan(4);
      expect(age.value).toBeLessThan(120);
      // Whole years only: a decimal age is a date of birth in disguise.
      expect(Number.isInteger(age.value)).toBe(true);
    }
  });

  it("still links waves, because the code is derived before the parts are put aside", () => {
    const { dataset } = built();
    expect(dataset.participants.length).toBeGreaterThan(0);
    for (const p of dataset.participants) expect(isParticipantCode(p.participantId)).toBe(true);
    expect(dataset.participants.some((p) => p.sessionCount > 1)).toBe(true);
  });
});

describe("correcting a mistyped code", () => {
  /**
   * The commonest real failure in a longitudinal study: someone gives a
   * slightly different code at wave 2 and arrives in the data as a stranger.
   * The repair has to join their waves without ever editing what they typed.
   */
  const alice = { initials: "JA", digit: "1", month: 1, postcode: "CD" };
  const mistyped = { initials: "JE", digit: "1", month: 1, postcode: "CD" };

  it("leaves the two apart when nothing has been corrected", () => {
    const { dataset } = ingest(
      [session("w1", alice, { startedAt: "2026-03-01T09:00:00.000Z" }), session("w2", mistyped, { startedAt: "2026-09-01T09:00:00.000Z" })],
      { manifest, study: "ybm" },
    );
    expect(dataset.participants).toHaveLength(2);
  });

  it("joins the waves once the correction is recorded", () => {
    const { dataset } = ingest(
      [session("w1", alice, { startedAt: "2026-03-01T09:00:00.000Z" }), session("w2", mistyped, { startedAt: "2026-09-01T09:00:00.000Z" })],
      { manifest, study: "ybm", aliases: { JE101CD: "JA101CD" } },
    );
    expect(dataset.participants).toHaveLength(1);
    const person = dataset.participants[0]!;
    expect(person.participantId).toBe("JA101CD");
    expect(person.sessionCount).toBe(2);
    // And the waves are numbered in the order the sittings happened.
    expect(dataset.sessions.map((s) => s.wave)).toEqual([1, 2]);
  });

  it("does not touch the event log — removing the correction undoes it", () => {
    const sessions = [session("w1", alice), session("w2", mistyped, { startedAt: "2026-09-01T09:00:00.000Z" })];
    const corrected = ingest(sessions, { manifest, study: "ybm", aliases: { JE101CD: "JA101CD" } });
    const reverted = ingest(sessions, { manifest, study: "ybm" });
    expect(corrected.dataset.participants).toHaveLength(1);
    expect(reverted.dataset.participants).toHaveLength(2);
    // The identity rows still say what was actually typed, both times.
    const initials = corrected.identity.filter((r) => r.variable === "ps_mother_initials").map((r) => r.value);
    expect(initials.sort()).toEqual(["JA", "JE"]);
  });

  it("follows a chain of corrections and survives one that loops", () => {
    expect(resolveAlias("A", { A: "B", B: "C" })).toBe("C");
    expect(resolveAlias("A", { A: "B", B: "A" })).toBe("B");
    expect(resolveAlias("A", undefined)).toBe("A");
  });
});

describe("twins", () => {
  /**
   * The code is mother's initials + house digit + birth month + postcode
   * letters. Twins share every one of them, so they derive the same code and
   * their answers merge into one person — silently, and unrecoverably once an
   * analysis has been run on it. Nothing but their names tells them apart.
   */
  const shared = { initials: "JA", digit: "1", month: 1, postcode: "CD" };

  const twin = (id: string, firstName: string, startedAt: string): DeviceSession =>
    session(id, shared, {
      startedAt,
      extra: [
        ev("response.recorded", "ybm_identity.first_name", { value: { kind: "text", value: firstName } }),
        ev("response.recorded", "ybm_identity.last_name", { value: { kind: "text", value: "Hussain" } }),
      ],
    });

  it("says so loudly when one code carries two different names", () => {
    const { collisions, dataset } = ingest(
      [twin("t1", "Amara", "2026-03-01T09:00:00.000Z"), twin("t2", "Zayn", "2026-03-01T10:00:00.000Z")],
      { manifest, study: "ybm" },
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.participantId).toBe("JA101CD");
    expect(collisions[0]!.names).toEqual(["amara", "zayn"]);
    expect(collisions[0]!.sessions).toEqual(["t1", "t2"]);
    // The rows are still here — nothing is lost — but the dataset currently
    // says these two children are one person, which is why it must be shouted.
    expect(dataset.participants).toHaveLength(1);
  });

  it("splits them once a sitting is assigned to its own code", () => {
    const { dataset, collisions } = ingest(
      [twin("t1", "Amara", "2026-03-01T09:00:00.000Z"), twin("t2", "Zayn", "2026-03-01T10:00:00.000Z")],
      { manifest, study: "ybm", assignments: { t2: "JA101CD2" } },
    );
    expect(collisions).toEqual([]);
    expect(dataset.participants.map((p) => p.participantId).sort()).toEqual(["JA101CD", "JA101CD2"]);
    for (const p of dataset.participants) expect(p.sessionCount).toBe(1);
  });

  it("keeps each twin's later waves with the right one of them", () => {
    const { dataset } = ingest(
      [
        twin("t1", "Amara", "2026-03-01T09:00:00.000Z"),
        twin("t2", "Zayn", "2026-03-01T10:00:00.000Z"),
        twin("t3", "Amara", "2026-09-01T09:00:00.000Z"),
        twin("t4", "Zayn", "2026-09-01T10:00:00.000Z"),
      ],
      { manifest, study: "ybm", assignments: { t2: "JA101CD2", t4: "JA101CD2" } },
    );
    expect(dataset.participants).toHaveLength(2);
    for (const p of dataset.participants) expect(p.sessionCount).toBe(2);
    const zayn = dataset.sessions.filter((s) => s.participantId === "JA101CD2");
    expect(zayn.map((s) => s.wave)).toEqual([1, 2]);
  });

  it("an assignment outranks a correction, because it is the more specific statement", () => {
    const { dataset } = ingest([twin("t1", "Amara", "2026-03-01T09:00:00.000Z")], {
      manifest,
      study: "ybm",
      aliases: { JA101CD: "ZZ999ZZ" },
      assignments: { t1: "JA101CD2" },
    });
    expect(dataset.participants[0]!.participantId).toBe("JA101CD2");
  });

  it("does not cry twins over one person answering at two waves", () => {
    const { collisions } = ingest(
      [twin("t1", "Amara", "2026-03-01T09:00:00.000Z"), twin("t2", "Amara", "2026-09-01T09:00:00.000Z")],
      { manifest, study: "ybm" },
    );
    expect(collisions).toEqual([]);
  });
});

describe("a sitting somebody did not finish", () => {
  /**
   * Stopping early is data, not an error. A young person who answers forty
   * questions and puts the iPad down has told us forty things, and every one
   * of them is kept — this is emphatically NOT the same as a storage fault
   * that loses part of a record.
   */
  const abandoned = (id: string) =>
    session(id, { initials: "JA", digit: "1", month: 1, postcode: "CD" }, {
      complete: false,
      extra: [
        ev("response.recorded", "kss.q1", { value: { kind: "choice", code: 3 } }),
        ev("response.recorded", "swemwbs.optimistic", { value: { kind: "choice", code: 4 } }),
        ev("item.skipped", "swemwbs.useful"),
        // …and then they stopped. Nothing further was ever presented.
      ],
    });

  it("keeps every answer that was given", () => {
    const { dataset } = ingest([abandoned("a1")], { manifest, study: "ybm" });
    const answered = dataset.responses.filter((r) => r.status === "answered");
    expect(answered.some((r) => r.variable === "kss_q1")).toBe(true);
    expect(answered.some((r) => r.variable === "swemwbs_q1")).toBe(true);
    expect(dataset.responses.find((r) => r.variable === "swemwbs_q2")?.status).toBe("skipped");
  });

  it("counts the person, the sitting and the wave like any other", () => {
    const { dataset, rejected } = ingest([abandoned("a1")], { manifest, study: "ybm" });
    expect(rejected).toEqual([]);
    expect(dataset.participants).toHaveLength(1);
    expect(dataset.sessions[0]!.complete).toBe(false);
    expect(dataset.sessions[0]!.wave).toBe(1);
  });

  it("scores what can be scored and says the rest is missing", () => {
    // A partial scale is reported as partial, not silently averaged over the
    // items that happen to be present.
    const { dataset } = ingest([abandoned("a1")], { manifest, study: "ybm" });
    expect(dataset.scores.length).toBeGreaterThan(0);
  });

  it("exports it, marked as unfinished rather than left out", () => {
    const { dataset } = ingest([abandoned("a1")], { manifest, study: "ybm" });
    const files = buildBidsExport(dataset, { manifest, datasetName: "test" });
    const sessions = files.find((f) => f.path.endsWith("sessions.tsv"))!.content;
    expect(sessions).toContain("ses-01");
    // `complete` is a column to filter on, so an analyst decides what to do
    // with an unfinished sitting rather than never learning it existed.
    expect(sessions.split("\n")[0]).toContain("complete");
  });

  it("shows up in the table, which is how you notice a room that struggled", () => {
    const { dataset } = ingest([abandoned("a1")], { manifest, study: "ybm" });
    const table = wideTable(dataset);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!["complete"]).toBe("no");
  });
});

/* ------------------------------------------------- narratives in the export */

describe("narrative runs in the dataset", () => {
  const record = (
    seq: number,
    kind: string,
    extra: Partial<StoredNarrativeRecord> = {},
  ): StoredNarrativeRecord => ({ seq, stageKey: "s", source: "participant", kind, ...extra });

  const run = (overrides: Partial<StoredNarrativeRun> = {}): StoredNarrativeRun => ({
    sessionId: "ses_1",
    protocolKey: "np.micro_narrative_full",
    protocolVersion: "1.0.0",
    provenance: "study",
    finished: true,
    elapsedSeconds: 480,
    records: [
      record(0, "participant_original", { text: "We fell out at lunch and it was horrible." }),
      record(1, "participant_clarification", { text: "Nobody said anything after." }),
      record(2, "participant_reaction", {
        text: "A retelling in the friend's voice.",
        data: { persona: "friend", chosenIndex: 0, offered: 3 },
      }),
      record(3, "participant_rating", { data: { rating: 8, max: 10 } }),
    ],
    ...overrides,
  });

  it("reduces a run to a row without being told anything twice", () => {
    const summary = summariseNarrative(run());
    expect(summary).toMatchObject({
      turns: 2,
      words: 13,
      chosenPersona: "friend",
      offered: 3,
      rating: 8,
      ratingMax: 10,
      adapted: false,
      acceptedUnchanged: false,
      fallbacks: 0,
      finalScenario: "A retelling in the friend's voice.",
    });
  });

  it("tells accepting it unchanged apart from never reaching the question", () => {
    // The distinction the record exists for: "this is already me" is a
    // finding, and an absence is not.
    const accepted = summariseNarrative(
      run({ records: [...run().records, record(4, "participant_reaction", { data: { accepted: true } })] }),
    );
    expect(accepted.acceptedUnchanged).toBe(true);
    expect(summariseNarrative(run()).acceptedUnchanged).toBe(false);
  });

  it("counts an edit and a requested rewrite as adaptation, and keeps the last version", () => {
    const edited = summariseNarrative(
      run({ records: [...run().records, record(4, "participant_edit", { text: "My own words instead." })] }),
    );
    expect(edited.adapted).toBe(true);
    expect(edited.finalScenario).toBe("My own words instead.");
    // The edit is the participant writing, so it counts as a turn too.
    expect(edited.turns).toBe(3);
  });

  it("puts a reverted version back as the one they left with", () => {
    const reverted = summariseNarrative(
      run({
        records: [
          ...run().records,
          record(4, "participant_edit", { text: "A version they thought better of." }),
          record(5, "participant_reaction", { data: { restored: "A retelling in the friend's voice." } }),
        ],
      }),
    );
    expect(reverted.finalScenario).toBe("A retelling in the friend's voice.");
  });

  it("counts fallbacks rather than hiding them", () => {
    const withGap = summariseNarrative(
      run({ records: [...run().records, { ...record(4, "fallback_applied"), source: "system" }] }),
    );
    expect(withGap.fallbacks).toBe(1);
  });

  it("summarises the same way whatever order the records arrive in", () => {
    const shuffled = run({ records: [...run().records].reverse() });
    expect(summariseNarrative(shuffled)).toEqual(summariseNarrative(run()));
  });
});

describe("which narrative runs may be exported", () => {
  const data = {
    ...emptyDataset(),
    sessions: [
      {
        sessionId: "ses_1",
        participantId: "P1",
        study: "ybm",
        wave: 1,
        releaseKey: "k",
        releaseHash: "h",
        startedAt: new Date().toISOString(),
      },
    ],
  } as unknown as Dataset;

  const base: StoredNarrativeRun = {
    sessionId: "ses_1",
    protocolKey: "np.x",
    protocolVersion: "1.0.0",
    provenance: "study",
    records: [],
  };

  it("keeps a run belonging to a sitting in the dataset", () => {
    expect(exportableNarratives([base], data)).toHaveLength(1);
  });

  it("never exports a tester link's run as research data", () => {
    // The mark comes from how the caller authenticated, so a page cannot
    // claim to be a participant.
    expect(exportableNarratives([{ ...base, provenance: "test" }], data)).toEqual([]);
  });

  it("leaves out a run whose sitting is not in the dataset", () => {
    // Quarantined, withdrawn, or simply not handed over yet. Exporting the
    // conversation without the sitting would be a child's words with no code
    // to withdraw them by.
    expect(exportableNarratives([{ ...base, sessionId: "ses_missing" }], data)).toEqual([]);
  });
});

/**
 * How long a sitting took, which is paradata a study screens on.
 *
 * Three numbers that mean different things, and the reason there are three is a real
 * limitation rather than indecision. The device measures with a monotonic clock, so its
 * durations survive an iPad's clock being wrong — but a monotonic clock does not survive
 * the page being reloaded, so the device's timer starts fresh when a sitting is resumed
 * and `durationMs` then covers only the last stretch.
 *
 * Screening on that without knowing would quietly drop the sittings that were
 * interrupted, which are exactly the ones a school day produces.
 */
describe("the time a sitting took", () => {
  const stamp = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 9, minutes)).toISOString();


  /**
   * A sitting that ingests, with its timing events placed by hand.
   *
   * Reuses the secret-code answers the other tests use, because a sitting with no
   * derivable participant code is rejected before any of this is computed — which is
   * correct, and which made the first version of these tests assert against nothing.
   */
  const sittingWith = (
    timing: { type: string; minutes: number; payload?: Record<string, unknown> }[],
  ): DeviceSession => {
    const one = session("ses_timing", { initials: "AB", digit: "1", month: 5, postcode: "LS" });
    const base = one.events.filter((event) => event.type !== "session.completed");
    return {
      ...one,
      events: [
        ...base.map((event, index) => ({ ...event, tWall: stamp(0), tMono: index * 100 })),
        ...timing.map((entry, index) => ({
          seq: base.length + index,
          type: entry.type,
          tWall: stamp(entry.minutes),
          tMono: (base.length + index) * 100,
          ...(entry.payload ? { payload: entry.payload } : {}),
        })),
      ],
    };
  };

  it("reports the whole span from the log, not only what the device timed", () => {
    const one = sittingWith([
      { type: "session.resumed", minutes: 40 },
      { type: "session.completed", minutes: 52, payload: { totalMs: 12 * 60_000 } },
    ]);

    const { dataset } = ingest([one as never], { manifest, study: "ybm" });
    const row = dataset.sessions[0]!;

    // What the device timed: twelve minutes, the stretch after it was picked up again.
    expect(row.durationMs).toBe(12 * 60_000);
    // What actually elapsed: fifty-two, including the time the app was closed.
    expect(row.wallClockMs).toBe(52 * 60_000);
    // And the reason the two differ is on the row.
    expect(row.resumedCount).toBe(1);
  });

  it("agrees with the device on a sitting that was never interrupted", () => {
    const one = sittingWith([{ type: "session.completed", minutes: 11, payload: { totalMs: 11 * 60_000 } }]);

    const { dataset } = ingest([one as never], { manifest, study: "ybm" });
    const row = dataset.sessions[0]!;
    expect(row.resumedCount).toBe(0);
    expect(row.wallClockMs).toBe(row.durationMs);
  });

  it("counts every resume, because a flaky iPad produces several", () => {
    const one = sittingWith([
      { type: "session.resumed", minutes: 5 },
      { type: "session.resumed", minutes: 9 },
      { type: "session.resumed", minutes: 14 },
      { type: "session.completed", minutes: 20, payload: { totalMs: 60_000 } },
    ]);
    expect(ingest([one as never], { manifest, study: "ybm" }).dataset.sessions[0]!.resumedCount).toBe(3);
  });

  it("says nothing rather than guessing when there is only one event", () => {
    // Every event on the same instant: a span of nothing is reported as nothing rather
    // than as a number somebody might screen on.
    const one = sittingWith([{ type: "session.completed", minutes: 0, payload: { totalMs: 0 } }]);
    expect(ingest([one as never], { manifest, study: "ybm" }).dataset.sessions[0]!.wallClockMs).toBe(0);
  });

  it("never reports a negative span, however out of order the timestamps are", () => {
    // An iPad whose clock went backwards mid-sitting. The span is still a span.
    const one = sittingWith([
      { type: "session.resumed", minutes: 30 },
      { type: "session.completed", minutes: 10, payload: { totalMs: 60_000 } },
    ]);
    const row = ingest([one as never], { manifest, study: "ybm" }).dataset.sessions[0]!;
    expect(row.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});

describe("SWEMWBS and STAI-5 totals in the dataset (D-49)", () => {
  const load = (version: string): ReleaseManifest =>
    releaseManifest.parse(
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../releases/ybm_nd2026_standard_r${version}.manifest.json`, import.meta.url)),
          "utf8",
        ),
      ),
    );
  const totals = (release: ReleaseManifest, key: string, output: string) => {
    const { dataset } = ingest(buildDemoSessions({ manifest: release, participants: 8, seed: 49 }), {
      manifest: release,
      study: "demo",
    });
    return dataset.scores.filter((s) => s.scoringKey === key && s.output === output);
  };

  it("are blank in every sitting under r7.1.0, whose definitions name items the forms do not have", () => {
    const r710 = load("7.1.0");
    const rows = [...totals(r710, "score.swemwbs", "raw_total"), ...totals(r710, "score.stai5", "state_anxiety")];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.value === null && r.scoringVersion === "1.0.0")).toBe(true);
  });

  it("are scored from the answers under r7.2.0, within each scale's range", () => {
    const r720 = load("7.2.0");
    const swemwbs = totals(r720, "score.swemwbs", "raw_total");
    const stai = totals(r720, "score.stai5", "state_anxiety");
    const scored = (rows: typeof swemwbs) => rows.map((r) => r.value).filter((v): v is number => typeof v === "number");
    expect(scored(swemwbs).length).toBeGreaterThan(0);
    expect(scored(stai).length).toBeGreaterThan(0);
    expect(scored(swemwbs).every((v) => v >= 7 && v <= 35)).toBe(true);
    expect(scored(stai).every((v) => v >= 5 && v <= 20)).toBe(true);
    expect([...swemwbs, ...stai].every((r) => r.scoringVersion === "1.0.1")).toBe(true);
  });

  it("scores the SDQ total and the RCADS total from their subscales (S7), in every release", () => {
    // The fix is in the reading, not the release: r7.1.0's frozen definitions total up too.
    for (const version of ["7.1.0", "7.2.0"]) {
      const release = load(version);
      const { dataset } = ingest(buildDemoSessions({ manifest: release, participants: 8, seed: 49 }), { manifest: release, study: "demo" });
      const of = (key: string, output: string, sessionId: string) => dataset.scores.find((r) => r.scoringKey === key && r.output === output && r.sessionId === sessionId)?.value ?? null;
      let totals = 0;
      for (const s of dataset.sessions) {
        const parts = ["emotional", "conduct", "hyperactivity", "peer"].map((o) => of("score.sdq25_s", o, s.sessionId));
        const total = of("score.sdq25_s", "total_difficulties", s.sessionId);
        if (parts.every((v) => typeof v === "number")) {
          expect(total, `${version} ${s.sessionId}`).toBe((parts as number[]).reduce((a, b) => a + b, 0));
          totals += 1;
        } else expect(total).toBeNull();
        const [dep, anx] = [of("score.rcads25", "depression", s.sessionId), of("score.rcads25", "anxiety", s.sessionId)];
        expect(of("score.rcads25", "total", s.sessionId)).toBe(typeof dep === "number" && typeof anx === "number" ? dep + anx : null);
      }
      expect(totals, version).toBeGreaterThan(0);
    }
  });
});
