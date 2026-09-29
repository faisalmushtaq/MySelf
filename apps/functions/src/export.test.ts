import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { paths, splitSession } from "@myself/firebase";
import { contentHashAsync, hashHex, type ReleaseManifest } from "@myself/schema";
import { buildDemoSessions, type DeviceSession } from "@myself/store";
import { buildStudyDataset, datasetManifest, exportFiles } from "./export.js";
import { bundledManifests, latestRelease, releaseResolver, releasesByHash } from "./releases.js";

/**
 * The nightly export, and the one rule it used to break.
 *
 * Sittings are read through the release their hash names. A hash the bundle
 * does not know used to be read through the latest release instead — every
 * answer decoded against questions and codes it was never collected under,
 * into files that looked complete. These tests hold the replacement: the
 * release store is consulted, and a hash nobody knows is left out, logged and
 * listed in the export itself.
 */

vi.mock("firebase-functions/logger", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  write: vi.fn(),
}));

const STUDY = "ybm";
const UNKNOWN = `sha256:${"e".repeat(64)}`;

type Raw = Record<string, unknown> & { release: Record<string, unknown>; hash?: string };

/** r7.1.0's content republished as r8.0.0 — held only by the release store. */
async function studioRelease(): Promise<{ raw: Raw; hash: string }> {
  const live = bundledManifests.find((b) => b.manifest.release.version === "7.1.0")!;
  const body = structuredClone(live.raw) as Raw;
  delete body.hash;
  body.release = { ...body.release, version: "8.0.0", key: "ybm_nd2026_standard_r8_0_0" };
  const hash = await contentHashAsync(body);
  return { raw: { ...body, hash }, hash };
}

/** A path-keyed Firestore: documents by path, collections by prefix. */
function fakeDb() {
  const docs = new Map<string, unknown>();
  const snapshot = (path: string) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const db = {
    doc: (path: string) => ({ get: async () => snapshot(path) }),
    collection: (path: string) => ({
      get: async () => ({
        docs: [...docs.keys()]
          .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
          .map((p) => ({ id: p.slice(path.length + 1), data: () => docs.get(p) })),
      }),
    }),
  } as unknown as Firestore;
  const file = (s: DeviceSession) => {
    const split = splitSession(s, "ipad_a", STUDY);
    docs.set(paths.session(STUDY, s.sessionId), split.doc);
    for (const chunk of split.chunks) docs.set(paths.sessionChunk(STUDY, s.sessionId, chunk.index), chunk);
  };
  return { db, docs, file };
}

const live = latestRelease!;
const sittings = buildDemoSessions({ manifest: live, participants: 3 });
const under = (s: DeviceSession, hash: string, id: string): DeviceSession => ({ ...s, sessionId: id, releaseHash: hash });

beforeEach(() => {
  vi.mocked(logger.error).mockClear();
});

describe("the export's releases", () => {
  it("leaves out and lists a sitting whose release nobody knows, never reading it through the latest", async () => {
    const { db, file } = fakeDb();
    for (const s of sittings) file(s);
    const lost = under(sittings[0]!, UNKNOWN, "ses_unknown_release");
    file(lost);

    const built = await buildStudyDataset(STUDY, db, releaseResolver());

    expect(built.unreadable).toEqual([{ sessionId: "ses_unknown_release", releaseHash: UNKNOWN }]);
    expect(built.dataset.sessions.map((s) => s.sessionId)).not.toContain("ses_unknown_release");
    expect(built.dataset.responses.some((r) => r.sessionId === "ses_unknown_release")).toBe(false);
    expect(built.dataset.releaseHashes).not.toContain(UNKNOWN);
    // The rest of the study is still exported: one unknown release does not
    // take the others down with it.
    expect(built.dataset.sessions).toHaveLength(sittings.length);
    expect(built.sittings).toBe(sittings.length + 1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/unknown release/),
      expect.objectContaining({ releaseHash: UNKNOWN, sittings: 1 }),
    );
  });

  it("writes the left-out sittings into the export beside the data", async () => {
    const { db, file } = fakeDb();
    for (const s of sittings) file(s);
    file(under(sittings[0]!, UNKNOWN, "ses_unknown_release"));

    const files = exportFiles(await buildStudyDataset(STUDY, db, releaseResolver()), STUDY, []);
    const listed = files.find((f) => f.path === "unreadable.json");
    expect(listed).toBeDefined();
    expect(JSON.parse(listed!.content).sittings).toEqual([
      { sessionId: "ses_unknown_release", releaseHash: UNKNOWN },
    ]);
    // Review fix: a top-level file BIDS does not define fails validation
    // unless the dataset's .bidsignore names it; the existing line stays.
    const ignore = files.find((f) => f.path === ".bidsignore")!.content.split("\n");
    expect(ignore).toContain("unreadable.json");
    expect(ignore[0]).toMatch(/^# Survey-only dataset/);
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)));
  });

  it("reads a sitting under a release only the store holds through that release", async () => {
    const { raw, hash } = await studioRelease();
    const { db, docs, file } = fakeDb();
    docs.set(paths.publicRelease(STUDY, hashHex(hash)), { hash, manifest: JSON.stringify(raw) });
    for (const s of sittings) file(s);
    file(under(sittings[0]!, hash, "ses_under_r8"));

    const built = await buildStudyDataset(STUDY, db, releaseResolver());

    expect(built.unreadable).toEqual([]);
    expect(built.dataset.sessions.map((s) => s.sessionId)).toContain("ses_under_r8");
    expect(built.dataset.releaseHashes).toContain(hash);
    expect(built.releases.map((r) => r.release.version).sort()).toEqual(["7.3.0", "8.0.0"]);

    // The dataset-level files describe the newest release the export holds.
    const files = exportFiles(built, STUDY, []);
    const description = JSON.parse(files.find((f) => f.path === "dataset_description.json")!.content);
    expect(description.SourceDatasets[0].ReleaseVersion).toBe("8.0.0");
    expect(description.SourceDatasets[0].ReleaseHash).toBe(hash);
  });

  it("does not use a store document that fails verification, and lists its sittings", async () => {
    const { raw, hash } = await studioRelease();
    (raw.release as Record<string, unknown>)["publishedBy"] = "somebody else";
    const { db, docs, file } = fakeDb();
    docs.set(paths.publicRelease(STUDY, hashHex(hash)), { hash, manifest: JSON.stringify(raw) });
    file(under(sittings[0]!, hash, "ses_tampered"));

    const built = await buildStudyDataset(STUDY, db, releaseResolver());
    expect(built.unreadable).toEqual([{ sessionId: "ses_tampered", releaseHash: hash }]);
    expect(built.dataset.sessions).toHaveLength(0);
  });

  it("is unchanged for a study whose releases are all bundled", async () => {
    const { db, file } = fakeDb();
    for (const s of sittings) file(s);

    const built = await buildStudyDataset(STUDY, db, releaseResolver());
    const files = exportFiles(built, STUDY, []);
    expect(built.unreadable).toEqual([]);
    expect(files.some((f) => f.path === "unreadable.json")).toBe(false);
    expect(files.find((f) => f.path === ".bidsignore")!.content).not.toMatch(/unreadable/);
    const description = JSON.parse(files.find((f) => f.path === "dataset_description.json")!.content);
    expect(description.SourceDatasets[0].ReleaseHash).toBe(live.hash);
  });
});

describe("which release the dataset-level files describe", () => {
  const byVersion = (version: string): ReleaseManifest =>
    [...releasesByHash.values()].find((m) => m.release.version === version)!;

  it("is the compiled-in latest when only older bundled releases are present", () => {
    // What it always was, so an export of an older wave does not change.
    expect(datasetManifest([byVersion("6.0.0")], live)).toBe(live);
    expect(datasetManifest([], live)).toBe(live);
  });

  it("is a newer release from the store when the export holds one", async () => {
    const { raw } = await studioRelease();
    const eight = { ...live, release: { ...live.release, version: raw.release["version"] as string } };
    expect(datasetManifest([byVersion("7.0.1"), eight], live)).toBe(eight);
  });

  it("keeps the compiled-in one on a tie", () => {
    const twin = { ...live, hash: `sha256:${"1".repeat(64)}` };
    expect(datasetManifest([twin], live)).toBe(live);
  });
});
