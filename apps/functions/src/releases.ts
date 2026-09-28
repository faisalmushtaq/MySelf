import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import r5 from "../../../releases/ybm_nd2026_standard_r5.0.0.manifest.json" with { type: "json" };
import r6 from "../../../releases/ybm_nd2026_standard_r6.0.0.manifest.json" with { type: "json" };
import r7 from "../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json" with { type: "json" };
import r701 from "../../../releases/ybm_nd2026_standard_r7.0.1.manifest.json" with { type: "json" };
import r710 from "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json" with { type: "json" };

/**
 * Every published release, by content hash.
 *
 * A sitting is always read back through the release it was collected under. In
 * a longitudinal study that is not a nicety: wave 1 under r5 and wave 3 under
 * r7 are not the same instrument, and reading one through the other is how a
 * renamed option code becomes a silently wrong answer.
 *
 * Bundled rather than fetched, so a function that runs at two in the morning
 * does not depend on anything being reachable.
 */

// Older releases stay. A sitting is always read back through the release it was
// collected under, so dropping one would make its sittings unreadable.
const published: unknown[] = [r5, r6, r7, r701, r710];

export const releasesByHash = new Map<string, ReleaseManifest>(
  published
    .map((raw) => releaseManifest.safeParse(raw))
    .filter((parsed): parsed is { success: true; data: ReleaseManifest } => parsed.success)
    .map((parsed) => [parsed.data.hash ?? "", parsed.data]),
);

export const latestRelease = [...releasesByHash.values()].sort((a, b) =>
  a.release.version.localeCompare(b.release.version, undefined, { numeric: true }),
)[releasesByHash.size - 1];
