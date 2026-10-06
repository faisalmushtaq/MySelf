import type { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { paths } from "@myself/firebase";
import { hashHex, releaseManifest, sha256, verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import type { PublicReleaseDoc } from "@myself/studio";
import r5 from "../../../releases/ybm_nd2026_standard_r5.0.0.manifest.json" with { type: "json" };
import r6 from "../../../releases/ybm_nd2026_standard_r6.0.0.manifest.json" with { type: "json" };
import r7 from "../../../releases/ybm_nd2026_standard_r7.0.0.manifest.json" with { type: "json" };
import r701 from "../../../releases/ybm_nd2026_standard_r7.0.1.manifest.json" with { type: "json" };
import r710 from "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json" with { type: "json" };
import r720 from "../../../releases/ybm_nd2026_standard_r7.2.0.manifest.json" with { type: "json" };
import r730 from "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json" with { type: "json" };
import r800 from "../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json" with { type: "json" };

/**
 * Every published release, by content hash.
 *
 * A sitting is always read back through the release it was collected under. In
 * a longitudinal study that is not a nicety: wave 1 under r5 and wave 3 under
 * r7 are not the same instrument, and reading one through the other is how a
 * renamed option code becomes a silently wrong answer.
 *
 * Bundled rather than fetched, so a function that runs at two in the morning
 * does not depend on anything being reachable. Releases published from the
 * Studio are not bundled — they exist only in the release store — and
 * `resolveRelease` below is how they are found.
 */

// Older releases stay. A sitting is always read back through the release it was
// collected under, so dropping one would make its sittings unreadable.
const published: unknown[] = [r5, r6, r7, r701, r710, r720, r730, r800];

/**
 * The bundled releases with their raw JSON beside the parsed copy.
 *
 * The raw form is kept because it is the only one whose hash can be checked:
 * zod drops keys it does not know, so a parsed manifest re-serialised is not
 * guaranteed to be the bytes that were hashed. Seeding the release store from
 * the live survey (docs/16 §6) writes these, and a reader later re-verifies
 * exactly what was written.
 */
export const bundledManifests: { raw: unknown; manifest: ReleaseManifest }[] = published.flatMap((raw) => {
  const parsed = releaseManifest.safeParse(raw);
  return parsed.success ? [{ raw, manifest: parsed.data }] : [];
});

export const releasesByHash = new Map<string, ReleaseManifest>(
  bundledManifests.map(({ manifest }) => [manifest.hash ?? "", manifest]),
);

export const latestRelease = [...releasesByHash.values()].sort((a, b) =>
  a.release.version.localeCompare(b.release.version, undefined, { numeric: true }),
)[releasesByHash.size - 1];

// ---------------------------------------------------------------------------
// Resolving a hash (docs/16 §5.4)
// ---------------------------------------------------------------------------

export interface ResolvedRelease {
  manifest: ReleaseManifest;
  /** Compiled into this build, or read from `studies/{study}/publicReleases`. */
  source: "bundled" | "store";
}

/**
 * A release-store document, checked, or the reason it cannot be used.
 *
 * The check is over the RAW parsed JSON, before any schema parse: the hash was
 * computed over those bytes, and a copy that zod had tidied could pass for a
 * manifest whose unknown fields were altered, or fail for one that uses a
 * field newer than this build (docs/16 R12). The manifest must also carry the
 * hash it was looked up by — a document filed under one hash that holds
 * another release, however intact, is the silent misread D-35 exists to stop.
 *
 * Never throws: whatever is in the document is data, and bad data is a
 * refusal to report, not an exception that takes an export down with it.
 */
export async function readStoredRelease(
  data: unknown,
  hash: string,
): Promise<{ manifest: ReleaseManifest } | { refused: string }> {
  const doc = (data ?? {}) as Partial<Record<keyof PublicReleaseDoc, unknown>>;
  if (typeof doc.manifest !== "string") return { refused: "the document holds no manifest string" };
  if (doc.hash !== undefined && doc.hash !== hash) {
    return { refused: `the document says it holds ${String(doc.hash)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(doc.manifest);
  } catch {
    return { refused: "the manifest is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || (raw as { hash?: unknown }).hash !== hash) {
    return { refused: "the manifest carries a different hash from the one it is filed under" };
  }
  // Hashing and parsing both walk the document recursively, so JSON nested
  // deeply enough (a few hundred kB of `[[[[…`, well inside a document's size
  // limit) overflows the stack — a RangeError, not a false. Uncaught, that
  // would abort the whole nightly export over one bad document, which is
  // exactly what "never throws" above promises cannot happen.
  let parsed: ReturnType<typeof releaseManifest.safeParse>;
  try {
    if (!(await verifyRawManifestHash(raw))) {
      return { refused: "the manifest's content does not hash to the hash it carries" };
    }
    parsed = releaseManifest.safeParse(raw);
  } catch (error) {
    return { refused: `the manifest could not be checked (${error instanceof Error ? error.name : "error"})` };
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { refused: `the manifest is not a release this build can read (${first?.path.join(".") ?? "?"}: ${first?.message ?? "?"})` };
  }
  return { manifest: parsed.data };
}

/**
 * A resolver with its own cache, for tests that must start cold.
 *
 * The cache holds verified store releases only. A release is immutable and
 * addressed by its content, so once one has verified it can be kept for the
 * life of the instance. A miss or a refusal is not kept: a release written to
 * the store a minute from now (the live survey imported, say) should be found
 * by the next sitting that names it, not hidden behind a remembered miss.
 */
export function releaseResolver(bundled: ReadonlyMap<string, ReleaseManifest> = releasesByHash) {
  // Keyed by study AND hash. The lookup reads `studies/{study}/publicReleases`,
  // so what is remembered must be what that study's store held: keyed by hash
  // alone, a release verified from one study's store would answer for another
  // study whose store never held it — and only on a warm instance, so the
  // same export could list a sitting as unreadable one night and read it the
  // next, depending on which trigger had run first.
  const verified = new Map<string, ReleaseManifest>();
  const cacheKey = (study: string, hash: string) => `${study}\u0000${hash}`;

  /**
   * The manifest a sitting's hash names: the bundled copy, else the study's
   * release store re-verified, else null — the hash is UNKNOWN.
   *
   * Null is never a cue to read the sitting through some other release; that
   * is for the caller to report. A document that fails verification is logged
   * here, because a tampered or corrupted release is worth an alarm of its own.
   * A failing Firestore read is not data and is allowed to throw: an export
   * that skipped a release because the database hiccuped would look complete.
   */
  return async function resolveRelease(db: Firestore, study: string, hash: string): Promise<ResolvedRelease | null> {
    /**
     * A bundled release only for ITS OWN study (D-56). The bundle is the
     * repository's releases, which are `ybm`'s; a sitting, or a model call, in
     * another study names a release that study published, and finding a `ybm`
     * one in its place would read the sitting through a questionnaire it was
     * never given — or run a config that study never froze. Every bundled
     * release says `release.study: "ybm"`, so nothing changes for `ybm`.
     */
    const inBundle = bundled.get(hash);
    if (inBundle && inBundle.release.study === study) return { manifest: inBundle, source: "bundled" };
    const known = verified.get(cacheKey(study, hash));
    if (known) return { manifest: known, source: "store" };

    // Anything else cannot be a document ID; a malformed hash on a sitting is
    // unknown by definition, and building a path from it could name another
    // document entirely.
    if (!sha256.safeParse(hash).success) return null;

    const snapshot = await db.doc(paths.publicRelease(study, hashHex(hash))).get();
    if (!snapshot.exists) return null;

    const read = await readStoredRelease(snapshot.data(), hash);
    if ("refused" in read) {
      logger.error("a release in the store failed verification and was not used", {
        study,
        releaseHash: hash,
        reason: read.refused,
      });
      return null;
    }
    verified.set(cacheKey(study, hash), read.manifest);
    return { manifest: read.manifest, source: "store" };
  };
}

export type ReleaseResolverFn = ReturnType<typeof releaseResolver>;

/** The one registry every reader in the functions uses. */
export const resolveRelease: ReleaseResolverFn = releaseResolver();
