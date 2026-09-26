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

export interface StudyPull {
  sessions: DeviceSession[];
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

  const sessions: DeviceSession[] = [];
  const unreadable: string[] = [];
  let quarantined = 0;

  for (const document of snapshot.docs) {
    const data = document.data() as SessionDoc;
    if (data.quarantined === true) {
      quarantined += 1;
      continue;
    }
    try {
      const chunks: ChunkDoc[] =
        data.chunkCount > 0
          ? (await getDocs(collection(db, paths.sessionChunks(STUDY, data.sessionId)))).docs.map(
              (c) => c.data() as ChunkDoc,
            )
          : [];
      sessions.push(joinSession(data, chunks));
    } catch {
      unreadable.push(data.sessionId);
    }
  }

  return { sessions, quarantined, unreadable };
}

// ── Devices ────────────────────────────────────────────────────────────────

export interface EnrolledDevice {
  deviceId: string;
  label: string;
  /** The one-time token to paste into that iPad. Shown once and never stored. */
  token: string;
}

/**
 * Enrol an iPad, and hand back the token to paste into it.
 *
 * WHY THIS IS HERE AT ALL. `enrolDevice` existed in the functions and nothing
 * called it, so there was no way to enrol a device — which made the whole sync
 * path unusable however correct it was. A capability with no caller is a
 * capability the study does not have.
 *
 * OWNER ONLY, enforced server-side. This UI hides the panel from anyone else as
 * a courtesy, not as the control: minting a credential is not something a browser
 * decides it may do, and the function checks the claim itself.
 *
 * The token is returned once, is valid for an hour, and is spent the moment the
 * iPad uses it. Nothing here writes it down.
 */
export async function enrolDevice(label: string): Promise<EnrolledDevice> {
  const call = httpsCallable<{ label: string }, EnrolledDevice>(firebase().fns, "enrolDevice");
  const { data } = await call({ label: label.trim() });
  return data;
}

/**
 * Stop an iPad posting anything more.
 *
 * For a device that has gone missing rather than one handed back: it disables the
 * account and revokes the refresh token, so the session the device already holds
 * stops working too.
 */
export async function revokeDevice(deviceId: string): Promise<void> {
  const call = httpsCallable<{ deviceId: string }, unknown>(firebase().fns, "revokeDevice");
  await call({ deviceId });
}
