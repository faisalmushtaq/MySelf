import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import {
  diffDrafts,
  extractDraft,
  insertFragment,
  outline,
  parseDraft,
  removeBlock,
  repositoryModuleFragment,
  serialiseDraft,
  suggestBump,
  validateDraft,
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
 *   insert --study S --survey V --pieces a,b --section K [--after ITEM] [--replace INSTRUMENT]
 *                             library questionnaires or modules into V's draft;
 *                             with --replace, in place of that questionnaire
 *   retitle --study S --survey V --title T
 *                             the survey's title, on its draft and in the Studio
 *   form-label --study S --survey V --instrument I --label L
 *                             a questionnaire's form label (researchers only see it)
 *   remove-blocks --study S --survey V --instruments a,b
 *                             whole questionnaires out of the draft (archived, restorable)
 *   dob-ages --study S --survey V --min-age A --max-age B
 *                             who may take part, by age: the survey's own
 *                             limits on its date of birth (no unlock needed)
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
  // What publishing this draft would be refused for, so the team is not surprised in the Studio.
  const blocking = validateDraft(next, live ? { baseline: live } : {}).filter((i) => i.severity === "error");
  console.log(blocking.length === 0 ? "No problems that would stop it being published." : `Would stop it being published (${blocking.length}):`);
  for (const i of blocking.slice(0, 20)) console.log(`  - ${i.message}`);
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
  const replace = flag("replace") ?? null;
  let sectionKey = flag("section") ?? (replace ? null : fail("Say which section with --section (list shows them)."));
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
      if (replace) {
        // Where the questionnaire being replaced sits: its section, and the question before it.
        const place = outline(d).sections.flatMap((s) => s.blocks.map((b) => ({ s, b }))).find(({ b }) => b.instrument === replace);
        if (!place) fail(`“${replace}” is not in this survey's draft.`);
        const inSection = place.s.blocks.flatMap((b) => (b.componentIndex < place.b.componentIndex ? b.questions.map((q) => q.itemKey) : []));
        sectionKey = place.s.key;
        anchor = inSection[inSection.length - 1] ?? null;
        const removed = removeBlock(d, sectionKey, place.b.componentIndex, { by: ACTOR.uid, at });
        d = removed.draft;
        console.log(`  ${replace}: removed from “${sectionKey}” (${removed.archived.length} question(s) archived, restorable)`);
      }
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
} else if (command === "dob-ages") {
  const study = studyArg();
  const surveyId = surveyArg();
  const minAge = Number(flag("min-age"));
  const maxAge = Number(flag("max-age"));
  if (![minAge, maxAge].every((n) => Number.isInteger(n) && n >= 0 && n <= 100) || minAge > maxAge) {
    fail("--min-age and --max-age must be whole numbers of years, 0 to 100, youngest first.");
  }
  await editDraft(
    study,
    surveyId,
    (draft) => {
      const found = Object.values(draft.instruments).find((x) => x.instrument === "ybm_identity");
      const dob = found?.forms[0]?.items.find((i) => i.key === "dob");
      if (!dob) fail(`“${surveyId}” has no date-of-birth question (ybm_identity.dob).`);
      console.log(`  date of birth was: years ${dob.minYear ?? "any"}–${dob.maxYear ?? "any"}, ages ${dob.minAgeYears ?? 0}–${dob.maxAgeYears ?? 100}`);
      // The ages say who may take part; a year range copied from another study would contradict them.
      delete dob.minYear;
      delete dob.maxYear;
      dob.minAgeYears = minAge;
      dob.maxAgeYears = maxAge;
      console.log(`  becomes: ages ${minAge}–${maxAge}`);
      return draft;
    },
    `Date of birth: ages ${minAge} to ${maxAge}`,
  );
} else if (command === "questions") {
  // Read-only: the draft's questions (and the archived ones, and the live
  // version's), optionally only those whose ID, variable or wording matches --match.
  const study = studyArg();
  const surveyId = surveyArg();
  const match = (flag("match") ?? "").toLowerCase();
  const survey = await db.doc(paths.studioSurvey(study, surveyId)).get();
  const snap = await db.doc(paths.studioDraft(study, surveyId)).get();
  if (!survey.exists || !snap.exists) fail(`There is no survey “${surveyId}” in the study space “${study}”.`);
  const draft = parseDraft(snap.get("content"));
  const live = await liveDraft(study, surveyId, survey);
  const itemOf = (d, itemKey) => {
    const [instrument, key] = [itemKey.slice(0, itemKey.indexOf(".")), itemKey.slice(itemKey.indexOf(".") + 1)];
    for (const def of Object.values(d.instruments)) if (def.instrument === instrument) for (const f of def.forms) for (const i of f.items) if (i.key === key) return i;
    return null;
  };
  const shows = (itemKey, item, text) => !match || [itemKey, item?.variable ?? "", text ?? ""].some((x) => x.toLowerCase().includes(match));
  const list = (label, d) => {
    console.log(`\n${label}`);
    for (const sec of outline(d).sections) {
      for (const b of sec.blocks) {
        for (const q of b.questions) {
          const item = itemOf(d, q.itemKey);
          if (shows(q.itemKey, item, q.text)) console.log(`  [${sec.key}] ${q.itemKey}  var=${item?.variable}  ${q.responseType}  “${q.text.slice(0, 70)}”`);
        }
      }
    }
  };
  console.log(`Survey “${surveyId}”: live ${survey.get("active")?.version ?? "never published"}; draft revision ${snap.get("revision")}`);
  if (live) list(`Live version (${survey.get("active")?.version}):`, live);
  list("Draft:", draft);
  console.log("\nArchived in the draft:");
  for (const a of draft.archived) if (shows(a.itemKey, a.item, a.item?.stem?.text)) console.log(`  ${a.itemKey}  var=${a.item?.variable}  ${a.item?.responseType}  archived ${a.archivedAt}`);
} else if (command === "remove-blocks") {
  // Whole questionnaires out of a draft. Their questions are archived (restorable),
  // and answers already recorded stay readable.
  const study = studyArg();
  const surveyId = surveyArg();
  const instruments = (flag("instruments") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (instruments.length === 0) fail("Say which questionnaires with --instruments (keys, comma-separated).");
  const at = new Date().toISOString();
  await editDraft(
    study,
    surveyId,
    (draft) => {
      let d = draft;
      for (const instrument of instruments) {
        let removed = 0;
        for (;;) {
          const place = outline(d).sections.flatMap((s) => s.blocks.map((b) => ({ s, b }))).find(({ b }) => b.instrument === instrument);
          if (!place) break;
          const out = removeBlock(d, place.s.key, place.b.componentIndex, { by: ACTOR.uid, at });
          d = out.draft;
          removed += 1;
          console.log(`  ${instrument}: removed from “${place.s.key}” (${out.archived.length} question(s) archived, restorable)`);
        }
        if (removed === 0) console.log(`  ${instrument}: not in this draft`);
      }
      return d;
    },
    `Remove ${instruments.join(", ")}`,
  );
} else if (command === "retitle") {
  // The survey's title (participants see it), on its draft and its Studio listing.
  const study = studyArg();
  const surveyId = surveyArg();
  const title = (flag("title") ?? "").trim();
  if (!title || title.length > 200) fail("Give the new title with --title (at most 200 characters).");
  await editDraft(
    study,
    surveyId,
    (draft) => {
      console.log(`  title was: “${draft.composition.title}”`);
      draft.composition.title = title;
      console.log(`  becomes:   “${title}”`);
      return draft;
    },
    `Title: ${title}`,
  );
  if (apply) await db.doc(paths.studioSurvey(study, surveyId)).set({ title, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
} else if (command === "form-label") {
  // A questionnaire's form label: a name for researchers, never shown to participants.
  const study = studyArg();
  const surveyId = surveyArg();
  const instrument = flag("instrument") ?? fail("Say which questionnaire with --instrument.");
  const label = (flag("label") ?? "").trim();
  if (!label) fail("Give the new label with --label.");
  await editDraft(
    study,
    surveyId,
    (draft) => {
      const defs = Object.values(draft.instruments).filter((d) => d.instrument === instrument);
      if (defs.length === 0) fail(`“${instrument}” is not in this survey's draft.`);
      for (const def of defs) {
        for (const form of def.forms) {
          console.log(`  ${instrument}: “${form.label}” → “${label}”`);
          form.label = label;
        }
      }
      return draft;
    },
    `Form label of ${instrument}: ${label}`,
  );
} else {
  fail("Commands: list, questions, grant-owners, insert, remove-blocks, dob-ages, retitle, form-label.");
}
