import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allInstruments, allModules, allScales } from "@myself/library";
import { allScoring } from "@myself/scoring";
import { buildRelease, releaseAssets, ybmComposition } from "./dist/index.js";

/**
 * Cut a release of the YBM standard questionnaire.
 *
 * There was no way to do this except by hand, which is why the corrected licence
 * records sat in the library with no release carrying them: the test that compares
 * a rebuild against the committed manifest failed, and the only obvious way out of
 * that failure is to weaken the test.
 *
 * Adapted semver, per docs/06 §3 — and the rule that matters is the one that
 * is NOT the software instinct. Participant-visible wording is never PATCH: a
 * one-character typo fix is MAJOR on the form it touches, because two versions
 * whose data cannot be pooled without a comparability argument are a MAJOR apart.
 * PATCH is for corrections invisible to both participants and analysts, and a
 * licence-status update is named there explicitly.
 *
 *   node publish.mjs 7.0.1 "D-10" --by faisalmushtaq
 */

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const [version, ...decisions] = positional;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node publish.mjs <MAJOR.MINOR.PATCH> [decision refs...] [--by who] [--at iso]");
  process.exit(1);
}

const meta = {
  version,
  publishedAt: flag("at") ?? new Date().toISOString(),
  publishedBy: flag("by") ?? "unknown",
  engineVersion: "0.3.0",
  decisionRefs: decisions.length > 0 ? decisions : ["D-10"],
};

const manifest = buildRelease(
  ybmComposition,
  { instruments: allInstruments, modules: allModules, scales: allScales, scoring: allScoring, assets: releaseAssets() },
  meta,
);

const out = fileURLToPath(new URL(`../../releases/ybm_nd2026_standard_r${version}.manifest.json`, import.meta.url));
// Two spaces and a trailing newline, matching the manifests already committed —
// so a diff between two releases is the content and not the whitespace.
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${manifest.release.key}  ${manifest.hash}`);
console.log(`written to releases/ybm_nd2026_standard_r${version}.manifest.json`);
