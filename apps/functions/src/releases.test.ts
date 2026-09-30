import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { manifestContentHash } from "@myself/schema";
import {
  MISS_RETRY_MS,
  PUBLISHED_CACHE_MS,
  bundledReleases,
  forgetPublishedForTests,
  knownReleases,
  releaseFor,
  releasesByHash,
} from "./releases.js";

// Refusals are logged as errors, which is right in production and noise here.
vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));

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

/**
 * Versions published from the dashboard (D-54), read from the database with a
 * stand-in for Firestore. The same thing against the real emulator is in
 * integration/releases.integration.test.ts.
 */
describe("versions published from the dashboard", () => {
  const r9 = JSON.parse(readFileSync(`${DIR}ybm_nd2026_standard_r9.0.0.manifest.json`, "utf8")) as Record<string, unknown> & {
    release: Record<string, unknown>;
  };

  /** r9.0.0 republished as `version`, hashed again as the dashboard's builder would. */
  async function version(v: string): Promise<{ hash: string; doc: Record<string, unknown> }> {
    const { hash: _old, ...body } = structuredClone(r9);
    body.release["version"] = v;
    body.release["key"] = `ybm_nd2026_standard_r${v.replaceAll(".", "_")}`;
    const hash = await manifestContentHash(body);
    return {
      hash,
      doc: { hash, version: v, key: body.release["key"], engineVersion: "0.3.0", manifestJson: JSON.stringify({ ...body, hash }) },
    };
  }

  /** The survey's database, holding `docs` under `studies/ybm/releases`. */
  function database(docs: () => Record<string, Record<string, unknown>>, fail = false) {
    const reads: string[] = [];
    const db = {
      collection: (path: string) => ({
        get: async () => {
          reads.push(path);
          if (fail) throw new Error("UNAVAILABLE");
          return { docs: Object.entries(docs()).map(([id, data]) => ({ id, data: () => data })) };
        },
      }),
    } as unknown as Firestore;
    return { db, reads };
  }

  beforeEach(() => forgetPublishedForTests());

  it("are read from the study's releases collection and used alongside the bundled ones", async () => {
    const v10 = await version("10.0.0");
    const { db, reads } = database(() => ({ [v10.hash]: v10.doc }));
    const known = await knownReleases({ db, study: "ybm" });
    expect(reads).toEqual(["studies/ybm/releases"]);
    expect(known.byHash.get(v10.hash)?.release.version).toBe("10.0.0");
    for (const hash of bundledReleases.keys()) expect(known.byHash.has(hash)).toBe(true);
    expect(known.latest?.release.version).toBe("10.0.0");
    // The synchronous view the older callers use has learned it too.
    expect(releasesByHash.has(v10.hash)).toBe(true);
  });

  it("are refused when the manifest does not match the hash it is filed under", async () => {
    const v10 = await version("10.0.0");
    const v11 = await version("11.0.0");
    const tampered = { ...v10.doc, manifestJson: String(v10.doc["manifestJson"]).replace("brainpop@leeds.ac.uk", "x@example.com") };
    const { db } = database(() => ({
      [v10.hash]: tampered,
      // Filed under another version's hash.
      [v11.hash]: v10.doc,
    }));
    const known = await knownReleases({ db, study: "ybm" });
    expect(known.byHash.has(v10.hash)).toBe(false);
    expect(known.byHash.has(v11.hash)).toBe(false);
    expect(known.latest?.release.version).toBe("9.0.0");
  });

  it("are read at most once a minute", async () => {
    const v10 = await version("10.0.0");
    const { db, reads } = database(() => ({ [v10.hash]: v10.doc }));
    let now = 1_000_000;
    await knownReleases({ db, now: () => now });
    now += PUBLISHED_CACHE_MS - 1;
    await knownReleases({ db, now: () => now });
    expect(reads).toHaveLength(1);
    now += 1;
    await knownReleases({ db, now: () => now });
    expect(reads).toHaveLength(2);
  });

  it("are looked for again, sooner, when a sitting names one not yet read", async () => {
    // Published a moment after this instance last looked.
    const v10 = await version("10.0.0");
    let docs: Record<string, Record<string, unknown>> = {};
    const { db, reads } = database(() => docs);
    let now = 1_000_000;
    await knownReleases({ db, now: () => now });
    docs = { [v10.hash]: v10.doc };

    now += MISS_RETRY_MS - 1;
    expect(await releaseFor(v10.hash, { db, now: () => now })).toBeUndefined();
    now += 1;
    expect((await releaseFor(v10.hash, { db, now: () => now }))?.release.version).toBe("10.0.0");
    expect(reads).toHaveLength(2);
  });

  it("leave the known releases usable when the database cannot be read", async () => {
    const { db } = database(() => ({}), true);
    const known = await knownReleases({ db });
    expect(known.byHash.size).toBe(bundledReleases.size);
    expect(known.latest?.release.version).toBe("9.0.0");
  });

  it("find a bundled release without asking the database twice", async () => {
    const { db, reads } = database(() => ({}));
    const [hash] = [...bundledReleases.keys()];
    expect(await releaseFor(hash!, { db })).toBe(bundledReleases.get(hash!));
    expect(reads).toHaveLength(1);
  });
});
