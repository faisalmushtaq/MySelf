import { doc, getDocFromServer } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { paths } from "@myself/firebase";
import {
  CALLABLES,
  type ActivateVersionRequest,
  type ActivateVersionResponse,
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
import { STUDY, studioFirebase } from "../firebase.js";
import { StudioCallError, toStudioCallError } from "./errors.js";
import { expectRestore } from "./restore-intent.js";

/**
 * The trusted operations: everything that changes more than the draft goes
 * through a function, which re-checks the caller's role against the allowlist
 * and writes its audit row in the same transaction (docs/16 §5.5, R9).
 */

async function call<Req, Res>(name: string, request: Req): Promise<Res> {
  const fb = studioFirebase();
  if (!fb) {
    throw new StudioCallError("This copy of the Studio isn’t connected to a study, so nothing can be changed.", "unavailable", null);
  }
  try {
    const result = await httpsCallable<Req, Res>(fb.fns, name)(request);
    return result.data;
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
  confirmLive: async (surveyId, hash) => {
    const fb = studioFirebase();
    if (!fb) return false;
    const ref = doc(fb.db, paths.publishedPointer(STUDY, surveyId));
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
