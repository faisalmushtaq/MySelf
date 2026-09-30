import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifestContentHash } from "@myself/schema";
import { addPublishedReleases, latestRelease, releases, releasesByHash } from "./lib/releases.js";

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

/**
 * Versions published from the dashboard (D-54), as read from the study. Each
 * joins the built-in list only when its manifest matches the hash it is filed
 * under, so a sitting under it is read through it rather than through the
 * latest built-in release.
 */
describe("versions published from the dashboard", () => {
  const r9 = JSON.parse(readFileSync(`${DIR}ybm_nd2026_standard_r9.0.0.manifest.json`, "utf8")) as Record<string, unknown> & {
    release: Record<string, unknown>;
  };

  async function version(v: string): Promise<{ id: string; data: Record<string, unknown> }> {
    const { hash: _old, ...body } = structuredClone(r9);
    body.release["version"] = v;
    body.release["key"] = `ybm_nd2026_standard_r${v.replaceAll(".", "_")}`;
    const hash = await manifestContentHash(body);
    return { id: hash, data: { hash, version: v, key: body.release["key"], manifestJson: JSON.stringify({ ...body, hash }) } };
  }

  it("are added, and the latest release follows them", async () => {
    const before = releases.length;
    const v12 = await version("12.0.0");
    const report = await addPublishedReleases([v12]);
    expect(report.added.map((r) => r.version)).toEqual(["12.0.0"]);
    expect(releasesByHash.get(v12.id)?.version).toBe("12.0.0");
    expect(releases).toHaveLength(before + 1);
    expect(latestRelease?.version).toBe("12.0.0");
    // Reading them again adds nothing.
    expect((await addPublishedReleases([v12])).added).toEqual([]);
    expect(releases).toHaveLength(before + 1);
  });

  it("are refused, and named, when a manifest does not match its hash", async () => {
    const v13 = await version("13.0.0");
    const tampered = {
      id: v13.id,
      data: { ...v13.data, manifestJson: String(v13.data["manifestJson"]).replace("brainpop@leeds.ac.uk", "x@example.com") },
    };
    const report = await addPublishedReleases([tampered]);
    expect(report.added).toEqual([]);
    expect(report.refused).toEqual([{ hash: v13.id, problem: expect.stringMatching(/hashes to/) }]);
    expect(releasesByHash.has(v13.id)).toBe(false);
  });

  it("leave a built-in release as it was when the dashboard republishes it", async () => {
    const hash = r9["hash"] as string;
    const builtIn = releasesByHash.get(hash);
    const report = await addPublishedReleases([{ id: hash, data: { hash, manifestJson: JSON.stringify(r9) } }]);
    expect(report.added).toEqual([]);
    expect(releasesByHash.get(hash)).toBe(builtIn);
  });
});
