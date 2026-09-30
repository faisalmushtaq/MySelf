import * as logger from "firebase-functions/logger";
import type { Firestore } from "firebase-admin/firestore";
import { openPublishedRelease, publishedPaths, releaseManifest, type ReleaseManifest } from "@myself/schema";
import { STUDY, research } from "./apps.js";
import r5 from "../../../releases/ybm_nd2026_standard_r5.0.0.manifest.json" with { type: "json" };
import r6 from "../../../releases/ybm_nd2026_standard_r6.0.0.manifest.json" with { type: "json" };
import r7 from "../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json" with { type: "json" };
import r701 from "../../../releases/ybm_nd2026_standard_r7.0.1.manifest.json" with { type: "json" };
import r710 from "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json" with { type: "json" };
import r720 from "../../../releases/ybm_nd2026_standard_r7.2.0.manifest.json" with { type: "json" };
import r730 from "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json" with { type: "json" };
import r800 from "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json" with { type: "json" };
import r900 from "../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json" with { type: "json" };

/**
 * Every published release, by content hash.
 *
 * A sitting is always read back through the release it was collected under. In
 * a longitudinal study that is not a nicety: wave 1 under r5 and wave 3 under
 * r7 are not the same instrument, and reading one through the other is how a
 * renamed option code becomes a silently wrong answer.
 *
 * TWO SOURCES. The releases cut in this repository are bundled, so a function
 * that runs at two in the morning does not depend on anything being reachable
 * to read them. Versions published from the dashboard (D-54) live in the
 * study's database, `studies/{study}/releases`, and are read from there by
 * `knownReleases`, cached for a minute. Each is used only if its manifest
 * hashes to the hash it is filed under, the same check a device makes before
 * running it, so a sitting or a MyStory run under a dashboard version is read
 * exactly like one under a bundled release.
 */

// Older releases stay. A sitting is always read back through the release it was
// collected under, so dropping one would make its sittings unreadable.
const published: unknown[] = [r5, r6, r7, r701, r710, r720, r730, r800, r900];

/** The releases bundled with these functions. */
export const bundledReleases: ReadonlyMap<string, ReleaseManifest> = new Map(
  published
    .map((raw) => releaseManifest.safeParse(raw))
    .filter((parsed): parsed is { success: true; data: ReleaseManifest } => parsed.success)
    .map((parsed) => [parsed.data.hash ?? "", parsed.data]),
);

/**
 * Every release known so far: the bundled ones, and each published version
 * once `knownReleases` has read it. Content-addressed, so an entry never
 * changes once it is here; it only grows.
 *
 * Synchronous for the callers that were written against the bundled list.
 * Anything that may meet a sitting under a dashboard version awaits
 * `knownReleases` or `releaseFor` first.
 */
export const releasesByHash = new Map<string, ReleaseManifest>(bundledReleases);

const newest = (releases: Iterable<ReleaseManifest>): ReleaseManifest | undefined =>
  [...releases].sort((a, b) => a.release.version.localeCompare(b.release.version, undefined, { numeric: true })).at(-1);

/** The highest-numbered release known so far. Updated as published versions are read. */
export let latestRelease: ReleaseManifest | undefined = newest(releasesByHash.values());

/** How long a read of the published versions is trusted before it is read again. */
export const PUBLISHED_CACHE_MS = 60_000;
/**
 * How soon a hash nobody knows may send us back to the database.
 *
 * A version published a moment ago reaches a device before this instance's
 * cache expires. Looking again on a miss picks it up; waiting at least this
 * long between looks stops a stream of unknown hashes from reading the
 * collection on every request.
 */
export const MISS_RETRY_MS = 5_000;

export interface ReleaseLookup {
  /** The survey's database. Defaults to this project's. */
  db?: Firestore;
  study?: string;
  /** Read again if the last read is older than this. */
  maxAgeMs?: number;
  now?: () => number;
}

export interface KnownReleases {
  byHash: ReadonlyMap<string, ReleaseManifest>;
  latest: ReleaseManifest | undefined;
}

let readAt = Number.NEGATIVE_INFINITY;
let reading: Promise<void> | null = null;
/** Hashes already refused, so a bad document is reported once rather than every minute. */
const refused = new Set<string>();

/** Bundled and published releases, the published ones read within the last minute. */
export async function knownReleases(lookup: ReleaseLookup = {}): Promise<KnownReleases> {
  const now = lookup.now?.() ?? Date.now();
  if (now - readAt >= (lookup.maxAgeMs ?? PUBLISHED_CACHE_MS)) {
    // One read at a time: callers arriving while it is under way share it.
    reading ??= readPublished(lookup, now).finally(() => {
      reading = null;
    });
    await reading;
  }
  return { byHash: releasesByHash, latest: latestRelease };
}

/** The release a sitting was collected under, looking in the database again if it is not yet known. */
export async function releaseFor(hash: string, lookup: ReleaseLookup = {}): Promise<ReleaseManifest | undefined> {
  const known = (await knownReleases(lookup)).byHash.get(hash);
  if (known) return known;
  return (await knownReleases({ ...lookup, maxAgeMs: MISS_RETRY_MS })).byHash.get(hash);
}

async function readPublished(lookup: ReleaseLookup, now: number): Promise<void> {
  try {
    const db = lookup.db ?? research();
    const snapshot = await db.collection(publishedPaths.releases(lookup.study ?? STUDY)).get();
    for (const document of snapshot.docs) {
      if (releasesByHash.has(document.id) || refused.has(document.id)) continue;
      const opened = await openPublishedRelease(document.data(), { expectedHash: document.id });
      if (!opened.ok) {
        refused.add(document.id);
        logger.error("a published version was refused and will not be used to read sittings", {
          hash: document.id,
          problem: opened.problem,
        });
        continue;
      }
      releasesByHash.set(document.id, opened.manifest);
    }
    latestRelease = newest(releasesByHash.values());
  } catch (error) {
    // The releases already known stay usable. Sittings under a version not
    // yet read are reported by whoever needed it, as they always were.
    logger.error("the published versions could not be read; using the releases already known", {
      error: String(error),
    });
  } finally {
    readAt = now;
  }
}

/** Only for tests, which each need to start from the bundled releases alone. */
export function forgetPublishedForTests(): void {
  releasesByHash.clear();
  for (const [hash, manifest] of bundledReleases) releasesByHash.set(hash, manifest);
  latestRelease = newest(releasesByHash.values());
  readAt = Number.NEGATIVE_INFINITY;
  reading = null;
  refused.clear();
}
