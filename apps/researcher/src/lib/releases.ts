import { openPublishedRelease, releaseManifest, type ReleaseManifest } from "@myself/schema";

/**
 * Every published release, indexed by content hash.
 *
 * A longitudinal study outlives its questionnaire: wave 1 is collected under
 * r5, wave 3 under r7, and the two are not the same instrument even where the
 * variable names match. So each sitting is read back through the release it
 * was actually collected under, which is what its hash identifies. Reading a
 * 2026 session through a 2028 manifest is how a renamed option code turns into
 * a silently wrong answer.
 *
 * Two sources. The files in `releases/` are built in. Versions published from
 * the dashboard (D-54) are read from the study once somebody signs in
 * (`addPublishedReleases`), each only if its manifest hashes to the hash it is
 * filed under, and join the same list. The exports below stay synchronous for
 * the code that reads them; they grow when a published version is added, and
 * the app rebuilds the dataset when that happens.
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

const known = (manifest: ReleaseManifest): KnownRelease => ({
  hash: manifest.hash ?? "",
  key: manifest.release.key,
  version: manifest.release.version,
  manifest,
});

const byVersion = (a: KnownRelease, b: KnownRelease) => a.version.localeCompare(b.version, undefined, { numeric: true });

export const releases: KnownRelease[] = Object.values(modules)
  .map((mod) => {
    const parsed = releaseManifest.safeParse(mod.default);
    if (!parsed.success || !parsed.data.hash) return null;
    return known(parsed.data);
  })
  .filter((r): r is KnownRelease => r !== null)
  .sort(byVersion);

export const releasesByHash = new Map(releases.map((r) => [r.hash, r]));

/** The most recent published release, by version number. */
export let latestRelease: KnownRelease | undefined = releases[releases.length - 1];

/**
 * Each release's manifest by hash, as the shared counting rules take them
 * (@myself/store counting.ts). Kept in step with `releasesByHash`, published
 * versions included.
 */
export const manifestsByHash = new Map(releases.map((r) => [r.hash, r.manifest]));

export interface PublishedReport {
  /** Versions this view had not known, now added. */
  added: KnownRelease[];
  /** Documents that did not check out, and why. None of these is used. */
  refused: { hash: string; problem: string }[];
}

/**
 * Add versions published from the dashboard, as read from
 * `studies/{study}/releases` (`readPublishedReleases` in study.ts).
 *
 * A document whose manifest does not hash to the id it is filed under is
 * refused and reported, never used: a sitting read through the wrong
 * instrument is worse than one not read at all.
 */
export async function addPublishedReleases(documents: { id: string; data: unknown }[]): Promise<PublishedReport> {
  const report: PublishedReport = { added: [], refused: [] };
  for (const document of documents) {
    if (releasesByHash.has(document.id)) continue;
    const opened = await openPublishedRelease(document.data, { expectedHash: document.id });
    if (!opened.ok) {
      report.refused.push({ hash: document.id, problem: opened.problem });
      continue;
    }
    const release = known(opened.manifest);
    releases.push(release);
    releasesByHash.set(release.hash, release);
    manifestsByHash.set(release.hash, release.manifest);
    report.added.push(release);
  }
  releases.sort(byVersion);
  latestRelease = releases[releases.length - 1];
  return report;
}
