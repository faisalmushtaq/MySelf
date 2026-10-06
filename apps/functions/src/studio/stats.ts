import type { Firestore } from "firebase-admin/firestore";
import { paths } from "@myself/firebase";
import type { ResponseStatsResponse, SessionResponse, VersionDoc } from "@myself/studio";
import { STUDY } from "../apps.js";
import { lookupStudy } from "../studies.js";
import { studioRoleFor, type StudioToken } from "./access.js";
import { refuse } from "./errors.js";
import { studiesFor } from "./study-spaces.js";

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
 * Who the caller is to the Studio, in the study asked about, and which studies
 * they may switch to (D-56). Answers anyone, signed in or not, because the page
 * that tells somebody they are not on the list needs to know why.
 *
 * A study asked for that is not registered (or not an id at all) is answered
 * as `unknown_study` rather than thrown: a bookmarked address of a study that
 * never existed should put the person on a page that says so, with the studies
 * they can open, not on an error.
 */
export async function studioSessionFor(
  db: Firestore,
  requested: unknown,
  auth: { token: StudioToken } | null | undefined,
  defaultStudy: string = STUDY,
): Promise<SessionResponse> {
  const found = await lookupStudy(db, requested, defaultStudy);
  const study = found.kind === "registered" ? found.study.study : found.kind === "unknown" ? found.study : found.raw;
  const base = { study, defaultStudy };
  if (!auth) return { ...base, email: null, role: null, reason: "not_signed_in" };
  const token = auth.token;
  const owner = token.role === "owner" && token.device !== true;
  const studies = await studiesFor(db, token, defaultStudy);
  if (found.kind !== "registered") {
    const access = await studioRoleFor(db, defaultStudy, token);
    return { ...base, email: access.email, role: null, reason: access.role || studies.length > 0 ? "unknown_study" : access.reason, studies, owner };
  }
  const access = await studioRoleFor(db, study, token);
  return { ...base, email: access.email, role: access.role, reason: access.role ? null : access.reason, studies, owner };
}
