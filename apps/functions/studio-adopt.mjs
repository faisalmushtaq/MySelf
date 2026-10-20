import { readFileSync } from "node:fs";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { diffDrafts, extractDraft, lockVouchers, parseDraft, serialiseDraft, suggestBump, validateDraft } from "@myself/studio";

/**
 * Publish the repository's version of a survey from MySelf Studio (D-58).
 *
 * The live survey is published from the Studio, so changes made in the
 * repository (`packages/library`, cut as releases/candidates/…) never reach
 * participants unless somebody re-makes them by hand in the editor. This makes
 * the Studio draft the repository's version and publishes it, through the same
 * `publish` the Studio's Publish button calls — the same validation, licence
 * locks, gate, hashing and audit — so nothing here is trusted that the Studio
 * would not trust.
 *
 * It refuses, changing nothing, when the draft has unpublished edits of its
 * own (they are somebody's work in progress), or when the repository's version
 * is not the live version plus the changes listed with `--expect`. Protected
 * modules (consent, identity) are unlocked with the reason given, which the
 * Studio records with the version as it does for an unlock in the editor.
 *
 *   pnpm --filter @myself/functions build
 *   node studio-adopt.mjs --project myself-research --release ../../releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json \
 *     --version 10.0.0 --note "…" --unlock ybm_intro_consent="…" --unlock ybm_identity="…" [--dry-run]
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const flags = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const projectId = flag("project");
const releasePath = flag("release");
const version = flag("version");
const note = flag("note");
const study = flag("study") ?? "ybm";
const dryRun = args.includes("--dry-run");
const keyFile = flag("key-file");
const unlocks = Object.fromEntries(
  flags("unlock").map((u) => {
    const at = u.indexOf("=");
    return [u.slice(0, at), u.slice(at + 1)];
  }),
);
if (!projectId || !releasePath || !version || !note) {
  console.error("Usage: node studio-adopt.mjs --project <id> --release <manifest.json> --version <x.y.z> --note <release note> [--unlock module=reason ...] [--study ybm] [--dry-run]");
  process.exit(1);
}

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

initializeApp({ credential: keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault(), projectId });
const db = getFirestore();
const { publish } = await import("./dist/studio/publish.js");
const ACTOR = { uid: "repository", email: null };

const target = extractDraft(JSON.parse(readFileSync(releasePath, "utf8")));
const surveyId = target.surveyId;
const surveyPath = `studies/${study}/surveys/${surveyId}`;
const draftRef = db.doc(`${surveyPath}/draft/current`);
const [survey, draftSnap] = await Promise.all([db.doc(surveyPath).get(), draftRef.get()]);
if (!survey.exists || !draftSnap.exists) fail(`There is no Studio survey “${surveyId}” in “${study}”.`);
const active = survey.get("active");
if (!active) fail(`“${surveyId}” has no live version.`);
const releaseDoc = await db.doc(`studies/${study}/publicReleases/${active.hash.replace(/^sha256:/, "")}`).get();
const live = extractDraft(JSON.parse(releaseDoc.get("manifest")));
const draft = parseDraft(draftSnap.get("content"));
const revision = draftSnap.get("revision");

// A question by its item key ("instrument.key"), wherever it sits in a draft.
// Returns the array holding it and its index, or null unless exactly one.
function locate(d, itemKey) {
  const dot = itemKey.indexOf(".");
  const inst = itemKey.slice(0, dot);
  const key = itemKey.slice(dot + 1);
  const found = [];
  const walk = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((it, i) => {
      if (!it || typeof it !== "object") return;
      if (it.key === key && it.responseType) found.push({ arr, i });
      for (const v of Object.values(it)) if (Array.isArray(v)) walk(v);
    });
  };
  for (const def of Object.values(d.instruments)) if (def.instrument === inst) for (const f of def.forms ?? []) walk(f.items);
  return found.length === 1 ? found[0] : null;
}
const stable = (v) =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);

// Somebody's unpublished edits are theirs to publish, not this command's.
// List them, and who last saved, so the team can see whose work it is.
const draftChanges = diffDrafts(live, draft);
const pending = suggestBump(draftChanges);
if (pending) {
  const savedAt = draftSnap.get("updatedAt")?.toDate?.()?.toISOString() ?? "unknown time";
  // The repository is public, so its run logs are: an email is shown masked.
  const email = draftSnap.get("updatedByEmail");
  const masked = typeof email === "string" && email.includes("@") ? `${email[0]}…@${email.split("@")[1]}` : "unknown";
  console.log(`Unpublished draft changes, last saved by ${masked} at ${savedAt}:`);
  for (const e of draftChanges.entries) {
    console.log(`  ${e.kind} ${e.itemKey ?? e.refKey ?? ""} ${e.message ?? ""}`.trimEnd());
    const at = e.itemKey ? locate(draft, e.itemKey) : null;
    if (at) console.log(`    the draft's question: ${JSON.stringify(at.arr[at.i])}`);
  }
}

// --take-draft <itemKey>: publish that question exactly as the draft has it,
// so the draft's edit goes out in this version instead of being discarded.
for (const itemKey of flags("take-draft")) {
  const from = locate(draft, itemKey);
  const to = locate(target, itemKey);
  if (!from || !to) fail(`Can't find “${itemKey}” once in both the draft and the repository's version.`);
  to.arr[to.i] = structuredClone(from.arr[from.i]);
  console.log(`Taking “${itemKey}” from the draft as it is.`);
}

// Go ahead only if every unpublished edit is in the version being published.
const carried = (e) => {
  if (e.kind !== "question.changed" || !e.itemKey) return false;
  const a = locate(draft, e.itemKey);
  const b = locate(target, e.itemKey);
  return Boolean(a && b && stable(a.arr[a.i]) === stable(b.arr[b.i]));
};
if (pending && !draftChanges.entries.every(carried)) {
  fail(`The draft of “${surveyId}” has unpublished changes (${pending}) since ${active.version}. Publish or discard them in the Studio first, or carry them with take_draft.`);
}
if (pending) console.log("Every unpublished draft change is in this version, so nothing in the draft is lost.");

const changes = diffDrafts(live, target);
console.log(`Live ${active.version} → ${version}: ${JSON.stringify(changes.counts)}`);
for (const e of changes.entries) console.log(`  ${e.kind} ${e.itemKey ?? e.refKey ?? ""} ${e.message ?? ""}`.trimEnd());

// An answer code the live version has and the repository's version drops is
// retired, as removing an option in the editor does, so it is never reused.
// A code that stays but changes its label is refused: answers already carry it.
const at = new Date().toISOString();
const retiredCodes = structuredClone(draft.retiredCodes ?? {});
for (const [scaleKey, scale] of Object.entries(live.scales)) {
  const now = target.scales[scaleKey];
  if (!now) continue;
  for (const option of scale.options) {
    const kept = now.options.find((o) => o.code === option.code);
    // Only case, spacing or a symbol written as words may differ ("<5 minutes"
    // and "Less than 5 minutes" mean the same); anything else is a new meaning.
    const same = (l) => l.toLowerCase().replace(/</g, "less than ").replace(/\s+/g, " ").trim();
    if (kept && kept.label !== option.label && same(kept.label) === same(option.label)) console.log(`  relabels ${scaleKey} code ${option.code}: “${option.label}” → “${kept.label}” (same meaning)`);
    if (kept && same(kept.label) !== same(option.label)) fail(`${scaleKey} code ${option.code} would change from “${option.label}” to “${kept.label}”. A published code never changes meaning.`);
    if (kept) continue;
    const list = (retiredCodes[scaleKey] ??= []);
    if (!list.some((r) => r.code === option.code)) list.push({ code: option.code, label: option.label, retiredAt: at });
    console.log(`  retires ${scaleKey} code ${option.code} (“${option.label}”)`);
  }
}

// The repository's version, with the Studio's own records carried over: what
// was archived, retired codes and notes stay the survey's history.
const next = {
  ...target,
  archived: draft.archived,
  retiredCodes,
  notes: draft.notes,
  imports: draft.imports ?? [],
  unlocked: Object.fromEntries(
    Object.entries(unlocks).map(([instrument, reason]) => [instrument, { instrument, by: ACTOR.uid, at: new Date().toISOString(), reason }]),
  ),
};

if (dryRun) {
  // The publish's own checks, against the live version, so a dry run that
  // passes is not followed by a refused publish. (The publish still runs them
  // all, with every release the Studio knows, so this is a preview of them.)
  const issues = validateDraft(next, { baseline: live, ...lockVouchers({ releases: [live], library: true, draft: next }) });
  const errors = issues.filter((i) => i.severity === "error");
  for (const e of errors) console.log(`  would be refused: ${e.code} ${e.message}${e.location?.itemKey ? ` (${e.location.itemKey})` : e.location?.refKey ? ` (${e.location.refKey})` : ""}`);
  if (errors.length > 0) fail(`The publish would be refused: ${errors.length} problem${errors.length === 1 ? "" : "s"}, listed above.`);
  console.log(`Dry run: would save draft revision ${revision + 1} and publish ${surveyId} ${version}.`);
  process.exit(0);
}

// The same single step the editor takes, refused if anybody saved meanwhile.
await db.runTransaction(async (tx) => {
  const now = await tx.get(draftRef);
  if (now.get("revision") !== revision) throw new Error("Somebody saved the draft meanwhile; nothing was changed. Run it again.");
  tx.update(draftRef, {
    content: serialiseDraft(next),
    revision: revision + 1,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: ACTOR.uid,
    updatedByEmail: "repository",
  });
});
try {
  const published = await publish(db, { study, surveyId, expectedRevision: revision + 1, version, releaseNote: note, actor: ACTOR });
  console.log(`Published ${surveyId} ${published.version} (${published.hash}), generation ${published.generation}.`);
} catch (error) {
  // Put the draft back as it was, one revision on, so a refused publish leaves
  // nobody's editor holding a version they did not make. Nothing live changed.
  await draftRef.update({
    content: draftSnap.get("content"),
    revision: revision + 2,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: ACTOR.uid,
    updatedByEmail: "repository",
  });
  const details = error?.details ? JSON.stringify(error.details).slice(0, 3000) : "";
  fail(`The publish was refused; the draft is as it was and nothing live changed: ${error?.message ?? error} ${details}`);
}
