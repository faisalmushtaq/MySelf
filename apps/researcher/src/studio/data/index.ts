/**
 * The Studio data layer's public surface.
 *
 * PLACEHOLDER IMPLEMENTATIONS. The signatures below are the contract the
 * screens are written against; the Firebase-backed implementations replace
 * these bodies (and may move them into sibling files re-exported from here),
 * without changing a signature. Until then every hook reports "loading" and
 * every call is refused, so the screens can be built and the playground run.
 */
import type { ReactNode } from "react";
import type {
  ActivateVersionRequest,
  ActivateVersionResponse,
  CreateSurveyRequest,
  CreateSurveyResponse,
  ImportLiveRequest,
  ImportLiveResponse,
  PublishRequest,
  PublishResponse,
  RestoreVersionRequest,
  RestoreVersionResponse,
  SetDomainRequest,
  SetDomainResponse,
  SetMemberRequest,
  SetMemberResponse,
  StudioErrorDetails,
} from "@myself/studio";
import type {
  AccessConfigDoc,
  AuditDoc,
  DraftEditor,
  Loadable,
  MemberDoc,
  PresenceDoc,
  PublishedContext,
  ReleaseManifest,
  ResponseStatsResponse,
  StudioSession,
  SurveyDoc,
  VersionDoc,
} from "./types.js";

export * from "./types.js";
export { useMemoryDraftEditor } from "./memory.js";

const LOADING = { status: "loading" } as const;

/** A refused callable, with the structured details the functions attach. */
export class StudioCallError extends Error {
  constructor(
    message: string,
    /** The Firebase Functions error code, e.g. "permission-denied", "aborted". */
    public readonly code: string,
    public readonly details: StudioErrorDetails | null,
  ) {
    super(message);
    this.name = "StudioCallError";
  }
}

/** Provides Firebase and the signed-in session to everything under it. */
export function StudioDataProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useStudioSession(): StudioSession {
  return {
    status: "unconfigured",
    user: null,
    role: null,
    reason: null,
    error: null,
    signIn: async () => undefined,
    signOut: async () => undefined,
    refresh: async () => undefined,
  };
}

export function useSurveys(): Loadable<SurveyDoc[]> {
  return LOADING;
}

export function useSurvey(_surveyId: string): Loadable<SurveyDoc | null> {
  return LOADING;
}

export function useDraftEditor(_surveyId: string): DraftEditor {
  throw new Error("useDraftEditor is not implemented yet");
}

/** The published baseline, reserved IDs and codes — what validation and the diff need. */
export function usePublishedContext(_surveyId: string): Loadable<PublishedContext> {
  return LOADING;
}

/** Newest first. */
export function useVersions(_surveyId: string): Loadable<VersionDoc[]> {
  return LOADING;
}

/** Newest first; `surveyId` null for access-management rows. */
export function useAudit(_surveyId: string | null, _max = 100): Loadable<AuditDoc[]> {
  return LOADING;
}

/** Other people with this survey open, excluding the current user. */
export function usePresence(_surveyId: string, _focus: string | null): PresenceDoc[] {
  return [];
}

/** A published release, fetched from the release store and verified against its hash. */
export function usePublishedManifest(_hash: string | null): Loadable<ReleaseManifest | null> {
  return LOADING;
}

export function useResponseStats(_surveyId: string): Loadable<ResponseStatsResponse> {
  return LOADING;
}

export function useMembers(): Loadable<MemberDoc[]> {
  return LOADING;
}

export function useAccessConfig(): Loadable<AccessConfigDoc | null> {
  return LOADING;
}

export function useOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

const notYet = async (): Promise<never> => {
  throw new StudioCallError("The Studio functions are not connected in this build.", "unavailable", null);
};

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
  importLive: notYet,
  createSurvey: notYet,
  publish: notYet,
  restoreVersion: notYet,
  activateVersion: notYet,
  setMember: notYet,
  setDomain: notYet,
  confirmLive: notYet,
};
