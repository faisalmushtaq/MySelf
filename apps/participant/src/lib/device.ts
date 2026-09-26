import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithCustomToken,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

/**
 * The iPad's own identity on the study.
 *
 * A device that posts sittings has to be somebody, because the server's whole
 * no-overwrite rule turns on which device a sitting came from: two copies of one
 * session id from two devices are quarantined, and the same device's own retry
 * is idempotent. An anonymous upload cannot be told apart from either.
 *
 * NOT GOOGLE SIGN-IN, AND THAT IS THE POINT. The lab page signs a researcher in
 * with `signInWithPopup`, and popups do not work in a page added to the iOS Home
 * Screen — which is how this app is installed. Three commits tried to make that
 * work and were reverted (#91, #92, #93, #94). None of it is needed here: the
 * backend already mints the right credential. `enrolDevice` returns a Firebase
 * CUSTOM TOKEN, `signInWithCustomToken` involves no popup, no redirect and no
 * third-party cookie, and it is exchanged once for a session the SDK then keeps
 * refreshed by itself.
 *
 * SO THE TOKEN IN A RESEARCHER'S HANDS IS SHORT-LIVED. A custom token is valid
 * for an hour and is spent at enrolment; what the iPad keeps afterwards is a
 * refresh token in the SDK's own storage, revocable from the console with
 * `revokeDevice` when an iPad goes missing. The researcher never types a
 * long-lived secret into a device that spends its day in children's hands.
 *
 * PERSISTENCE IS `indexedDBLocalPersistence`, DELIBERATELY. The default would
 * do, but the lab page's `browserSessionPersistence` would not: it is scoped to
 * the tab, and an iPad that forgot which device it was every time Safari
 * discarded the page would stop syncing halfway through a school day with
 * nothing on screen to say why.
 *
 * NONE OF THE CONFIGURATION IS SECRET. A Firebase web config is a set of public
 * identifiers — the `apiKey` names a project, it does not authorise anything.
 * What authorises is the `device` claim on the enrolled account. It is baked in
 * at build time rather than typed into the page for the same reason the relay
 * URL is: the survey must not be a place where somebody can point a child's
 * answers at a host of their choosing.
 */

declare const __FIREBASE_CONFIG__: string;
declare const __SITTINGS_URL__: string;

export interface DeviceIdentity {
  /** The enrolled account's uid, which IS the device id the server files under. */
  deviceId: string;
  /** What the researcher called this iPad when they enrolled it. */
  label: string | null;
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
  if (!config) throw new Error("this build has no study configured, so it cannot enrol a device");
  app ??= initializeApp(config);
  const instance = getAuth(app);
  // Awaited nowhere on purpose: the SDK queues work behind it, and a failure
  // here (a browser with IndexedDB blocked) must not stop the survey loading.
  void setPersistence(instance, indexedDBLocalPersistence);
  cachedAuth = instance;
  return instance;
}

/**
 * Exchange the enrolment token for this device's identity.
 *
 * THE `device` CLAIM IS CHECKED HERE rather than left to the first upload. A
 * researcher who pastes their own sign-in token, or a token from another
 * project, would otherwise enrol apparently successfully and discover at the end
 * of a school day that nothing had been accepted. It fails now, while somebody
 * is still looking at the screen.
 */
export async function enrolDevice(customToken: string): Promise<DeviceIdentity> {
  const token = customToken.trim();
  if (token.length === 0) throw new Error("paste the enrolment token from the researcher console");

  const auth = firebaseAuth();
  const credential = await signInWithCustomToken(auth, token);
  const claims = await credential.user.getIdTokenResult(true);
  if (claims.claims["device"] !== true) {
    await signOut(auth).catch(() => undefined);
    throw new Error(
      "that token signs in an account rather than enrolling an iPad. Use the token from Enrol a device in the researcher console.",
    );
  }
  return { deviceId: credential.user.uid, label: credential.user.displayName ?? null };
}

/** Forget which device this is. Used on handover to a different study. */
export async function withdrawDevice(): Promise<void> {
  if (!config) return;
  await signOut(firebaseAuth());
}

/**
 * Who this iPad currently is, once the SDK has finished looking.
 *
 * `onAuthStateChanged` fires with `null` before it has read its own storage, so
 * a naive read of `auth.currentUser` at start-up reports an enrolled device as
 * unenrolled. Resolved on the first callback instead.
 */
export async function currentDevice(): Promise<DeviceIdentity | null> {
  if (!config) return null;
  const user = await firstAuthState();
  if (!user) return null;
  return { deviceId: user.uid, label: user.displayName ?? null };
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
  const user = await firstAuthState();
  if (!user) return null;
  return { url: __SITTINGS_URL__, token: await user.getIdToken() };
}
