import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp, type CollectionReference, type Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import { hashHex, verifyRawManifestHash } from "@myself/schema";
import {
  addQuestion,
  compileDraft,
  diffDrafts,
  extractDraft,
  liveQuestions,
  manifestIndex,
  parseDraft,
  serialiseDraft,
  unlockModule,
  updateScreen,
  type AuditDoc,
  type DraftDoc,
  type PublishedPointerDoc,
  type PublicReleaseDoc,
  type StudioDraft,
  type SurveyDoc,
  type VersionDoc,
} from "@myself/studio";
import { bundledManifests } from "../src/releases.js";
import { MAX_UNLOCK_ROWS_PER_SAVE, recordDraftWrite, type DraftSide } from "../src/studio/draft-trigger.js";
import { setDomain, setMember } from "../src/studio/members.js";
import { publish } from "../src/studio/publish.js";
import { responseStats } from "../src/studio/stats.js";
import { createSurvey, importLive, REPOSITORY_RELEASE_NOTE } from "../src/studio/surveys.js";
import { activateVersion, restoreVersion } from "../src/studio/versions.js";

/**
 * MySelf Studio's trusted operations, against a real Firestore.
 *
 * The unit suite covers the decisions that need no database. This covers what
 * only a database can show: that a publish lands whole or not at all, that
 * two publishes racing from one draft resolve to one, that a refusal leaves
 * every document exactly as it was, and that what is stored is what every
 * reader will verify. Each core is called as its callable calls it, with an
 * actor that has already passed `requireStudio` (the unit suite's subject).
 */

const STUDY = "ybm";
const SURVEY = "ybm_nd2026_standard";

const ADMIN = { uid: "u_admin", email: "ada.admin@example.org", owner: false };
const PUBLISHER = { uid: "u_pat", email: "pat.publisher@example.org", owner: false };
const EDITOR = { uid: "u_ed", email: "ed.editor@example.org" };

const bundled = (version: string) => bundledManifests.find((b) => b.manifest.release.version === version)!;
const R800 = bundled("8.0.0");
const LIVE_HASH = R800.manifest.hash!;
const IMPORTED = ["5.0.0", "6.0.0", "7.0.0", "7.0.1", "7.1.0", "7.2.0", "7.3.0", "8.0.0"];

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" }, `studio-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const collection of ["surveys", "published", "publicReleases", "studioAudit", "studioMembers", "studioAccess", "sessions"]) {
    await db.recursiveDelete(db.collection(`studies/${STUDY}/${collection}`));
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

const ref = {
  survey: (id = SURVEY) => db.doc(paths.studioSurvey(STUDY, id)),
  draft: (id = SURVEY) => db.doc(paths.studioDraft(STUDY, id)),
  pointer: (id = SURVEY) => db.doc(paths.publishedPointer(STUDY, id)),
  version: (v: string, id = SURVEY) => db.doc(paths.studioVersion(STUDY, id, v)),
  release: (hash: string) => db.doc(paths.publicRelease(STUDY, hashHex(hash))),
};

const data = async <T>(r: FirebaseFirestore.DocumentReference) => (await r.get()).data() as T;

async function audit(action?: AuditDoc["action"]): Promise<AuditDoc[]> {
  const rows = (await db.collection(paths.studioAudit(STUDY)).get()).docs.map((d) => d.data() as AuditDoc);
  return action ? rows.filter((r) => r.action === action) : rows;
}

/** Every Studio document in the study, by path, so a refusal can be shown to have written nothing. */
async function dump(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (collection: CollectionReference) => {
    for (const doc of await collection.listDocuments()) {
      const snap = await doc.get();
      if (snap.exists) out.set(doc.path, JSON.stringify(snap.data()));
      for (const sub of await doc.listCollections()) await walk(sub);
    }
  };
  for (const collection of await db.doc(`studies/${STUDY}`).listCollections()) await walk(collection);
  return out;
}

const refusal = async (promise: Promise<unknown>): Promise<HttpsError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpsError) return error;
    throw error;
  }
  throw new Error("that was accepted, and it should not have been");
};

/** A refusal that wrote nothing at all. */
async function refusedCleanly(attempt: () => Promise<unknown>): Promise<HttpsError> {
  const before = await dump();
  const error = await refusal(attempt());
  expect(await dump()).toEqual(before);
  return error;
}

async function currentDraft(id = SURVEY): Promise<{ doc: DraftDoc; draft: StudioDraft }> {
  const doc = await data<DraftDoc>(ref.draft(id));
  return { doc, draft: parseDraft(doc.content) };
}

/**
 * An editor's save, as the Studio makes one under the rules — the next
 * revision, the server's clock, the saver's own uid and list key — followed by
 * the trigger the functions emulator would run for it.
 */
async function save(draft: StudioDraft, editor = EDITOR, id = SURVEY): Promise<number> {
  const before = (await ref.draft(id).get()).data() as DraftSide & { revision: number };
  const revision = before.revision + 1;
  await ref.draft(id).update({
    content: serialiseDraft(draft),
    revision,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: editor.uid,
    updatedByEmail: editor.email,
  });
  const after = (await ref.draft(id).get()).data() as DraftSide;
  await recordDraftWrite(db, { study: STUDY, surveyId: id, docId: "current" }, before, after, new Date().toISOString());
  return revision;
}

const setUp = () => importLive(db, { study: STUDY, surveyId: SURVEY, actor: ADMIN });

/** A new question: a MAJOR change. */
const withQuestion = (draft: StudioDraft, text = "What is your favourite colour?") =>
  addQuestion(draft, { sectionKey: draft.composition.sections[1]!.key, typeId: "short_text", text }).draft;

const publishAs = (expectedRevision: number, version: string, releaseNote = "Adds a question about colour.") =>
  publish(db, { study: STUDY, surveyId: SURVEY, expectedRevision, version, releaseNote, actor: PUBLISHER });

// ── Set up from the live survey ─────────────────────────────────────────────

describe("setting up from the live survey", () => {
  it("writes every bundled release, points the live survey at r8.0.0, and starts the draft from it", async () => {
    const result = await setUp();
    expect(result).toEqual({ surveyId: SURVEY, imported: IMPORTED, active: "8.0.0" });

    const pointer = await data<PublishedPointerDoc & { publishedAt: Timestamp }>(ref.pointer());
    expect(pointer).toMatchObject({ surveyId: SURVEY, study: STUDY, hash: LIVE_HASH, version: "8.0.0", releaseKey: "ybm_nd2026_standard_r8_0_0", generation: 1 });
    // A Firestore timestamp, which is what the participant app's REST read expects.
    expect(pointer.publishedAt).toBeInstanceOf(Timestamp);
    expect(pointer.publishedAt.toDate().toISOString()).toBe(R800.manifest.release.publishedAt);

    const survey = await data<SurveyDoc>(ref.survey());
    expect(survey).toMatchObject({
      surveyId: SURVEY,
      title: R800.manifest.composition.title,
      latestVersion: "8.0.0",
      versionCount: IMPORTED.length,
      draftEditors: [],
      createdBy: ADMIN.uid,
      active: { version: "8.0.0", hash: LIVE_HASH, generation: 1, publishedBy: "repository", publishedByEmail: null },
    });

    for (const version of IMPORTED) {
      const b = bundled(version);
      const v = await data<VersionDoc>(ref.version(version));
      expect(v).toMatchObject({
        version,
        hash: b.manifest.hash,
        source: "repository",
        releaseNote: REPOSITORY_RELEASE_NOTE,
        changeSummary: null,
        bump: null,
        draftRevision: null,
        basedOnVersion: null,
        authors: [],
        publishedBy: "repository",
        publishedByEmail: null,
        manifestPublishedAt: b.manifest.release.publishedAt,
      });
      expect({ itemKeys: v.itemKeys, variables: v.variables }).toEqual(manifestIndex(b.raw));
      // Stored as the JSON it was hashed from, and verifiable by any reader.
      const stored = await data<PublicReleaseDoc>(ref.release(b.manifest.hash!));
      expect(stored.hash).toBe(b.manifest.hash);
      expect(await verifyRawManifestHash(JSON.parse(stored.manifest))).toBe(true);
      expect(JSON.parse(stored.manifest)).toEqual(b.raw);
    }

    const { doc, draft } = await currentDraft();
    expect(doc).toMatchObject({ revision: 1, basedOn: { version: "8.0.0", hash: LIVE_HASH }, updatedBy: ADMIN.uid });
    // The draft round-trips: it is the live release, extracted.
    expect(draft).toEqual(extractDraft(R800.raw));

    const rows = await audit("survey.imported");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: ADMIN.uid, actorEmail: ADMIN.email, surveyId: SURVEY, detail: { imported: IMPORTED } });
  });

  it("is idempotent: a second run imports nothing and changes nothing", async () => {
    await setUp();
    const before = await dump();
    await expect(setUp()).resolves.toEqual({ surveyId: SURVEY, imported: [], active: "8.0.0" });
    expect(await dump()).toEqual(before);
  });

  it("never overwrites what the Studio has done since", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    await publishAs(revision, "9.0.0");
    const before = await dump();
    await expect(setUp()).resolves.toEqual({ surveyId: SURVEY, imported: [], active: "9.0.0" });
    expect(await dump()).toEqual(before);
  });

  it("refuses a store that contradicts the repository, and writes nothing", async () => {
    await ref.survey().set({ surveyId: SURVEY });
    await ref.version("7.1.0").set({ version: "7.1.0", hash: "sha256:" + "0".repeat(64), source: "studio" });
    const error = await refusedCleanly(() => setUp());
    expect(error.code).toBe("failed-precondition");
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "import.version_conflict" }] });
  });
});

// ── Publishing ──────────────────────────────────────────────────────────────

describe("publishing", () => {
  it("writes the release, the version, the pointer, the survey and the audit row together", async () => {
    await setUp();
    const edited = withQuestion((await currentDraft()).draft);
    const revision = await save(edited);

    const result = await publishAs(revision, "9.0.0");
    expect(result).toMatchObject({ surveyId: SURVEY, version: "9.0.0", releaseKey: "ybm_nd2026_standard_r9_0_0", generation: 2, alreadyPublished: false });

    // The release: stored as JSON that verifies against its hash, naming the
    // publisher by uid only — the manifest is public.
    const stored = await data<PublicReleaseDoc>(ref.release(result.hash));
    const raw = JSON.parse(stored.manifest) as Record<string, unknown> & { release: Record<string, unknown> };
    expect(await verifyRawManifestHash(raw)).toBe(true);
    expect(raw["hash"]).toBe(result.hash);
    expect(stored).toMatchObject({ surveyId: SURVEY, hash: result.hash, version: "9.0.0", releaseKey: "ybm_nd2026_standard_r9_0_0", engineVersion: "0.2.0" });
    expect(stored.bytes).toBe(Buffer.byteLength(stored.manifest, "utf8"));
    expect(raw.release["publishedBy"]).toBe(`studio:${PUBLISHER.uid}`);
    expect(stored.manifest).not.toContain(PUBLISHER.email);
    expect(stored.manifest).not.toContain(EDITOR.email);

    // What participants get is exactly what was edited.
    const back = extractDraft(raw);
    const compiled = compileDraft(edited);
    expect(back.composition).toEqual(compiled.composition);
    expect(diffDrafts(back, edited).entries).toEqual([]);
    expect(Object.keys(back.instruments).sort()).toEqual(Object.keys(edited.instruments).sort());

    const version = await data<VersionDoc>(ref.version("9.0.0"));
    expect(version).toMatchObject({
      version: "9.0.0",
      hash: result.hash,
      source: "studio",
      draftRevision: revision,
      basedOnVersion: "8.0.0",
      bump: "major",
      authors: [EDITOR.email],
      publishedBy: PUBLISHER.uid,
      publishedByEmail: PUBLISHER.email,
      releaseNote: "Adds a question about colour.",
      manifestPublishedAt: raw.release["publishedAt"],
    });
    expect(version.itemKeys).toContain("ybm_studio.favourite_colour");
    expect(version.changeSummary?.entries.map((e) => e.kind)).toEqual(["question.added"]);

    expect(await data<PublishedPointerDoc>(ref.pointer())).toMatchObject({ hash: result.hash, version: "9.0.0", generation: 2, engineVersion: "0.2.0" });
    expect(await data<SurveyDoc>(ref.survey())).toMatchObject({
      active: { version: "9.0.0", hash: result.hash, generation: 2, publishedBy: PUBLISHER.uid, publishedByEmail: PUBLISHER.email },
      latestVersion: "9.0.0",
      versionCount: IMPORTED.length + 1,
      draftEditors: [],
    });

    // The draft's provenance moves; its content and revision are the editors'.
    const { doc } = await currentDraft();
    expect(doc.revision).toBe(revision);
    expect(parseDraft(doc.content)).toEqual(edited);
    expect(doc.basedOn).toEqual({ version: "9.0.0", hash: result.hash });

    const [row] = await audit("version.published");
    expect(row).toMatchObject({
      actor: PUBLISHER.uid,
      actorEmail: PUBLISHER.email,
      surveyId: SURVEY,
      subject: "9.0.0",
      detail: { version: "9.0.0", hash: result.hash, releaseNote: "Adds a question about colour.", bump: "major", draftRevision: revision },
    });
    expect(row!.at).toBeInstanceOf(Timestamp);
  });

  it("refuses a draft saved since the publisher looked at it, writing nothing", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    await save(withQuestion((await currentDraft()).draft, "And your favourite animal?"));
    const error = await refusedCleanly(() => publishAs(revision, "9.0.0"));
    expect(error.code).toBe("aborted");
    expect(error.details).toEqual({ kind: "conflict", currentRevision: revision + 1 });
  });

  it("refuses an invalid draft with every problem located, writing nothing", async () => {
    await setUp();
    const draft = (await currentDraft()).draft;
    // A reworded licensed questionnaire: the change the locks exist to stop.
    const locked = Object.values(draft.instruments).find((d) => d.licence.modifiable !== "yes")!;
    (locked.forms[0]!.items[0] as { stem?: { text: string } }).stem = { text: "Something the licence never said" };
    const revision = await save(draft);
    const error = await refusedCleanly(() => publishAs(revision, "9.0.0"));
    expect(error.code).toBe("failed-precondition");
    const details = error.details as { kind: string; issues: { code: string; severity: string; location: { itemKey?: string } }[]; gate: string[] };
    expect(details.kind).toBe("invalid");
    expect(details.gate).toEqual([]);
    expect(details.issues.some((i) => i.severity === "error" && i.code.startsWith("locked."))).toBe(true);
  });

  it("refuses a licensed instrument whose licence the draft has quietly changed", async () => {
    await setUp();
    const draft = (await currentDraft()).draft;
    const locked = Object.values(draft.instruments).find((d) => d.licence.modifiable !== "yes")!;
    locked.licence = { ...locked.licence, modifiable: "yes" };
    (locked.forms[0]!.items[0] as { stem?: { text: string } }).stem = { text: "Reworded behind a changed licence" };
    const revision = await save(draft);
    const error = await refusedCleanly(() => publishAs(revision, "9.0.0"));
    expect((error.details as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("locked.licence_changed");
  });

  it("refuses a draft that claims to be another survey", async () => {
    await setUp();
    const draft = withQuestion((await currentDraft()).draft);
    draft.composition = { ...draft.composition, key: "another_survey" };
    const revision = await save(draft);
    const error = await refusedCleanly(() => publishAs(revision, "9.0.0"));
    expect((error.details as { issues: { code: string }[] }).issues.map((i) => i.code)).toContain("survey.key_mismatch");
  });

  it("refuses to publish nothing new", async () => {
    await setUp();
    const error = await refusedCleanly(() => publishAs(1, "9.0.0"));
    expect(error.code).toBe("failed-precondition");
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "publish.no_changes" }] });
    expect(error.message).toMatch(/Nothing has changed since the live version \(8\.0\.0\)/);
  });

  it("refuses a version number smaller than the changes need, or not above the latest", async () => {
    await setUp();
    // New finishing-screen text: participant-visible outside the questions, so MINOR.
    const revision = await save(updateScreen((await currentDraft()).draft, "finish", { title: "Thank you so much, {first_name}!" }).draft);
    const small = await refusedCleanly(() => publishAs(revision, "8.0.1"));
    expect(small.code).toBe("invalid-argument");
    expect(small.details).toEqual({ kind: "bump_too_small", required: "minor", minimumVersion: "8.1.0" });
    const lower = await refusedCleanly(() => publishAs(revision, "7.9.9"));
    expect(lower.details).toEqual({ kind: "bump_too_small", required: "minor", minimumVersion: "8.1.0" });
    expect(lower.message).toMatch(/not above the latest version, 8\.0\.0/);
    // A larger bump than needed is always allowed.
    await expect(publishAs(revision, "9.0.0")).resolves.toMatchObject({ version: "9.0.0" });
    expect((await data<VersionDoc>(ref.version("9.0.0"))).bump).toBe("major");
  });

  it("refuses a version number already published", async () => {
    await setUp();
    const first = await save(withQuestion((await currentDraft()).draft));
    await publishAs(first, "9.0.0");
    const second = await save(withQuestion((await currentDraft()).draft, "And your favourite animal?"));
    const error = await refusedCleanly(() => publishAs(second, "9.0.0"));
    expect(error.code).toBe("already-exists");
    expect(error.details).toEqual({ kind: "version_taken", version: "9.0.0" });
    // An imported version number is just as taken.
    const imported = await refusedCleanly(() => publishAs(second, "8.0.0"));
    expect(imported.details).toEqual({ kind: "version_taken", version: "8.0.0" });
  });

  it("credits the saver of the published revision even when the trigger has not yet run for it", async () => {
    await setUp();
    await save(withQuestion((await currentDraft()).draft));
    // A second editor's save, published before its trigger event arrives.
    const LATE = { uid: "u_late", email: "late.editor@example.org" };
    const doc = (await ref.draft().get()).data() as DraftSide & { revision: number };
    const revision = doc.revision + 1;
    const before = doc;
    await ref.draft().update({
      content: serialiseDraft(withQuestion((await currentDraft()).draft, "And your favourite animal?")),
      revision,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: LATE.uid,
      updatedByEmail: LATE.email,
    });
    await publishAs(revision, "9.0.0");
    expect((await data<VersionDoc>(ref.version("9.0.0"))).authors).toEqual([EDITOR.email, LATE.email]);
    // The trigger arriving late still credits nobody with the next version.
    const after = (await ref.draft().get()).data() as DraftSide;
    await recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, before, after, new Date().toISOString());
    expect((await data<SurveyDoc>(ref.survey())).draftEditors).toEqual([]);
  });

  it("returns the stored result when a publish that landed is retried", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    const first = await publishAs(revision, "9.0.0");
    const before = await dump();
    const again = await publishAs(revision, "9.0.0");
    expect(again).toEqual({ ...first, alreadyPublished: true });
    expect(await dump()).toEqual(before);
  });

  it("lets exactly one of two publishes racing from the same draft win, and the loser writes nothing", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    const results = await Promise.allSettled([publishAs(revision, "9.0.0"), publishAs(revision, "10.0.0")]);

    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof publishAs>>> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(HttpsError);
    // The loser re-read a history where the winner's version is live and
    // found nothing left to publish.
    expect((lost[0]!.reason as HttpsError).details).toMatchObject({ kind: "invalid", issues: [{ code: "publish.no_changes" }] });

    const winner = won[0]!.value;
    const versions = (await db.collection(paths.studioVersions(STUDY, SURVEY)).get()).docs.map((d) => d.id).sort();
    expect(versions).toEqual([...IMPORTED, winner.version].sort());
    expect((await db.collection(paths.publicReleases(STUDY)).get()).size).toBe(IMPORTED.length + 1);
    expect(await data<PublishedPointerDoc>(ref.pointer())).toMatchObject({ hash: winner.hash, generation: 2 });
    expect(await data<SurveyDoc>(ref.survey())).toMatchObject({ versionCount: IMPORTED.length + 1, latestVersion: winner.version });
    expect(await audit("version.published")).toHaveLength(1);
  });
});

// ── Going back ──────────────────────────────────────────────────────────────

describe("making an earlier version live again", () => {
  it("repoints the live pointer, moves the generation on, and records why", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    const r9 = await publishAs(revision, "9.0.0");

    const back = await activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "8.0.0", reason: "r9 shows a blank screen on older iPads", actor: PUBLISHER });
    expect(back).toEqual({ version: "8.0.0", hash: LIVE_HASH, generation: 3 });
    expect(await data<PublishedPointerDoc>(ref.pointer())).toMatchObject({ hash: LIVE_HASH, version: "8.0.0", generation: 3, engineVersion: "0.2.0" });
    const survey = await data<SurveyDoc>(ref.survey());
    expect(survey.active).toMatchObject({ version: "8.0.0", hash: LIVE_HASH, generation: 3, publishedBy: "repository" });
    // The highest version ever published is still r8: its number is never reused.
    expect(survey.latestVersion).toBe("9.0.0");
    expect(survey.versionCount).toBe(IMPORTED.length + 1);

    const [row] = await audit("version.activated");
    expect(row).toMatchObject({
      actor: PUBLISHER.uid,
      subject: "8.0.0",
      detail: { version: "8.0.0", hash: LIVE_HASH, previous: { version: "9.0.0", hash: r9.hash, generation: 2 }, reason: "r9 shows a blank screen on older iPads", generation: 3 },
    });

    // Already live: refused, nothing written.
    const error = await refusedCleanly(() =>
      activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "8.0.0", reason: "pressing it twice by mistake", actor: PUBLISHER }),
    );
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "version.already_live" }] });

    // And forward again.
    await expect(
      activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "9.0.0", reason: "the fix for older iPads is out", actor: PUBLISHER }),
    ).resolves.toEqual({ version: "9.0.0", hash: r9.hash, generation: 4 });
  });

  it("refuses a version that was never published", async () => {
    await setUp();
    const error = await refusedCleanly(() =>
      activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "9.9.9", reason: "no such version at all", actor: PUBLISHER }),
    );
    expect(error.code).toBe("not-found");
    expect(error.details).toMatchObject({ kind: "not_found" });
  });

  it("refuses to point devices at a release that is missing from the store", async () => {
    await setUp();
    await ref.release(bundled("7.0.1").manifest.hash!).delete();
    const error = await refusedCleanly(() =>
      activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "7.0.1", reason: "back to the previous wording", actor: PUBLISHER }),
    );
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "store.release_unreadable" }] });
  });

  it("after a rollback, the next publish is compared with what is live and numbered above everything", async () => {
    await setUp();
    await publishAs(await save(withQuestion((await currentDraft()).draft)), "9.0.0");
    await activateVersion(db, { study: STUDY, surveyId: SURVEY, version: "8.0.0", reason: "r9 shows a blank screen", actor: PUBLISHER });
    const revision = (await currentDraft()).doc.revision;
    // The draft still has r8's question, which is a change from live r8.0.0 —
    // and 8.x is taken, so the lowest allowed is 9.0.0.
    const error = await refusedCleanly(() => publishAs(revision, "9.1.0"));
    expect(error.details).toEqual({ kind: "bump_too_small", required: "major", minimumVersion: "10.0.0" });
    await expect(publishAs(revision, "10.0.0")).resolves.toMatchObject({ version: "10.0.0", generation: 4 });
  });
});

describe("restoring a version into the draft", () => {
  it("replaces the content, moves the revision on, keeps what the Studio knows, and records it", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    await publishAs(revision, "9.0.0");

    const result = await restoreVersion(db, { study: STUDY, surveyId: SURVEY, version: "8.0.0", expectedRevision: revision, actor: PUBLISHER });
    expect(result).toEqual({ revision: revision + 1 });

    const { doc, draft } = await currentDraft();
    expect(doc).toMatchObject({ revision: revision + 1, updatedBy: PUBLISHER.uid, updatedByEmail: PUBLISHER.email, basedOn: { version: "8.0.0", hash: LIVE_HASH } });
    expect(doc.updatedAt).toBeInstanceOf(Timestamp);
    const restored = extractDraft(R800.raw);
    expect(draft.composition).toEqual(restored.composition);
    // r8's question is not lost: it is archived, under its reserved ID.
    expect(liveQuestions(draft).map((q) => q.itemKey)).not.toContain("ybm_studio.favourite_colour");
    expect(draft.archived.map((a) => a.itemKey)).toEqual(["ybm_studio.favourite_colour"]);

    const [row] = await audit("draft.restored");
    expect(row).toMatchObject({
      actor: PUBLISHER.uid,
      subject: "8.0.0",
      detail: { version: "8.0.0", hash: LIVE_HASH, fromRevision: revision, toRevision: revision + 1, archived: ["ybm_studio.favourite_colour"] },
    });

    // The ordinary rollback: restore, then publish it as a new version.
    await expect(publishAs(revision + 1, "10.0.0", "Back to the r8.0.0 questions.")).resolves.toMatchObject({ version: "10.0.0", generation: 3 });
    const v10 = await data<VersionDoc>(ref.version("10.0.0"));
    expect(v10.basedOnVersion).toBe("8.0.0");
    expect(v10.changeSummary?.entries.map((e) => e.kind)).toEqual(["question.archived"]);
  });

  it("refuses a stale revision, writing nothing", async () => {
    await setUp();
    await save(withQuestion((await currentDraft()).draft));
    const error = await refusedCleanly(() =>
      restoreVersion(db, { study: STUDY, surveyId: SURVEY, version: "7.0.1", expectedRevision: 1, actor: PUBLISHER }),
    );
    expect(error.details).toEqual({ kind: "conflict", currentRevision: 2 });
  });

  it("mends a draft nobody can read", async () => {
    await setUp();
    await ref.draft().update({ content: "{broken", revision: 2 });
    await expect(restoreVersion(db, { study: STUDY, surveyId: SURVEY, version: "8.0.0", expectedRevision: 2, actor: PUBLISHER })).resolves.toEqual({ revision: 3 });
    const { draft } = await currentDraft();
    const release = extractDraft(R800.raw);
    expect({ composition: draft.composition, instruments: draft.instruments, scales: draft.scales, archived: draft.archived }).toEqual({
      composition: release.composition,
      instruments: release.instruments,
      scales: release.scales,
      archived: [],
    });
    expect((await audit("draft.restored"))[0]?.detail).toMatchObject({ currentUnreadable: true });
  });
});

// ── New surveys ─────────────────────────────────────────────────────────────

describe("a new survey", () => {
  it("starts blank, with a draft and nothing published, and cannot be created twice", async () => {
    await createSurvey(db, { study: STUDY, surveyId: "wellbeing_pilot", title: "Wellbeing pilot", actor: ADMIN });
    expect(await data<SurveyDoc>(ref.survey("wellbeing_pilot"))).toMatchObject({ title: "Wellbeing pilot", active: null, latestVersion: null, versionCount: 0 });
    const { doc, draft } = await currentDraft("wellbeing_pilot");
    expect(doc).toMatchObject({ revision: 1, basedOn: null });
    expect(draft.composition.key).toBe("wellbeing_pilot");
    expect(await audit("survey.created")).toHaveLength(1);

    const error = await refusedCleanly(() => createSurvey(db, { study: STUDY, surveyId: "wellbeing_pilot", title: "Again", actor: ADMIN }));
    expect(error.code).toBe("already-exists");
  });

  it("copied from a published version publishes as its own 1.0.0 — with the copied locks still holding", async () => {
    await setUp();
    await createSurvey(db, { study: STUDY, surveyId: "ybm_copy", title: "YBM copy", from: { surveyId: SURVEY, version: "8.0.0" }, actor: ADMIN });
    const { doc, draft } = await currentDraft("ybm_copy");
    expect(doc.basedOn).toEqual({ version: "8.0.0", hash: LIVE_HASH });
    expect(draft.composition).toMatchObject({ key: "ybm_copy", title: "YBM copy" });

    // A reworded licensed question in the copy is refused, though the copy has
    // never been published: it is checked against the release it came from.
    const tampered = structuredClone(draft);
    const locked = Object.values(tampered.instruments).find((d) => d.licence.modifiable !== "yes")!;
    (locked.forms[0]!.items[0] as { stem?: { text: string } }).stem = { text: "Reworded in a copy" };
    const bad = await save(tampered, EDITOR, "ybm_copy");
    const error = await refusedCleanly(() =>
      publish(db, { study: STUDY, surveyId: "ybm_copy", expectedRevision: bad, version: "1.0.0", releaseNote: "First.", actor: PUBLISHER }),
    );
    expect((error.details as { issues: { code: string }[] }).issues.some((i) => i.code.startsWith("locked."))).toBe(true);

    const good = await save(draft, EDITOR, "ybm_copy");
    const published = await publish(db, { study: STUDY, surveyId: "ybm_copy", expectedRevision: good, version: "1.0.0", releaseNote: "First.", actor: PUBLISHER });
    expect(published).toMatchObject({ version: "1.0.0", releaseKey: "ybm_copy_r1_0_0", generation: 1 });
    // The original is untouched.
    expect(await data<PublishedPointerDoc>(ref.pointer())).toMatchObject({ hash: LIVE_HASH, generation: 1 });
  });
});

// ── The list ────────────────────────────────────────────────────────────────

describe("the Studio list", () => {
  // The cores re-read the acting admin's own access inside their transaction,
  // so the admin these tests act as has to be on the list, as in life.
  const listed = (email: string, role: string) => db.doc(paths.studioMember(STUDY, email)).set({ email, role });
  beforeEach(() => listed(ADMIN.email, "admin"));

  it("adds, changes and removes people, each audited", async () => {
    await setMember(db, { study: STUDY, email: "new.person@example.org", role: "editor", note: "BrainPOP content lead", actor: ADMIN });
    expect(await data(db.doc(paths.studioMember(STUDY, "new.person@example.org")))).toMatchObject({
      email: "new.person@example.org",
      role: "editor",
      addedBy: ADMIN.uid,
      addedByEmail: ADMIN.email,
      note: "BrainPOP content lead",
    });
    await setMember(db, { study: STUDY, email: "new.person@example.org", role: "publisher", actor: ADMIN });
    expect(await data(db.doc(paths.studioMember(STUDY, "new.person@example.org")))).toMatchObject({ role: "publisher", note: "BrainPOP content lead" });
    await setMember(db, { study: STUDY, email: "new.person@example.org", role: null, actor: ADMIN });
    expect((await db.doc(paths.studioMember(STUDY, "new.person@example.org")).get()).exists).toBe(false);

    expect((await audit("access.member_set")).map((r) => r.detail)).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "editor", previousRole: null }), expect.objectContaining({ role: "publisher", previousRole: "editor" })]),
    );
    expect(await audit("access.member_removed")).toMatchObject([{ subject: "new.person@example.org", surveyId: null, detail: { previousRole: "publisher" } }]);
  });

  it("will not let an admin change or remove their own entry", async () => {
    for (const role of [null, "viewer", "admin"] as const) {
      const error = await refusedCleanly(() => setMember(db, { study: STUDY, email: ADMIN.email, role, actor: ADMIN }));
      expect(error.code).toBe("failed-precondition");
      expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "access.own_entry" }] });
    }
    // The owner, whose access does not depend on the list, can.
    await setMember(db, { study: STUDY, email: "owner@leeds.ac.uk", role: "viewer", actor: { uid: "u_owner", email: "owner@leeds.ac.uk", owner: true } });
    expect(await data(db.doc(paths.studioMember(STUDY, "owner@leeds.ac.uk")))).toMatchObject({ role: "viewer" });
  });

  it("refuses a public mail provider as a domain rule, writing nothing", async () => {
    const error = await refusedCleanly(() => setDomain(db, { study: STUDY, domain: "gmail.com", role: "viewer", actor: ADMIN }));
    expect(error.code).toBe("invalid-argument");
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "access.consumer_domain" }] });
  });

  it("sets and removes a domain rule, keeping the others", async () => {
    await setDomain(db, { study: STUDY, domain: "brainpop.com", role: "editor", actor: ADMIN });
    await expect(setDomain(db, { study: STUDY, domain: "leeds.ac.uk", role: "viewer", actor: ADMIN })).resolves.toEqual({
      domains: { "brainpop.com": "editor", "leeds.ac.uk": "viewer" },
    });
    await expect(setDomain(db, { study: STUDY, domain: "brainpop.com", role: null, actor: ADMIN })).resolves.toEqual({ domains: { "leeds.ac.uk": "viewer" } });
    expect(await data(db.doc(paths.studioAccessConfig(STUDY)))).toMatchObject({ domains: { "leeds.ac.uk": "viewer" }, updatedBy: ADMIN.uid });
    expect((await audit("access.domain_set")).map((r) => [r.subject, (r.detail as { role: unknown }).role])).toEqual(
      expect.arrayContaining([["brainpop.com", "editor"], ["leeds.ac.uk", "viewer"], ["brainpop.com", null]]),
    );
    // Taking away a rule for a public provider (set before this check existed) is always possible.
    await db.doc(paths.studioAccessConfig(STUDY)).set({ domains: { "gmail.com": "viewer" } });
    await expect(setDomain(db, { study: STUDY, domain: "gmail.com", role: null, actor: ADMIN })).resolves.toEqual({ domains: {} });
  });

  it("will not let someone who is an admin only through a domain rule take it away from themselves", async () => {
    await db.doc(paths.studioAccessConfig(STUDY)).set({ domains: { "brainpop.com": "admin" } });
    const viaDomain = { uid: "u_bp", email: "lead@brainpop.com", owner: false };
    const error = await refusedCleanly(() => setDomain(db, { study: STUDY, domain: "brainpop.com", role: "editor", actor: viaDomain }));
    expect(error.details).toMatchObject({ kind: "invalid", issues: [{ code: "access.own_domain" }] });
  });

  it("refuses an admin whose own access went between the check and the change, writing nothing", async () => {
    // `requireStudio` passed a moment ago; the entry has gone since.
    await db.doc(paths.studioMember(STUDY, ADMIN.email)).delete();
    for (const attempt of [
      () => setMember(db, { study: STUDY, email: "new.person@example.org", role: "admin", actor: ADMIN }),
      () => setDomain(db, { study: STUDY, domain: "example.net", role: "admin", actor: ADMIN }),
    ]) {
      const error = await refusedCleanly(attempt);
      expect(error.code).toBe("permission-denied");
      expect(error.details).toEqual({ kind: "forbidden", needed: "admin" });
    }
    // Demoted rather than removed: the same.
    await listed(ADMIN.email, "publisher");
    expect((await refusedCleanly(() => setMember(db, { study: STUDY, email: "x@example.org", role: "viewer", actor: ADMIN }))).code).toBe("permission-denied");
  });

  it("cannot be emptied of admins by two admins removing each other at the same instant", async () => {
    const BEA = { uid: "u_bea", email: "bea.admin@example.org", owner: false };
    await listed(BEA.email, "admin");
    for (let round = 0; round < 2; round += 1) {
      await listed(ADMIN.email, "admin");
      await listed(BEA.email, "admin");
      const results = await Promise.allSettled([
        setMember(db, { study: STUDY, email: BEA.email, role: null, actor: ADMIN }),
        setMember(db, { study: STUDY, email: ADMIN.email, role: null, actor: BEA }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect((lost.reason as HttpsError).details).toEqual({ kind: "forbidden", needed: "admin" });
      const admins = (await db.collection(paths.studioMembers(STUDY)).where("role", "==", "admin").get()).docs.map((d) => d.id);
      expect(admins).toHaveLength(1);
    }
  });

  it("cannot be emptied of admins by one admin lowering the domain rule another depends on while that one removes them", async () => {
    await db.doc(paths.studioAccessConfig(STUDY)).set({ domains: { "brainpop.com": "admin" } });
    const viaDomain = { uid: "u_bp", email: "lead@brainpop.com", owner: false };
    const results = await Promise.allSettled([
      setDomain(db, { study: STUDY, domain: "brainpop.com", role: "editor", actor: ADMIN }),
      setMember(db, { study: STUDY, email: ADMIN.email, role: null, actor: viaDomain }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const adminEntry = (await db.doc(paths.studioMember(STUDY, ADMIN.email)).get()).exists;
    const domainRole = (await db.doc(paths.studioAccessConfig(STUDY)).get()).get("domains")["brainpop.com"];
    // Whichever landed, somebody is still an admin.
    expect(adminEntry || domainRole === "admin").toBe(true);
  });
});

// ── Responses ───────────────────────────────────────────────────────────────

describe("response counts", () => {
  it("counts sittings per version by hash, complete and partial, and nothing else", async () => {
    await setUp();
    const r701 = bundled("7.0.1").manifest.hash!;
    const sittings: [string, string, boolean][] = [
      ["s1", LIVE_HASH, true],
      ["s2", LIVE_HASH, true],
      ["s3", LIVE_HASH, false],
      ["s4", r701, true],
      ["s5", "sha256:" + "e".repeat(64), true],
    ];
    for (const [id, releaseHash, complete] of sittings) {
      await db.doc(paths.session(STUDY, id)).set({ sessionId: id, releaseHash, complete, quarantined: false, events: [{ secret: "an answer" }] });
    }
    const stats = await responseStats(db, { study: STUDY, surveyId: SURVEY });
    expect(Object.keys(stats.byHash).sort()).toEqual(IMPORTED.map((v) => bundled(v).manifest.hash!).sort());
    expect(stats.byHash[LIVE_HASH]).toEqual({ complete: 2, partial: 1 });
    expect(stats.byHash[r701]).toEqual({ complete: 1, partial: 0 });
    expect(stats.byHash[bundled("5.0.0").manifest.hash!]).toEqual({ complete: 0, partial: 0 });
    expect(JSON.stringify(stats)).not.toContain("an answer");
  });
});

// ── The draft's activity log ────────────────────────────────────────────────

describe("the draft trigger", () => {
  it("folds one editor's saves into one row, and a redelivered event changes nothing", async () => {
    await setUp();
    const first = withQuestion((await currentDraft()).draft);
    await save(first);
    await save(withQuestion(first, "And your favourite animal?"));

    const rows = await audit("draft.edited");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: EDITOR.uid, actorEmail: EDITOR.email, surveyId: SURVEY });
    expect(rows[0]!.subject).toBe("ybm_studio.favourite_colour, ybm_studio.favourite_animal");
    expect(rows[0]!.detail).toMatchObject({ fromRevision: 1, toRevision: 3, itemKeys: ["ybm_studio.favourite_colour", "ybm_studio.favourite_animal"] });
    expect((await data<SurveyDoc>(ref.survey())).draftEditors).toEqual([EDITOR.email]);

    // The same event again, as at-least-once delivery may do.
    const before = await dump();
    const doc = (await ref.draft().get()).data() as DraftSide;
    const previous = { ...doc, revision: 2, content: serialiseDraft(first) };
    await recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, previous, doc, new Date().toISOString());
    expect(await dump()).toEqual(before);
  });

  it("ignores the publish moving the draft's provenance", async () => {
    await setUp();
    const revision = await save(withQuestion((await currentDraft()).draft));
    const before = (await ref.draft().get()).data() as DraftSide;
    await publishAs(revision, "9.0.0");
    const after = (await ref.draft().get()).data() as DraftSide;
    const edited = await audit("draft.edited");
    await expect(recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, before, after, new Date().toISOString())).resolves.toEqual({
      kind: "ignore",
      why: "content unchanged",
    });
    expect(await audit("draft.edited")).toEqual(edited);
    // And a late event for a save the publish already included adds nobody to the next version's authors.
    expect((await data<SurveyDoc>(ref.survey())).draftEditors).toEqual([]);
    const late = { ...before, revision: revision - 1, content: serialiseDraft(extractDraft(R800.raw)) };
    await recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, late, before, new Date().toISOString());
    expect((await data<SurveyDoc>(ref.survey())).draftEditors).toEqual([]);
  });

  it("records an unlock on its own row, as the person who saved it", async () => {
    await setUp();
    const reason = "Ethics amendment AM-3 approved the new consent wording on 20 September.";
    await save(unlockModule((await currentDraft()).draft, "ybm_intro_consent", { by: "somebody.else@example.org", at: "2026-09-28T10:00:00Z", reason }).draft);
    const rows = await audit("draft.unlocked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: EDITOR.uid,
      actorEmail: EDITOR.email,
      subject: "ybm_intro_consent",
      detail: { reason, revision: 2, claimedBy: "somebody.else@example.org" },
    });
  });

  it("still records a save that carries a flood of made-up unlocks, with a bounded number of rows", async () => {
    await setUp();
    const before = (await ref.draft().get()).data() as DraftSide;
    const flooded = withQuestion((await currentDraft()).draft);
    // Within the rules' 900,000-character ceiling on a saved draft.
    for (let i = 0; i < 300; i += 1) {
      flooded.unlocked[`fake_module_${i}`] = { instrument: `fake_module_${i}`, by: "x", at: "x", reason: "r".repeat(1_500) };
    }
    expect(serialiseDraft(flooded).length).toBeLessThan(900_000);
    await ref.draft().update({
      content: serialiseDraft(flooded),
      revision: 2,
      updatedBy: EDITOR.uid,
      updatedByEmail: EDITOR.email,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const after = (await ref.draft().get()).data() as DraftSide;
    await recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, before, after, new Date().toISOString());
    const [row] = await audit("draft.edited");
    expect(row).toMatchObject({ actor: EDITOR.uid, subject: "ybm_studio.favourite_colour" });
    expect((row!.detail as { unlocksNotRowed: string[] }).unlocksNotRowed).toHaveLength(300 - MAX_UNLOCK_ROWS_PER_SAVE);
    expect(await audit("draft.unlocked")).toHaveLength(MAX_UNLOCK_ROWS_PER_SAVE);
  });

  it("records a save it cannot read, without failing", async () => {
    await setUp();
    const before = (await ref.draft().get()).data() as DraftSide;
    await ref.draft().update({ content: "{not a draft", revision: 2, updatedBy: EDITOR.uid, updatedByEmail: EDITOR.email, updatedAt: FieldValue.serverTimestamp() });
    const after = (await ref.draft().get()).data() as DraftSide;
    await expect(recordDraftWrite(db, { study: STUDY, surveyId: SURVEY, docId: "current" }, before, after, new Date().toISOString())).resolves.toMatchObject({
      kind: "edit",
      unparsable: true,
    });
    expect(await audit("draft.edited")).toMatchObject([{ subject: "", detail: { unparsable: true, toRevision: 2 } }]);
  });
});
