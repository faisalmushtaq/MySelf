import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  atLeast,
  extractDraft,
  lockBaseline,
  StudioOpError,
  validateDraft,
  type Issue,
  type OpActor,
  type ReservedIds,
  type StudioDraft,
  type StudioRole,
  type SurveyDoc,
  type ValidationContext,
} from "@myself/studio";
import { usePublishedManifest, type DraftEditor, type Loadable, type PublishedContext, type StudioUser } from "../data/index.js";
import { usePlaygroundMode } from "../mode.js";
import { useSelectedQuestion } from "../router.js";
import { useToast } from "../ui/toast.js";
import { decodeSelection, encodeSelection, type Selection } from "./selection.js";

/**
 * Everything the editor's panels share, in one place.
 *
 * The outline, the centre editor, the settings panel, the validation panel
 * and the publish dialog are built separately but must agree on four things:
 * what is selected, what the draft is, what is wrong with it, and how a change
 * is made. This context is that agreement.
 *
 * CHANGES GO THROUGH `run`. It applies one of @myself/studio's operations as a
 * single undo step and, when the operation refuses (a licensed question
 * cannot be reworded, a published question cannot be deleted), shows the
 * refusal's own plain-English reason instead of letting it escape as an
 * exception. Nothing in the editor calls `editor.apply` directly.
 *
 * VALIDATION RUNS HERE, once, on a short delay after the last change, with
 * the published context the server will use: so the count in the toolbar, the
 * list in the panel and the marks on each field are the same issues, and they
 * are the ones publishing will be judged by.
 */

export interface EditorContextValue {
  surveyId: string;
  survey: SurveyDoc | null;
  editor: DraftEditor;
  /** The working draft (never null inside the provider). */
  draft: StudioDraft;
  /** What has been published, once loaded; null while loading or on error. */
  published: PublishedContext | null;
  publishedStatus: Loadable<PublishedContext>["status"];
  /**
   * The version the draft is checked against — the live one, else the release
   * a never-published survey was copied from — once loaded; null otherwise.
   * It names what the draft no longer has (a question removed outright).
   */
  baseline: StudioDraft | null;
  /** Question IDs that have ever been published: archive, don't delete; ID and variable locked. */
  publishedItemKeys: ReadonlySet<string>;
  reserved: ReservedIds | undefined;
  role: StudioRole;
  user: StudioUser;
  playground: boolean;
  /** Can change the draft (editor role and above, not read-only, no unresolved conflict). */
  canEdit: boolean;
  /** Why the draft can't be changed, for the banner and disabled controls; null when it can. */
  readOnlyReason: string | null;
  /** Publisher role and above, outside the playground. */
  canPublish: boolean;

  selection: Selection | null;
  select: (selection: Selection | null, options?: { field?: string }) => void;
  /** A field the centre editor should move focus to after a jump (from the validation panel). */
  pendingFocus: { selection: string; field: string } | null;
  clearPendingFocus: () => void;

  issues: Issue[];
  /** False while a change is waiting to be validated. */
  issuesFresh: boolean;

  /** Who is doing something now, for the draft's own records (archive, unlock). */
  actor: () => OpActor;
  /**
   * Apply an operation as one undo step. Returns false, and shows why, if the
   * operation refused or the draft is read-only.
   */
  run: (label: string, operation: (draft: StudioDraft) => StudioDraft) => boolean;
  /** Say something to screen-reader users (moves, reorders) without a visible toast. */
  announce: (message: string) => void;

  validationOpen: boolean;
  setValidationOpen: (open: boolean) => void;
  publishOpen: boolean;
  setPublishOpen: (open: boolean) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error("useEditor outside EditorProvider");
  return value;
}

const VALIDATE_DELAY_MS = 300;

export function EditorProvider({
  surveyId,
  survey,
  editor,
  draft,
  context,
  role,
  user,
  children,
}: {
  surveyId: string;
  survey: SurveyDoc | null;
  editor: DraftEditor;
  draft: StudioDraft;
  context: Loadable<PublishedContext>;
  role: StudioRole;
  user: StudioUser;
  children: ReactNode;
}) {
  const toast = useToast();
  const playground = usePlaygroundMode();
  const [q, setQ] = useSelectedQuestion();
  const [pendingFocus, setPendingFocus] = useState<{ selection: string; field: string } | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [message, setMessage] = useState("");

  const published = context.status === "ready" ? context.data : null;

  // A survey that has never been published is checked, as on the server, against
  // the release it was copied from (its `basedOn`), so a copy with a reworded
  // licensed questionnaire is flagged here rather than first at Publish.
  const originHash = published && !published.baseline ? (editor.basedOn?.hash ?? null) : null;
  const originManifest = usePublishedManifest(originHash);
  const origin = useMemo(
    () => (originManifest.status === "ready" && originManifest.data ? extractDraft(originManifest.data) : null),
    [originManifest],
  );

  // ── Validation, debounced, with the context the server will use ──────────
  const [issues, setIssues] = useState<Issue[]>(() => validateDraft(draft, contextFor(published, origin, draft)));
  const [validatedDraft, setValidatedDraft] = useState<StudioDraft>(draft);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIssues(validateDraft(draft, contextFor(published, origin, draft)));
      setValidatedDraft(draft);
    }, VALIDATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, published, origin]);

  // ── Permissions ──────────────────────────────────────────────────────────
  const conflict = editor.save.kind === "conflict";
  const readOnlyReason = !atLeast(role, "editor")
    ? "You can view this survey but not change it. An admin can give you editing access."
    : conflict
      ? "Someone else saved while you were editing. Choose which version to keep before making more changes."
      : editor.readOnly
        ? "This draft can't be changed right now."
        : null;
  const canEdit = readOnlyReason === null;
  const canPublish = !playground && atLeast(role, "publisher");

  // ── Selection (in the address) ───────────────────────────────────────────
  const selection = useMemo(() => decodeSelection(q), [q]);
  const select = useCallback(
    (next: Selection | null, options?: { field?: string }) => {
      const encoded = encodeSelection(next);
      setQ(encoded);
      setPendingFocus(encoded && options?.field ? { selection: encoded, field: options.field } : null);
    },
    [setQ],
  );

  // ── Changes ──────────────────────────────────────────────────────────────
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const run = useCallback(
    (label: string, operation: (d: StudioDraft) => StudioDraft): boolean => {
      if (!canEdit) {
        toast.info("This draft can't be changed", readOnlyReason ?? undefined);
        return false;
      }
      try {
        editorRef.current.apply(operation, label);
        return true;
      } catch (error) {
        if (error instanceof StudioOpError) {
          toast.error(refusalTitle(error.code), error.message);
          return false;
        }
        toast.error("That change couldn't be made", error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [canEdit, readOnlyReason, toast],
  );

  const actor = useCallback((): OpActor => ({ by: user.email ?? user.uid, at: new Date().toISOString() }), [user]);

  const announce = useCallback((text: string) => {
    // Cleared first so the same sentence twice in a row is still read out.
    setMessage("");
    window.setTimeout(() => setMessage(text), 30);
  }, []);

  const value = useMemo<EditorContextValue>(
    () => ({
      surveyId,
      survey,
      editor,
      draft,
      published,
      publishedStatus: context.status,
      baseline: published?.baseline ?? origin,
      publishedItemKeys: published?.publishedItemKeys ?? EMPTY,
      reserved: published?.reserved,
      role,
      user,
      playground,
      canEdit,
      readOnlyReason,
      canPublish,
      selection,
      select,
      pendingFocus,
      clearPendingFocus: () => setPendingFocus(null),
      issues,
      issuesFresh: validatedDraft === draft,
      actor,
      run,
      announce,
      validationOpen,
      setValidationOpen,
      publishOpen,
      setPublishOpen,
    }),
    [
      surveyId,
      survey,
      editor,
      draft,
      published,
      context.status,
      origin,
      role,
      user,
      playground,
      canEdit,
      readOnlyReason,
      canPublish,
      selection,
      select,
      pendingFocus,
      issues,
      validatedDraft,
      actor,
      run,
      announce,
      validationOpen,
      publishOpen,
    ],
  );

  return (
    <EditorContext.Provider value={value}>
      {children}
      <div className="st-sr" role="status" aria-live="polite">
        {message}
      </div>
    </EditorContext.Provider>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The validation context, built exactly as `studioPublish` builds it: the live
 * version when there is one, otherwise the locked and protected content of the
 * release the survey was copied from (or nothing at all for a blank survey),
 * so licensed text cannot enter a first release unnoticed.
 */
function contextFor(published: PublishedContext | null, origin: StudioDraft | null, draft: StudioDraft): ValidationContext {
  if (!published) return {};
  return {
    reserved: published.reserved,
    baseline: published.baseline ?? lockBaseline(origin, draft),
    publishedScaleCodes: published.publishedScaleCodes,
  };
}

function refusalTitle(code: string): string {
  switch (code) {
    case "locked":
      return "This is part of a licensed questionnaire";
    case "protected":
      return "This part of the survey is protected";
    case "linkage":
      return "This question makes the participant code";
    case "published":
      return "This has already been published";
    case "not_found":
      return "That's no longer in the draft";
    default:
      return "That change couldn't be made";
  }
}
