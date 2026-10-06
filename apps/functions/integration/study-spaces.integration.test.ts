import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import { hashHex, type ReleaseManifest } from "@myself/schema";
import { addQuestion, parseDraft, serialiseDraft, type AuditDoc, type DraftDoc, type SessionResponse } from "@myself/studio";
import type { DeviceEvent, DeviceSession } from "@myself/store";
import { llmRelay } from "../src/relay.js";
import { latestRelease, releaseResolver } from "../src/releases.js";
import { saveNarrative } from "../src/narratives.js";
import { saveSitting } from "../src/sittings.js";
import { transcribe } from "../src/transcribe.js";
import { studioCreateStudy, studioCreateSurvey, studioImportLive, studioResponseStats, studioSession, studioSetStudy } from "../src/studio/functions.js";
import { publish } from "../src/studio/publish.js";
import { createStudy, setStudy } from "../src/studio/study-spaces.js";
import { createSurvey } from "../src/studio/surveys.js";

/**
 * Study spaces against a real Firestore (D-56, docs/16 §11).
 *
 * What only a database shows: that a sitting lands in the study it names and
 * nowhere else, that an unknown or closed study is refused before anything is
 * written, that creating a study is one transaction, that a Studio role in one
 * study is nothing in another when the callables themselves are called, and
 * that MyStory's three endpoints resolve the study before anything else.
 *
 * The DEFAULT app, as in the participant-devices suite: the endpoints reach
 * Firestore through `research()`, exactly as deployed, and are called here
 * through their own exported handlers — `onRequest` with a request and a
 * response, `onCall` through `.run` — so the wiring is under test as well as
 * the cores.
 */

const FUTURE = "future";

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
  for (const study of ["ybm", FUTURE, "nowhere", "leftover", "other"]) {
    await db.recursiveDelete(db.doc(paths.study(study)));
  }
});

// ── Calling the endpoints as they are deployed ─────────────────────────────

interface Reply {
  status: number;
  body: { error?: { kind?: string; message?: string; limit?: string }; stored?: number; outcomes?: { stored: boolean }[] } & Record<string, unknown>;
}

/** POST to an `onRequest` handler, from the study's own page, as an iPad or anybody. */
async function post(handler: unknown, body: unknown, authorization?: string): Promise<Reply> {
  let status = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    set(key: string, value: string) {
      headers.set(key.toLowerCase(), value);
      return res;
    },
    setHeader(key: string, value: string) {
      headers.set(key.toLowerCase(), value);
    },
    getHeader: (key: string) => headers.get(key.toLowerCase()),
    end: () => res,
    on: () => res,
  };
  const req = {
    method: "POST",
    headers: { origin: "https://faisalmushtaq.github.io", ...(authorization ? { authorization } : {}) },
    body,
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
    get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  };
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return { status, body: (payload ?? {}) as Reply["body"] };
}

const credential = (installId = "ipad_01ABC", secret = "s".repeat(43)) => `Device ${installId}.${secret}`;

function sitting(sessionId: string, releaseHash = latestRelease!.hash!): DeviceSession {
  const events: DeviceEvent[] = [
    { seq: 0, type: "session.started", payload: { releaseHash }, tWall: "2026-10-06T09:00:00.000Z", tMono: 0 },
    { seq: 1, type: "session.completed", tWall: "2026-10-06T09:10:00.000Z", tMono: 600_000 },
  ];
  return {
    sessionId,
    studyCode: "NDC0001",
    releaseKey: "x_r1_0_0",
    releaseHash,
    startedAt: "2026-10-06T09:00:00.000Z",
    completedAt: "2026-10-06T09:10:00.000Z",
    complete: true,
    events,
  };
}

const upload = (sessionId: string, study?: string) => ({
  ...(study === undefined ? {} : { study }),
  sentAt: new Date().toISOString(),
  sittings: [sitting(sessionId)],
});

const exists = async (path: string) => (await db.doc(path).get()).exists;

/** Everything under a study, so a refusal can be shown to have written nothing. */
async function everythingUnder(study: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (collection: FirebaseFirestore.CollectionReference) => {
    for (const doc of await collection.listDocuments()) {
      if ((await doc.get()).exists) out.push(doc.path);
      for (const sub of await doc.listCollections()) await walk(sub);
    }
  };
  for (const collection of await db.doc(paths.study(study)).listCollections()) await walk(collection);
  if (await exists(paths.study(study))) out.push(paths.study(study));
  return out.sort();
}

const OWNER = { uid: "u_owner", email: "owner@leeds.test" };
const ownerToken = { role: "owner", email: OWNER.email, email_verified: true, firebase: { sign_in_provider: "google.com" } };
const googleToken = (email: string) => ({ email, email_verified: true, firebase: { sign_in_provider: "google.com" } });

/** An `onCall` handler, called as the SDK would call it for this account. */
async function callAs<T>(fn: unknown, uid: string | null, token: Record<string, unknown>, data: unknown): Promise<T> {
  const request = { data, auth: uid ? { uid, token } : undefined, rawRequest: {} } as unknown as CallableRequest;
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

const openFuture = () => createStudy(db, { study: FUTURE, title: "Perspectives of the future", actor: OWNER });

// ── Filing sittings ─────────────────────────────────────────────────────────

describe("filing a sitting into a study", () => {
  it("files into the default study when the upload names none, exactly as before", async () => {
    const reply = await post(saveSitting, upload("ses_default"), credential());
    expect(reply.status).toBe(200);
    expect(reply.body.stored).toBe(1);
    expect(await exists(paths.session("ybm", "ses_default"))).toBe(true);
    expect(await exists(paths.device("ybm", "ipad_01ABC"))).toBe(true);
  });

  it("files into a study space it names, registering the iPad there and touching ybm not at all", async () => {
    await openFuture();
    const before = await everythingUnder("ybm");
    const reply = await post(saveSitting, upload("ses_future", FUTURE), credential());
    expect(reply.status).toBe(200);
    const stored = (await db.doc(paths.session(FUTURE, "ses_future")).get()).data();
    expect(stored).toMatchObject({ study: FUTURE, deviceId: "ipad_01ABC", provenance: "device" });
    expect(await exists(paths.device(FUTURE, "ipad_01ABC"))).toBe(true);
    expect(await everythingUnder("ybm")).toEqual(before);
  });

  it("files two studies' sittings from one iPad each into its own study", async () => {
    await openFuture();
    expect((await post(saveSitting, upload("ses_a"), credential())).status).toBe(200);
    expect((await post(saveSitting, upload("ses_b", FUTURE), credential())).status).toBe(200);
    expect(await exists(paths.session("ybm", "ses_a"))).toBe(true);
    expect(await exists(paths.session(FUTURE, "ses_a"))).toBe(false);
    expect(await exists(paths.session(FUTURE, "ses_b"))).toBe(true);
    expect(await exists(paths.session("ybm", "ses_b"))).toBe(false);
  });

  it("refuses a study that was never created, writing nothing anywhere", async () => {
    const reply = await post(saveSitting, upload("ses_x", "nowhere"), credential());
    expect(reply.status).toBe(404);
    expect(reply.body.error?.message).toMatch(/not a study this project runs/);
    expect(await everythingUnder("nowhere")).toEqual([]);
    expect(await exists(paths.device("ybm", "ipad_01ABC"))).toBe(false);
  });

  it("refuses an id that could name another document, before reading anything", async () => {
    for (const study of ["../ybm", "ybm/sessions", "Future", ""]) {
      const reply = await post(saveSitting, upload("ses_x", study), credential());
      expect(reply.status, study).toBe(400);
    }
  });

  it("in a closed study, refuses a new iPad and still takes one it knows, so nothing collected is lost", async () => {
    await openFuture();
    expect((await post(saveSitting, upload("ses_before", FUTURE), credential())).status).toBe(200);
    await setStudy(db, { study: FUTURE, status: "closed", actor: OWNER });

    const stranger = await post(saveSitting, upload("ses_stranger", FUTURE), credential("ipad_02NEW"));
    expect(stranger.status).toBe(403);
    expect(stranger.body.error?.message).toMatch(/closed/);
    expect(await exists(paths.session(FUTURE, "ses_stranger"))).toBe(false);
    expect(await exists(paths.device(FUTURE, "ipad_02NEW"))).toBe(false);

    const known = await post(saveSitting, upload("ses_after", FUTURE), credential());
    expect(known.status).toBe(200);
    expect(await exists(paths.session(FUTURE, "ses_after"))).toBe(true);

    // Reopened, it takes new iPads again.
    await setStudy(db, { study: FUTURE, status: "open", actor: OWNER });
    expect((await post(saveSitting, upload("ses_new", FUTURE), credential("ipad_02NEW"))).status).toBe(200);
  });
});

// ── Creating and changing a study space ─────────────────────────────────────

describe("creating a study space", () => {
  it("writes the registry, its creator as its first admin, and both audit rows, together", async () => {
    await openFuture();
    const doc = (await db.doc(paths.study(FUTURE)).get()).data();
    expect(doc).toMatchObject({ study: FUTURE, title: "Perspectives of the future", status: "open", createdBy: OWNER.uid, closedAt: null });
    expect(JSON.stringify(doc)).not.toContain(OWNER.email);
    expect((await db.doc(paths.studioMember(FUTURE, OWNER.email)).get()).data()).toMatchObject({ role: "admin", addedBy: OWNER.uid });
    const audit = (await db.collection(paths.studioAudit(FUTURE)).get()).docs.map((d) => d.data() as AuditDoc);
    expect(audit.map((r) => r.action).sort()).toEqual(["access.member_set", "study.created"]);
  });

  it("refuses the default's id, a taken id, and an id with data already under it, writing nothing", async () => {
    await openFuture();
    await db.doc(paths.session("leftover", "ses_old")).set({ sessionId: "ses_old" });
    for (const [study, code] of [
      ["ybm", "already-exists"],
      [FUTURE, "already-exists"],
      ["leftover", "already-exists"],
    ] as const) {
      const before = [...(await everythingUnder(study))];
      const error = await refusalOf(createStudy(db, { study, title: "Again", actor: OWNER }));
      expect(error.code, study).toBe(code);
      expect(await everythingUnder(study)).toEqual(before);
    }
  });

  it("closes, reopens and renames, auditing each change once and keeping the last closure", async () => {
    await openFuture();
    await setStudy(db, { study: FUTURE, status: "closed", actor: OWNER });
    const closed = (await db.doc(paths.study(FUTURE)).get()).data()!;
    expect(closed["status"]).toBe("closed");
    expect(closed["closedAt"]).not.toBeNull();
    // The same again changes nothing and records nothing.
    await setStudy(db, { study: FUTURE, status: "closed", actor: OWNER });
    await setStudy(db, { study: FUTURE, status: "open", title: "The future", actor: OWNER });
    const reopened = (await db.doc(paths.study(FUTURE)).get()).data()!;
    expect(reopened).toMatchObject({ status: "open", title: "The future" });
    expect(reopened["closedAt"]).toEqual(closed["closedAt"]);
    const updates = (await db.collection(paths.studioAudit(FUTURE)).where("action", "==", "study.updated").get()).size;
    expect(updates).toBe(2);
  });

  it("gives the default study a document only when an owner asks, changing nothing else of ybm's", async () => {
    await db.doc(paths.session("ybm", "ses_kept")).set({ sessionId: "ses_kept", study: "ybm" });
    const before = await everythingUnder("ybm");
    await setStudy(db, { study: "ybm", title: "Yorkshire Brain Map", actor: OWNER });
    const after = await everythingUnder("ybm");
    expect(after.filter((p) => !before.includes(p)).every((p) => p === paths.study("ybm") || p.startsWith(`${paths.studioAudit("ybm")}/`))).toBe(true);
    expect((await db.doc(paths.study("ybm")).get()).data()).toMatchObject({ study: "ybm", title: "Yorkshire Brain Map", status: "open" });
    expect((await db.doc(paths.session("ybm", "ses_kept")).get()).data()).toEqual({ sessionId: "ses_kept", study: "ybm" });
  });

  it("is an owner's alone, through the callable", async () => {
    await db.doc(paths.studioMember("ybm", "ada.admin@example.org")).set({ email: "ada.admin@example.org", role: "admin" });
    const admin = await refusalOf(callAs(studioCreateStudy, "u_ada", googleToken("ada.admin@example.org"), { study: "other", title: "Other" }));
    expect(admin.code).toBe("permission-denied");
    expect(await exists(paths.study("other"))).toBe(false);
    const closer = await refusalOf(callAs(studioSetStudy, "u_ada", googleToken("ada.admin@example.org"), { study: "ybm", status: "closed" }));
    expect(closer.code).toBe("permission-denied");

    await expect(callAs(studioCreateStudy, OWNER.uid, ownerToken, { study: "other", title: "Other" })).resolves.toEqual({ study: "other" });
    expect(await exists(paths.study("other"))).toBe(true);
  });
});

// ── The Studio, study by study ──────────────────────────────────────────────

describe("the Studio's callables in two study spaces", () => {
  const FAY = "fay.future@example.org";
  const ADA = "ada.admin@example.org";
  beforeEach(async () => {
    await openFuture();
    await db.doc(paths.studioMember(FUTURE, FAY)).set({ email: FAY, role: "admin" });
    await db.doc(paths.studioMember("ybm", ADA)).set({ email: ADA, role: "admin" });
  });

  it("tell each person which studies they may open, and their role in each", async () => {
    const fay = await callAs<SessionResponse>(studioSession, "u_fay", googleToken(FAY), { study: FUTURE });
    expect(fay).toMatchObject({ role: "admin", study: FUTURE, defaultStudy: "ybm", owner: false });
    expect(fay.studies?.map((s) => s.study)).toEqual([FUTURE]);

    const fayInYbm = await callAs<SessionResponse>(studioSession, "u_fay", googleToken(FAY), {});
    expect(fayInYbm).toMatchObject({ role: null, reason: "not_listed", study: "ybm" });

    const ada = await callAs<SessionResponse>(studioSession, "u_ada", googleToken(ADA), {});
    expect(ada.studies?.map((s) => s.study)).toEqual(["ybm"]);

    const owner = await callAs<SessionResponse>(studioSession, OWNER.uid, ownerToken, { study: FUTURE });
    expect(owner).toMatchObject({ role: "admin", owner: true });
    expect(owner.studies?.map((s) => s.study)).toEqual(["ybm", FUTURE]);

    const lost = await callAs<SessionResponse>(studioSession, "u_fay", googleToken(FAY), { study: "nowhere" });
    expect(lost).toMatchObject({ role: null, reason: "unknown_study", study: "nowhere" });
  });

  it("check the caller against the list of the study the request names", async () => {
    // Fay is admin of future: she creates a survey there.
    await callAs(studioCreateSurvey, "u_fay", googleToken(FAY), { study: FUTURE, surveyId: "future_main", title: "Future" });
    expect(await exists(paths.studioSurvey(FUTURE, "future_main"))).toBe(true);

    // In ybm she is nobody, whether ybm is named or left as the default.
    for (const data of [{ study: "ybm", surveyId: "x_one", title: "X" }, { surveyId: "x_two", title: "X" }]) {
      const error = await refusalOf(callAs(studioCreateSurvey, "u_fay", googleToken(FAY), data));
      expect(error.code).toBe("permission-denied");
    }
    expect(await exists(paths.studioSurvey("ybm", "x_one"))).toBe(false);

    // And Ada, ybm's admin, is nobody in future.
    const ada = await refusalOf(callAs(studioResponseStats, "u_ada", googleToken(ADA), { study: FUTURE, surveyId: "future_main" }));
    expect(ada.code).toBe("permission-denied");

    // A study that does not exist is refused before anybody's list is read.
    const lost = await refusalOf(callAs(studioCreateSurvey, OWNER.uid, ownerToken, { study: "nowhere", surveyId: "x_three", title: "X" }));
    expect(lost.code).toBe("not-found");
    expect(await everythingUnder("nowhere")).toEqual([]);
  });

  it("keep “Set up from the live survey” to the study whose releases this build carries", async () => {
    const error = await refusalOf(callAs(studioImportLive, OWNER.uid, ownerToken, { study: FUTURE, surveyId: "ybm_nd2026_standard" }));
    expect(error.code).toBe("failed-precondition");
    expect(await exists(paths.publishedPointer(FUTURE, "ybm_nd2026_standard"))).toBe(false);
  });

  it("publish a survey in a study space into that study's store, for its own link", async () => {
    await createSurvey(db, { study: FUTURE, surveyId: "future_main", title: "Perspectives of the future", actor: { uid: "u_fay", email: FAY } });
    const draftRef = db.doc(paths.studioDraft(FUTURE, "future_main"));
    const current = (await draftRef.get()).data() as DraftDoc;
    const draft = parseDraft(current.content);
    const edited = addQuestion(draft, { sectionKey: draft.composition.sections[0]!.key, typeId: "long_text", text: "How do you imagine your life in ten years?" }).draft;
    await draftRef.update({
      content: serialiseDraft(edited),
      revision: current.revision + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "u_fay",
      updatedByEmail: FAY,
    });

    const published = await publish(db, {
      study: FUTURE,
      surveyId: "future_main",
      expectedRevision: current.revision + 1,
      version: "1.0.0",
      releaseNote: "The first version.",
      actor: { uid: "u_fay", email: FAY },
    });
    const pointer = (await db.doc(paths.publishedPointer(FUTURE, "future_main")).get()).data();
    expect(pointer).toMatchObject({ study: FUTURE, surveyId: "future_main", hash: published.hash, version: "1.0.0" });
    const stored = (await db.doc(paths.publicRelease(FUTURE, hashHex(published.hash))).get()).data()!;
    const manifest = JSON.parse(stored["manifest"] as string) as ReleaseManifest;
    expect(manifest.release).toMatchObject({ study: FUTURE, assessment: "future_main" });

    // Found in its own study and nowhere else.
    const resolve = releaseResolver();
    expect((await resolve(db, FUTURE, published.hash))?.manifest.release.assessment).toBe("future_main");
    expect(await resolve(db, "ybm", published.hash)).toBeNull();
    expect(await exists(paths.publishedPointer("ybm", "future_main"))).toBe(false);
  });
});

// ── MyStory's endpoints ─────────────────────────────────────────────────────

describe("MyStory's endpoints find the sitting's study first", () => {
  const run = (sessionId: string, study?: string) => ({
    ...(study === undefined ? {} : { study }),
    sessionId,
    protocolKey: "np.phone_wellbeing",
    protocolVersion: "0.1.1",
    records: [],
    finished: false,
    releaseHash: `sha256:${"a".repeat(64)}`,
  });

  const relayCall = (study?: string, releaseHash = latestRelease!.hash!) => ({
    ...(study === undefined ? {} : { study }),
    prompt: { system: "Be kind.", messages: [{ role: "user", content: "Hello" }] },
    modelConfigKey: "openai.gpt_4o_mini.interviewer",
    protocolKey: "np.phone_wellbeing",
    releaseHash,
  });

  it("stores a run beside its sitting, in the study it names", async () => {
    await openFuture();
    expect((await post(saveNarrative, run("ses_n1", FUTURE), credential())).status).toBe(200);
    expect((await db.doc(paths.narrative(FUTURE, "ses_n1")).get()).data()).toMatchObject({ uid: "ipad_01ABC", provenance: "study" });
    expect(await exists(paths.narrative("ybm", "ses_n1"))).toBe(false);
    expect((await post(saveNarrative, run("ses_n2"), credential())).status).toBe(200);
    expect(await exists(paths.narrative("ybm", "ses_n2"))).toBe(true);
  });

  it("refuse a study that does not exist, registering nobody and counting nothing", async () => {
    for (const [name, handler, body] of [
      ["the relay", llmRelay, relayCall("nowhere")],
      ["saveNarrative", saveNarrative, run("ses_n3", "nowhere")],
      ["transcribe", transcribe, { study: "nowhere", audio: "A".repeat(64), mimeType: "audio/webm", protocolKey: "np.x", sessionId: "ses_n3" }],
    ] as const) {
      const reply = await post(handler, body, credential());
      expect(reply.status, name).toBe(404);
    }
    expect(await everythingUnder("nowhere")).toEqual([]);
    expect(await exists(paths.device("ybm", "ipad_01ABC"))).toBe(false);
  });

  it("switch MyStory off for a closed study's iPads, before any release is looked at or call counted", async () => {
    await openFuture();
    await post(saveSitting, upload("ses_c1", FUTURE), credential());
    await setStudy(db, { study: FUTURE, status: "closed", actor: OWNER });
    for (const [name, handler, body] of [
      ["the relay", llmRelay, relayCall(FUTURE)],
      ["transcribe", transcribe, { study: FUTURE, audio: "A".repeat(64), mimeType: "audio/webm", protocolKey: "np.x", sessionId: "ses_c1" }],
    ] as const) {
      const reply = await post(handler, body, credential());
      expect(reply.status, name).toBe(429);
      expect(reply.body.error?.limit, name).toBe("off");
    }
    expect((await db.collection(`${paths.audit(FUTURE)}_relayDevices`).get()).empty).toBe(true);
  });

  it("refuse a release the sitting's study never published — even one ybm ships — before the provider", async () => {
    await openFuture();
    const reply = await post(llmRelay, relayCall(FUTURE, latestRelease!.hash!), credential());
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toMatch(/has not published/);
    // The iPad is registered in future (that is who asked) and nothing was counted.
    expect(await exists(paths.device(FUTURE, "ipad_01ABC"))).toBe(true);
    expect((await db.collection(`${paths.audit(FUTURE)}_relayDevices`).get()).empty).toBe(true);
  });
});
