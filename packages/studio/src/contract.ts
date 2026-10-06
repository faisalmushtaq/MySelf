import type { NarrativeProtocol } from "@myself/narrative";
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
  /**
   * Files the release pins, as it pins them (D-52): the postcode list an
   * address question checks against. Carried unchanged from the release the
   * draft came from; the Studio does not edit them. Absent in drafts saved
   * before releases carried assets.
   */
  assets?: Record<string, { path: string; sha256: string; bytes: number }>;
  /**
   * MyStory's protocol, frozen (docs/16 §10.1): its whole definition, keyed
   * `key@version`, exactly as the release's `narrativeProtocols` will hold it.
   * The MyStory section names it; publishing freezes it with its prompts and
   * model settings, and the survey sends the module this very definition. Absent
   * when the survey has no MyStory, and in drafts saved before it could have one.
   */
  narrativeProtocols?: Record<string, NarrativeProtocol>;
  /**
   * Where copied questions came from (D-57, docs/16 §12.5): one record per
   * piece added from the library. Written by `insertFragment` and
   * `updateFromModule`, never edited by hand. Its release origins are what the
   * server reads, verifies and compares a copied validated questionnaire with
   * at publish (§12.4); naming a release vouches for nothing on its own.
   * Absent in drafts saved before the library.
   */
  imports?: ImportRecord[];
}

// ---------------------------------------------------------------------------
// The item library (D-57, docs/16 §12)
// ---------------------------------------------------------------------------

/** Where a piece came from. */
export type FragmentOrigin =
  /** A published version of a survey, in any study space. */
  | { kind: "release"; study: string; surveyId: string; version: string; hash: string }
  /** A validated questionnaire from the instrument library, frozen as a release freezes it. */
  | { kind: "validated"; instrument: string; refKey: string }
  /** A saved module, at one of its versions. */
  | { kind: "module"; moduleId: string; version: number; contentHash: string };

/** One piece added to a draft, and what became of its questions (docs/16 §12.5). */
export interface ImportRecord {
  /** `imp_` and random characters. */
  id: string;
  /** ISO time it was added. */
  at: string;
  by: string;
  byEmail: string;
  origin: FragmentOrigin;
  /** Question ID in this draft -> question ID in the source. Identical unless renamed. */
  items: Record<string, string>;
  /** Source question ID -> the ID it was given here, only for renamed ones. */
  renamed?: Record<string, string>;
  /** Source variable -> the variable it was given here, only for renamed ones. */
  variablesRenamed?: Record<string, string>;
  /** Modules only: the newest version the team chose not to take (§12.6). */
  dismissed?: number;
}

export const FRAGMENT_FORMAT = "myself-studio-fragment" as const;
export const FRAGMENT_FORMAT_VERSION = 1 as const;

/** One block of a piece. */
export interface FragmentBlock {
  refKey: string;
  /**
   * The instrument or module definition. Its one form holds only the piece's
   * questions, in the order they are placed — except a validated
   * questionnaire, which is always its whole licensed form.
   */
  definition: InstrumentOrModule;
  /**
   * The block's display condition, as the source had it. Adding the piece keeps
   * it only when every question it tests is in the draft after the copy, and
   * says when it does not (§12.3 rule 7); a saved module may test only
   * questions inside itself (`moduleProblems`).
   */
  displayIf?: unknown;
}

/**
 * What is copied (docs/16 §12.1): questions from one block, a whole block, or
 * a whole section. Self-contained: everything its questions need comes with it.
 */
export interface StudioFragment {
  format: typeof FRAGMENT_FORMAT;
  formatVersion: typeof FRAGMENT_FORMAT_VERSION;
  /** A name for the piece: the block's, the section's, or the module's title. */
  title: string;
  /** Present when the piece is a whole section: added as a new section with this title. */
  section?: { title: string } | null;
  blocks: FragmentBlock[];
  /** Every option list the questions use, by scale key. */
  scales: Record<string, ScaleInput>;
  /** Scoring that comes with a block (validated questionnaires), by key. */
  scoring: Record<string, ScoringInput>;
  /** Files the questions need (the postcode list, D-52). */
  assets?: Record<string, { path: string; sha256: string; bytes: number }>;
  origin: FragmentOrigin;
}

/** The project-wide library's module id pattern: the same as a survey id. */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Largest saved module, in characters of canonical JSON. */
export const MAX_MODULE_CHARS = 200_000;
/** Most releases one publish reads to vouch for copied content (docs/16 §12.4). */
export const MAX_IMPORTED_RELEASES = 25;

/** `studioLibrary/{moduleId}` — project-wide; written only by functions (docs/16 §12.6). */
export interface LibraryModuleDoc {
  moduleId: string;
  title: string;
  description: string;
  tags: string[];
  latestVersion: number;
  retired: boolean;
  createdAt: StoredTime;
  createdBy: string;
  createdByEmail: string;
  updatedAt: StoredTime;
  updatedBy: string;
}

/** `studioLibrary/{moduleId}/versions/{n}` — immutable. */
export interface LibraryModuleVersionDoc {
  moduleId: string;
  version: number;
  /** The StudioFragment, as canonical JSON. */
  content: string;
  /** `sha256:` over `content`. */
  contentHash: string;
  /** What changed, in the saver's words. */
  note: string;
  questionCount: number;
  savedAt: StoredTime;
  savedBy: string;
  savedByEmail: string;
  /** The survey it was saved from. */
  source: { study: string; surveyId: string; draftRevision: number | null };
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
  kind: "survey" | "welcome" | "completion" | "section" | "block" | "question" | "option" | "mystory";
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
  | "settings.changed"
  | "mystory.added"
  | "mystory.removed"
  | "mystory.changed";

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
  /**
   * The published version this draft started from. Set by functions only.
   * `study` is present when it was copied from another study space (D-57);
   * absent means this draft's own study.
   */
  basedOn: { version: string; hash: string; study?: string } | null;
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
  /** The draft's provenance records for the questions this version asks (D-57, docs/16 §12.5). */
  imports?: ImportRecord[];
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
  | "study.created"
  | "study.updated"
  | "survey.imported"
  | "survey.created"
  | "draft.edited"
  | "draft.restored"
  | "draft.unlocked"
  | "version.published"
  | "version.activated"
  | "access.member_set"
  | "access.member_removed"
  | "access.domain_set"
  | "library.module_saved"
  | "library.module_changed";

// ---------------------------------------------------------------------------
// Study spaces (D-56, docs/16 §11.4)
// ---------------------------------------------------------------------------

export const STUDY_STATUSES = ["open", "closed"] as const;
/**
 * Open: takes new devices, new sittings and MyStory's model calls. Closed:
 * none of the three — but a sitting from an iPad the study already knows is
 * still accepted, so nothing collected before the closure is refused.
 */
export type StudyStatus = (typeof STUDY_STATUSES)[number];

/**
 * `studies/{study}` — the registry, one document per study space. PUBLIC by
 * `get` (an iPad reads `status` to tell a closed study), so it holds nothing a
 * poster could not: the creator is a uid here and an address only in the audit
 * trail. Written only by functions. The deployment's default study is
 * registered and open whether or not it has one.
 */
export interface StudyDoc {
  /** The id again, so a document read on its own says what it is. */
  study: string;
  title: string;
  status: StudyStatus;
  createdAt: StoredTime;
  createdBy: string;
  updatedAt: StoredTime;
  updatedBy: string;
  /** When it was last closed; null while it has never been. */
  closedAt: StoredTime | null;
}

/** A study as the Studio's switcher lists it: only ones the caller has a role in. */
export interface StudySummary {
  study: string;
  title: string;
  status: StudyStatus;
  /** The caller's role in this study; an owner is admin in every one. */
  role: StudioRole;
  /** The deployment's default study (`ybm`), registered with or without a document. */
  isDefault: boolean;
}

/**
 * What every Studio request may say about which study it is for. Absent means
 * the deployment's default, which is what every request meant before study
 * spaces (D-56). Checked against the registry, and the caller against THAT
 * study's list, before anything else is read.
 */
export interface StudyScoped {
  study?: string;
}

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
  createStudy: "studioCreateStudy",
  setStudy: "studioSetStudy",
  libraryCatalogue: "studioLibraryCatalogue",
  libraryModules: "studioLibraryModules",
  libraryModule: "studioLibraryModule",
  librarySaveModule: "studioLibrarySaveModule",
  librarySetModule: "studioLibrarySetModule",
} as const;

export interface SessionRequest extends StudyScoped {}
export interface SessionResponse {
  email: string | null;
  /** The caller's role in `study`. */
  role: StudioRole | null;
  /**
   * Why there is no role, in terms the unauthorised page can explain.
   * `unknown_study`: the study asked for is not registered.
   */
  reason: "not_signed_in" | "not_google" | "email_not_verified" | "not_listed" | "unknown_study" | null;
  /** The study this answer is about: the one asked for, or the default. */
  study: string;
  /** The deployment's default study. */
  defaultStudy: string;
  /**
   * Every study the caller has a role in, for the switcher (D-56). Absent from
   * an older function, which knew only the default.
   */
  studies?: StudySummary[];
  /** Holds the project's `owner` claim: may create, close and reopen study spaces. */
  owner?: boolean;
}

export interface CreateStudyRequest {
  /** The new study's id (`STUDY_ID_PATTERN`). */
  study: string;
  title: string;
}
export interface CreateStudyResponse {
  study: string;
}

/** Change a study's title, or close or reopen it. Owners only. */
export interface SetStudyRequest {
  study: string;
  title?: string;
  status?: StudyStatus;
}
export interface SetStudyResponse {
  study: string;
  title: string;
  status: StudyStatus;
}

export interface ImportLiveRequest extends StudyScoped {
  surveyId: string;
}
export interface ImportLiveResponse {
  surveyId: string;
  /** Versions written by this call; already-present ones are left untouched. */
  imported: string[];
  active: string;
}

export interface CreateSurveyRequest extends StudyScoped {
  surveyId: string;
  title: string;
  /**
   * Start from a published version of any survey; omitted starts blank.
   * `study` names another study space to copy from (D-57); absent means this one.
   */
  from?: { surveyId: string; version: string; study?: string } | null;
}
export interface CreateSurveyResponse {
  surveyId: string;
}

export interface PublishRequest extends StudyScoped {
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

export interface RestoreVersionRequest extends StudyScoped {
  surveyId: string;
  version: string;
  expectedRevision: number;
}
export interface RestoreVersionResponse {
  revision: number;
}

export interface ActivateVersionRequest extends StudyScoped {
  surveyId: string;
  version: string;
  reason: string;
}
export interface ActivateVersionResponse {
  version: string;
  hash: string;
  generation: number;
}

export interface SetMemberRequest extends StudyScoped {
  email: string;
  /** null removes the person. */
  role: StudioRole | null;
  note?: string | null;
}
export interface SetMemberResponse {
  email: string;
  role: StudioRole | null;
}

export interface SetDomainRequest extends StudyScoped {
  domain: string;
  role: StudioRole | null;
}
export interface SetDomainResponse {
  domains: Record<string, StudioRole>;
}

export interface ResponseStatsRequest extends StudyScoped {
  surveyId: string;
}
export interface ResponseStatsResponse {
  /** Sittings recorded per release hash — counts only, never content. */
  byHash: Record<string, { complete: number; partial: number }>;
}

// ---------------------------------------------------------------------------
// The item library's callables (D-57, docs/16 §12)
// ---------------------------------------------------------------------------

/** Every study's published surveys, for the "Published surveys" shelf. Needs viewer in `study`. */
export interface LibraryCatalogueRequest extends StudyScoped {}
export interface LibraryCatalogueResponse {
  studies: {
    study: string;
    title: string;
    status: StudyStatus;
    surveys: {
      surveyId: string;
      title: string;
      /** The live version, or null. */
      live: string | null;
      /** Newest first. Each release is public by hash in `studies/{study}/publicReleases/{hashHex}`. */
      versions: { version: string; hash: string; publishedAt: string }[];
    }[];
  }[];
}

/** A saved module as the shelf lists it. */
export interface LibraryModuleSummary {
  moduleId: string;
  title: string;
  description: string;
  tags: string[];
  latestVersion: number;
  retired: boolean;
  createdByEmail: string;
  /** ISO. */
  updatedAt: string;
  /** In the latest version. */
  questionCount: number;
  /** The latest version's content hash. */
  contentHash: string;
}

export interface LibraryModulesRequest extends StudyScoped {
  includeRetired?: boolean;
}
export interface LibraryModulesResponse {
  modules: LibraryModuleSummary[];
}

export interface LibraryModuleRequest extends StudyScoped {
  moduleId: string;
  /** Omitted for the latest. */
  version?: number;
}
export interface LibraryModuleVersionSummary {
  version: number;
  note: string;
  /** ISO. */
  savedAt: string;
  savedByEmail: string;
  contentHash: string;
  questionCount: number;
  source: { study: string; surveyId: string; draftRevision: number | null };
}
export interface LibraryModuleResponse {
  module: LibraryModuleSummary;
  /** The version asked for, with its piece. */
  version: LibraryModuleVersionSummary & { fragment: StudioFragment };
  /** Every version, newest first, without content. */
  versions: LibraryModuleVersionSummary[];
}

/**
 * Save a piece as a new module (`create`) or as the next version of one
 * (`moduleId` + `baseVersion`, refused if that is no longer the latest).
 * Needs editor in `study`; the piece must be editable content only.
 */
export interface LibrarySaveModuleRequest extends StudyScoped {
  /** The survey it is saved from, for the record. */
  surveyId: string;
  draftRevision?: number | null;
  create?: { moduleId: string; title: string; description: string; tags: string[] } | null;
  moduleId?: string | null;
  baseVersion?: number | null;
  note: string;
  fragment: StudioFragment;
}
export interface LibrarySaveModuleResponse {
  moduleId: string;
  version: number;
  contentHash: string;
}

/** Change a module's title, description or tags (editor), or retire/restore it (its creator or an owner). */
export interface LibrarySetModuleRequest extends StudyScoped {
  moduleId: string;
  title?: string;
  description?: string;
  tags?: string[];
  retired?: boolean;
}
export interface LibrarySetModuleResponse {
  module: LibraryModuleSummary;
}
