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
  /** Every unfinished sitting under the code, newest first (D-97); `find`'s one if absent. */
  findAll?(participantCode: string, scope: ResumeScope): Promise<SessionRow[]>;
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
  /**
   * The survey the iPad is on (D-56): only a sitting started on it is resumed.
   * After an iPad is moved to another survey, a participant typing their code
   * starts that survey; their unfinished sitting of the other one waits on the
   * iPad, uploading as the partial sitting it is, until the iPad is moved back.
   */
  choice?: { study: string; surveyId: string },
): Promise<{ session: SessionRow | undefined; runtime: Runtime }> {
  const only = choice ? { choice } : {};
  const newest = await lookup.find(code, { anyRelease: true, ...only });
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
  return { session: await lookup.find(code, { releaseHash: current.hash, ...only }), runtime: current };
}

/**
 * Every unfinished sitting a code could carry on, each with the release to
 * render it with (D-97): a code shared by a group may have several. Pinned as
 * `sittingToResume` is: a sitting whose own release cannot be loaded is left
 * out, unless it is of the release running now.
 */
export async function sittingsToResume(
  code: string,
  current: Runtime,
  lookup: ResumeLookup,
  choice?: { study: string; surveyId: string },
): Promise<{ session: SessionRow; runtime: Runtime }[]> {
  const only = choice ? { choice } : {};
  const rows = lookup.findAll
    ? await lookup.findAll(code, { anyRelease: true, ...only })
    : [await lookup.find(code, { anyRelease: true, ...only })].filter((r): r is SessionRow => r !== undefined);
  const out: { session: SessionRow; runtime: Runtime }[] = [];
  for (const session of rows) {
    if (session.releaseHash === current.hash) {
      out.push({ session, runtime: current });
      continue;
    }
    try {
      const pinned = await lookup.releaseForHash(session.releaseHash);
      if (pinned) {
        const runtime = buildRuntime(pinned.manifest, pinned.source);
        if (runtime.hash === session.releaseHash) out.push({ session, runtime });
      }
    } catch {
      // Its release is unavailable: it stays on the iPad and uploads as the partial sitting it is.
    }
  }
  return out;
}
