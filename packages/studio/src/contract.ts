import type {
  assessmentDraft,
  instrumentVersion,
  moduleDefinition,
  responseScale,
  scoringDefinition,
  ItemDefinition,
} from "@myself/schema";
import type { z } from "zod";

/**
 * The MySelf Studio contract — docs/16.
 *
 * Everything the Studio's three parties agree on is typed here, once: the
 * browser editor, the trusted functions that publish, and the rules (which
 * cannot import TypeScript, so infra/firebase/test asserts the same shapes).
 * The pure model code (draft extraction, editing operations, validation, diff)
 * builds on these types and is shared by the editor and the functions, so the
 * validation a researcher sees while editing is the validation the server
 * enforces when they publish.
 */

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export type CompositionInput = z.input<typeof assessmentDraft>;
export type InstrumentInput = z.input<typeof instrumentVersion>;
export type ModuleInput = z.input<typeof moduleDefinition>;
export type ScaleInput = z.input<typeof responseScale>;
export type ScoringInput = z.input<typeof scoringDefinition>;
/** An instrument or a study module, exactly as a manifest freezes it. */
export type InstrumentOrModule = InstrumentInput | ModuleInput;

export const DRAFT_FORMAT = "myself-studio-draft" as const;
export const DRAFT_FORMAT_VERSION = 1 as const;

/**
 * A survey as it is being edited: precisely the inputs `buildRelease` takes,
 * plus the Studio's own bookkeeping, which never reaches a release.
 *
 * `instruments` holds only the questions still administered. An archived
 * question moves to `archived` with its full definition, so restoring it is
 * lossless and its ID stays reserved.
 */
export interface StudioDraft {
  format: typeof DRAFT_FORMAT;
  formatVersion: typeof DRAFT_FORMAT_VERSION;
  /** The composition key, e.g. "ybm_nd2026_standard". Also the release key prefix. */
  surveyId: string;
  composition: CompositionInput;
  /** Keyed by reference string, e.g. "kss@1.0/en-GB/self/standard" (see `refKeyOf`). */
  instruments: Record<string, InstrumentOrModule>;
  /** Keyed by scale key, e.g. "scale.sdq_3pt". */
  scales: Record<string, ScaleInput>;
  /** Keyed by scoring key, e.g. "score.sdq25_s". */
  scoring: Record<string, ScoringInput>;
  archived: ArchivedQuestion[];
  /**
   * Option values removed after they were published. A value may never be
   * reused for a different answer: the recorded data would then mean two
   * things under one code.
   */
  retiredCodes: Record<string, RetiredCode[]>;
  /** Protected modules opened for editing, with who and why (docs/16 §4.4). */
  unlocked: Record<string, Unlock>;
  /** Studio-only notes per question ID. Never frozen into a release. */
  notes: Record<string, QuestionNotes>;
}

export interface ArchivedQuestion {
  /** `<instrument>.<key>` — the stable question ID. */
  itemKey: string;
  refKey: string;
  item: ItemDefinition;
  /** Where it was, so a restore can put it back. */
  sectionKey: string | null;
  archivedAt: string;
  archivedBy: string;
  /**
   * The instrument's definition with no questions in it, kept when archiving
   * this question emptied the instrument and so removed it from the draft.
   * Without it a restore would have nothing to put the question back into.
   */
  instrumentShell?: InstrumentOrModule;
  /**
   * Exactly where it was, so restoring it into the same section puts it back
   * in the same place rather than at the end. Neighbours are recorded by key,
   * not index, so questions restored in any order still land in their order.
   */
  position?: ArchivedPosition;
}

export interface ArchivedPosition {
  /** The keys before it in its instrument's form, nearest first. */
  formAfter: string[];
  /** Its block, if it was placed. */
  placement: {
    /** The block's index among its section's components. */
    componentIndex: number;
    /** The keys before it in the block, nearest first. */
    after: string[];
    /** The block showed the whole form rather than a list of questions. */
    wholeForm: boolean;
  } | null;
}

export interface RetiredCode {
  code: number;
  label: string;
  retiredAt: string;
}

export interface Unlock {
  /** Instrument/module key, e.g. "ybm_intro_consent". */
  instrument: string;
  by: string;
  at: string;
  /** The acknowledgement the editor typed, kept verbatim. */
  reason: string;
}

export interface QuestionNotes {
  codingNotes?: string;
}

// ---------------------------------------------------------------------------
// Validation and change summaries
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning";

/** Where a problem is, precisely enough for the editor to jump to it. */
export interface IssueLocation {
  kind: "survey" | "welcome" | "completion" | "section" | "block" | "question" | "option";
  sectionKey?: string;
  /** `<instrument>.<key>`. */
  itemKey?: string;
  refKey?: string;
  /** The field at fault, e.g. "stem", "variable", "options", "displayIf". */
  field?: string;
  optionCode?: number;
}

export interface Issue {
  severity: Severity;
  /** Stable machine code, e.g. "question.text_missing", "options.duplicate_value". */
  code: string;
  /**
   * What is wrong, in one short line a researcher can scan. It does not name
   * the question or screen it is about: `location` says that, and the editor
   * shows the message under that place's heading or beside the field itself.
   */
  message: string;
  /** Why it matters and what to do about it, when that takes more than the message. */
  hint?: string;
  location: IssueLocation;
}

export type Bump = "major" | "minor" | "patch";

export type ChangeKind =
  | "question.added"
  | "question.removed"
  | "question.archived"
  | "question.restored"
  | "question.moved"
  | "question.reordered"
  | "question.changed"
  | "section.added"
  | "section.removed"
  | "section.changed"
  | "section.reordered"
  | "welcome.changed"
  | "completion.changed"
  | "settings.changed";

export interface ChangeEntry {
  kind: ChangeKind;
  itemKey?: string;
  sectionKey?: string;
  /** For `question.changed`: which aspects, e.g. ["wording", "options", "required"]. */
  aspects?: string[];
  /** The smallest version bump this change needs on its own (docs/06 §3). */
  bump: Bump;
  /** Changes how existing data is coded or compared; worth a new question ID. */
  breaking: boolean;
  message: string;
}

export interface ChangeSummary {
  /** The bump the whole set of changes needs, or null when nothing changed. */
  bump: Bump | null;
  entries: ChangeEntry[];
  counts: { added: number; removed: number; archived: number; changed: number; moved: number };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export const STUDIO_ROLES = ["viewer", "editor", "publisher", "admin"] as const;
export type StudioRole = (typeof STUDIO_ROLES)[number];

/**
 * Each role includes everything below it. The same numbers are written into
 * firestore.rules (`studioLevel`), which cannot import this file; the rules
 * tests assert they agree.
 */
export const ROLE_LEVEL: Record<StudioRole, number> = { viewer: 1, editor: 2, publisher: 3, admin: 4 };

export function atLeast(role: StudioRole | null | undefined, needed: StudioRole): boolean {
  return role != null && ROLE_LEVEL[role] >= ROLE_LEVEL[needed];
}

// ---------------------------------------------------------------------------
// Firestore documents (paths in @myself/firebase `paths`)
// ---------------------------------------------------------------------------

/**
 * A Firestore server timestamp as either side sees it. The Admin and Web SDKs
 * both return a `Timestamp` with these fields; the REST API returns an RFC 3339
 * string. Always written with the server's clock, never the client's.
 */
export type StoredTime = { seconds: number; nanoseconds: number; toDate?: () => Date } | string;

export interface ActiveVersion {
  version: string;
  hash: string;
  releaseKey: string;
  generation: number;
  publishedAt: StoredTime;
  publishedBy: string;
  publishedByEmail: string | null;
}

/** `studies/{study}/surveys/{surveyId}` — functions write, Studio members read. */
export interface SurveyDoc {
  surveyId: string;
  study: string;
  title: string;
  createdAt: StoredTime;
  createdBy: string;
  active: ActiveVersion | null;
  /** Highest version ever published — not necessarily the active one after a rollback. */
  latestVersion: string | null;
  versionCount: number;
  /** Emails of everyone who edited the draft since the last publish. */
  draftEditors: string[];
}

/** `studies/{study}/surveys/{surveyId}/draft/current`. */
export interface DraftDoc {
  surveyId: string;
  /**
   * Increases by exactly one on every save. A save succeeds only against the
   * revision the editor loaded, so two people can never silently overwrite
   * each other (docs/16 §5.5).
   */
  revision: number;
  /** The StudioDraft, as JSON. */
  content: string;
  updatedAt: StoredTime;
  updatedBy: string;
  updatedByEmail: string;
  /** The published version this draft started from. Set by functions only. */
  basedOn: { version: string; hash: string } | null;
  createdAt: StoredTime;
}

/** Fields an editor may change on the draft; the rules allow no others. */
export const DRAFT_CLIENT_FIELDS = ["content", "revision", "updatedAt", "updatedBy", "updatedByEmail"] as const;

/** Largest draft the rules accept, in characters of JSON. */
export const MAX_DRAFT_CHARS = 900_000;

/** `studies/{study}/surveys/{surveyId}/versions/{version}` — immutable. */
export interface VersionDoc {
  surveyId: string;
  version: string;
  hash: string;
  releaseKey: string;
  engineVersion: string;
  releaseNote: string;
  changeSummary: ChangeSummary | null;
  bump: Bump | null;
  /** Every question ID and analysis variable this version administers — reserved forever. */
  itemKeys: string[];
  variables: string[];
  /** "repository" for releases imported from releases/*.manifest.json. */
  source: "studio" | "repository";
  draftRevision: number | null;
  basedOnVersion: string | null;
  /** Editors of the draft this version was published from. */
  authors: string[];
  publishedAt: StoredTime;
  publishedBy: string;
  publishedByEmail: string | null;
  /** The `release.publishedAt` inside the manifest (ISO), which is part of its hash. */
  manifestPublishedAt: string;
}

/** `studies/{study}/published/{surveyId}` — PUBLIC by `get`: what participants load. */
export interface PublishedPointerDoc {
  surveyId: string;
  study: string;
  hash: string;
  version: string;
  releaseKey: string;
  engineVersion: string;
  /** Increases by one on every publish or rollback. */
  generation: number;
  publishedAt: StoredTime;
}

/** `studies/{study}/publicReleases/{hashHex}` — PUBLIC by `get`, immutable. */
export interface PublicReleaseDoc {
  surveyId: string;
  study: string;
  hash: string;
  version: string;
  releaseKey: string;
  engineVersion: string;
  /** The manifest as JSON — a string so its bytes, and so its hash, survive storage. */
  manifest: string;
  bytes: number;
  publishedAt: StoredTime;
}

/** `studies/{study}/studioMembers/{email}` — the allowlist. */
export interface MemberDoc {
  email: string;
  role: StudioRole;
  addedAt: StoredTime;
  addedBy: string;
  addedByEmail: string | null;
  note: string | null;
}

/** `studies/{study}/studioAccess/config`. */
export interface AccessConfigDoc {
  /** Verified accounts at these domains get the role named, unless listed individually. */
  domains: Record<string, StudioRole>;
  updatedAt: StoredTime;
  updatedBy: string;
}

export type AuditAction =
  | "survey.imported"
  | "survey.created"
  | "draft.edited"
  | "draft.restored"
  | "draft.unlocked"
  | "version.published"
  | "version.activated"
  | "access.member_set"
  | "access.member_removed"
  | "access.domain_set";

/** `studies/{study}/studioAudit/{id}` — written only by functions, never changed. */
export interface AuditDoc {
  at: StoredTime;
  actor: string;
  actorEmail: string | null;
  action: AuditAction;
  surveyId: string | null;
  /** What the action was on: a version, an email, a domain, a question ID list. */
  subject: string;
  detail: Record<string, unknown> | null;
}

/** `studies/{study}/surveys/{surveyId}/presence/{uid}` — who else has the editor open. */
export interface PresenceDoc {
  uid: string;
  email: string;
  at: StoredTime;
  /** The question ID being edited, if any. */
  focus: string | null;
}

// ---------------------------------------------------------------------------
// Callable functions (europe-west2, `onCall`)
// ---------------------------------------------------------------------------

export const CALLABLES = {
  session: "studioSession",
  importLive: "studioImportLive",
  createSurvey: "studioCreateSurvey",
  publish: "studioPublish",
  restoreVersion: "studioRestoreVersion",
  activateVersion: "studioActivateVersion",
  setMember: "studioSetMember",
  setDomain: "studioSetDomain",
  responseStats: "studioResponseStats",
} as const;

export interface SessionRequest {}
export interface SessionResponse {
  email: string | null;
  role: StudioRole | null;
  /** Why there is no role, in terms the unauthorised page can explain. */
  reason: "not_signed_in" | "not_google" | "email_not_verified" | "not_listed" | null;
  study: string;
}

export interface ImportLiveRequest {
  surveyId: string;
}
export interface ImportLiveResponse {
  surveyId: string;
  /** Versions written by this call; already-present ones are left untouched. */
  imported: string[];
  active: string;
}

export interface CreateSurveyRequest {
  surveyId: string;
  title: string;
  /** Start from a published version of any survey; omitted starts blank. */
  from?: { surveyId: string; version: string } | null;
}
export interface CreateSurveyResponse {
  surveyId: string;
}

export interface PublishRequest {
  surveyId: string;
  /** The draft revision the publisher validated and previewed. */
  expectedRevision: number;
  version: string;
  releaseNote: string;
}
export interface PublishResponse {
  surveyId: string;
  version: string;
  hash: string;
  releaseKey: string;
  generation: number;
  /** A retry of a publish that had already succeeded. */
  alreadyPublished: boolean;
}

/**
 * The `details` an HttpsError from a Studio callable carries, so the editor
 * can show the exact problem rather than a message string.
 */
export type StudioErrorDetails =
  | { kind: "invalid"; issues: Issue[]; gate: string[] }
  | { kind: "conflict"; currentRevision: number }
  | { kind: "version_taken"; version: string }
  | { kind: "bump_too_small"; required: Bump; minimumVersion: string }
  | { kind: "not_found"; what: string }
  | { kind: "forbidden"; needed: StudioRole };

export interface RestoreVersionRequest {
  surveyId: string;
  version: string;
  expectedRevision: number;
}
export interface RestoreVersionResponse {
  revision: number;
}

export interface ActivateVersionRequest {
  surveyId: string;
  version: string;
  reason: string;
}
export interface ActivateVersionResponse {
  version: string;
  hash: string;
  generation: number;
}

export interface SetMemberRequest {
  email: string;
  /** null removes the person. */
  role: StudioRole | null;
  note?: string | null;
}
export interface SetMemberResponse {
  email: string;
  role: StudioRole | null;
}

export interface SetDomainRequest {
  domain: string;
  role: StudioRole | null;
}
export interface SetDomainResponse {
  domains: Record<string, StudioRole>;
}

export interface ResponseStatsRequest {
  surveyId: string;
}
export interface ResponseStatsResponse {
  /** Sittings recorded per release hash — counts only, never content. */
  byHash: Record<string, { complete: number; partial: number }>;
}
