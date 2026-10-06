import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { StudioRole } from "@myself/studio";
// The region, set before any function below is defined (see apps.ts).
import { STUDY, research } from "../apps.js";
import type { RegisteredStudy } from "../studies.js";
import { requireStudio, type StudioActor, type StudioToken } from "./access.js";
import { recordDraftWrite, type DraftSide } from "./draft-trigger.js";
import { parseRequest, problem, refuse } from "./errors.js";
import { getModule, libraryCatalogue, listModules, saveModule, setModule } from "./library.js";
import { setDomain, setMember } from "./members.js";
import { publish } from "./publish.js";
import {
  activateVersionRequest,
  createStudyRequest,
  createSurveyRequest,
  importLiveRequest,
  libraryCatalogueRequest,
  libraryModuleRequest,
  libraryModulesRequest,
  librarySaveModuleRequest,
  librarySetModuleRequest,
  publishRequest,
  responseStatsRequest,
  restoreVersionRequest,
  setDomainRequest,
  setMemberRequest,
  setStudyRequest,
} from "./requests.js";
import { responseStats, studioSessionFor } from "./stats.js";
import { createStudy, setStudy, studyForStudio } from "./study-spaces.js";
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
 *
 * WHICH STUDY is the one thing the request does say (D-56): `study`, optional,
 * the default when absent. It is looked up in the registry first — an unknown
 * study is refused before anybody's list is read — and then the caller is
 * checked against THAT study's list. So a role in one study space is nothing
 * in another, here exactly as in the rules, and every core below is handed the
 * study that was checked, never the one the request typed.
 */

function studioCall<T>(
  needed: StudioRole,
  run: (request: CallableRequest, actor: StudioActor, study: RegisteredStudy) => Promise<T>,
) {
  return onCall(async (request) => {
    if (!request.auth) throw refuse.unauthenticated(needed);
    const study = await studyForStudio(research(), (request.data as { study?: unknown } | null | undefined)?.study);
    const actor = await requireStudio(request, needed, { db: research(), study: study.study });
    try {
      return await run(request, actor, study);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // Anything unexpected is logged with the detail and returned without
      // it: the caller learns that it failed, not how the server is built.
      logger.error("studio call failed", { needed, uid: actor.uid, error: error instanceof Error ? error.stack ?? error.message : String(error) });
      throw new HttpsError("internal", "Something went wrong on the server and nothing was changed. Try again.");
    }
  });
}

/**
 * Who the caller is to the Studio, in the study asked about, and the studies
 * they may switch to. Answers anyone, including somebody not signed in.
 */
export const studioSession = onCall(async (request) =>
  studioSessionFor(research(), (request.data as { study?: unknown } | null | undefined)?.study, request.auth ?? null),
);

/**
 * "Set up from the live survey" brings in the releases built into this build,
 * which are the default study's (their `release.study` says so). Anywhere else
 * it would file `ybm`'s questionnaire, and a draft that says it is `ybm`'s,
 * into a study space that is not — so it is the default study's alone.
 */
export const studioImportLive = studioCall("admin", (request, actor, study) => {
  const { surveyId } = parseRequest(importLiveRequest, request.data);
  if (!study.isDefault) {
    throw refuse.invalid(
      `“Set up from the live survey” brings in ${STUDY}'s own releases, so it can only be used in that study. A new study space starts with a new survey.`,
      [problem("import.other_study", `The live survey belongs to ${STUDY}.`)],
    );
  }
  return importLive(research(), { study: study.study, surveyId, actor });
});

export const studioCreateSurvey = studioCall("admin", (request, actor, study) => {
  const req = parseRequest(createSurveyRequest, request.data);
  return createSurvey(research(), { study: study.study, surveyId: req.surveyId, title: req.title, from: req.from ?? null, actor });
});

export const studioPublish = studioCall("publisher", (request, actor, study) => {
  const req = parseRequest(publishRequest, request.data);
  return publish(research(), { study: study.study, ...req, actor });
});

export const studioRestoreVersion = studioCall("publisher", (request, actor, study) => {
  const req = parseRequest(restoreVersionRequest, request.data);
  return restoreVersion(research(), { study: study.study, ...req, actor });
});

export const studioActivateVersion = studioCall("publisher", (request, actor, study) => {
  const req = parseRequest(activateVersionRequest, request.data);
  return activateVersion(research(), { study: study.study, ...req, actor });
});

export const studioSetMember = studioCall("admin", (request, actor, study) => {
  const req = parseRequest(setMemberRequest, request.data);
  return setMember(research(), {
    study: study.study,
    email: req.email,
    role: req.role,
    ...(req.note !== undefined ? { note: req.note } : {}),
    actor,
  });
});

export const studioSetDomain = studioCall("admin", (request, actor, study) => {
  const req = parseRequest(setDomainRequest, request.data);
  return setDomain(research(), { study: study.study, domain: req.domain, role: req.role, actor });
});

export const studioResponseStats = studioCall("viewer", (request, _actor, study) => {
  const { surveyId } = parseRequest(responseStatsRequest, request.data);
  return responseStats(research(), { study: study.study, surveyId });
});

// ── The item library (D-57, docs/16 §12) ──────────────────────────────────
// Every shelf is for anyone with Studio access to the study they are working
// in (§12.8); saving and describing a module is an editor's, as any edit is.
// `studioLibrary` is closed to browsers, so these are its only way in.

/** Every study's published surveys and their versions — never a draft. */
export const studioLibraryCatalogue = studioCall("viewer", (request) => {
  parseRequest(libraryCatalogueRequest, request.data);
  return libraryCatalogue(research());
});

/** The saved modules on the shelf. */
export const studioLibraryModules = studioCall("viewer", (request) => {
  const req = parseRequest(libraryModulesRequest, request.data);
  return listModules(research(), { includeRetired: req.includeRetired === true });
});

/** One saved module at one version, with its piece, checked against its hash. */
export const studioLibraryModule = studioCall("viewer", (request) => {
  const req = parseRequest(libraryModuleRequest, request.data);
  return getModule(research(), { moduleId: req.moduleId, ...(req.version !== undefined ? { version: req.version } : {}) });
});

/** Save a piece as a new module, or as the next version of one; audited in the caller's study. */
export const studioLibrarySaveModule = studioCall("editor", (request, actor, study) => {
  const req = parseRequest(librarySaveModuleRequest, request.data);
  return saveModule(research(), {
    study: study.study,
    surveyId: req.surveyId,
    draftRevision: req.draftRevision ?? null,
    create: req.create ?? null,
    moduleId: req.moduleId ?? null,
    baseVersion: req.baseVersion ?? null,
    note: req.note,
    fragment: req.fragment,
    actor,
  });
});

/** Describe a module (an editor), or retire it or bring it back (its creator, or an owner). */
export const studioLibrarySetModule = studioCall("editor", (request, actor, study) => {
  const req = parseRequest(librarySetModuleRequest, request.data);
  return setModule(research(), {
    study: study.study,
    moduleId: req.moduleId,
    ...(req.title !== undefined ? { title: req.title } : {}),
    ...(req.description !== undefined ? { description: req.description } : {}),
    ...(req.tags !== undefined ? { tags: req.tags } : {}),
    ...(req.retired !== undefined ? { retired: req.retired } : {}),
    actor,
  });
});

/**
 * The project's owners, and nobody else: whoever holds the `owner` claim, not
 * on an iPad. A Studio admin of one study cannot make another — that would let
 * anybody an admin added start a study under the project's approval and budget.
 */
function requireOwner(request: CallableRequest): { uid: string; email: string | null } {
  if (!request.auth) throw refuse.unauthenticated("admin");
  const token = request.auth.token as StudioToken;
  if (token.role !== "owner" || token.device === true) {
    throw refuse.forbidden("admin", "Only an owner of the project can create, close or reopen a study space.");
  }
  return { uid: request.auth.uid, email: typeof token.email === "string" ? token.email.toLowerCase() : null };
}

/** A new study space, open, its creator its first Studio admin (D-56). */
export const studioCreateStudy = onCall(async (request) => {
  const actor = requireOwner(request);
  const req = parseRequest(createStudyRequest, request.data);
  return guarded("createStudy", actor.uid, () => createStudy(research(), { study: req.study, title: req.title, actor }));
});

/** Rename a study space, or close or reopen it (D-56). */
export const studioSetStudy = onCall(async (request) => {
  const actor = requireOwner(request);
  const req = parseRequest(setStudyRequest, request.data);
  return guarded("setStudy", actor.uid, () =>
    setStudy(research(), {
      study: req.study,
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.status !== undefined ? { status: req.status } : {}),
      actor,
    }),
  );
});

/** The same "nothing unexpected leaks" rule as `studioCall`, for the owners' calls. */
async function guarded<T>(what: string, uid: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("studio call failed", { what, uid, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    throw new HttpsError("internal", "Something went wrong on the server and nothing was changed. Try again.");
  }
}

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
