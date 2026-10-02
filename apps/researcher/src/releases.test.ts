import { describe, expect, it, vi } from "vitest";
import { contentHashAsync } from "@myself/schema";
import { buildDemoSessions, type DeviceSession } from "@myself/store";
import live from "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json";
import { buildDatasetWithStore, resolveFromStore, type ReleaseFetcher } from "./lib/build.js";
import { latestRelease, readStoredRelease, releasesByHash, type KnownRelease } from "./lib/releases.js";

/**
 * Reading a sitting collected under a release this build was not shipped with.
 *
 * Releases published from the Studio live in the study's release store, not in
 * this bundle (docs/16 §5.4). Before a dataset is built the view asks the store
 * for any hash it does not know, and believes only what re-verifies: a release
 * that is not what its hash says would decode every answer against the wrong
 * questions, which is worse than not reading them at all. The store is stood
 * in for by a function, the way `assemblePull` is tested without a database.
 */

type Raw = Record<string, unknown> & { release: Record<string, unknown>; hash?: string };

/** r8.0.0's content republished as another version: held only by the store. */
async function studioRelease(version = "9.0.0"): Promise<{ raw: Raw; hash: string }> {
  const body = structuredClone(live) as unknown as Raw;
  delete body.hash;
  body.release = { ...body.release, version, key: `ybm_nd2026_standard_r${version.replaceAll(".", "_")}` };
  const hash = await contentHashAsync(body);
  return { raw: { ...body, hash }, hash };
}

/** What `studioPublish` files under `publicReleases/{hashHex}`. */
const storeDoc = (raw: Raw, hash: string) => ({ hash, version: raw.release["version"], manifest: JSON.stringify(raw) });

const fetcherOf = (docs: Record<string, unknown>) =>
  vi.fn<ReleaseFetcher>(async (hash) => (hash in docs ? docs[hash] : null));

const sittings = buildDemoSessions({ manifest: latestRelease!.manifest, participants: 2 });
const under = (hash: string, id: string): DeviceSession => ({ ...sittings[0]!, sessionId: id, releaseHash: hash });

describe("asking the release store", () => {
  it("adds a release the store holds, once its hash verifies", async () => {
    const { raw, hash } = await studioRelease();
    const { found, refused } = await resolveFromStore([hash], fetcherOf({ [hash]: storeDoc(raw, hash) }));
    expect(refused).toEqual([]);
    expect(found.map((r) => [r.hash, r.version])).toEqual([[hash, "9.0.0"]]);
  });

  it("refuses a stored manifest whose content was altered", async () => {
    const { raw, hash } = await studioRelease();
    const scale = Object.values(raw["scales"] as Record<string, { options: { label: string }[] }>)[0]!;
    scale.options[0]!.label = "Something else entirely";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { found, refused } = await resolveFromStore([hash], fetcherOf({ [hash]: storeDoc(raw, hash) }));
    expect(found).toEqual([]);
    expect(refused).toEqual([{ hash, reason: expect.stringMatching(/does not hash/) }]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refuses an intact release filed under another release's hash", async () => {
    const nine = await studioRelease("9.0.0");
    const ten = await studioRelease("10.0.0");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { found, refused } = await resolveFromStore(
      [ten.hash],
      fetcherOf({ [ten.hash]: { ...storeDoc(nine.raw, nine.hash), hash: ten.hash } }),
    );
    expect(found).toEqual([]);
    expect(refused).toHaveLength(1);
    vi.mocked(console.error).mockRestore();
  });

  it("leaves a hash unknown when the store has nothing, the fetch fails or it never answers", async () => {
    const [a, b, c] = await Promise.all([studioRelease("9.0.0"), studioRelease("9.0.1"), studioRelease("9.0.2")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchRelease = vi.fn<ReleaseFetcher>(async (hash) => {
      if (hash === b.hash) throw new Error("offline");
      if (hash === c.hash) return new Promise(() => undefined);
      return null;
    });
    const { found, refused } = await resolveFromStore([a.hash, b.hash, c.hash], fetchRelease, 20);
    expect(found).toEqual([]);
    expect(refused).toEqual([]);
    expect(fetchRelease).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("does not ask about something that is not a hash", async () => {
    const fetchRelease = fetcherOf({});
    await resolveFromStore(["sha256:abc", "sha256:../../sessions/x"], fetchRelease);
    expect(fetchRelease).not.toHaveBeenCalled();
  });

  it("never throws on what a document holds", async () => {
    const { hash } = await studioRelease();
    for (const data of [{}, { manifest: 42 }, { manifest: "{" }, { manifest: "null" }, { manifest: "[]" }]) {
      expect(await readStoredRelease(data, hash)).toEqual({ refused: expect.any(String) });
    }
  });
});

describe("building a dataset with the release store", () => {
  it("reads a sitting under a store release through that release, without the unpublished warning", async () => {
    const { raw, hash } = await studioRelease();
    const fetchRelease = fetcherOf({ [hash]: storeDoc(raw, hash) });
    const built = await buildDatasetWithStore([...sittings, under(hash, "ses_under_r8")], "YBM-ND2026", {}, {}, {
      fetchRelease,
      cache: new Map(),
    });

    expect(fetchRelease).toHaveBeenCalledTimes(1);
    expect(fetchRelease).toHaveBeenCalledWith(hash);
    expect(built.dataset.releaseHashes).toContain(hash);
    expect(built.dataset.sessions.map((s) => s.sessionId)).toContain("ses_under_r8");
    expect(built.warnings.some((w) => /unpublished release/.test(w))).toBe(false);
  });

  it("does not use a tampered store release, and keeps today's warning for its sittings", async () => {
    const { raw, hash } = await studioRelease();
    (raw.release as Record<string, unknown>)["publishedBy"] = "somebody else";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cache = new Map<string, KnownRelease>();

    const built = await buildDatasetWithStore([under(hash, "ses_tampered")], "YBM-ND2026", {}, {}, {
      fetchRelease: fetcherOf({ [hash]: storeDoc(raw, hash) }),
      cache,
    });

    // Not kept, and not used: the sitting falls back to exactly what an unknown
    // hash always got, warning and all.
    expect(cache.size).toBe(0);
    expect(built.warnings.some((w) => /failed verification/.test(w))).toBe(true);
    expect(built.warnings.some((w) => /unpublished release/.test(w) && w.includes(latestRelease!.version))).toBe(true);
    vi.mocked(console.error).mockRestore();
  });

  it("does not go to the store for bundled releases, or twice for one it already verified", async () => {
    const { raw, hash } = await studioRelease();
    const fetchRelease = fetcherOf({ [hash]: storeDoc(raw, hash) });
    const cache = new Map<string, KnownRelease>();

    await buildDatasetWithStore(sittings, "YBM-ND2026", {}, {}, { fetchRelease, cache });
    expect(fetchRelease).not.toHaveBeenCalled();
    expect(releasesByHash.has(sittings[0]!.releaseHash)).toBe(true);

    await buildDatasetWithStore([under(hash, "ses_a")], "YBM-ND2026", {}, {}, { fetchRelease, cache });
    await buildDatasetWithStore([under(hash, "ses_b")], "YBM-ND2026", {}, {}, { fetchRelease, cache });
    expect(fetchRelease).toHaveBeenCalledTimes(1);
  });
});
