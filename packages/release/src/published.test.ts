import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseManifest } from "@myself/schema";
import { verifyManifestHash } from "./builder.js";

/**
 * Every release that has been fielded stays readable.
 *
 * The researcher view and the functions read each sitting back through the
 * manifest it was collected under, and both SKIP a manifest that no longer
 * parses — quietly, so its sittings simply stop being readable. A schema change
 * that breaks an old manifest (a new required field, a narrowed type, a renamed
 * key) fails here instead. New fields must be optional or have a default
 * (docs/16 §3.3).
 *
 * Fielding began with r5.0.0. r1.0.0–r4.0.0 and preview.manifest.json predate
 * it: they never collected a sitting, nothing loads them, and they no longer
 * parse. apps/functions/src/releases.test.ts and apps/researcher/src/releases.test.ts
 * check that each loader keeps every fielded release.
 */

const DIR = fileURLToPath(new URL("../../../releases/", import.meta.url));
const FIRST_FIELDED = [5, 0, 0];
const PRE_FIELDING = ["preview.manifest.json"];

const versionOf = (file: string): number[] | null => {
  const m = /^ybm_nd2026_standard_r(\d+)\.(\d+)\.(\d+)\.manifest\.json$/.exec(file);
  return m ? m.slice(1).map(Number) : null;
};
const atLeast = (v: number[], floor: number[]) => {
  for (let i = 0; i < floor.length; i += 1) if (v[i] !== floor[i]) return v[i]! > floor[i]!;
  return true;
};

const manifestFiles = readdirSync(DIR).filter((f) => f.endsWith(".manifest.json"));
const fielded = manifestFiles.filter((f) => {
  const v = versionOf(f);
  return v !== null && atLeast(v, FIRST_FIELDED);
});

describe("every fielded release in releases/", () => {
  it("is found: r5.0.0 to r8.0.0 at least, and no manifest file the naming rule misses", () => {
    // A release cut but not yet approved for fielding waits in releases/candidates/.
    expect(fielded.length).toBeGreaterThanOrEqual(8);
    // A manifest named some other way would be skipped by every check below.
    const unaccounted = manifestFiles.filter((f) => versionOf(f) === null && !PRE_FIELDING.includes(f));
    expect(unaccounted).toEqual([]);
  });

  it.each(fielded)("%s still parses under the current schema, unedited", (file) => {
    const raw = JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as { hash?: string; release?: { version?: string } };
    const parsed = releaseManifest.safeParse(raw);
    const problems = parsed.success ? [] : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(problems, `${file} no longer parses; its sittings would become unreadable`).toEqual([]);
    if (!parsed.success) return;
    // The loaders index releases by the hash the manifest carries.
    expect(parsed.data.hash).toBe(raw.hash);
    expect(parsed.data.release.version).toBe(versionOf(file)!.join("."));
    // A committed manifest is never edited: its content still matches its hash.
    expect(verifyManifestHash(raw as never), `${file} was edited after it was published`).toBe(true);
  });
});
