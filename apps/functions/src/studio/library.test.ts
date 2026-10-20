import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { paths } from "@myself/firebase";
import {
  extractDraft,
  fragmentFromDraft,
  moduleContentHash,
  validatedFragment,
  type AuditDoc,
  type FragmentOrigin,
  type LibraryModuleVersionDoc,
  type StudioFragment,
} from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { getModule, isoOf, libraryCatalogue, listModules, saveModule, setModule } from "./library.js";

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));

/**
 * The item library's cores, against a stand-in for Firestore: documents in a
 * map, and a transaction that applies its writes only if its body finishes —
 * enough to show what each core decides and what it writes, with nothing
 * written when it refuses. The emulator suite (integration/library) runs the
 * same cores against a real database and through the callables.
 */

type Data = Record<string, unknown>;
let docs: Map<string, Data>;
let autoId: number;

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    id: path.slice(path.lastIndexOf("/") + 1),
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
    get: (field: string) => field.split(".").reduce<unknown>((v, k) => (v as Data | undefined)?.[k], data),
  };
}

function children(collection: string) {
  const prefix = `${collection}/`;
  return [...docs.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")).sort();
}

const query = (collection: string) => ({
  get: async () => {
    const found = children(collection).map(snapshot);
    return { docs: found, empty: found.length === 0, size: found.length };
  },
});

interface Ref {
  path: string;
  get: () => Promise<ReturnType<typeof snapshot>>;
}

const db = {
  doc: (path: string): Ref => ({ path, get: async () => snapshot(path) }),
  collection: (path: string) => ({
    ...query(path),
    select: () => query(path),
    doc: () => ({ path: `${path}/auto_${++autoId}` }),
  }),
  getAll: async (...refs: Ref[]) => refs.map((r) => snapshot(r.path)),
  runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
    const writes: (() => void)[] = [];
    const tx = {
      get: async (ref: Ref) => snapshot(ref.path),
      getAll: async (...refs: Ref[]) => refs.map((r) => snapshot(r.path)),
      create: (ref: Ref, data: Data) => {
        if (docs.has(ref.path)) throw new Error(`already exists: ${ref.path}`);
        writes.push(() => docs.set(ref.path, structuredClone(data)));
      },
      update: (ref: Ref, data: Data) => {
        if (!docs.has(ref.path)) throw new Error(`no document to update: ${ref.path}`);
        writes.push(() => docs.set(ref.path, { ...docs.get(ref.path), ...structuredClone(data) }));
      },
    };
    const result = await body(tx);
    for (const write of writes) write();
    return result;
  },
} as unknown as Firestore;

const STUDY = "ybm";
const ED = { uid: "u_ed", email: "ed.editor@example.org" };
const EVE = { uid: "u_eve", email: "eve.editor@example.org" };
const R800 = bundledManifests.find((b) => b.manifest.release.version === "8.0.0")!;
const FROM: FragmentOrigin = { kind: "release", study: STUDY, surveyId: "ybm_nd2026_standard", version: "8.0.0", hash: R800.manifest.hash! };
const gaming = (): StudioFragment => fragmentFromDraft(extractDraft(R800.raw), { kind: "block", sectionKey: "gaming", componentIndex: 0 }, FROM);
const timestamp = (iso: string) => ({ toDate: () => new Date(iso) });

async function refusal(promise: Promise<unknown>): Promise<HttpsError> {
  const before = JSON.stringify([...docs]);
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) {
      expect(JSON.stringify([...docs]), "a refusal wrote something").toBe(before);
      return error;
    }
    throw error;
  }
  throw new Error("that was accepted, and it should not have been");
}

const audit = () =>
  [...docs.entries()].filter(([p]) => p.startsWith(`${paths.studioAudit(STUDY)}/`)).map(([, d]) => d as unknown as AuditDoc);

const save = (overrides: Partial<Parameters<typeof saveModule>[1]> = {}) =>
  saveModule(db, {
    study: STUDY,
    surveyId: "ybm_nd2026_standard",
    draftRevision: 7,
    create: { moduleId: "gaming_habits", title: "Gaming habits", description: "How much and what young people play.", tags: ["gaming", "screen time"] },
    note: "First version.",
    fragment: gaming(),
    actor: ED,
    ...overrides,
  });

beforeEach(() => {
  docs = new Map();
  autoId = 0;
  docs.set(paths.studioSurvey(STUDY, "ybm_nd2026_standard"), { surveyId: "ybm_nd2026_standard", study: STUDY, title: "YBM" });
});

describe("saving a module", () => {
  it("writes the immutable version, the module and the audit row in the saving study", async () => {
    const saved = await save();
    expect(saved).toMatchObject({ moduleId: "gaming_habits", version: 1 });
    const version = docs.get(paths.studioLibraryVersion("gaming_habits", 1)) as unknown as LibraryModuleVersionDoc;
    expect(version).toMatchObject({ moduleId: "gaming_habits", version: 1, note: "First version.", questionCount: 8, savedBy: ED.uid, savedByEmail: ED.email });
    expect(version.source).toEqual({ study: STUDY, surveyId: "ybm_nd2026_standard", draftRevision: 7 });
    expect(await moduleContentHash(version.content)).toBe(saved.contentHash);
    expect(version.contentHash).toBe(saved.contentHash);
    expect(docs.get(paths.studioLibraryModule("gaming_habits"))).toMatchObject({
      title: "Gaming habits",
      tags: ["gaming", "screen time"],
      latestVersion: 1,
      retired: false,
      createdBy: ED.uid,
      createdByEmail: ED.email,
    });
    expect(audit()).toMatchObject([{ action: "library.module_saved", actor: ED.uid, subject: "gaming_habits", detail: { version: 1, created: true } }]);
  });

  it("saves the next version only from the latest, and says who got there first", async () => {
    await save();
    const second = await save({ create: null, moduleId: "gaming_habits", baseVersion: 1, note: "Clearer wording.", actor: EVE });
    expect(second.version).toBe(2);
    expect(docs.get(paths.studioLibraryModule("gaming_habits"))).toMatchObject({ latestVersion: 2, updatedBy: EVE.uid, createdBy: ED.uid });
    const stale = await refusal(save({ create: null, moduleId: "gaming_habits", baseVersion: 1, note: "Mine." }));
    expect(stale.code).toBe("aborted");
    expect(stale.details).toEqual({ kind: "conflict", currentRevision: 2 });
    expect(stale.message).toMatch(/newer version of “Gaming habits” \(version 2\)/);
  });

  it("refuses a taken ID, an unknown module or survey, and a retired module", async () => {
    await save();
    expect((await refusal(save())).code).toBe("already-exists");
    expect((await refusal(save({ create: null, moduleId: "nothing_here", baseVersion: 1 }))).code).toBe("not-found");
    expect((await refusal(save({ surveyId: "not_a_survey", create: { moduleId: "other", title: "O", description: "", tags: [] } }))).code).toBe("not-found");
    docs.set(paths.studioLibraryModule("gaming_habits"), { ...docs.get(paths.studioLibraryModule("gaming_habits")), retired: true });
    const retired = await refusal(save({ create: null, moduleId: "gaming_habits", baseVersion: 1 }));
    expect(retired.details).toMatchObject({ issues: [{ code: "library.module_retired" }] });
  });

  it("saves a licensed questionnaire as the library's own copy (a variant)", async () => {
    const saved = await save({ fragment: validatedFragment("kss@1.0/en-GB/self/standard") });
    expect(saved.contentHash).toMatch(/^sha256:/);
  });

  it("refuses protected or malformed content before reading anything", async () => {
    const identity = fragmentFromDraft(extractDraft(R800.raw), { kind: "block", sectionKey: "about_you", componentIndex: 0 }, FROM);
    expect((await refusal(save({ fragment: identity }))).details).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: "piece.protected" })]) });
    expect((await refusal(save({ fragment: { format: "nonsense" } }))).details).toMatchObject({ issues: [{ code: "piece.malformed" }] });
  });
});

describe("reading modules", () => {
  it("hands a version out with its hash in its origin, and every version newest first", async () => {
    const one = await save();
    const two = await save({ create: null, moduleId: "gaming_habits", baseVersion: 1, note: "Second." });
    const latest = await getModule(db, { moduleId: "gaming_habits" });
    expect(latest.version).toMatchObject({ version: 2, note: "Second.", contentHash: two.contentHash, questionCount: 8 });
    expect(latest.version.fragment.origin).toEqual({ kind: "module", moduleId: "gaming_habits", version: 2, contentHash: two.contentHash });
    expect(latest.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(latest.module).toMatchObject({ moduleId: "gaming_habits", latestVersion: 2, contentHash: two.contentHash, questionCount: 8 });
    const first = await getModule(db, { moduleId: "gaming_habits", version: 1 });
    expect(first.version.fragment.origin).toMatchObject({ version: 1, contentHash: one.contentHash });
    expect((await refusal(getModule(db, { moduleId: "gaming_habits", version: 9 }))).code).toBe("not-found");
    expect((await refusal(getModule(db, { moduleId: "nothing_here" }))).code).toBe("not-found");
  });

  it("refuses a stored version whose content no longer matches its hash", async () => {
    await save();
    const path = paths.studioLibraryVersion("gaming_habits", 1);
    const stored = docs.get(path)!;
    docs.set(path, { ...stored, content: (stored["content"] as string).replace("hours", "minutes") });
    const error = await refusal(getModule(db, { moduleId: "gaming_habits" }));
    expect(error.details).toMatchObject({ issues: [{ code: "library.version_unreadable" }] });
  });

  it("lists the shelf by title, leaving retired modules off unless asked", async () => {
    await save();
    await save({ create: { moduleId: "a_screen", title: "A screen time module", description: "", tags: [] } });
    expect((await listModules(db)).modules.map((m) => m.moduleId)).toEqual(["a_screen", "gaming_habits"]);
    await setModule(db, { study: STUDY, moduleId: "a_screen", retired: true, actor: { ...ED, owner: false } });
    expect((await listModules(db)).modules.map((m) => m.moduleId)).toEqual(["gaming_habits"]);
    const all = await listModules(db, { includeRetired: true });
    expect(all.modules.find((m) => m.moduleId === "a_screen")).toMatchObject({ retired: true, questionCount: 8, latestVersion: 1 });
  });
});

describe("describing and retiring a module", () => {
  beforeEach(async () => {
    await save();
  });

  it("lets any editor describe it, auditing what changed, and writes nothing for no change", async () => {
    const { module } = await setModule(db, { study: STUDY, moduleId: "gaming_habits", title: "Gaming", tags: ["games"], actor: { ...EVE, owner: false } });
    expect(module).toMatchObject({ title: "Gaming", tags: ["games"], description: "How much and what young people play." });
    expect(audit().filter((r) => r.action === "library.module_changed")).toMatchObject([
      { actor: EVE.uid, subject: "gaming_habits", detail: { changes: { title: { from: "Gaming habits", to: "Gaming" }, tags: { from: ["gaming", "screen time"], to: ["games"] } } } },
    ]);
    const rows = audit().length;
    await setModule(db, { study: STUDY, moduleId: "gaming_habits", title: "Gaming", actor: { ...EVE, owner: false } });
    expect(audit()).toHaveLength(rows);
  });

  it("keeps retiring for whoever first saved it, or an owner", async () => {
    const other = await refusal(setModule(db, { study: STUDY, moduleId: "gaming_habits", retired: true, actor: { ...EVE, owner: false } }));
    expect(other.code).toBe("permission-denied");
    await setModule(db, { study: STUDY, moduleId: "gaming_habits", retired: true, actor: { ...ED, owner: false } });
    expect(docs.get(paths.studioLibraryModule("gaming_habits"))).toMatchObject({ retired: true });
    await setModule(db, { study: STUDY, moduleId: "gaming_habits", retired: false, actor: { uid: "u_owner", email: "owner@leeds.test", owner: true } });
    expect(docs.get(paths.studioLibraryModule("gaming_habits"))).toMatchObject({ retired: false });
    // Its versions are untouched either way.
    expect(docs.has(paths.studioLibraryVersion("gaming_habits", 1))).toBe(true);
    expect((await refusal(setModule(db, { study: STUDY, moduleId: "nothing_here", title: "X", actor: { ...ED, owner: false } }))).code).toBe("not-found");
  });
});

describe("the published-surveys shelf", () => {
  it("lists every registered study's published versions, newest first, live marked, and no unpublished survey", async () => {
    docs.set(paths.study("future"), { study: "future", title: "Perspectives of the future", status: "open" });
    docs.set(paths.studioSurvey(STUDY, "ybm_nd2026_standard"), { title: "Yorkshire Brain Map", active: { version: "9.0.0" } });
    for (const [v, at] of [["9.0.0", "2026-09-01T00:00:00.000Z"], ["10.0.0", "2026-10-01T00:00:00.000Z"], ["8.0.0", "2026-08-01T00:00:00.000Z"]] as const) {
      docs.set(paths.studioVersion(STUDY, "ybm_nd2026_standard", v), { version: v, hash: `sha256:${v}`, publishedAt: timestamp(at) });
    }
    docs.set(paths.studioSurvey(STUDY, "unpublished"), { title: "Only a draft", active: null });
    docs.set(paths.studioDraft(STUDY, "unpublished"), { content: "never read" });
    docs.set(paths.studioSurvey("future", "future_main"), { title: "Future", active: { version: "1.0.0" } });
    docs.set(paths.studioVersion("future", "future_main", "1.0.0"), { version: "1.0.0", hash: "sha256:f", publishedAt: "2026-10-05T00:00:00.000Z" });

    const { studies } = await libraryCatalogue(db, { defaultStudy: STUDY });
    expect(studies.map((s) => [s.study, s.title, s.status])).toEqual([
      [STUDY, STUDY, "open"],
      ["future", "Perspectives of the future", "open"],
    ]);
    expect(studies[0]!.surveys).toEqual([
      {
        surveyId: "ybm_nd2026_standard",
        title: "Yorkshire Brain Map",
        live: "9.0.0",
        versions: [
          { version: "10.0.0", hash: "sha256:10.0.0", publishedAt: "2026-10-01T00:00:00.000Z" },
          { version: "9.0.0", hash: "sha256:9.0.0", publishedAt: "2026-09-01T00:00:00.000Z" },
          { version: "8.0.0", hash: "sha256:8.0.0", publishedAt: "2026-08-01T00:00:00.000Z" },
        ],
      },
    ]);
    expect(studies[1]!.surveys).toMatchObject([{ surveyId: "future_main", live: "1.0.0", versions: [{ version: "1.0.0", publishedAt: "2026-10-05T00:00:00.000Z" }] }]);
  });

  it("reads times however they were stored", () => {
    expect(isoOf("2026-10-06T12:00:00.000Z")).toBe("2026-10-06T12:00:00.000Z");
    expect(isoOf(timestamp("2026-10-06T12:00:00.000Z"))).toBe("2026-10-06T12:00:00.000Z");
    expect(isoOf({ seconds: 1, nanoseconds: 500_000_000 })).toBe("1970-01-01T00:00:01.500Z");
    expect(isoOf(null)).toBe("");
  });
});
