import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";

/**
 * The study's database, as the Admin SDK sees it, for setting the scene and
 * checking the outcome — never for doing the thing under test. Everything the
 * test asserts about happens through the browser.
 */

export const STUDY = "ybm";
export const SURVEY = "ybm_nd2026_standard";
export const R710_HASH = "sha256:308f47ba5b447f455613a183430d9b4a4ad86a9c39d1de43576b12d15d975bee";

export interface Study {
  db: Firestore;
  close(): Promise<void>;
}

export function openStudy(): Study {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("the Studio suite needs the emulators; run it with `pnpm test:e2e:studio`");
  }
  const app: App = initializeApp({ projectId: process.env["GCLOUD_PROJECT"] ?? "demo-myself" }, `studio-e2e-${Date.now()}`);
  return { db: getFirestore(app), close: () => deleteApp(app) };
}

/** Put someone on the Studio list, as the command-line bootstrap would. */
export async function addMember(db: Firestore, email: string, role: "viewer" | "editor" | "publisher" | "admin"): Promise<void> {
  const key = email.trim().toLowerCase();
  await db.doc(paths.studioMember(STUDY, key)).set({
    email: key,
    role,
    addedAt: new Date(),
    addedBy: "e2e",
    addedByEmail: null,
    note: "Added by the end-to-end test",
  });
}

/**
 * A sitting recorded under r7.1.0 before the Studio existed — the historical
 * data the brief says must stay readable and unchanged. Shaped as saveSitting
 * stores one (packages/firebase/src/layout.ts SessionDoc).
 */
export async function seedHistoricalSitting(db: Firestore): Promise<{ id: string; before: string }> {
  const id = "ses_01HISTORICALR710SITTING00";
  const doc = {
    sessionId: id,
    deviceId: "ipad_historical",
    study: STUDY,
    studyCode: "NDC0001",
    releaseKey: "ybm_nd2026_standard_r7_1_0",
    releaseHash: R710_HASH,
    startedAt: "2026-09-20T09:00:00.000Z",
    completedAt: "2026-09-20T09:40:00.000Z",
    complete: true,
    events: [
      { seq: 0, type: "session.started", payload: { releaseHash: R710_HASH, val_id: "NDC0001" }, tWall: "2026-09-20T09:00:00.000Z", tMono: 0 },
      {
        seq: 1,
        type: "response.recorded",
        itemKey: "kss.q1",
        payload: { value: { kind: "choice", code: 3 } },
        tWall: "2026-09-20T09:10:00.000Z",
        tMono: 600000,
      },
      { seq: 2, type: "session.completed", payload: { totalMs: 2400000 }, tWall: "2026-09-20T09:40:00.000Z", tMono: 2400000 },
    ],
    chunkCount: 0,
    eventCount: 3,
    receivedAt: "2026-09-20T09:41:00.000Z",
    quarantined: false,
    provenance: "device",
  };
  await db.doc(paths.session(STUDY, id)).set(doc);
  return { id, before: await sittingJson(db, id) };
}

/** A sitting exactly as stored, keys sorted, so two readings compare byte for byte. */
export async function sittingJson(db: Firestore, id: string): Promise<string> {
  const snap = await db.doc(paths.session(STUDY, id)).get();
  return JSON.stringify(sortKeys(snap.data() ?? null));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export async function livePointer(db: Firestore): Promise<{ hash: string; version: string; generation: number } | null> {
  const snap = await db.doc(paths.publishedPointer(STUDY, SURVEY)).get();
  return snap.exists ? (snap.data() as { hash: string; version: string; generation: number }) : null;
}

/** The sittings filed for one study code, as the device uploaded them. */
export async function sittingsFor(db: Firestore, studyCode: string): Promise<{ sessionId: string; releaseHash: string; releaseKey: string; complete: boolean }[]> {
  const snap = await db.collection(paths.sessions(STUDY)).where("studyCode", "==", studyCode).get();
  return snap.docs.map((d) => d.data() as { sessionId: string; releaseHash: string; releaseKey: string; complete: boolean });
}

export async function auditActions(db: Firestore): Promise<string[]> {
  const snap = await db.collection(paths.studioAudit(STUDY)).get();
  return snap.docs.map((d) => String(d.get("action")));
}
