import {
  countSittings,
  DEFAULT_COUNTING_RULES,
  emptyDataset,
  ingest,
  type CountResult,
  type Dataset,
  type DeviceSession,
  type IdentityRow,
} from "@myself/store";
import { latestRelease, manifestsByHash, releasesByHash } from "./releases.js";

/**
 * Turning everything stored into one dataset.
 *
 * Sittings are grouped by the release they were collected under and ingested
 * oldest release first, each pass carrying the previous one forward, so wave
 * numbering follows the participant across releases rather than restarting
 * whenever the questionnaire changed.
 */

export interface BuildResult {
  dataset: Dataset;
  /** Names and code components, kept apart from the dataset (D-37). */
  identity: IdentityRow[];
  rejected: { sessionId: string; reason: string }[];
  /** One code carrying two different names — twins, until resolved (D-38). */
  collisions: { participantId: string; names: string[]; sessions: string[] }[];
  warnings: string[];
}

export function buildDataset(
  sessions: DeviceSession[],
  study: string,
  aliases: Record<string, string> = {},
  assignments: Record<string, string> = {},
): BuildResult {
  if (sessions.length === 0) {
    return { dataset: emptyDataset(), identity: [], rejected: [], collisions: [], warnings: [] };
  }

  const groups = new Map<string, DeviceSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.releaseHash);
    if (list) list.push(s);
    else groups.set(s.releaseHash, [s]);
  }

  // Oldest sitting first, so a participant's waves are numbered in the order
  // they actually happened rather than the order the files were imported.
  const ordered = [...groups.entries()].sort((a, b) => {
    const first = (rows: DeviceSession[]) => rows.reduce((m, r) => (r.startedAt < m ? r.startedAt : m), rows[0]!.startedAt);
    return first(a[1]).localeCompare(first(b[1]));
  });

  let dataset = emptyDataset();
  const identity: IdentityRow[] = [];
  const collisions: BuildResult["collisions"] = [];
  const rejected: BuildResult["rejected"] = [];
  const warnings: string[] = [];

  for (const [hash, group] of ordered) {
    const known = releasesByHash.get(hash);
    const release = known ?? latestRelease;
    if (!release) {
      rejected.push(
        ...group.map((s) => ({ sessionId: s.sessionId, reason: "no release manifest available to read this sitting" })),
      );
      continue;
    }
    if (!known) {
      // Read under a release it was not collected under: usable for counting
      // sittings, not for analysis, and it says so rather than looking fine.
      warnings.push(
        `${group.length} sitting${group.length === 1 ? "" : "s"} collected under an unpublished release (${hash.slice(0, 16)}…) — read using ${release.version}; check before analysing`,
      );
    }
    const sortedGroup = [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const result = ingest(sortedGroup, {
      manifest: release.manifest,
      study,
      existing: dataset,
      aliases,
      assignments,
    });
    dataset = result.dataset;
    identity.push(...result.identity);
    collisions.push(...result.collisions);
    rejected.push(...result.rejected);
    warnings.push(...result.warnings);
  }

  return { dataset, identity, rejected, collisions, warnings };
}

/** The rules this view counts by: the research dashboard's defaults. */
export const COUNTING_RULES = DEFAULT_COUNTING_RULES;

/**
 * Count what is held, by the rules the research dashboard counts by.
 *
 * The rules are @myself/store's `countSittings`, which the dashboard vendors and checks
 * against its own figures, so a number shown here and there under the same label is the
 * same number for the same sittings. Each sitting is judged against its OWN release: one
 * collected under a release this build does not know is counted, but cannot be called
 * incomplete — unlike `buildDataset` above, which reads it through the latest release so
 * its answers can at least be seen.
 *
 * `dataset` is `buildDataset`'s, over every stored sitting: test sittings are ingested
 * too, so leaving them out never renumbers anybody's waves.
 */
export function countStudy(
  sessions: readonly (DeviceSession & { receivedAt?: string })[],
  dataset: Dataset,
  includeTest: boolean,
  now = new Date(),
): CountResult {
  return countSittings({ sittings: sessions, dataset, manifests: manifestsByHash, rules: COUNTING_RULES, includeTest, now });
}
