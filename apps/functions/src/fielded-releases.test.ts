import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releasesByHash } from "./releases.js";

/**
 * The functions read a sitting through the release it was collected under, and
 * skip a bundled manifest that does not parse. So every fielded release (r5.0.0
 * on; packages/release/src/published.test.ts) must be bundled in releases.ts
 * AND survive parsing — otherwise its sittings cannot be ingested or exported.
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

describe("the releases the functions bundle", () => {
  it("are every fielded release in releases/, none dropped for failing to parse", () => {
    const expected = fieldedHashes();
    const missing = [...expected].filter(([hash]) => !releasesByHash.has(hash)).map(([, file]) => file);
    expect(missing, "add each to `published` in releases.ts, and keep it parsing").toEqual([]);
  });
});
