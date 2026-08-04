import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Where the functions run, set before any of them is defined.
 *
 * This lives here, in the module every function file imports, because ES
 * modules evaluate imports before the importing module's body: calling
 * `setGlobalOptions` in index.ts ran it AFTER every `export … from` had
 * already defined its functions, so the region silently did not apply and
 * everything would have deployed to us-central1 — the wrong continent from
 * the data, on a study whose Firestore location is permanent.
 *
 * europe-west2 is London. Set once, checked by a test that reads the region
 * off each endpoint the way the deploy tooling does.
 */
export const REGION = "europe-west2";
setGlobalOptions({ region: REGION, maxInstances: 10 });

/**
 * Two Firebase projects, reached from one set of functions.
 *
 * The research project is where these functions run, so it needs no
 * credentials. The identity project is separate — different project, different
 * IAM — and is reached with a service account that has been granted access to
 * it deliberately, held in Secret Manager rather than in the repository.
 *
 * That asymmetry is the point. A person, a browser or a leaked API key that
 * reaches the answers does not reach the names. The only thing that bridges
 * the two is this code, running server-side, and every crossing is logged.
 */

let identityApp: App | null = null;

export const research = (): Firestore => getFirestore();

export function identity(): Firestore {
  if (identityApp) return getFirestore(identityApp);

  const raw = process.env["IDENTITY_SERVICE_ACCOUNT"];
  if (!raw) {
    // Failing loudly beats falling back to the research project and quietly
    // writing children's names into it.
    throw new Error(
      "IDENTITY_SERVICE_ACCOUNT is not set — the identity project cannot be reached, and this must not fall back",
    );
  }
  const credential = JSON.parse(raw) as { project_id: string };
  identityApp =
    getApps().find((a) => a.name === "identity") ??
    initializeApp({ credential: cert(raw as never), projectId: credential.project_id }, "identity");
  return getFirestore(identityApp);
}

export const auth = () => getAuth();

/** The study this deployment serves. One study per project keeps IAM simple. */
export const STUDY = process.env["MYSELF_STUDY"] ?? "ybm";
