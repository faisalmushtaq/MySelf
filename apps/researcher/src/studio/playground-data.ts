import { extractDraft, type StudioDraft } from "@myself/studio";
import { releaseManifest, type ReleaseManifest } from "@myself/schema";
import { manifestIndex, publishedProtocols, publishedScaleCodes, reservedFrom } from "./data/model-adapter.js";
import type { PublishedContext } from "./data/types.js";

/**
 * What the playground edits: the live survey as bundled with this build, and
 * the published context the real Studio would derive for it from the releases
 * in the repository — so validation behaves as it would for real (reserved IDs,
 * published option codes) with no Firebase project at all.
 *
 * Loaded on demand, so the manifests are fetched only when someone opens the
 * playground.
 */

/** The version participants are answering now, which the playground starts from. */
export const PLAYGROUND_VERSION = "8.0.0";

const bundled = import.meta.glob("../../../../releases/ybm_nd2026_standard_r*.manifest.json", { import: "default" }) as Record<
  string,
  () => Promise<unknown>
>;

export interface PlaygroundData {
  draft: StudioDraft;
  context: PublishedContext;
}

export async function loadPlayground(): Promise<PlaygroundData> {
  const all = await Promise.all(Object.values(bundled).map((load) => load()));
  // Only releases the current schema reads (r5 onwards): the older ones are
  // still readable by their hash elsewhere, but were never Studio versions.
  const releases: { raw: unknown; manifest: ReleaseManifest }[] = [];
  for (const raw of all) {
    const parsed = releaseManifest.safeParse(raw);
    if (parsed.success) releases.push({ raw, manifest: parsed.data });
  }
  const live = releases.find((r) => r.manifest.release.version === PLAYGROUND_VERSION);
  if (!live) throw new Error(`The live survey (r${PLAYGROUND_VERSION}) isn’t bundled with this build.`);
  const upToLive = releases.filter((r) => compare(r.manifest.release.version, PLAYGROUND_VERSION) <= 0);
  const indexes = upToLive.map((r) => manifestIndex(r.manifest));
  const reserved = reservedFrom(indexes);
  const m = live.manifest;
  return {
    draft: extractDraft(live.raw),
    context: {
      baseline: extractDraft(live.raw),
      active: {
        version: m.release.version,
        hash: m.hash ?? "",
        releaseKey: m.release.key,
        generation: 0,
        publishedAt: m.release.publishedAt,
        publishedBy: m.release.publishedBy,
        publishedByEmail: null,
      },
      latestVersion: m.release.version,
      reserved,
      publishedItemKeys: new Set(reserved.itemKeys),
      publishedScaleCodes: publishedScaleCodes(upToLive.map((r) => r.manifest)),
      publishedProtocols: publishedProtocols(upToLive.map((r) => r.manifest)),
    },
  };
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
