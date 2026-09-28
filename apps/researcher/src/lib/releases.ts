import { releaseManifest, verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import type { PublicReleaseDoc } from "@myself/studio";

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

/**
 * A release-store document (`publicReleases/{hashHex}`), checked, or why it
 * cannot be used.
 *
 * Releases published from the Studio are not compiled into this view; the
 * store is where they are found (docs/16 §5.4). The hash is re-verified over
 * the RAW parsed JSON before the schema sees it — zod drops keys it does not
 * know, so a tidied copy could pass for a manifest whose unknown fields were
 * altered — and the manifest must carry the hash it was asked for, because an
 * intact release filed under another's hash is still the wrong release.
 * Never throws: what a document holds is data, and bad data is a refusal.
 */
export async function readStoredRelease(
  data: unknown,
  hash: string,
): Promise<{ release: KnownRelease } | { refused: string }> {
  const doc = (data ?? {}) as Partial<Record<keyof PublicReleaseDoc, unknown>>;
  if (typeof doc.manifest !== "string") return { refused: "the document holds no manifest" };
  if (doc.hash !== undefined && doc.hash !== hash) return { refused: "the document says it holds a different release" };
  let raw: unknown;
  try {
    raw = JSON.parse(doc.manifest);
  } catch {
    return { refused: "the manifest is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || (raw as { hash?: unknown }).hash !== hash) {
    return { refused: "the manifest carries a different hash from the one it is filed under" };
  }
  try {
    if (!(await verifyRawManifestHash(raw))) {
      return { refused: "the manifest's content does not hash to the hash it carries" };
    }
  } catch {
    // No WebCrypto (an insecure origin, say): unverifiable is not verified.
    return { refused: "this browser cannot verify a release" };
  }
  const parsed = releaseManifest.safeParse(raw);
  if (!parsed.success) return { refused: "the manifest is not a release this view can read" };
  const manifest = parsed.data;
  return { release: { hash, key: manifest.release.key, version: manifest.release.version, manifest } };
}
