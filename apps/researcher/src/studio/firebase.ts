import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  signInWithCredential,
  type Auth,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, type Functions } from "firebase/functions";
import { parseEmulators, parseFirebaseConfig } from "./config.js";

/**
 * The Studio's own Firebase app.
 *
 * A NAMED APP, not the default one the researcher view uses, because the two
 * sign in differently on purpose. The Studio keeps its session for the tab
 * only (docs/16 §5.7): it runs on the shared github.io origin, where anything
 * kept in IndexedDB or localStorage outlives the tab and is readable by every
 * other page GitHub serves from the same user's site (docs/16 §8). A person who
 * closes the tab is signed out of the Studio, and nothing they could publish
 * with is left behind in the browser.
 *
 * The region has to match the deployed functions: `getFunctions(app)` defaults
 * to us-central1 and fails with a CORS error that looks like a permissions
 * problem (the same trap lib/study.ts documents).
 */

const config = parseFirebaseConfig(__FIREBASE_CONFIG__);
const emulators = parseEmulators(__STUDIO_EMULATORS__);

/** Whether this build was pointed at a Firebase project at all. */
export const studioConfigured = config !== null;

/** Whether this build talks to local emulators rather than the real project. */
export const usingEmulators = emulators !== null;

/** What "Set up from the live survey" imports — in the default study only (D-56). */
export const SURVEY_ID = __SURVEY_ID__ || "ybm_nd2026_standard";

export const REGION = "europe-west2";

export interface StudioFirebase {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  fns: Functions;
}

let instance: StudioFirebase | null = null;

/** The Studio's Firebase handles, created on first use; null in an unconfigured build. */
export function studioFirebase(): StudioFirebase | null {
  if (!config) return null;
  if (instance) return instance;

  const app = getApps().find((a) => a.name === "studio") ?? initializeApp(config, "studio");
  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence: browserSessionPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    // Already initialised — only after a hot reload in development, where the
    // module is evaluated again against the app the page already holds.
    auth = getAuth(app);
  }
  const db = getFirestore(app);
  const fns = getFunctions(app, REGION);

  if (emulators) {
    try {
      if (emulators.auth) connectAuthEmulator(auth, emulators.auth, { disableWarnings: true });
      if (emulators.firestore) connectFirestoreEmulator(db, emulators.firestore.host, emulators.firestore.port);
      if (emulators.functions) connectFunctionsEmulator(fns, emulators.functions.host, emulators.functions.port);
    } catch {
      // Connected already (hot reload); connecting twice throws and changes nothing.
    }
  }

  instance = { app, auth, db, fns };
  return instance;
}

/**
 * Signing in without a Google popup, for the end-to-end tests.
 *
 * The condition is the build-time constant itself, so a build made without
 * emulators has `if ("")` here and the bundler removes the whole block: the
 * function does not exist in a production build, rather than existing and
 * refusing. Inside, it also refuses unless every configured emulator is local
 * (parseEmulators) — the Auth emulator accepts an unsigned token; the real
 * service never does.
 */
if (__STUDIO_EMULATORS__) {
  if (emulators?.auth && typeof window !== "undefined") {
    (window as unknown as { __studioTestSignIn?: (email: string) => Promise<void> }).__studioTestSignIn = async (
      email: string,
    ) => {
      const fb = studioFirebase();
      if (!fb) throw new Error("no Firebase config in this build");
      const normalised = email.trim().toLowerCase();
      const sub = `test-${normalised.replace(/[^a-z0-9]/g, "-")}`;
      const token = JSON.stringify({ sub, email: normalised, email_verified: true });
      await signInWithCredential(fb.auth, GoogleAuthProvider.credential(token));
    };
  }
}
