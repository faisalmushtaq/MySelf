import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

/**
 * The iPad's own identity on the study.
 *
 * NOBODY REGISTERS A DEVICE. A participant opens the study's URL on whatever iPad
 * is in front of them and takes part; the app signs itself in on first upload and
 * that is the whole setup. An earlier version had a researcher mint a token in a
 * console and paste it into each device, which is a barrier in front of the one
 * thing this exists to do.
 *
 * SO WHY SIGN IN AT ALL? Because the server's no-overwrite rule turns on which
 * device a sitting came from: two copies of one session id from two devices are
 * quarantined rather than merged, and the same device's own retry is idempotent.
 * That decision has to rest on something the device cannot simply claim, so it
 * rests on an anonymous Firebase identity — which the participant never sees, is
 * created without asking them anything, and carries no permission beyond filing
 * sittings. It cannot make a model call or read the study back.
 *
 * ITS LIFETIME IS EXACTLY THE DATA'S LIFETIME, which is what makes it safe to
 * rely on. The identity is held in this origin's IndexedDB, next to the AES key
 * that the sittings are encrypted with. Clear one and you have cleared the other,
 * so there is no state in which a device has readable sittings but has forgotten
 * who it is — the case that would otherwise send a re-upload in under a new
 * identity and have it quarantined as a second device.
 *
 * NO POPUP, NO REDIRECT, NO THIRD-PARTY COOKIE, which is what makes it work in a
 * page added to the iOS Home Screen. The lab page's `signInWithPopup` does not,
 * and the four reverted commits at the top of main were that.
 *
 * NONE OF THE CONFIGURATION IS SECRET. A Firebase web config is a set of public
 * identifiers — the `apiKey` names a project, it does not authorise anything. It
 * is baked in at build time rather than typed into the page so that the survey is
 * not a place where somebody can point a child's answers at a host of their
 * choosing.
 */

declare const __FIREBASE_CONFIG__: string;
declare const __SITTINGS_URL__: string;

export interface DeviceIdentity {
  /** The signed-in account's uid, which IS the device id the server files under. */
  deviceId: string;
}

export interface SyncTarget {
  /** Where `saveSitting` answers. */
  url: string;
  /** A fresh ID token for the enrolled device. */
  token: string;
}

function parseConfig(): Record<string, string> | null {
  try {
    const parsed = JSON.parse(__FIREBASE_CONFIG__ || "null") as Record<string, string> | null;
    return parsed && parsed["apiKey"] && parsed["projectId"] ? parsed : null;
  } catch {
    return null;
  }
}

const config = parseConfig();

/**
 * Whether this build can reach a study at all.
 *
 * False for the public preview, which is deliberately a survey that stores
 * everything on the device and sends nothing anywhere. The app says so rather
 * than offering an enrolment that could not work.
 */
export const syncAvailable = config !== null && Boolean(__SITTINGS_URL__);

let app: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;

function firebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  if (!config) throw new Error("this build has no study configured, so it cannot reach one");
  app ??= initializeApp(config);
  const instance = getAuth(app);
  // Awaited nowhere on purpose: the SDK queues work behind it, and a failure
  // here (a browser with IndexedDB blocked) must not stop the survey loading.
  void setPersistence(instance, indexedDBLocalPersistence);
  cachedAuth = instance;
  return instance;
}

/**
 * This device's identity, creating one if it has none.
 *
 * Called from the sync path rather than at start-up, deliberately: signing in
 * needs a network, and a survey must open and run in a hall with no usable wifi.
 * A device that has never been online simply has no identity yet, collects
 * normally, and gets one the first time it uploads.
 */
export async function deviceIdentity(): Promise<DeviceIdentity> {
  const auth = firebaseAuth();
  const existing = await firstAuthState();
  if (existing) return { deviceId: existing.uid };

  try {
    const credential = await signInAnonymously(auth);
    return { deviceId: credential.user.uid };
  } catch (error) {
    /**
     * The one failure worth naming precisely.
     *
     * Anonymous sign-in is off until somebody turns it on in the Firebase console,
     * and the SDK's own answer is `auth/admin-restricted-operation`, which reads
     * like a permissions bug in this code. It is one switch, and saying where it
     * is saves an afternoon.
     */
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "auth/admin-restricted-operation" || code === "auth/operation-not-allowed") {
      throw new Error(
        "this study's Firebase project has anonymous sign-in switched off, so devices cannot file sittings. Firebase console → Authentication → Sign-in method → Anonymous → Enable.",
      );
    }
    throw error;
  }
}

/** Forget this identity. For handing a device to a different study. */
export async function forgetIdentity(): Promise<void> {
  if (!config) return;
  settled = null;
  await signOut(firebaseAuth());
}

/** Who this iPad is, if it has been online at least once. Never creates one. */
export async function currentDevice(): Promise<DeviceIdentity | null> {
  if (!config) return null;
  const user = await firstAuthState();
  return user ? { deviceId: user.uid } : null;
}

let settled: Promise<User | null> | null = null;

function firstAuthState(): Promise<User | null> {
  settled ??= new Promise<User | null>((resolve) => {
    const unsubscribe = onAuthStateChanged(firebaseAuth(), (user) => {
      unsubscribe();
      resolve(user);
    });
  });
  return settled;
}

/**
 * Where to post, and what to post it with.
 *
 * The ID token is asked for on every attempt rather than cached: one lasts an
 * hour, a school day does not, and the SDK refreshes it from the refresh token
 * without any of this code knowing. Offline, the cached token is returned until
 * it expires and the upload fails on the network instead — which is the right
 * failure, because the sitting stays queued either way.
 */
export async function syncTarget(): Promise<SyncTarget | null> {
  if (!syncAvailable) return null;
  await deviceIdentity();
  const user = await firebaseAuth().currentUser;
  if (!user) return null;
  return { url: __SITTINGS_URL__, token: await user.getIdToken() };
}
