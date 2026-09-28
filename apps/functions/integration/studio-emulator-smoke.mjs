import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

/**
 * MySelf Studio over HTTP, end to end, against the emulators — the way the
 * Studio in a browser reaches it: a Google sign-in on the Auth emulator, then
 * callables with that ID token, then the draft trigger running in the
 * Functions emulator.
 *
 * Run it inside the emulators, from apps/functions, after packaging:
 *
 *   pnpm --filter @myself/functions package
 *   cd apps/functions && npx firebase emulators:exec --only auth,firestore,functions \
 *     --project demo-myself --config ../../infra/firebase/firebase.studio-e2e.json \
 *     "node integration/studio-emulator-smoke.mjs"
 *
 * Ports come from the emulator hub (FIREBASE_EMULATOR_HUB, set by
 * emulators:exec), so a config with other ports needs no change here. Exits
 * non-zero on the first thing that is not as it should be.
 */

const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-myself";
const REGION = "europe-west2";
const STUDY = process.env.MYSELF_STUDY ?? "ybm";
const SURVEY = "ybm_nd2026_standard";

const hubHost = process.env.FIREBASE_EMULATOR_HUB;
if (!hubHost) throw new Error("run this under `firebase emulators:exec` — FIREBASE_EMULATOR_HUB is not set");
const emulators = await (await fetch(`http://${hubHost}/emulators`)).json();
const at = (name) => {
  const e = emulators[name];
  if (!e) throw new Error(`the ${name} emulator is not running`);
  return `${e.host.includes(":") ? `[${e.host}]` : e.host}:${e.port}`;
};
const AUTH = at("auth");
const FUNCTIONS = at("functions");

initializeApp({ projectId: PROJECT });
const db = getFirestore();

let failures = 0;
const check = (what, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

/** A Google sign-in on the Auth emulator, which accepts an unsigned claims object as the Google ID token. */
async function signInWithGoogle(email) {
  const claims = { sub: `google-${email}`, email, email_verified: true, name: email.split("@")[0] };
  const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      postBody: `id_token=${encodeURIComponent(JSON.stringify(claims))}&providerId=google.com`,
      requestUri: "http://localhost",
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  });
  const body = await res.json();
  if (!body.idToken) throw new Error(`sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken;
}

/** A callable, over the callable protocol: `{data}` in, `{result}` or `{error}` out. */
async function call(name, data, idToken) {
  const res = await fetch(`http://${FUNCTIONS}/${PROJECT}/${REGION}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idToken ? { authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return res.json();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The list: one admin, added the way studio-access.mjs does it ───────────
const ADMIN = "ada.admin@example.org";
await db.doc(`studies/${STUDY}/studioMembers/${ADMIN}`).set({ email: ADMIN, role: "admin", addedAt: FieldValue.serverTimestamp(), addedBy: "cli:smoke", addedByEmail: null, note: null });

const admin = await signInWithGoogle("Ada.Admin@Example.org");
const stranger = await signInWithGoogle("stranger@example.org");

// ── Who am I ────────────────────────────────────────────────────────────────
const session = await call("studioSession", {}, admin);
check("studioSession: a listed admin", session.result?.role === "admin" && session.result?.email === ADMIN, session);
const nobody = await call("studioSession", {});
check("studioSession: signed out", nobody.result?.reason === "not_signed_in", nobody);
const unlisted = await call("studioSession", {}, stranger);
check("studioSession: a stranger", unlisted.result?.role === null && unlisted.result?.reason === "not_listed", unlisted);

// ── Refusals ────────────────────────────────────────────────────────────────
const refusedStranger = await call("studioImportLive", { surveyId: SURVEY }, stranger);
check("studioImportLive refuses a stranger", refusedStranger.error?.status === "PERMISSION_DENIED" && refusedStranger.error?.details?.kind === "forbidden", refusedStranger);
const refusedAnon = await call("studioImportLive", { surveyId: SURVEY });
check("studioImportLive refuses somebody signed out", refusedAnon.error?.status === "UNAUTHENTICATED", refusedAnon);
const refusedBad = await call("studioImportLive", { surveyId: "../evil" }, admin);
check("studioImportLive refuses a malformed request", refusedBad.error?.status === "INVALID_ARGUMENT" && refusedBad.error?.details?.kind === "invalid", refusedBad);

// ── Set up from the live survey ─────────────────────────────────────────────
const imported = await call("studioImportLive", { surveyId: SURVEY }, admin);
check(
  "studioImportLive imports r5.0.0 to r7.1.0 and makes r7.1.0 live",
  imported.result?.active === "7.1.0" && imported.result?.imported?.length === 5,
  imported,
);
const pointer = (await db.doc(`studies/${STUDY}/published/${SURVEY}`).get()).data();
check("the public pointer names r7.1.0", pointer?.version === "7.1.0" && pointer?.generation === 1, pointer);
const again = await call("studioImportLive", { surveyId: SURVEY }, admin);
check("studioImportLive again imports nothing", again.result?.imported?.length === 0, again);

// ── The draft trigger, running in the Functions emulator ───────────────────
const draftRef = db.doc(`studies/${STUDY}/surveys/${SURVEY}/draft/current`);
const draft = (await draftRef.get()).data();
const content = JSON.parse(draft.content);
content.composition.screens.finish.title.text = "Thank you so much, {first_name}!";
await draftRef.update({
  content: JSON.stringify(content),
  revision: draft.revision + 1,
  updatedAt: FieldValue.serverTimestamp(),
  updatedBy: "u_smoke_editor",
  updatedByEmail: "ed.editor@example.org",
});
let edited = [];
for (let i = 0; i < 30 && edited.length === 0; i += 1) {
  await wait(500);
  edited = (await db.collection(`studies/${STUDY}/studioAudit`).where("action", "==", "draft.edited").get()).docs.map((d) => d.data());
}
check("the draft trigger records the save", edited.length === 1 && edited[0].actor === "u_smoke_editor", edited);

// ── Publish it ──────────────────────────────────────────────────────────────
const published = await call("studioPublish", { surveyId: SURVEY, expectedRevision: draft.revision + 1, version: "7.2.0", releaseNote: "A warmer thank-you." }, admin);
check("studioPublish publishes 7.2.0", published.result?.version === "7.2.0" && published.result?.generation === 2, published);
const live = (await db.doc(`studies/${STUDY}/published/${SURVEY}`).get()).data();
check("the public pointer names 7.2.0", live?.hash === published.result?.hash, live);
const stats = await call("studioResponseStats", { surveyId: SURVEY }, admin);
check("studioResponseStats answers with counts per hash", Object.keys(stats.result?.byHash ?? {}).length === 6, stats);

console.log(failures === 0 ? "\nMySelf Studio smoke test: everything as expected." : `\nMySelf Studio smoke test: ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
