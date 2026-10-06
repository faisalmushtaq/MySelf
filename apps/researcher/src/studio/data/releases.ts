import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { paths } from "@myself/firebase";
import { hashHex, releaseManifest, verifyRawManifestHash, type ReleaseManifest } from "@myself/schema";
import type { PublicReleaseDoc } from "@myself/studio";
import { studioFirebase } from "../firebase.js";
import { currentStudy, useStudy } from "../router.js";
import { readErrorMessage } from "./errors.js";
import { NOT_CONNECTED } from "./live.js";
import type { Loadable } from "./types.js";

/**
 * Published releases, fetched from the public release store by hash.
 *
 * A release is only used after its hash has been recomputed over the exact
 * JSON that was stored (docs/16 §5.4): a manifest that does not hash to the
 * name it was fetched under is refused, never shown. Releases are immutable,
 * so each is fetched once per page and kept — the raw JSON as well as the
 * parsed manifest, because extracting a draft and downloading a release both
 * want the bytes exactly as published.
 */

export interface LoadedRelease {
  hash: string;
  /** The manifest JSON exactly as stored — what "Download" saves. */
  json: string;
  /** The parsed JSON, before the schema: what drafts are extracted from. */
  raw: unknown;
  manifest: ReleaseManifest;
}

export class ReleaseLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseLoadError";
  }
}

const cache = new Map<string, Promise<LoadedRelease>>();

/**
 * Fetch and verify one release, from the release store of the study space the
 * Studio is in, or of the study named (the library reads every study's
 * published versions, D-57). Cached by study and hash — a release is read from
 * its own study's store, and one study's copy never answers for another
 * (D-56). A failure is not cached, so a retry fetches again.
 */
export function loadRelease(hash: string, study: string = currentStudy()): Promise<LoadedRelease> {
  const key = `${study}\u0000${hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = fetchRelease(study, hash);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

async function fetchRelease(study: string, hash: string): Promise<LoadedRelease> {
  const fb = studioFirebase();
  if (!fb) throw new ReleaseLoadError(NOT_CONNECTED);
  let data: PublicReleaseDoc | undefined;
  try {
    const snap = await getDoc(doc(fb.db, paths.publicRelease(study, hashHex(hash))));
    data = snap.exists() ? (snap.data() as PublicReleaseDoc) : undefined;
  } catch (error) {
    throw new ReleaseLoadError(readErrorMessage(error, "this published version"));
  }
  const label = data?.version ? `r${data.version}` : "This version";
  if (!data || typeof data.manifest !== "string") {
    throw new ReleaseLoadError(`${label} is missing from the release store, so it can’t be opened.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data.manifest);
  } catch {
    throw new ReleaseLoadError(`${label}’s stored copy is damaged (it isn’t valid JSON), so it hasn’t been used.`);
  }
  const claimed = (raw as { hash?: unknown } | null)?.hash;
  if (claimed !== hash || !(await verifyRawManifestHash(raw))) {
    throw new ReleaseLoadError(
      `${label}’s stored copy doesn’t match its fingerprint (content hash), so it hasn’t been used. Tell the study’s technical lead.`,
    );
  }
  const parsed = releaseManifest.safeParse(raw);
  if (!parsed.success) {
    throw new ReleaseLoadError(`${label} was published in a format this version of the Studio can’t read.`);
  }
  return { hash, json: data.manifest, raw, manifest: parsed.data };
}

/**
 * Several releases at once, keyed by hash. `hashes` null means "not known yet"
 * (stays loading). From the study space the Studio is in, unless `study` names
 * another.
 */
export function useReleases(hashes: readonly string[] | null, study?: string | null): Loadable<Map<string, LoadedRelease>> {
  const here = useStudy();
  const from = study ?? here;
  const hashKey = hashes ? [...new Set(hashes)].sort().join(",") : null;
  const key = hashKey === null ? null : `${from}:${hashKey}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value: Loadable<Map<string, LoadedRelease>> } | null>(null);
  const retry = useMemo(() => () => setAttempt((a) => a + 1), []);
  const stateKey = `${key ?? ""}#${attempt}`;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    const list = hashKey ? hashKey.split(",") : [];
    Promise.all(list.map((h) => loadRelease(h, from)))
      .then((loaded) => {
        if (live) setState({ key: stateKey, value: { status: "ready", data: new Map(loaded.map((r) => [r.hash, r])) } });
      })
      .catch((error: unknown) => {
        if (live) {
          setState({
            key: stateKey,
            value: {
              status: "error",
              error: error instanceof ReleaseLoadError ? error.message : "Couldn’t load the published versions.",
              retry,
            },
          });
        }
      });
    return () => {
      live = false;
    };
  }, [key, hashKey, from, stateKey, retry]);

  if (key === null || state?.key !== stateKey) return { status: "loading" };
  return state.value;
}

/** One release. `hash` null means there is none (ready with null). `study` as for `useReleases`. */
export function useRelease(hash: string | null, study?: string | null): Loadable<LoadedRelease | null> {
  const hashes = useMemo(() => (hash ? [hash] : []), [hash]);
  const all = useReleases(hashes, study);
  return useMemo(() => {
    if (all.status !== "ready") return all;
    return { status: "ready", data: hash ? (all.data.get(hash) ?? null) : null };
  }, [all, hash]);
}
