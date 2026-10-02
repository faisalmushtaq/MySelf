import type { ResumeScope, SessionRow } from "./db.js";
import type { LoadedRelease } from "./releases.js";
import { buildRuntime, type Runtime } from "./runtime.js";

/**
 * What choosing a sitting to resume needs from the device. Dexie and the release
 * cache in the app (`findResumableSession`, `releaseForHash`); fakes in the unit
 * suite, which has no IndexedDB.
 */
export interface ResumeLookup {
  find(participantCode: string, scope: ResumeScope): Promise<SessionRow | undefined>;
  releaseForHash(hash: string): Promise<LoadedRelease | null>;
}

/**
 * Which sitting a code resumes, and the release to render it with.
 *
 * PINNED: a sitting is only ever rendered under the release it started with. Its
 * saved position is an index into THAT release's questions, and the same index in
 * another release is a different question — so the newest unfinished sitting for
 * the code is found whatever its release, and comes back with its own.
 *
 * If that release cannot be loaded — which pruning is meant to make impossible —
 * this falls back to exactly the old rule: resume only a sitting of the release
 * running now, otherwise start a new one. The other sitting's row is not touched;
 * it stays on the device and uploads as the partial sitting it is.
 *
 * Moved here from App.tsx unchanged in behaviour, so the rule — and above all the
 * fallback, which only runs when something has already gone wrong — is tested
 * rather than only described.
 */
export async function sittingToResume(
  code: string,
  current: Runtime,
  lookup: ResumeLookup,
): Promise<{ session: SessionRow | undefined; runtime: Runtime }> {
  const newest = await lookup.find(code, { anyRelease: true });
  if (!newest || newest.releaseHash === current.hash) return { session: newest, runtime: current };
  try {
    const pinned = await lookup.releaseForHash(newest.releaseHash);
    if (pinned) {
      const runtime = buildRuntime(pinned.manifest, pinned.source);
      if (runtime.hash === newest.releaseHash) return { session: newest, runtime };
    }
  } catch {
    // Treated as unavailable, below.
  }
  return { session: await lookup.find(code, { releaseHash: current.hash }), runtime: current };
}
