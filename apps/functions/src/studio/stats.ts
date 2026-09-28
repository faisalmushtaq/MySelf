import type { Firestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import type { ResponseStatsResponse, SessionResponse, VersionDoc } from "@myself/studio";
import { studioRoleFor, type StudioToken } from "./access.js";
import { refuse } from "./errors.js";

/**
 * How many sittings each version of a survey has collected (docs/16 §1.2).
 *
 * COUNTS ONLY. Studio viewers are not necessarily people the rules let read
 * sittings (a Studio role is not a `researcher` claim), so this never returns
 * anything from inside one — no codes, no answers, no times — only how many
 * sittings carry each release hash, complete and partial. The counting is
 * Firestore's own aggregation: no sitting document is read into the function.
 */
export async function responseStats(db: Firestore, args: { study: string; surveyId: string }): Promise<ResponseStatsResponse> {
  const { study, surveyId } = args;
  const [survey, versions] = await Promise.all([
    db.doc(paths.studioSurvey(study, surveyId)).get(),
    db.collection(paths.studioVersions(study, surveyId)).get(),
  ]);
  if (!survey.exists) throw refuse.notFound(`survey:${surveyId}`, `There is no survey “${surveyId}”.`);
  const hashes = new Set(versions.docs.map((d) => (d.data() as VersionDoc).hash));
  const active = survey.get("active.hash") as unknown;
  if (typeof active === "string") hashes.add(active);

  const sessions = db.collection(paths.sessions(study));
  const count = async (hash: string, complete: boolean) =>
    (await sessions.where("releaseHash", "==", hash).where("complete", "==", complete).count().get()).data().count;

  const byHash: ResponseStatsResponse["byHash"] = {};
  await Promise.all(
    [...hashes].map(async (hash) => {
      const [complete, partial] = await Promise.all([count(hash, true), count(hash, false)]);
      byHash[hash] = { complete, partial };
    }),
  );
  return { byHash };
}

/**
 * Who the caller is to the Studio. Answers anyone, signed in or not, because
 * the page that tells somebody they are not on the list needs to know why.
 */
export async function studioSessionFor(
  db: Firestore,
  study: string,
  auth: { token: StudioToken } | null | undefined,
): Promise<SessionResponse> {
  if (!auth) return { email: null, role: null, reason: "not_signed_in", study };
  const access = await studioRoleFor(db, study, auth.token);
  return { email: access.email, role: access.role, reason: access.role ? null : access.reason, study };
}
