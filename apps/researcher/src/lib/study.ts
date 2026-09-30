import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { collection, getDocs, getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, httpsCallable, type Functions } from "firebase/functions";
import { joinSession, paths, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import { publishedPaths } from "@myself/schema";
import type { DeviceSession } from "@myself/store";

/**
 * Reading the study back.
 *
 * The gap this closes: iPads now file their sittings into Firestore, and nothing
 * could read them. The researcher view ingested files carried off a device by
 * hand, the nightly BIDS export landed in a Storage bucket reachable only from a
 * console, and "the data is in the database" was true and useless.
 *
 * IT READS DIRECTLY, not through a function. `firestore.rules` already allows
 * `read: if isPerson()` on sittings and their chunks — a signed-in account
 * carrying an owner, researcher or analyst role an owner granted — so a function
 * in front of this would be a second copy of an access rule that already exists,
 * and the copy is how one of them ends up wrong.
 *
 * A POPUP IS FINE HERE. The participant app cannot use `signInWithPopup` because
 * it runs as a standalone iOS web app, which is why devices enrol with a custom
 * token instead. This is a laptop with a browser, where a popup is the ordinary
 * thing and the researcher is present to click it.
 *
 * THE FILE ROUTE STAYS. A school hall with no usable wifi is the normal case,
 * and both routes land in the same table keyed on the same session id, so a
 * sitting that arrives by both roads is one sitting.
 */

declare const __FIREBASE_CONFIG__: string;
declare const __STUDY__: string;

function parseConfig(): Record<string, string> | null {
  try {
    const parsed = JSON.parse(__FIREBASE_CONFIG__ || "null") as Record<string, string> | null;
    return parsed && parsed["apiKey"] && parsed["projectId"] ? parsed : null;
  } catch {
    return null;
  }
}

const config = parseConfig();

/** Whether this build was pointed at a study at all. */
export const studyAvailable = config !== null;

export const STUDY = __STUDY__ || "ybm";

let app: FirebaseApp | null = null;

/**
 * The region has to match where the functions are deployed.
 *
 * `getFunctions(app)` defaults to us-central1 and fails with a CORS error that
 * looks like a permissions problem, which sends whoever reads it to the IAM
 * console rather than to this line.
 */
const REGION = "europe-west2";

function firebase(): { auth: Auth; db: Firestore; fns: Functions } {
  if (!config) throw new Error("this build has no study configured");
  app ??= initializeApp(config);
  return { auth: getAuth(app), db: getFirestore(app), fns: getFunctions(app, REGION) };
}

export async function signIn(): Promise<void> {
  await signInWithPopup(firebase().auth, new GoogleAuthProvider());
}

export async function signOutOfStudy(): Promise<void> {
  await signOut(firebase().auth);
}

export interface StudyUser {
  email: string | null;
  /** The role an owner granted, or null for an account that has none. */
  role: string | null;
}

/**
 * Who is signed in, and what the study says they may do.
 *
 * The role is read off the token rather than guessed from the email, and it is
 * reported even when absent: "signed in with no role" is a specific, fixable
 * situation — an owner has to grant one — and a view that showed only "signed
 * in" would leave somebody staring at an empty study wondering which half was
 * broken.
 */
export function watchUser(listener: (user: StudyUser | null) => void): () => void {
  if (!config) {
    listener(null);
    return () => undefined;
  }
  return onAuthStateChanged(firebase().auth, (user: User | null) => {
    if (!user) {
      listener(null);
      return;
    }
    void user.getIdTokenResult().then((result) => {
      const role = result.claims["role"];
      listener({ email: user.email, role: typeof role === "string" ? role : null });
    });
  });
}

/**
 * A sitting as pulled, with the time the study last received it.
 *
 * `receivedAt` is the server's clock, written on every upload. It is what decides
 * whether an unfinished sitting is still in progress or has been abandoned, in the
 * dashboard and here alike (`lifecycleOf` in @myself/store), and a device's own clock
 * can be hours out — so it is kept rather than dropped at the door.
 */
export type PulledSitting = DeviceSession & { receivedAt?: string };

export interface StudyPull {
  sessions: PulledSitting[];
  /** Sittings the study is holding back for review, and so left out of here. */
  quarantined: number;
  /** Sittings that could not be reassembled, named so somebody can go and look. */
  unreadable: string[];
}

/**
 * Every sitting the study holds, reassembled.
 *
 * QUARANTINED SITTINGS ARE LEFT OUT, the same as the nightly export does. One is
 * quarantined because the study holds two copies that contradict each other, and
 * until a person has decided which is real, pulling either into a dataset is
 * choosing for them.
 *
 * A SITTING THAT CANNOT BE REASSEMBLED IS NAMED, not skipped quietly and not
 * allowed to fail the whole pull. `joinSession` throws rather than returning a
 * short log when a spilled sitting is missing a chunk — the one way a sitting
 * could lose data invisibly — so the honest report is "these thirty came, this
 * one is torn, go and look at it".
 */
export async function pullSittings(): Promise<StudyPull> {
  const { db } = firebase();
  const snapshot = await getDocs(collection(db, paths.sessions(STUDY)));

  return assemblePull(
    snapshot.docs.map((document) => document.data() as SessionDoc),
    async (sessionId) =>
      (await getDocs(collection(db, paths.sessionChunks(STUDY, sessionId)))).docs.map((c) => c.data() as ChunkDoc),
  );
}

/**
 * Turn what the database holds into sittings, or say why it could not.
 *
 * Separated from the querying so it can be tested without a browser or an emulator,
 * because the decisions here are the ones with consequences and the query is four lines
 * of SDK. It is also the path by which a researcher gets data at all: a bug in it means
 * sittings that are safely in the database and unreachable, which is the failure this
 * whole read path was built to fix.
 */
export async function assemblePull(
  documents: readonly SessionDoc[],
  chunksFor: (sessionId: string) => Promise<ChunkDoc[]>,
): Promise<StudyPull> {
  const sessions: PulledSitting[] = [];
  const unreadable: string[] = [];
  let quarantined = 0;

  for (const data of documents) {
    if (data.quarantined === true) {
      quarantined += 1;
      continue;
    }
    try {
      // Only fetched when the sitting says it spilled. A normal sitting is one document,
      // and reading a collection that does not exist for every one of them would double
      // the cost of a pull for nothing.
      const chunks = data.chunkCount > 0 ? await chunksFor(data.sessionId) : [];
      sessions.push({ ...joinSession(data, chunks), ...(data.receivedAt ? { receivedAt: data.receivedAt } : {}) });
    } catch {
      /**
       * Named, not dropped, and not allowed to fail the whole pull.
       *
       * `joinSession` throws rather than returning a short log when a spilled sitting is
       * missing a chunk — the one way a sitting could lose data invisibly. So the honest
       * report is "these thirty came, this one is torn, go and look at it", and the
       * thirty still arrive.
       */
      unreadable.push(data.sessionId);
    }
  }

  return { sessions, quarantined, unreadable };
}

// ── Versions published from the dashboard (D-54) ──────────────────────────────

/**
 * The versions published from the dashboard, as the database holds them.
 *
 * Readable by anyone (`firestore.rules`), so this needs no role; it is read on
 * signing in because that is when this view starts reading the study. The
 * documents are checked against their hashes by `addPublishedReleases` in
 * releases.ts, not here.
 */
export async function readPublishedReleases(): Promise<{ id: string; data: unknown }[]> {
  const { db } = firebase();
  const snapshot = await getDocs(collection(db, publishedPaths.releases(STUDY)));
  return snapshot.docs.map((document) => ({ id: document.id, data: document.data() }));
}

// ── Devices ────────────────────────────────────────────────────────────────

/**
 * Stop one device filing anything more.
 *
 * NOTHING IS ENROLLED ANY MORE — a participant opens the URL on any iPad and takes
 * part, and the device registers itself on its first upload. So there is no
 * enrolment panel here, and no `enrolDevice` in the functions: `revokeDevice` is
 * what took its place.
 *
 * Revoking still matters, and arguably more: the way to deal with a device posting
 * something it should not — a stray iPad, a duplicate, an obvious test run from
 * outside the room — is to take its identity away. The device id is on every
 * sitting in the table, so it can be read off the row and pasted here. The device
 * is marked revoked, which `registerDevice` checks on every upload, and an older
 * device that was given an account of its own has that account disabled and its
 * refresh token revoked as well.
 */
export async function revokeDevice(deviceId: string): Promise<void> {
  const call = httpsCallable<{ deviceId: string }, unknown>(firebase().fns, "revokeDevice");
  await call({ deviceId });
}
