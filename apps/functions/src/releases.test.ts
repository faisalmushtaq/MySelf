import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { paths } from "@myself/firebase";
import { contentHashAsync, hashHex, verifyRawManifestHash } from "@myself/schema";
import { bundledManifests, latestRelease, readStoredRelease, releaseResolver, releasesByHash } from "./releases.js";

/**
 * Finding the release a sitting was collected under (docs/16 §5.4).
 *
 * Every reader in the functions — the nightly export, identity capture — goes
 * through this, so what it refuses is what nobody downstream can misread. The
 * store is stood in for by a map: what is worth proving is the order of the
 * lookup and what a document has to be before it is believed, not Firestore.
 */

vi.mock("firebase-functions/logger", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  write: vi.fn(),
}));

const STUDY = "ybm";

type Raw = Record<string, unknown> & { release: Record<string, unknown>; hash?: string };

/** The live release, republished under a new version: a release only the store holds. */
async function studioRelease(version = "8.0.0"): Promise<{ raw: Raw; hash: string }> {
  const live = bundledManifests.find((b) => b.manifest.release.version === "7.1.0");
  if (!live) throw new Error("r7.1.0 is not bundled");
  const body = structuredClone(live.raw) as Raw;
  delete body.hash;
  body.release = {
    ...body.release,
    version,
    key: `ybm_nd2026_standard_r${version.replaceAll(".", "_")}`,
    publishedAt: "2026-10-01T09:00:00.000Z",
  };
  const hash = await contentHashAsync(body);
  return { raw: { ...body, hash }, hash };
}

/** What `studioPublish` writes to `publicReleases/{hashHex}`. */
const storeDoc = (raw: Raw, hash: string) => ({
  surveyId: "ybm_nd2026_standard",
  study: STUDY,
  hash,
  version: String(raw.release["version"]),
  releaseKey: String(raw.release["key"]),
  engineVersion: String(raw.release["engineVersion"]),
  manifest: JSON.stringify(raw),
  bytes: JSON.stringify(raw).length,
  publishedAt: "2026-10-01T09:00:01.000Z",
});

/** Enough Firestore to be read by path, counting the reads. */
function fakeStore() {
  const docs = new Map<string, unknown>();
  const reads: string[] = [];
  const db = {
    doc: (path: string) => ({
      get: async () => {
        reads.push(path);
        return { exists: docs.has(path), data: () => docs.get(path) };
      },
    }),
  } as unknown as Firestore;
  const put = (hash: string, value: unknown) => docs.set(paths.publicRelease(STUDY, hashHex(hash)), value);
  return { db, reads, put };
}

beforeEach(() => {
  vi.mocked(logger.error).mockClear();
});

describe("the bundled releases", () => {
  it("are kept raw beside the parsed copy, and the raw copy verifies", async () => {
    // The import of the live survey writes the raw JSON into the store; a
    // reader re-verifies exactly that, so it has to hash to what it says.
    expect(bundledManifests.length).toBe(releasesByHash.size);
    for (const { raw, manifest } of bundledManifests) {
      expect(await verifyRawManifestHash(raw)).toBe(true);
      expect(releasesByHash.get(manifest.hash!)).toBe(manifest);
    }
    expect(latestRelease?.release.version).toBe("7.1.0");
  });
});

describe("resolving a release by hash", () => {
  it("finds a bundled release without reading the store", async () => {
    const { db, reads } = fakeStore();
    const resolve = releaseResolver();
    const found = await resolve(db, STUDY, latestRelease!.hash!);
    expect(found?.source).toBe("bundled");
    expect(found?.manifest).toBe(latestRelease);
    expect(reads).toEqual([]);
  });

  it("reads a release only the store holds, once its hash verifies", async () => {
    const { raw, hash } = await studioRelease();
    const { db, put } = fakeStore();
    put(hash, storeDoc(raw, hash));

    const found = await releaseResolver()(db, STUDY, hash);
    expect(found?.source).toBe("store");
    expect(found?.manifest.hash).toBe(hash);
    expect(found?.manifest.release.version).toBe("8.0.0");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("refuses a stored manifest whose content was altered, and says so", async () => {
    const { raw, hash } = await studioRelease();
    // One option label changed, the hash left as it was: the answers would be
    // read against a label nobody was shown.
    const scale = Object.values(raw["scales"] as Record<string, { options: { label: string }[] }>)[0]!;
    scale.options[0]!.label = "Something else entirely";
    const { db, put } = fakeStore();
    put(hash, storeDoc(raw, hash));

    expect(await releaseResolver()(db, STUDY, hash)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/failed verification/),
      expect.objectContaining({ releaseHash: hash, reason: expect.stringMatching(/does not hash/) }),
    );
  });

  it("refuses an intact release filed under another release's hash", async () => {
    // Every byte of it verifies — against its own hash. Read under the one it
    // is filed as, it would be exactly the silent misread D-35 forbids.
    const eight = await studioRelease("8.0.0");
    const nine = await studioRelease("9.0.0");
    const { db, put } = fakeStore();
    put(nine.hash, { ...storeDoc(eight.raw, eight.hash), hash: nine.hash });

    expect(await releaseResolver()(db, STUDY, nine.hash)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/failed verification/),
      expect.objectContaining({ reason: expect.stringMatching(/different hash/) }),
    );
  });

  it("refuses a document whose manifest is not a JSON string", async () => {
    const { raw, hash } = await studioRelease();
    const { db, put } = fakeStore();
    put(hash, { ...storeDoc(raw, hash), manifest: raw });
    expect(await releaseResolver()(db, STUDY, hash)).toBeNull();

    put(hash, { ...storeDoc(raw, hash), manifest: "{not json" });
    expect(await releaseResolver()(db, STUDY, hash)).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("returns null for a hash neither the bundle nor the store knows", async () => {
    const { hash } = await studioRelease();
    const { db, reads } = fakeStore();
    expect(await releaseResolver()(db, STUDY, hash)).toBeNull();
    expect(reads).toEqual([paths.publicRelease(STUDY, hashHex(hash))]);
  });

  it("does not build a document path out of a malformed hash", async () => {
    const { db, reads } = fakeStore();
    const resolve = releaseResolver();
    expect(await resolve(db, STUDY, "sha256-abc")).toBeNull();
    expect(await resolve(db, STUDY, "sha256:../../sessions/x")).toBeNull();
    expect(reads).toEqual([]);
  });

  it("keeps a verified release, and reads the store once for it", async () => {
    const { raw, hash } = await studioRelease();
    const { db, reads, put } = fakeStore();
    put(hash, storeDoc(raw, hash));
    const resolve = releaseResolver();

    const first = await resolve(db, STUDY, hash);
    const second = await resolve(db, STUDY, hash);
    expect(second?.manifest).toBe(first?.manifest);
    expect(second?.source).toBe("store");
    expect(reads).toHaveLength(1);
  });

  it("does not remember a miss, so a release stored later is found", async () => {
    const { raw, hash } = await studioRelease();
    const { db, reads, put } = fakeStore();
    const resolve = releaseResolver();

    expect(await resolve(db, STUDY, hash)).toBeNull();
    put(hash, storeDoc(raw, hash));
    expect((await resolve(db, STUDY, hash))?.source).toBe("store");
    expect(reads).toHaveLength(2);
  });

  it("lets a failing read throw rather than report the release as unknown", async () => {
    // An export that left a release out because the database hiccuped would
    // look complete; one that fails is retried and noticed.
    const { hash } = await studioRelease();
    const db = {
      doc: () => ({
        get: async () => {
          throw new Error("unavailable");
        },
      }),
    } as unknown as Firestore;
    await expect(releaseResolver()(db, STUDY, hash)).rejects.toThrow("unavailable");
  });
});

describe("reading a stored release", () => {
  it("refuses a document that disagrees with itself about its hash", async () => {
    const { raw, hash } = await studioRelease();
    const other = `sha256:${"0".repeat(64)}`;
    expect(await readStoredRelease({ ...storeDoc(raw, hash), hash: other }, hash)).toEqual({
      refused: expect.stringMatching(/says it holds/),
    });
  });

  it("refuses a missing document body without throwing", async () => {
    const { hash } = await studioRelease();
    expect(await readStoredRelease(undefined, hash)).toEqual({ refused: expect.any(String) });
    expect(await readStoredRelease({ manifest: "null" }, hash)).toEqual({ refused: expect.any(String) });
  });
});
