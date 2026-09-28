import { liveQuestions, type StudioRole } from "@myself/studio";
import { usePresence, type DraftEditor, type Loadable, type PublishedContext, type StudioUser, type SurveyDoc } from "../data/index.js";
import { formatTime } from "../format.js";
import { usePlaygroundMode } from "../mode.js";
import { Badge, EmptyState, Field, IconButton, Skeleton } from "../ui/kit.js";

/**
 * PLACEHOLDER — the question editor is being built on its own branch and
 * replaces this file. It exists so the platform (routes, saving, versions,
 * access) can be run and reviewed on its own, and it pins the props the
 * platform passes. The one field it edits (the survey's title) is enough to
 * exercise the whole save path: debounce, transaction, conflict, recovery.
 */

export interface EditorPageProps {
  surveyId: string;
  /** Null in the playground, where there is no stored survey. */
  survey: SurveyDoc | null;
  editor: DraftEditor;
  context: Loadable<PublishedContext>;
  role: StudioRole;
  user: StudioUser;
}

function saveText(editor: DraftEditor): string {
  const s = editor.save;
  switch (s.kind) {
    case "saved":
      return s.at ? `Draft saved ${formatTime(s.at)}` : "Draft saved";
    case "unsaved":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "offline":
      return "Offline — changes kept in this tab";
    case "error":
      return "Save failed";
    case "conflict":
      return "Someone else saved — choose a version";
  }
}

export function EditorPage({ surveyId, editor }: EditorPageProps) {
  const others = usePresence(surveyId, null);
  const playground = usePlaygroundMode();
  if (editor.status === "loading") {
    return (
      <div className="stp-page">
        <Skeleton lines={6} label="Loading the draft" />
      </div>
    );
  }
  const draft = editor.draft;
  if (!draft) {
    return (
      <div className="stp-page">
        <EmptyState icon="warning" title="There’s no draft to show">
          <p>{editor.error ?? "This survey has no working draft."}</p>
        </EmptyState>
      </div>
    );
  }
  const questions = liveQuestions(draft).length;
  return (
    <div className="stp-page">
      <div className="stp-page-head">
        <h1 className="stp-h1">Edit</h1>
        <div className="stp-actions">
          <span role="status" className="stp-muted">
            {playground ? "Nothing is saved in the playground" : saveText(editor)}
          </span>
          <IconButton icon="undo" label={editor.undoLabel ? `Undo ${editor.undoLabel}` : "Undo"} disabled={!editor.canUndo} onClick={editor.undo} />
          <IconButton icon="redo" label={editor.redoLabel ? `Redo ${editor.redoLabel}` : "Redo"} disabled={!editor.canRedo} onClick={editor.redo} />
        </div>
      </div>
      {others.length > 0 ? (
        <p className="stp-gap">
          Also here:{" "}
          {others.map((p) => (
            <Badge key={p.uid} icon="user">
              {p.email}
            </Badge>
          ))}
        </p>
      ) : null}
      <div className="stp-card stp-gap">
        <Field label="Survey title" hint="For the research team: it appears in the Studio, exports and the audit trail.">
          {(p) => (
            <input
              {...p}
              className="st-input"
              value={draft.composition.title}
              readOnly={editor.readOnly}
              onChange={(e) => {
                const title = e.target.value;
                editor.apply((d) => ({ ...d, composition: { ...d.composition, title } }), "Rename the survey");
              }}
            />
          )}
        </Field>
      </div>
      <EmptyState icon="section" title="The question editor is coming soon">
        <p>
          This draft has {draft.composition.sections.length} sections and {questions} questions. Saving, versions and
          access already work around it.
        </p>
      </EmptyState>
    </div>
  );
}
