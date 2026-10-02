import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { StudioRole } from "@myself/studio";
// The region, set before any function below is defined (see apps.ts).
import { STUDY, research } from "../apps.js";
import { requireStudio, type StudioActor } from "./access.js";
import { recordDraftWrite, type DraftSide } from "./draft-trigger.js";
import { parseRequest } from "./errors.js";
import { setDomain, setMember } from "./members.js";
import { publish } from "./publish.js";
import {
  activateVersionRequest,
  createSurveyRequest,
  importLiveRequest,
  publishRequest,
  responseStatsRequest,
  restoreVersionRequest,
  setDomainRequest,
  setMemberRequest,
} from "./requests.js";
import { responseStats, studioSessionFor } from "./stats.js";
import { createSurvey, importLive } from "./surveys.js";
import { activateVersion, restoreVersion } from "./versions.js";

/**
 * MySelf Studio's trusted operations, as callable functions in europe-west2
 * (docs/16 §5.5, §5.7). Named exactly as `CALLABLES` in the contract.
 *
 * Each one is the same three steps: check the request, check the caller
 * against the Studio list (read afresh, every call), then hand both to a core
 * that takes the database as an argument — which is what the integration suite
 * runs against the emulator. Nothing here decides anything; it only refuses to
 * let an unchecked request or an unlisted caller reach something that does.
 *
 * The actor passed on is the verified uid and the list's own key for the
 * caller's address. Nothing in the request can say who is asking.
 */

function studioCall<T>(needed: StudioRole, run: (request: CallableRequest, actor: StudioActor) => Promise<T>) {
  return onCall(async (request) => {
    const actor = await requireStudio(request, needed, { db: research(), study: STUDY });
    try {
      return await run(request, actor);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // Anything unexpected is logged with the detail and returned without
      // it: the caller learns that it failed, not how the server is built.
      logger.error("studio call failed", { needed, uid: actor.uid, error: error instanceof Error ? error.stack ?? error.message : String(error) });
      throw new HttpsError("internal", "Something went wrong on the server and nothing was changed. Try again.");
    }
  });
}

/** Who the caller is to the Studio. Answers anyone, including somebody not signed in. */
export const studioSession = onCall(async (request) => studioSessionFor(research(), STUDY, request.auth ?? null));

export const studioImportLive = studioCall("admin", (request, actor) => {
  const { surveyId } = parseRequest(importLiveRequest, request.data);
  return importLive(research(), { study: STUDY, surveyId, actor });
});

export const studioCreateSurvey = studioCall("admin", (request, actor) => {
  const req = parseRequest(createSurveyRequest, request.data);
  return createSurvey(research(), { study: STUDY, surveyId: req.surveyId, title: req.title, from: req.from ?? null, actor });
});

export const studioPublish = studioCall("publisher", (request, actor) => {
  const req = parseRequest(publishRequest, request.data);
  return publish(research(), { study: STUDY, ...req, actor });
});

export const studioRestoreVersion = studioCall("publisher", (request, actor) => {
  const req = parseRequest(restoreVersionRequest, request.data);
  return restoreVersion(research(), { study: STUDY, ...req, actor });
});

export const studioActivateVersion = studioCall("publisher", (request, actor) => {
  const req = parseRequest(activateVersionRequest, request.data);
  return activateVersion(research(), { study: STUDY, ...req, actor });
});

export const studioSetMember = studioCall("admin", (request, actor) => {
  const req = parseRequest(setMemberRequest, request.data);
  return setMember(research(), {
    study: STUDY,
    email: req.email,
    role: req.role,
    ...(req.note !== undefined ? { note: req.note } : {}),
    actor,
  });
});

export const studioSetDomain = studioCall("admin", (request, actor) => {
  const req = parseRequest(setDomainRequest, request.data);
  return setDomain(research(), { study: STUDY, domain: req.domain, role: req.role, actor });
});

export const studioResponseStats = studioCall("viewer", (request) => {
  const { surveyId } = parseRequest(responseStatsRequest, request.data);
  return responseStats(research(), { study: STUDY, surveyId });
});

/**
 * The draft's activity log (see draft-trigger.ts). Every study's drafts, as
 * the path says; the study is the path's, not this deployment's default.
 */
export const onStudioDraftWritten = onDocumentWritten("studies/{study}/surveys/{surveyId}/draft/{doc}", async (event) => {
  const before = event.data?.before?.exists ? (event.data.before.data() as DraftSide) : undefined;
  const after = event.data?.after?.exists ? (event.data.after.data() as DraftSide) : undefined;
  await recordDraftWrite(
    research(),
    { study: event.params.study, surveyId: event.params.surveyId, docId: event.params.doc },
    before,
    after,
    event.time,
  );
});
