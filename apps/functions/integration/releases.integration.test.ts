import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { manifestContentHash, publishedPaths } from "@myself/schema";
import { configFor, configForPublished, type Caller } from "../src/relay-policy.js";
import { MISS_RETRY_MS, bundledReleases, forgetPublishedForTests, knownReleases, releaseFor } from "../src/releases.js";

/**
 * Versions published from the dashboard (D-54), read from a real Firestore.
 *
 * The dashboard's functions write `studies/{study}/releases/{hash}` with the
 * Admin SDK. This writes the same documents the same way, and checks that the
 * functions read them back as releases: alongside the bundled ones, only when
 * the manifest matches its hash, soon after publishing, and with their model
 * configs available to a device's MyStory run.
 */

const STUDY = "ybm";
const r9 = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json", import.meta.url)), "utf8"),
) as Record<string, unknown> & { release: Record<string, unknown>; modelConfigs: Record<string, unknown> };

const device: Caller = { uid: "dev_integration", device: true, anonymous: false };

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" }, `releases-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection(publishedPaths.releases(STUDY)));
  forgetPublishedForTests();
});

/** Publish r9.0.0 again as `version`, the way the dashboard's `publishSurveyVersion` writes it. */
async function publish(version: string, modelConfigs: Record<string, unknown> = {}): Promise<string> {
  const { hash: _old, ...body } = structuredClone(r9);
  body.release["version"] = version;
  body.release["key"] = `ybm_nd2026_standard_r${version.replaceAll(".", "_")}`;
  body.modelConfigs = { ...body.modelConfigs, ...modelConfigs };
  const hash = await manifestContentHash(body);
  await db.doc(publishedPaths.release(STUDY, hash)).set({
    hash,
    version,
    key: body.release["key"],
    study: STUDY,
    publishedAt: new Date().toISOString(),
    publishedBy: "owner@example.ac.uk",
    engineVersion: "0.3.0",
    manifestJson: JSON.stringify({ ...body, hash }),
    source: "editor",
    notes: "integration test",
  });
  return hash;
}

describe("versions published from the dashboard, in a real database", () => {
  it("are read alongside the bundled releases, and only when they match their hash", async () => {
    const good = await publish("10.0.0");
    const bad = await publish("11.0.0");
    // Changed after it was hashed, as a hand edit in the console would.
    const stored = (await db.doc(publishedPaths.release(STUDY, bad)).get()).data()!;
    await db.doc(publishedPaths.release(STUDY, bad)).update({
      manifestJson: String(stored["manifestJson"]).replace("brainpop@leeds.ac.uk", "someone@example.com"),
    });

    const known = await knownReleases({ db, study: STUDY });
    expect(known.byHash.get(good)?.release.version).toBe("10.0.0");
    expect(known.byHash.has(bad)).toBe(false);
    for (const hash of bundledReleases.keys()) expect(known.byHash.has(hash)).toBe(true);
    expect(known.latest?.release.version).toBe("10.0.0");
  });

  it("are found for a sitting soon after they are published, without waiting out the cache", async () => {
    let now = 5_000_000;
    await knownReleases({ db, study: STUDY, now: () => now });
    const fresh = await publish("10.0.0");

    now += MISS_RETRY_MS;
    const manifest = await releaseFor(fresh, { db, study: STUDY, now: () => now });
    expect(manifest?.release.version).toBe("10.0.0");
    expect(manifest?.hash).toBe(fresh);
  });

  it("give a device's MyStory run the model config the version froze, and nothing else", async () => {
    // A protocol edited in the dashboard, frozen with its own model config.
    const key = "mc.integration.dashboard.v1";
    await publish("10.0.0", {
      [key]: { key, provider: "openai", model: "gpt-4o-mini", temperature: 0.7, maxOutputTokens: 800 },
    });
    expect(() => configFor(key, device)).toThrow();

    const load = async (maxAgeMs?: number) =>
      (await knownReleases({ db, study: STUDY, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) })).byHash.values();
    expect((await configForPublished(key, device, load)).key).toBe(key);
    await expect(configForPublished("mc.integration.never.published", device, load)).rejects.toThrow();
  });
});
