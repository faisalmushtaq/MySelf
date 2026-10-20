import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import {
  addQuestion,
  extractDraft,
  fragmentFromDraft,
  insertFragment,
  parseDraft,
  serialiseDraft,
  validatedFragment,
  type AuditDoc,
  type DraftDoc,
  type FragmentOrigin,
  type LibraryCatalogueResponse,
  type LibraryModuleResponse,
  type LibraryModulesResponse,
  type LibrarySaveModuleResponse,
  type StudioDraft,
  type StudioFragment,
  type VersionDoc,
} from "@myself/studio";
import { bundledManifests } from "../src/releases.js";
import {
  studioCreateSurvey,
  studioLibraryCatalogue,
  studioLibraryModule,
  studioLibraryModules,
  studioLibrarySaveModule,
  studioLibrarySetModule,
} from "../src/studio/functions.js";
import { publish } from "../src/studio/publish.js";
import { createStudy } from "../src/studio/study-spaces.js";
import { createSurvey, importLive } from "../src/studio/surveys.js";

/**
 * The item library against a real Firestore (D-57, docs/16 §12).
 *
 * What only a database shows: that a module's save is one transaction and the
 * second of two saves from one version is refused; that the shelf of
 * published surveys spans study spaces and never shows a draft; and, above
 * all, that the publish of a draft holding a copied validated questionnaire
 * reads the releases the draft names from their own studies' stores, verifies
 * them, and accepts the copy only when it matches one of them, or the
 * library, exactly — so naming a release, or a forged one, proves nothing.
 *
 * The DEFAULT app, as in the study-spaces suite: the callables reach
 * Firestore through `research()`, as deployed, and are called through their
 * own exported handlers, so the wiring and the role each needs are under test
 * as well as the cores.
 */

const YBM = "ybm";
const FUTURE = "future";
const SURVEY = "ybm_nd2026_standard";
const SDQ2 = "sdq25_s@2.0/en-GB/self/standard";
const SDQ1 = "sdq25_s@1.0/en-GB/self/standard";

const bundled = (version: string) => bundledManifests.find((b) => b.manifest.release.version === version)!;
const R800 = bundled("8.0.0");
const R730 = bundled("7.3.0");

const OWNER = { uid: "u_owner", email: "owner@leeds.test" };
const ownerToken = { role: "owner", email: OWNER.email, email_verified: true, firebase: { sign_in_provider: "google.com" } };
const googleToken = (email: string) => ({ email, email_verified: true, firebase: { sign_in_provider: "google.com" } });
const ED = { uid: "u_ed", email: "ed.editor@example.org" };
const EVE = { uid: "u_eve", email: "eve.editor@example.org" };
const VERA = { uid: "u_vera", email: "vera.viewer@example.org" };
const FAY = { uid: "u_fay", email: "fay.future@example.org" };

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" });
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const study of [YBM, FUTURE, "nowhere"]) await db.recursiveDelete(db.doc(paths.study(study)));
  await db.recursiveDelete(db.collection(paths.studioLibrary()));
  await createStudy(db, { study: FUTURE, title: "Perspectives of the future", actor: OWNER });
  await db.doc(paths.studioMember(YBM, ED.email)).set({ email: ED.email, role: "editor" });
  await db.doc(paths.studioMember(YBM, EVE.email)).set({ email: EVE.email, role: "editor" });
  await db.doc(paths.studioMember(YBM, VERA.email)).set({ email: VERA.email, role: "viewer" });
  await db.doc(paths.studioMember(FUTURE, FAY.email)).set({ email: FAY.email, role: "admin" });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** An `onCall` handler, called as the SDK would call it for this account. */
async function callAs<T>(fn: unknown, who: { uid: string; email: string } | null, data: unknown, token?: Record<string, unknown>): Promise<T> {
  const request = { data, auth: who ? { uid: who.uid, token: token ?? googleToken(who.email) } : undefined, rawRequest: {} } as unknown as CallableRequest;
  return (fn as { run: (r: CallableRequest) => Promise<T> }).run(request);
}

async function refusalOf(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) return error;
    throw error;
  }
  throw new Error("that was accepted, and it should not have been");
}

const issueCodes = (error: HttpsError) => ((error.details as { issues?: { code: string }[] }).issues ?? []).map((i) => i.code);
const exists = async (path: string) => (await db.doc(path).get()).exists;
const data = async <T>(path: string) => (await db.doc(path).get()).data() as T;

async function currentDraft(study: string, surveyId: string): Promise<{ doc: DraftDoc; draft: StudioDraft }> {
  const doc = await data<DraftDoc>(paths.studioDraft(study, surveyId));
  return { doc, draft: parseDraft(doc.content) };
}

/** An editor's save, as the Studio makes one under the rules. */
async function saveDraft(study: string, surveyId: string, draft: StudioDraft, editor = FAY): Promise<number> {
  const ref = db.doc(paths.studioDraft(study, surveyId));
  const revision = ((await ref.get()).get("revision") as number) + 1;
  await ref.update({ content: serialiseDraft(draft), revision, updatedAt: FieldValue.serverTimestamp(), updatedBy: editor.uid, updatedByEmail: editor.email });
  return revision;
}

const publishFirst = (study: string, surveyId: string, revision: number) =>
  publish(db, { study, surveyId, expectedRevision: revision, version: "1.0.0", releaseNote: "The first version.", actor: FAY });

const fromRelease = (study: string, version: string, hash: string): FragmentOrigin => ({ kind: "release", study, surveyId: SURVEY, version, hash });
const gaming = (): StudioFragment => fragmentFromDraft(extractDraft(R800.raw), { kind: "block", sectionKey: "gaming", componentIndex: 0 }, fromRelease(YBM, "8.0.0", R800.manifest.hash!));
const insertOpts = { by: FAY.uid, byEmail: FAY.email, at: "2026-10-06T12:00:00.000Z" };

/** A blank survey in `future`, ready to have pieces added. */
async function blankFuture(surveyId = "future_main"): Promise<StudioDraft> {
  await createSurvey(db, { study: FUTURE, surveyId, title: "Perspectives of the future", actor: FAY });
  return (await currentDraft(FUTURE, surveyId)).draft;
}

const setUpYbm = () => importLive(db, { study: YBM, surveyId: SURVEY, actor: OWNER });

// ── Saved modules ───────────────────────────────────────────────────────────

describe("saved modules, through the callables", () => {
  const saveRequest = (extra: Record<string, unknown> = {}) => ({
    surveyId: "pilot",
    draftRevision: 1,
    create: { moduleId: "gaming_habits", title: "Gaming habits", description: "How much, and what, young people play.", tags: ["Gaming", "screen time"] },
    note: "First version.",
    fragment: gaming(),
    ...extra,
  });

  beforeEach(async () => {
    await createSurvey(db, { study: YBM, surveyId: "pilot", title: "Pilot", actor: ED });
  });

  it("are saved by an editor, read by a viewer, and never silently overwritten", async () => {
    expect((await refusalOf(callAs(studioLibrarySaveModule, VERA, saveRequest()))).code).toBe("permission-denied");
    const one = await callAs<LibrarySaveModuleResponse>(studioLibrarySaveModule, ED, saveRequest());
    expect(one).toMatchObject({ moduleId: "gaming_habits", version: 1 });

    const shelf = await callAs<LibraryModulesResponse>(studioLibraryModules, VERA, {});
    expect(shelf.modules).toMatchObject([{ moduleId: "gaming_habits", title: "Gaming habits", tags: ["gaming", "screen time"], latestVersion: 1, questionCount: 8, contentHash: one.contentHash, createdByEmail: ED.email }]);
    const got = await callAs<LibraryModuleResponse>(studioLibraryModule, VERA, { moduleId: "gaming_habits" });
    expect(got.version.fragment.origin).toEqual({ kind: "module", moduleId: "gaming_habits", version: 1, contentHash: one.contentHash });
    expect(got.version.source).toEqual({ study: YBM, surveyId: "pilot", draftRevision: 1 });

    // Eve saves version 2 from version 1; Ed, still on version 1, is told.
    const next = { create: null, moduleId: "gaming_habits", baseVersion: 1, note: "Clearer wording." };
    expect((await callAs<LibrarySaveModuleResponse>(studioLibrarySaveModule, EVE, saveRequest(next))).version).toBe(2);
    const stale = await refusalOf(callAs(studioLibrarySaveModule, ED, saveRequest({ ...next, note: "Mine." })));
    expect(stale.code).toBe("aborted");
    expect(stale.details).toEqual({ kind: "conflict", currentRevision: 2 });
    expect(await exists(paths.studioLibraryVersion("gaming_habits", 3))).toBe(false);
    expect((await refusalOf(callAs(studioLibrarySaveModule, ED, saveRequest()))).code).toBe("already-exists");

    const rows = (await db.collection(paths.studioAudit(YBM)).where("action", "==", "library.module_saved").get()).docs.map((d) => d.data() as AuditDoc);
    expect(rows.map((r) => [r.actor, (r.detail as { version: number }).version]).sort()).toEqual([
      [ED.uid, 1],
      [EVE.uid, 2],
    ]);
  });

  it("are one shelf for every study space, saved from each study's own surveys", async () => {
    await callAs(studioLibrarySaveModule, ED, saveRequest());
    // Fay has a role in future alone: she reads the shelf from there…
    const shelf = await callAs<LibraryModulesResponse>(studioLibraryModules, FAY, { study: FUTURE });
    expect(shelf.modules.map((m) => m.moduleId)).toEqual(["gaming_habits"]);
    // …cannot save from ybm, where she is nobody…
    expect((await refusalOf(callAs(studioLibrarySaveModule, FAY, saveRequest({ create: { moduleId: "x_mod", title: "X", description: "", tags: [] } })))).code).toBe(
      "permission-denied",
    );
    // …and saves from one of future's surveys, audited in future's trail.
    await blankFuture();
    await callAs(studioLibrarySaveModule, FAY, { ...saveRequest({ create: { moduleId: "future_gaming", title: "Gaming (future)", description: "", tags: [] } }), study: FUTURE, surveyId: "future_main" });
    expect((await db.collection(paths.studioAudit(FUTURE)).where("action", "==", "library.module_saved").get()).size).toBe(1);
  });

  it("refuse the identity module, writing nothing, but save a licensed questionnaire as the library's own copy (D-64)", async () => {
    const identity = fragmentFromDraft(extractDraft(R800.raw), { kind: "block", sectionKey: "about_you", componentIndex: 0 }, fromRelease(YBM, "8.0.0", R800.manifest.hash!));
    expect(issueCodes(await refusalOf(callAs(studioLibrarySaveModule, ED, saveRequest({ fragment: identity }))))).toContain("piece.protected");
    expect((await db.collection(paths.studioLibrary()).get()).empty).toBe(true);
    await callAs(studioLibrarySaveModule, ED, saveRequest({ fragment: validatedFragment(SDQ2) }));
    expect((await db.collection(paths.studioLibrary()).get()).empty).toBe(false);
  });

  it("are retired only by whoever first saved them, or an owner, and never deleted", async () => {
    await callAs(studioLibrarySaveModule, ED, saveRequest());
    expect((await refusalOf(callAs(studioLibrarySetModule, EVE, { moduleId: "gaming_habits", retired: true }))).code).toBe("permission-denied");
    // Any editor may describe it.
    await callAs(studioLibrarySetModule, EVE, { moduleId: "gaming_habits", description: "Hours and favourite games." });
    await callAs(studioLibrarySetModule, ED, { moduleId: "gaming_habits", retired: true });
    expect((await callAs<LibraryModulesResponse>(studioLibraryModules, VERA, {})).modules).toEqual([]);
    expect((await callAs<LibraryModulesResponse>(studioLibraryModules, VERA, { includeRetired: true })).modules).toMatchObject([
      { moduleId: "gaming_habits", retired: true, description: "Hours and favourite games." },
    ]);
    // A survey using it can still read every version.
    expect((await callAs<LibraryModuleResponse>(studioLibraryModule, VERA, { moduleId: "gaming_habits", version: 1 })).version.version).toBe(1);
    await callAs(studioLibrarySetModule, OWNER, { moduleId: "gaming_habits", retired: false }, ownerToken);
    expect((await callAs<LibraryModulesResponse>(studioLibraryModules, VERA, {})).modules).toHaveLength(1);
    expect((await db.collection(paths.studioAudit(YBM)).where("action", "==", "library.module_changed").get()).size).toBe(3);
  });
});

// ── The published-surveys shelf ─────────────────────────────────────────────

describe("the published-surveys shelf", () => {
  it("lists every study's published versions, newest first with the live one marked, and no draft", { timeout: 120_000 }, async () => {
    await setUpYbm();
    const draft = await blankFuture();
    const edited = addQuestion(draft, { sectionKey: draft.composition.sections[0]!.key, typeId: "long_text", text: "How do you imagine your life in ten years?" }).draft;
    await publishFirst(FUTURE, "future_main", await saveDraft(FUTURE, "future_main", edited));
    await createSurvey(db, { study: FUTURE, surveyId: "future_draft_only", title: "Only a draft", actor: FAY });

    const shelf = await callAs<LibraryCatalogueResponse>(studioLibraryCatalogue, FAY, { study: FUTURE });
    expect(shelf.studies.map((s) => s.study)).toEqual([YBM, FUTURE]);
    const ybm = shelf.studies[0]!.surveys;
    expect(ybm).toHaveLength(1);
    expect(ybm[0]).toMatchObject({ surveyId: SURVEY, live: "8.0.0" });
    expect(ybm[0]!.versions.map((v) => v.version)).toEqual(["8.0.0", "7.3.0", "7.2.0", "7.1.0", "7.0.1", "7.0.0", "6.0.0", "5.0.0"]);
    expect(ybm[0]!.versions[0]).toEqual({ version: "8.0.0", hash: R800.manifest.hash, publishedAt: R800.manifest.release.publishedAt });
    expect(shelf.studies[1]).toMatchObject({ title: "Perspectives of the future", surveys: [{ surveyId: "future_main", live: "1.0.0", versions: [{ version: "1.0.0" }] }] });
    // Somebody with no Studio role anywhere sees nothing.
    expect((await refusalOf(callAs(studioLibraryCatalogue, { uid: "u_x", email: "x@example.org" }, {}))).code).toBe("permission-denied");
  });
});

// ── Publishing what was copied ──────────────────────────────────────────────

describe("publishing a copied questionnaire", () => {
  it("accepts one added from the library, unchanged, and records where it came from", { timeout: 60_000 }, async () => {
    const draft = await blankFuture();
    const { draft: withSdq } = insertFragment(draft, validatedFragment(SDQ2), { sectionKey: "welcome" }, insertOpts);
    const published = await publishFirst(FUTURE, "future_main", await saveDraft(FUTURE, "future_main", withSdq));
    expect(published.version).toBe("1.0.0");
    const version = await data<VersionDoc>(paths.studioVersion(FUTURE, "future_main", "1.0.0"));
    expect(version.imports).toHaveLength(1);
    expect(version.imports![0]!.origin).toEqual({ kind: "validated", instrument: "sdq25_s", refKey: SDQ2 });
    expect(Object.keys(version.imports![0]!.items)).toHaveLength(25);
  });

  it("accepts the same with one word changed: it is the study's own version (D-64)", { timeout: 60_000 }, async () => {
    const draft = await blankFuture();
    const { draft: withSdq } = insertFragment(draft, validatedFragment(SDQ2), { sectionKey: "welcome" }, insertOpts);
    const item = withSdq.instruments[SDQ2]!.forms[0]!.items[0] as { stem: { text: string } };
    item.stem = { text: item.stem.text.replace(/\bnice\b/, "kind") };
    const revision = await saveDraft(FUTURE, "future_main", withSdq);
    await publishFirst(FUTURE, "future_main", revision);
    expect(await exists(paths.studioVersion(FUTURE, "future_main", "1.0.0"))).toBe(true);
  });

  it("accepts one copied from another study's release, read from that study's store and verified", { timeout: 120_000 }, async () => {
    await setUpYbm();
    const draft = await blankFuture();
    // SDQ 1.0 is not in today's library: only ybm's release r7.3.0 can vouch for it.
    const piece = fragmentFromDraft(extractDraft(R730.raw), { kind: "block", sectionKey: "wellbeing", componentIndex: 1 }, fromRelease(YBM, "7.3.0", R730.manifest.hash!));
    expect(piece.blocks[0]!.refKey).toBe(SDQ1);
    const { draft: copied } = insertFragment(draft, piece, { sectionKey: "welcome" }, insertOpts);
    await publishFirst(FUTURE, "future_main", await saveDraft(FUTURE, "future_main", copied));
    const version = await data<VersionDoc>(paths.studioVersion(FUTURE, "future_main", "1.0.0"));
    expect(version.imports!.map((r) => r.origin)).toEqual([fromRelease(YBM, "7.3.0", R730.manifest.hash!)]);
    const row = (await db.collection(paths.studioAudit(FUTURE)).where("action", "==", "version.published").get()).docs[0]!.data() as AuditDoc;
    expect((row.detail as { copiedFrom: unknown }).copiedFrom).toEqual([{ study: YBM, hash: R730.manifest.hash }]);
  });

  it("refuses an import that names a release which is not there, or no study at all", { timeout: 120_000 }, async () => {
    await setUpYbm();
    const draft = await blankFuture();
    const piece = fragmentFromDraft(extractDraft(R730.raw), { kind: "block", sectionKey: "wellbeing", componentIndex: 1 }, fromRelease(YBM, "7.3.0", R730.manifest.hash!));
    const { draft: copied } = insertFragment(draft, piece, { sectionKey: "welcome" }, insertOpts);
    const forged = (origin: FragmentOrigin): StudioDraft => ({ ...structuredClone(copied), imports: [{ ...copied.imports![0]!, origin }] });

    // A hash no store holds.
    const bogus = await refusalOf(publishFirst(FUTURE, "future_main", await saveDraft(FUTURE, "future_main", forged(fromRelease(YBM, "7.3.0", `sha256:${"0".repeat(64)}`)))));
    expect(issueCodes(bogus)).toEqual(["imports.release_unreadable"]);
    expect(bogus.message).toMatch(/copied questions from a published version that can't be checked/);

    // A study this project does not run.
    const nowhere = await refusalOf(publishFirst(FUTURE, "future_main", await saveDraft(FUTURE, "future_main", forged(fromRelease("nowhere", "7.3.0", R730.manifest.hash!)))));
    expect(issueCodes(nowhere)).toEqual(["imports.unknown_study"]);
    expect(await exists(paths.studioVersion(FUTURE, "future_main", "1.0.0"))).toBe(false);
  });
});

// ── Copying a whole survey from another study ──────────────────────────────

describe("copying a whole survey from another study space", () => {
  it("copies a published version of ybm into future, and its first publish checks it against ybm's release", { timeout: 120_000 }, async () => {
    await setUpYbm();
    await callAs(studioCreateSurvey, FAY, { study: FUTURE, surveyId: "future_ybm", title: "YBM, in future", from: { study: YBM, surveyId: SURVEY, version: "8.0.0" } });
    const { doc, draft } = await currentDraft(FUTURE, "future_ybm");
    expect(doc.basedOn).toEqual({ version: "8.0.0", hash: R800.manifest.hash, study: YBM });
    expect(draft.composition).toMatchObject({ key: "future_ybm", study: FUTURE, title: "YBM, in future" });
    expect(draft.imports).toMatchObject([{ origin: fromRelease(YBM, "8.0.0", R800.manifest.hash!), by: FAY.uid, byEmail: FAY.email }]);
    const created = (await db.collection(paths.studioAudit(FUTURE)).where("action", "==", "survey.created").get()).docs.map((d) => d.data() as AuditDoc);
    expect(created.find((r) => r.subject === "future_ybm")?.detail).toMatchObject({ from: SURVEY, fromVersion: "8.0.0", fromStudy: YBM });

    // Its licensed content is held to ybm's release, though it was never published here.
    const tampered = structuredClone(draft);
    const sdq = tampered.instruments[SDQ2]!.forms[0]!.items[0] as { stem: { text: string } };
    sdq.stem = { text: "Reworded in a copy" };
    const error = await refusalOf(publishFirst(FUTURE, "future_ybm", await saveDraft(FUTURE, "future_ybm", tampered)));
    expect(issueCodes(error).some((c) => c.startsWith("locked."))).toBe(true);

    const published = await publishFirst(FUTURE, "future_ybm", await saveDraft(FUTURE, "future_ybm", draft));
    expect(published).toMatchObject({ version: "1.0.0", releaseKey: "future_ybm_r1_0_0" });
    const version = await data<VersionDoc>(paths.studioVersion(FUTURE, "future_ybm", "1.0.0"));
    expect(version.basedOnVersion).toBe("8.0.0");
    expect(version.imports!.map((r) => r.origin)).toEqual([fromRelease(YBM, "8.0.0", R800.manifest.hash!)]);
    // Once published, the draft is based on its own version, in its own study.
    expect((await currentDraft(FUTURE, "future_ybm")).doc.basedOn).toEqual({ version: "1.0.0", hash: published.hash });
    // ybm is untouched.
    expect(await data(paths.publishedPointer(YBM, SURVEY))).toMatchObject({ hash: R800.manifest.hash, generation: 1 });
  });

  it("refuses a study that does not exist, or a version not published there", { timeout: 60_000 }, async () => {
    await setUpYbm();
    const nowhere = await refusalOf(callAs(studioCreateSurvey, FAY, { study: FUTURE, surveyId: "x_one", title: "X", from: { study: "nowhere", surveyId: SURVEY, version: "8.0.0" } }));
    expect(nowhere.code).toBe("not-found");
    const unpublished = await refusalOf(callAs(studioCreateSurvey, FAY, { study: FUTURE, surveyId: "x_two", title: "X", from: { study: YBM, surveyId: SURVEY, version: "9.9.9" } }));
    expect(unpublished.code).toBe("not-found");
    expect(unpublished.message).toMatch(/in the study space “ybm” has not been published/);
    expect(await exists(paths.studioSurvey(FUTURE, "x_one"))).toBe(false);
    expect(await exists(paths.studioSurvey(FUTURE, "x_two"))).toBe(false);
  });
});
