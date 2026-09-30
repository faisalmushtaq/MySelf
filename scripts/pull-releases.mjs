#!/usr/bin/env node
/**
 * Copy the versions published from the dashboard into releases/ (D-54).
 *
 * A version published from the dashboard lives in the study's database,
 * `studies/{study}/releases/{hash}`, and goes straight to the live survey. This
 * brings each one into git as well, beside the releases cut here, so the
 * repository keeps the full history and `packages/release/src/published.test.ts`
 * checks it like any other.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> node scripts/pull-releases.mjs [--dry-run]
 *
 *   --dry-run         list what is published and what would be written; write nothing
 *   --project <id>    the Firebase project (default: GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or myself-research)
 *   --study <key>     the study (default: MYSELF_STUDY, or ybm)
 *   --out <dir>       where to write (default: releases/)
 *
 * Reads with the Admin SDK and credentials from the environment, as any
 * Google tool does: a service account key named by GOOGLE_APPLICATION_CREDENTIALS,
 * or `gcloud auth application-default login`. With FIRESTORE_EMULATOR_HOST set it
 * reads the emulator instead and needs no credentials.
 *
 * NOTHING IS TRUSTED OR OVERWRITTEN. A manifest is written only if it hashes to
 * the hash it is filed under, the same check a device makes before running it.
 * A file already in releases/ is never replaced: the same hash is left alone,
 * and a different manifest under the same version number is refused, because a
 * committed manifest is never edited (docs/16 §3.4). Either refusal makes the
 * script exit non-zero after it has reported everything else.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { openPublishedRelease, publishedPaths } from "@myself/schema";

const USAGE = "Usage: node scripts/pull-releases.mjs [--dry-run] [--project <id>] [--study <key>] [--out <dir>]";
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const name = args[i];
  if (name === "--dry-run") options.dryRun = true;
  else if (["--project", "--study", "--out"].includes(name) && args[i + 1] !== undefined) options[name.slice(2)] = args[++i];
  else {
    // A mistyped option must not turn into a real run with the defaults.
    console.error(`Not an option: ${name}\n${USAGE}`);
    process.exit(1);
  }
}
const dryRun = options.dryRun === true;
const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "myself-research";
const study = options.study ?? process.env.MYSELF_STUDY ?? "ybm";
const out = options.out ?? fileURLToPath(new URL("../releases/", import.meta.url));

const db = getFirestore(initializeApp({ projectId: project }));
const where = process.env.FIRESTORE_EMULATOR_HOST ? `the emulator at ${process.env.FIRESTORE_EMULATOR_HOST}` : project;
const snapshot = await db.collection(publishedPaths.releases(study)).get();
console.log(`${snapshot.size} version${snapshot.size === 1 ? "" : "s"} published in ${where}, study ${study}${dryRun ? " (dry run: nothing is written)" : ""}`);

/** The name `publish.mjs` gives a release, so a pulled one sits beside the rest. */
const fileFor = (manifest) => `${manifest.release.assessment}_r${manifest.release.version}.manifest.json`;

const rows = [];
let refusals = 0;
for (const document of snapshot.docs) {
  const data = document.data();
  const opened = await openPublishedRelease(data, { expectedHash: document.id });
  if (!opened.ok) {
    refusals += 1;
    rows.push({ version: String(data.version ?? "?"), line: `REFUSED   ${document.id}: ${opened.problem}` });
    continue;
  }
  const manifest = opened.manifest;
  const file = fileFor(manifest);
  const path = join(out, file);
  const provenance = [data.publishedBy, typeof data.publishedAt === "string" ? data.publishedAt : null, data.source]
    .filter(Boolean)
    .join(", ");

  if (existsSync(path)) {
    const committed = JSON.parse(readFileSync(path, "utf8"));
    if (committed.hash === manifest.hash) {
      rows.push({ version: manifest.release.version, line: `present   ${file}` });
    } else {
      refusals += 1;
      rows.push({
        version: manifest.release.version,
        line: `REFUSED   ${file} is already committed with ${String(committed.hash).slice(0, 19)}…, and ${manifest.hash.slice(0, 19)}… is published under the same version; it is not overwritten`,
      });
    }
    continue;
  }

  if (!dryRun) {
    // The manifest exactly as published, laid out like the committed ones: two
    // spaces and a trailing newline, so a diff between releases is content.
    writeFileSync(path, `${JSON.stringify(JSON.parse(data.manifestJson), null, 2)}\n`);
  }
  rows.push({ version: manifest.release.version, line: `${dryRun ? "would add" : "added    "} ${file}  ${manifest.hash.slice(0, 19)}…${provenance ? `  (${provenance})` : ""}` });
}

rows.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
for (const row of rows) console.log(`  ${row.line}`);

if (!dryRun && rows.some((r) => r.line.startsWith("added"))) {
  console.log(
    "\nNext: add each new release to `published` in apps/functions/src/releases.ts (its test fails until you do), " +
      "run the tests, and commit the files. See docs/16 §3.4.",
  );
}
if (refusals > 0) {
  console.error(`\n${refusals} version${refusals === 1 ? " was" : "s were"} refused. Nothing was written for ${refusals === 1 ? "it" : "them"}.`);
  process.exit(1);
}
process.exit(0);
