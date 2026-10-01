import { sha256 } from "@myself/schema";
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
import { latestRelease, manifestsByHash, readStoredRelease, releasesByHash, type KnownRelease } from "./releases.js";
import { fetchPublicRelease } from "./study.js";

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

/**
 * Releases by hash. The bundled ones by default; `buildDatasetWithStore`
 * passes them together with any the release store supplied.
 */
export type ReleaseRegistry = ReadonlyMap<string, KnownRelease>;

export function buildDataset(
  sessions: DeviceSession[],
  study: string,
  aliases: Record<string, string> = {},
  assignments: Record<string, string> = {},
  registry: ReleaseRegistry = releasesByHash,
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
    const known = registry.get(hash);
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

// ---------------------------------------------------------------------------
// Releases the bundle does not know (docs/16 §5.4)
// ---------------------------------------------------------------------------

/** The release store's document for a hash, unverified, or null when it has none. */
export type ReleaseFetcher = (hash: string) => Promise<unknown>;

export interface StoreResolution {
  /** Releases the store held for the hashes asked about, each verified. */
  found: KnownRelease[];
  /** Documents the store held that failed verification, and were not used. */
  refused: { hash: string; reason: string }[];
}

/**
 * Long enough for a slow school network, short enough that a laptop with no
 * connection still shows its data. The web SDK can take a while to decide it
 * is offline, and nothing here is worth waiting on indefinitely.
 */
const FETCH_TIMEOUT_MS = 10_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Ask the release store for each hash, and keep only what verifies.
 *
 * A fetch that fails or does not answer leaves its hash unknown, exactly as
 * it was before the store existed; the dataset is still built. A document
 * that fails verification is different — something wrote a release that is
 * not what its hash says — so it is reported, and never used.
 */
export async function resolveFromStore(
  hashes: Iterable<string>,
  fetchRelease: ReleaseFetcher,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<StoreResolution> {
  const found: KnownRelease[] = [];
  const refused: StoreResolution["refused"] = [];
  // Only a well-formed hash names a document; anything else is unknown.
  const asked = [...new Set(hashes)].filter((hash) => sha256.safeParse(hash).success);

  await Promise.all(
    asked.map(async (hash) => {
      let data: unknown;
      try {
        data = await within(fetchRelease(hash), timeoutMs);
      } catch (error) {
        console.warn(`release ${hash} could not be fetched from the study; its sittings stay unknown`, error);
        return;
      }
      if (data === null || data === undefined) return;
      const read = await readStoredRelease(data, hash);
      if ("refused" in read) {
        console.error(`release ${hash} in the study's release store failed verification: ${read.refused}`);
        refused.push({ hash, reason: read.refused });
      } else {
        found.push(read.release);
      }
    }),
  );
  return { found, refused };
}

/**
 * Verified store releases, kept for the life of the page. A release never
 * changes once published, so one fetched and verified is never fetched again;
 * a miss is not kept, so a release published while the page is open is found
 * on the next build.
 */
const verifiedFromStore = new Map<string, KnownRelease>();

/**
 * `buildDataset`, after asking the release store for any release the bundle
 * does not know.
 *
 * What the store cannot supply is read exactly as before — through the latest
 * bundled release, with the warning that says so. A store document that
 * failed verification adds a warning of its own, because that is not a
 * missing release but a wrong one.
 */
export async function buildDatasetWithStore(
  sessions: DeviceSession[],
  study: string,
  aliases: Record<string, string> = {},
  assignments: Record<string, string> = {},
  options: { fetchRelease?: ReleaseFetcher; cache?: Map<string, KnownRelease>; timeoutMs?: number } = {},
): Promise<BuildResult> {
  const cache = options.cache ?? verifiedFromStore;
  const unknown = new Set(
    sessions.map((s) => s.releaseHash).filter((hash) => !releasesByHash.has(hash) && !cache.has(hash)),
  );
  const { found, refused } =
    unknown.size > 0
      ? await resolveFromStore(unknown, options.fetchRelease ?? fetchPublicRelease, options.timeoutMs)
      : { found: [], refused: [] };
  for (const release of found) cache.set(release.hash, release);

  const built = buildDataset(sessions, study, aliases, assignments, new Map([...releasesByHash, ...cache]));
  for (const { hash, reason } of refused) {
    built.warnings.unshift(
      `the study's copy of release ${hash.slice(0, 16)}… failed verification (${reason}) and was not used — tell whoever runs the study`,
    );
  }
  return built;
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
  // Releases the Studio published, once read from the study's store, count as
  // known releases too: their sittings can be judged complete or not.
  const manifests = new Map([...manifestsByHash, ...[...verifiedFromStore.values()].map((r) => [r.hash, r.manifest] as const)]);
  return countSittings({ sittings: sessions, dataset, manifests, rules: COUNTING_RULES, includeTest, now });
}
