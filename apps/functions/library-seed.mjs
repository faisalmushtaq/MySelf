import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { allModules } from "@myself/library";
import { moduleContent, repositoryModuleFragment } from "@myself/studio";

/**
 * Put questions written in the repository into MySelf Studio's library as a
 * saved module (D-58, docs/16 §12.6), so a researcher can drop them into a
 * survey from the Studio's Library drawer and publish them there.
 *
 * Runs from the "Studio library" workflow with the deploy service account, or
 * from a laptop with admin credentials. It goes through the same `saveModule`
 * core the Studio's own "Save to library" calls — the same checks, the same
 * documents, the same audit row — and is idempotent: a module whose latest
 * version already holds exactly this content is left alone; different content
 * becomes the next version, which gives every survey using it an update notice.
 *
 *   pnpm --filter @myself/functions build
 *   node library-seed.mjs languages --project myself-research [--dry-run]
 */

/** The pieces this command can seed. Each is one block of one repository module. */
const SEEDS = {
  languages: () => {
    const keys = allModules.find((m) => m.instrument === "ybm_demographics").forms[0].items.map((i) => i.key);
    return {
      moduleId: "languages_understand_speak",
      title: "Languages: understanding and speaking",
      description:
        "Was English the first language learned; any other languages (West Yorkshire Census order); and for each one ticked, " +
        "how well it is understood and how well it is spoken, on one five-point scale, so receptive and expressive " +
        "bilingualism can be told apart. Part of the demographics block: add it after the ethnicity question.",
      tags: ["languages", "bilingualism", "demographics"],
      note: "From the repository library (D-53 languages, D-58 understanding and speaking).",
      fragment: repositoryModuleFragment("ybm_demographics", {
        itemKeys: keys.slice(keys.indexOf("first_language_english"), keys.indexOf("gender")),
        title: "Languages: understanding and speaking",
      }),
    };
  },
};

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const [name] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const projectId = flag("project") ?? process.env.GCLOUD_PROJECT;
const study = flag("study") ?? "ybm";
const surveyId = flag("survey") ?? "ybm_nd2026_standard";
const dryRun = args.includes("--dry-run");
const keyFile = flag("key-file");

if (!name || !SEEDS[name] || !projectId) {
  console.error(`Usage: node library-seed.mjs <${Object.keys(SEEDS).join("|")}> --project <id> [--study ybm] [--survey <id>] [--dry-run]`);
  process.exit(1);
}

const seed = SEEDS[name]();
initializeApp({ credential: keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault(), projectId });
const db = getFirestore();
// The deploy's own bundle of the server code, not a copy of it.
const { saveModule } = await import("./dist/studio/library.js");

const moduleRef = db.doc(`studioLibrary/${seed.moduleId}`);
const existing = await moduleRef.get();
let baseVersion = null;
if (existing.exists) {
  baseVersion = existing.get("latestVersion");
  const latest = await db.doc(`studioLibrary/${seed.moduleId}/versions/${baseVersion}`).get();
  const { contentHash } = await moduleContent(seed.fragment, { moduleId: seed.moduleId, version: baseVersion });
  if (latest.exists && latest.get("contentHash") === contentHash) {
    console.log(`${seed.moduleId} v${baseVersion} already holds exactly this; nothing to do.`);
    process.exit(0);
  }
}

const what = existing.exists ? `version ${baseVersion + 1} of ${seed.moduleId}` : `${seed.moduleId} (new, version 1)`;
if (dryRun) {
  console.log(`Would save ${what}: ${seed.fragment.blocks[0].definition.forms[0].items.length} questions.`);
  process.exit(0);
}

const saved = await saveModule(db, {
  study,
  surveyId,
  draftRevision: null,
  create: existing.exists ? null : { moduleId: seed.moduleId, title: seed.title, description: seed.description, tags: seed.tags },
  moduleId: existing.exists ? seed.moduleId : null,
  baseVersion,
  note: seed.note,
  fragment: seed.fragment,
  actor: { uid: "repository", email: null },
});
console.log(`Saved ${saved.moduleId} v${saved.version} (${saved.contentHash}).`);
