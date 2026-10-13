import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { verifyRawManifestHash } from "@myself/schema";
import { extractDraft, questionnaireHtml } from "@myself/studio";

/**
 * A permanent, readable record of every published survey version (D-60).
 *
 * For each version in every study's Studio that the archive does not hold yet:
 *   <study>/<survey>/<version>/manifest.json      the release exactly as stored (what the hash covers)
 *   <study>/<survey>/<version>/questionnaire.pdf  every question, option, code and condition, readable
 *   <study>/<survey>/<version>/questionnaire.html the same, as a web page
 *   <study>/<survey>/<version>/version.json       who published it, when, the release note and changes
 *   <study>/<survey>/<version>/CHANGES.md         the note and changes in words
 * and README.md at the top lists every version. The release is verified against
 * its hash before anything is written; a version already archived is never
 * rewritten, so the archive only ever grows. Read-only on Firestore.
 *
 * Writes the folders it added, one per line, to --new-list (for the releases).
 *
 *   pnpm --filter @myself/functions build
 *   node survey-archive.mjs --project myself-research --out <archive dir> --chrome <chrome binary> [--new-list file]
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const projectId = flag("project");
const out = flag("out");
const chrome = flag("chrome");
const newList = flag("new-list");
const keyFile = flag("key-file");
if (!projectId || !out || !chrome) {
  console.error("Usage: node survey-archive.mjs --project <id> --out <dir> --chrome <path> [--new-list <file>] [--key-file <sa.json>]");
  process.exit(1);
}

initializeApp({ credential: keyFile ? cert(JSON.parse(readFileSync(keyFile, "utf8"))) : applicationDefault(), projectId });
const db = getFirestore();
const { registeredStudies } = await import("./dist/studies.js");

const iso = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : typeof t === "string" ? t : null);
const added = [];

for (const { study } of await registeredStudies(db)) {
  const surveys = await db.collection(`studies/${study}/surveys`).get();
  for (const survey of surveys.docs) {
    const versions = await db.collection(`studies/${study}/surveys/${survey.id}/versions`).get();
    for (const v of versions.docs) {
      const dir = join(out, study, survey.id, v.id);
      if (existsSync(join(dir, "version.json"))) continue;
      const doc = v.data();
      const stored = await db.doc(`studies/${study}/publicReleases/${String(doc.hash).replace(/^sha256:/, "")}`).get();
      if (!stored.exists) throw new Error(`${study}/${survey.id} ${v.id}: release ${doc.hash} is not in the store`);
      const json = stored.get("manifest");
      const raw = JSON.parse(json);
      if (!(await verifyRawManifestHash(raw)) || raw.hash !== doc.hash) throw new Error(`${study}/${survey.id} ${v.id}: release does not verify against ${doc.hash}`);

      const meta = {
        study,
        surveyId: survey.id,
        version: v.id,
        hash: doc.hash,
        publishedAt: iso(doc.publishedAt) ?? raw.release?.publishedAt ?? "",
        publishedBy: doc.publishedByEmail ?? (doc.source === "repository" ? "the repository" : doc.publishedBy ?? null),
        releaseNote: doc.releaseNote ?? null,
        changeSummary: doc.changeSummary ?? null,
        basedOnVersion: doc.basedOnVersion ?? null,
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), json);
      writeFileSync(join(dir, "version.json"), `${JSON.stringify({ ...meta, source: doc.source ?? null, bump: doc.bump ?? null, imports: doc.imports ?? [], itemKeys: doc.itemKeys ?? [], variables: doc.variables ?? [] }, null, 2)}\n`);
      const html = questionnaireHtml(extractDraft(raw), meta);
      writeFileSync(join(dir, "questionnaire.html"), html);
      execFileSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${join(dir, "questionnaire.pdf")}`, `file://${join(process.cwd(), dir, "questionnaire.html")}`], { stdio: "ignore" });
      const changes = meta.changeSummary?.entries?.length ? meta.changeSummary.entries.map((e) => `- ${e.message}`).join("\n") : "- No changes recorded (the first version, or set up from the repository).";
      writeFileSync(
        join(dir, "CHANGES.md"),
        `# ${survey.id} ${v.id}\n\nStudy \`${study}\` · published ${meta.publishedAt}${meta.publishedBy ? ` by ${meta.publishedBy}` : ""} · release \`${doc.hash}\`\n\n${meta.releaseNote ? `## Release note\n\n${meta.releaseNote}\n\n` : ""}## What changed\n\n${changes}\n`,
      );
      added.push(join(study, survey.id, v.id));
      console.log(`archived ${study}/${survey.id} ${v.id}`);
    }
  }
}

// The index: every archived version, newest first within each survey.
const rows = [];
for (const study of existsSync(out) ? readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")) : []) {
  for (const survey of readdirSync(join(out, study.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const version of readdirSync(join(out, study.name, survey.name))) {
      const file = join(out, study.name, survey.name, version, "version.json");
      if (existsSync(file)) rows.push(JSON.parse(readFileSync(file, "utf8")));
    }
  }
}
const semver = (s) => s.split(".").map(Number);
rows.sort((a, b) => a.study.localeCompare(b.study) || a.surveyId.localeCompare(b.surveyId) || (() => { const x = semver(b.version), y = semver(a.version); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })());
const line = (r) => {
  const p = `${r.study}/${r.surveyId}/${r.version}`;
  const note = (r.releaseNote ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 140);
  return `| ${r.study} | ${r.surveyId} | ${r.version} | ${(r.publishedAt ?? "").slice(0, 10)} | ${r.publishedBy ?? ""} | ${note} | [PDF](${p}/questionnaire.pdf) · [JSON](${p}/manifest.json) · [changes](${p}/CHANGES.md) |`;
};
writeFileSync(
  join(out, "README.md"),
  `# Published survey versions\n\nEvery version published from MySelf Studio, archived automatically (D-60). Each folder holds the release exactly as fielded (\`manifest.json\`, what its hash covers), a readable questionnaire (PDF and HTML), and who published it, when and what changed. Nothing here is ever rewritten.\n\n| Study | Survey | Version | Published | By | Note | Files |\n|---|---|---|---|---|---|---|\n${rows.map(line).join("\n")}\n`,
);
if (newList) writeFileSync(newList, added.map((a) => `${a}\n`).join(""));
console.log(`${added.length} new version(s) archived; ${rows.length} in the archive.`);
