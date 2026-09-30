import { releaseManifest, type ReleaseManifest } from "@myself/schema";

/**
 * Every published release, indexed by content hash.
 *
 * A longitudinal study outlives its questionnaire: wave 1 is collected under
 * r5, wave 3 under r7, and the two are not the same instrument even where the
 * variable names match. So each sitting is read back through the release it
 * was actually collected under, which is what its hash identifies. Reading a
 * 2026 session through a 2028 manifest is how a renamed option code turns into
 * a silently wrong answer.
 */

const modules = import.meta.glob("../../../../releases/*.manifest.json", { eager: true }) as Record<
  string,
  { default: unknown }
>;

export interface KnownRelease {
  hash: string;
  key: string;
  version: string;
  manifest: ReleaseManifest;
}

export const releases: KnownRelease[] = Object.entries(modules)
  .map(([path, mod]) => {
    const parsed = releaseManifest.safeParse(mod.default);
    if (!parsed.success) return null;
    const manifest = parsed.data;
    if (!manifest.hash) return null;
    void path;
    return { hash: manifest.hash, key: manifest.release.key, version: manifest.release.version, manifest };
  })
  .filter((r): r is KnownRelease => r !== null)
  .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

export const releasesByHash = new Map(releases.map((r) => [r.hash, r]));

/** The most recent published release — what a new sitting will be collected under. */
export const latestRelease = releases[releases.length - 1];

/** Each release's manifest by hash, as the shared counting rules take them (@myself/store counting.ts). */
export const manifestsByHash = new Map(releases.map((r) => [r.hash, r.manifest]));
