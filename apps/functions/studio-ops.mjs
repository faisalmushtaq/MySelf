import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import {
  diffDrafts,
  extractDraft,
  insertFragment,
  parseDraft,
  repositoryModuleFragment,
  serialiseDraft,
  suggestBump,
  unlockModule,
  validatedFragment,
} from "@myself/studio";

/**
 * Studio housekeeping for a study space, from the repository's Actions (run by
 * hand; .github/workflows/studio-ops.yml).
 *
 *   list                      every study space, its surveys and its members
 *   grant-owners --study S    everyone on S's Studio list: Studio admin there,
 *                             the project "owner" role (raw sittings, every
 *                             study) and the dashboard's access list
 *   insert --study S --survey V --pieces a,b --section K [--after ITEM]
 *                             library questionnaires or modules into V's draft
 *   adult-dob --study S --survey V [--min-age N]
 *                             the date of birth for adults: no 1990–2026 years,
 *                             youngest age N (unlocking the identity module,
 *                             with the reason recorded)
 *
 * Nothing is published: drafts are saved, and the team publishes from the
 * Studio. Every run is a dry run unless --apply is given. The repository is
 * public, so are its run logs: email addresses are only ever printed masked.
 */

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const apply = args.includes("--apply");
const projectId = flag("project") ?? "myself-research";
const keyFile = flag("key-file");

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};
const mask = (email) => (typeof email === "string" && email.includes("@") ? `${email[0]}…@${email.split("@")[1]}` : "(no email)");
const ACTOR = { uid: "repository", email: null };
const REPO_EMAIL = "repository";

const app = initializeApp({ credential: keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault(), projectId });
const db = getFirestore();
const { registeredStudies } = await import("./dist/studies.js");

const studyArg = () => flag("study") ?? fail("Say which study space with --study.");
const surveyArg = () => flag("survey") ?? fail("Say which survey with --survey.");

async function audit(study, surveyId, action, subject, detail) {
  await db.collection(paths.studioAudit(study)).add({
    at: FieldValue.serverTimestamp(),
    actor: ACTOR.uid,
    actorEmail: REPO_EMAIL,
    action,
    surveyId,
    subject,
    detail,
  });
}

async function liveDraft(study, surveyId, survey) {
  const active = survey.get("active");
  if (!active) return null;
  const release = await db.doc(paths.publicRelease(study, active.hash.replace(/^sha256:/, ""))).get();
  return release.exists ? extractDraft(JSON.parse(release.get("manifest"))) : null;
}

/** Read the draft, change it, and save it back only if nobody saved meanwhile. */
async function editDraft(study, surveyId, change, what) {
  const surveyRef = db.doc(paths.studioSurvey(study, surveyId));
  const draftRef = db.doc(paths.studioDraft(study, surveyId));
  const [survey, snap] = await Promise.all([surveyRef.get(), draftRef.get()]);
  if (!survey.exists || !snap.exists) fail(`There is no survey “${surveyId}” in the study space “${study}”.`);
  const draft = parseDraft(snap.get("content"));
  const revision = snap.get("revision");
  const next = change(draft);
  const live = await liveDraft(study, surveyId, survey);
  const summary = diffDrafts(live, next);
  console.log(`${what}. The draft would then differ from the live version by: ${JSON.stringify(summary.counts)} (${suggestBump(summary) ?? "no change"}).`);
  if (!apply) {
    console.log("Dry run: nothing saved. Run again with apply to save the draft (it is not published).");
    return;
  }
  await db.runTransaction(async (tx) => {
    const now = await tx.get(draftRef);
    if (now.get("revision") !== revision) throw new Error("Somebody saved the draft meanwhile; nothing was changed. Run it again.");
    tx.update(draftRef, {
      content: serialiseDraft(next),
      revision: revision + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: ACTOR.uid,
      updatedByEmail: REPO_EMAIL,
    });
  });
  await audit(study, surveyId, "draft.edited", surveyId, { by: "studio-ops", what });
  console.log(`Saved draft revision ${revision + 1}. Nothing is published: the team reviews it in the Studio and publishes.`);
}

if (command === "list") {
  for (const s of await registeredStudies(db)) {
    console.log(`\nStudy space “${s.study}”${s.title ? ` (${s.title})` : ""}${s.isDefault ? ", the default" : ""}, ${s.status}`);
    const members = await db.collection(paths.studioMembers(s.study)).get();
    const byRole = {};
    for (const m of members.docs) (byRole[m.get("role") ?? "?"] ??= []).push(mask(m.id));
    console.log(`  Studio list: ${members.size} — ${Object.entries(byRole).map(([r, e]) => `${r}: ${e.join(", ")}`).join("; ") || "nobody"}`);
    const surveys = await db.collection(paths.studioSurveys(s.study)).get();
    for (const sv of surveys.docs) {
      const draft = await db.doc(paths.studioDraft(s.study, sv.id)).get();
      let pending = "no draft";
      let sections = "";
      if (draft.exists) {
        const d = parseDraft(draft.get("content"));
        const live = await liveDraft(s.study, sv.id, sv);
        pending = suggestBump(diffDrafts(live, d)) ? "unpublished edits" : "draft matches live";
        sections = d.composition.sections.map((x) => `${x.key} “${x.title}”`).join(", ");
      }
      console.log(`  Survey “${sv.id}” (${sv.get("title") ?? "untitled"}): live ${sv.get("active")?.version ?? "never published"}; ${pending}; draft revision ${draft.get("revision") ?? "-"}`);
      if (sections) console.log(`    sections: ${sections}`);
    }
  }
} else if (command === "grant-owners") {
  const study = studyArg();
  const members = await db.collection(paths.studioMembers(study)).get();
  if (members.empty) fail(`Nobody is on the Studio list of “${study}”.`);
  const auth = getAuth();
  const dashboardAccess = getFirestore(app, "dashboard").doc("config/access");
  for (const m of members.docs) {
    const email = m.id;
    const was = m.get("role");
    let user = null;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      // Not signed in to the project yet: the Studio role and the dashboard list still apply.
    }
    console.log(`${mask(email)}: Studio ${was} → admin; project role ${user?.customClaims?.role ?? (user ? "none" : "not signed in yet")} → owner${user ? "" : " (once they sign in, run this again)"}; dashboard list: add`);
    if (!apply) continue;
    if (was !== "admin") {
      await m.ref.set({ ...m.data(), role: "admin", updatedAt: FieldValue.serverTimestamp(), updatedBy: REPO_EMAIL }, { merge: true });
      await audit(study, null, "access.member_set", email, { from: was ?? null, to: "admin", by: "studio-ops grant-owners" });
    }
    await dashboardAccess.set({ emails: FieldValue.arrayUnion(email) }, { merge: true });
    if (user && user.customClaims?.role !== "owner") {
      await auth.setCustomUserClaims(user.uid, { ...(user.customClaims ?? {}), role: "owner" });
      await auth.revokeRefreshTokens(user.uid);
    }
  }
  console.log(apply ? "Done. Each person signs out and in again to pick up the owner role." : "Dry run: nothing changed. Run again with apply.");
} else if (command === "insert") {
  const study = studyArg();
  const surveyId = surveyArg();
  const sectionKey = flag("section") ?? fail("Say which section with --section (list shows them).");
  const after = flag("after") ?? null;
  const pieces = (flag("pieces") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (pieces.length === 0) fail("Say which pieces with --pieces.");
  const at = new Date().toISOString();
  await editDraft(
    study,
    surveyId,
    (draft) => {
      let d = draft;
      let anchor = after;
      for (const piece of pieces) {
        // A validated questionnaire by its reference ("phq4@1.0/en-GB/self/standard"), else a repository module by key.
        const fragment = piece.includes("@") ? validatedFragment(piece) : repositoryModuleFragment(piece, { title: piece });
        const { draft: next, report } = insertFragment(d, fragment, { sectionKey, afterItemKey: anchor }, { by: ACTOR.uid, byEmail: REPO_EMAIL, at });
        console.log(`  ${piece}: adds ${report.added.length} question(s) in “${sectionKey}”${anchor ? ` after ${anchor}` : ""}`);
        d = next;
        anchor = report.added[report.added.length - 1] ?? anchor;
      }
      return d;
    },
    `Insert ${pieces.join(", ")}`,
  );
} else if (command === "adult-dob") {
  const study = studyArg();
  const surveyId = surveyArg();
  const minAge = Number(flag("min-age") ?? "16");
  if (!Number.isInteger(minAge) || minAge < 0 || minAge > 100) fail("--min-age must be a whole number of years.");
  const reason = `The ${study} study asks adults: their dates of birth go back before 1990, so the schools survey's 1990–2026 year range and its youngest age of 4 do not fit (requested by the study team, 2026-10-20).`;
  await editDraft(
    study,
    surveyId,
    (draft) => {
      let d = unlockModule(draft, "ybm_identity", { by: ACTOR.uid, at: new Date().toISOString(), reason }).draft;
      const found = Object.values(d.instruments).find((x) => x.instrument === "ybm_identity");
      const dob = found?.forms[0]?.items.find((i) => i.key === "dob");
      if (!dob) fail(`“${surveyId}” has no date-of-birth question (ybm_identity.dob).`);
      console.log(`  date of birth was: years ${dob.minYear ?? "any"}–${dob.maxYear ?? "any"}, ages ${dob.minAgeYears ?? 0}–${dob.maxAgeYears ?? "100"}`);
      delete dob.minYear;
      delete dob.maxYear;
      dob.minAgeYears = minAge;
      dob.maxAgeYears = 100;
      console.log(`  becomes: any year, ages ${minAge}–100`);
      // Left unlocked, with the reason: a protected module's change is
      // published only while it is unlocked. The team can lock it again after.
      return d;
    },
    `Date of birth for adults (youngest ${minAge})`,
  );
} else {
  fail("Commands: list, grant-owners, insert, adult-dob.");
}
