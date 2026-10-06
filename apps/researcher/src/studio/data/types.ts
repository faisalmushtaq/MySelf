import type {
  AccessConfigDoc,
  AuditDoc,
  MemberDoc,
  PresenceDoc,
  ReservedIds,
  ResponseStatsResponse,
  SessionResponse,
  StudioDraft,
  StudioRole,
  StudySummary,
  SurveyDoc,
  VersionDoc,
} from "@myself/studio";
import type { ReleaseManifest } from "@myself/schema";

/**
 * What the Studio's screens can ask the data layer for.
 *
 * The screens never touch Firebase themselves. They read through these hooks
 * and change things through `DraftEditor.apply` and the callables, so the
 * rules about saving (revision checks, conflict handling, offline behaviour)
 * live in one place and every screen gets them for free.
 */

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string; retry: () => void };

export interface StudioUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface StudioSession {
  /**
   * - `unconfigured`: this build has no Firebase project, so there is nothing to sign in to.
   * - `signed_out`: show the sign-in page.
   * - `unauthorised`: signed in, but not on the Studio list (see `reason`).
   * - `ready`: signed in with a role.
   */
  status: "loading" | "unconfigured" | "signed_out" | "unauthorised" | "ready" | "error";
  user: StudioUser | null;
  /** The person's role in the study space the Studio is in. */
  role: StudioRole | null;
  reason: SessionResponse["reason"];
  error: string | null;
  /**
   * The study spaces this person has a role in, for the switcher (D-56): the
   * server works this out from each study's own list, so it never offers a
   * study whose every read would be refused. Empty until known.
   */
  studies: StudySummary[];
  /** Holds the project's owner claim: may create, close and reopen study spaces. */
  owner: boolean;
  /** The study space `role` is for; until it is the one in the address, the role is not yet known there. */
  study: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Ask the server again — after an admin has added you, for instance. */
  refresh: () => Promise<void>;
}

export type SaveState =
  | { kind: "saved"; at: Date | null }
  | { kind: "unsaved" }
  | { kind: "saving" }
  /** Offline: changes are kept in this tab and saved when the connection returns. */
  | { kind: "offline" }
  | { kind: "error"; message: string; retryAt: Date | null }
  /** Someone else saved first. Nothing is written until the editor chooses. */
  | {
      kind: "conflict";
      theirs: { draft: StudioDraft; revision: number; by: string | null; at: Date | null };
    };

export interface DraftEditor {
  status: "loading" | "ready" | "missing" | "error";
  error: string | null;
  /** The working copy, including changes not yet saved. */
  draft: StudioDraft | null;
  /** The saved revision the working copy is based on. */
  revision: number;
  /** `study` is set when it was copied from another study space's version (D-57). */
  basedOn: { version: string; hash: string; study?: string } | null;
  save: SaveState;
  /** True for viewers, and while a conflict is unresolved. */
  readOnly: boolean;
  hasUnsavedChanges: boolean;
  /**
   * Apply a change — normally one of @myself/studio's operations — as one undo
   * step, and schedule a save. A `StudioOpError` thrown by the change is passed
   * back to the caller untouched, and the draft is left as it was.
   */
  apply: (change: (draft: StudioDraft) => StudioDraft, label: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Save now rather than after the idle delay (Ctrl/Cmd+S, and before publishing). */
  saveNow: () => Promise<void>;
  /**
   * After a conflict: keep this tab's changes (saved on top of theirs, which
   * stay in the history) or take theirs and drop this tab's unsaved changes.
   */
  resolveConflict: (choice: "keep_mine" | "take_theirs") => void;
}

/** What validation and the diff need to know about what has been published. */
export interface PublishedContext {
  /** The live version, extracted as a draft — what the working draft is compared against. */
  baseline: StudioDraft | null;
  active: SurveyDoc["active"];
  latestVersion: string | null;
  /** Every question ID and variable any version has published. */
  reserved: ReservedIds;
  /** Question IDs that have ever been published — these can be archived but not deleted, and their IDs are locked. */
  publishedItemKeys: Set<string>;
  /** Option codes each scale has ever published, with their labels. */
  publishedScaleCodes: Map<string, Map<number, string>>;
  /** Every MyStory protocol a version has published, by `key@version`, as it was frozen. */
  publishedProtocols: Map<string, unknown>;
}

export type { AccessConfigDoc, AuditDoc, MemberDoc, PresenceDoc, ReleaseManifest, ResponseStatsResponse, StudySummary, SurveyDoc, VersionDoc };
