import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releases } from "./lib/releases.js";

/**
 * The researcher view loads every file in releases/ and skips any that does not
 * parse, so a sitting collected under a skipped release cannot be read. Every
 * fielded release (r5.0.0 on; packages/release/src/published.test.ts) must load;
 * the earlier ones never collected a sitting and are expected to be skipped.
 */

const DIR = fileURLToPath(new URL("../../../releases/", import.meta.url));

function fieldedHashes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(DIR)) {
    const m = /^ybm_nd2026_standard_r(\d+)\.\d+\.\d+\.manifest\.json$/.exec(file);
    if (!m || Number(m[1]) < 5) continue;
    const { hash } = JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as { hash: string };
    out.set(hash, file);
  }
  return out;
}

describe("the releases the researcher view loads", () => {
  it("include every fielded release in releases/", () => {
    const loaded = new Set(releases.map((r) => r.hash));
    const missing = [...fieldedHashes()].filter(([hash]) => !loaded.has(hash)).map(([, file]) => file);
    expect(missing, "these no longer parse, so their sittings cannot be read").toEqual([]);
  });
});
