import { doc, getDocFromServer } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { paths } from "@myself/firebase";
import {
  CALLABLES,
  type ActivateVersionRequest,
  type ActivateVersionResponse,
  type CreateStudyRequest,
  type CreateStudyResponse,
  type SetStudyRequest,
  type SetStudyResponse,
  type CreateSurveyRequest,
  type CreateSurveyResponse,
  type ImportLiveRequest,
  type ImportLiveResponse,
  type PublishRequest,
  type PublishResponse,
  type PublishedPointerDoc,
  type RestoreVersionRequest,
  type RestoreVersionResponse,
  type SetDomainRequest,
  type SetDomainResponse,
  type SetMemberRequest,
  type SetMemberResponse,
} from "@myself/studio";
import { studioFirebase } from "../firebase.js";
import { currentStudy } from "../router.js";
import { StudioCallError, toStudioCallError } from "./errors.js";
import { expectRestore } from "./restore-intent.js";

/**
 * The trusted operations: everything that changes more than the draft goes
 * through a function, which re-checks the caller's role against the allowlist
 * and writes its audit row in the same transaction (docs/16 §5.5, R9).
 */

/**
 * Every operation is made in the study space the Studio is in (D-56): the
 * request names it, the function looks it up in the registry and checks the
 * caller against THAT study's list. A request a page builds for one study
 * cannot be sent as another's, because the study is added here, at the moment
 * of sending, from the address.
 */
async function call<Req, Res>(name: string, request: Req): Promise<Res> {
  const fb = studioFirebase();
  if (!fb) {
    throw new StudioCallError("This copy of the Studio isn’t connected to a study, so nothing can be changed.", "unavailable", null);
  }
  try {
    const result = await httpsCallable<Req & { study: string }, Res>(fb.fns, name)({ ...request, study: currentStudy() });
    return result.data;
  } catch (error) {
    throw toStudioCallError(error);
  }
}

/**
 * The owners' study-space operations (D-56), which name the study they act on
 * themselves — creating one is not done "in" the study the Studio is in — so
 * they are sent as they are.
 */
async function callAsIs<Req, Res>(name: string, request: Req): Promise<Res> {
  const fb = studioFirebase();
  if (!fb) {
    throw new StudioCallError("This copy of the Studio isn’t connected to a study, so nothing can be changed.", "unavailable", null);
  }
  try {
    return (await httpsCallable<Req, Res>(fb.fns, name)(request)).data;
  } catch (error) {
    throw toStudioCallError(error);
  }
}

// ── The operations ────────────────────────────────────────────────────────

/** The trusted operations. Each rejects with a StudioCallError. */
export const studio: {
  importLive: (req: ImportLiveRequest) => Promise<ImportLiveResponse>;
  createSurvey: (req: CreateSurveyRequest) => Promise<CreateSurveyResponse>;
  publish: (req: PublishRequest) => Promise<PublishResponse>;
  restoreVersion: (req: RestoreVersionRequest) => Promise<RestoreVersionResponse>;
  activateVersion: (req: ActivateVersionRequest) => Promise<ActivateVersionResponse>;
  setMember: (req: SetMemberRequest) => Promise<SetMemberResponse>;
  setDomain: (req: SetDomainRequest) => Promise<SetDomainResponse>;
  /** A new study space; owners only. */
  createStudy: (req: CreateStudyRequest) => Promise<CreateStudyResponse>;
  /** Rename a study space, or close or reopen it; owners only. */
  setStudy: (req: SetStudyRequest) => Promise<SetStudyResponse>;
  /**
   * Read the public pointer back and say whether it now names this hash. The
   * publish dialog reports success only once this is true (docs/16 §5.5).
   */
  confirmLive: (surveyId: string, hash: string) => Promise<boolean>;
} = {
  importLive: (req) => call(CALLABLES.importLive, req),
  createSurvey: (req) => call(CALLABLES.createSurvey, req),
  publish: (req) => call(CALLABLES.publish, req),
  restoreVersion: async (req) => {
    // Registered first: the draft listener may see the restored draft before
    // this call returns. See restore-intent.ts.
    const pending = expectRestore(req.surveyId, req.version, req.expectedRevision);
    try {
      const res = await call<RestoreVersionRequest, RestoreVersionResponse>(CALLABLES.restoreVersion, req);
      pending.confirm(res.revision);
      return res;
    } catch (error) {
      pending.cancel();
      throw error;
    }
  },
  activateVersion: (req) => call(CALLABLES.activateVersion, req),
  setMember: (req) => call(CALLABLES.setMember, req),
  setDomain: (req) => call(CALLABLES.setDomain, req),
  createStudy: (req) => callAsIs(CALLABLES.createStudy, req),
  setStudy: (req) => callAsIs(CALLABLES.setStudy, req),
  confirmLive: async (surveyId, hash) => {
    const fb = studioFirebase();
    if (!fb) return false;
    const ref = doc(fb.db, paths.publishedPointer(currentStudy(), surveyId));
    // From the server, never the cache: the point is to see what a
    // participant's device will see when it next asks.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snap = await getDocFromServer(ref);
        if ((snap.data() as PublishedPointerDoc | undefined)?.hash === hash) return true;
      } catch (error) {
        if (attempt === 2) throw toStudioCallError(error);
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    return false;
  },
};
