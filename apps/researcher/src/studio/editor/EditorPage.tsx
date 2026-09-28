import type { StudioRole, SurveyDoc } from "@myself/studio";
import type { DraftEditor, Loadable, PublishedContext, StudioUser } from "../data/index.js";
import { EmptyState, Skeleton } from "../ui/kit.js";
import { EditorProvider } from "./context.js";
import { Inspector } from "./Inspector.js";
import { NodeEditor } from "./NodeEditor.js";
import { Outline } from "./Outline.js";
import { PublishDialog } from "./PublishDialog.js";
import { Toolbar } from "./Toolbar.js";
import { ValidationPanel } from "./ValidationPanel.js";
import "./editor.css";

/**
 * The Studio editor: outline on the left, the selected thing in the middle,
 * its settings on the right, and a toolbar that always says whether the work
 * is saved and whether it can be published.
 *
 * The draft editor is passed in, never created here: SurveyLayout owns the one
 * save engine for the survey (a second would compete with it), and the
 * playground passes an in-memory one. Everything below reads the draft, the
 * selection and the validation through the editor context.
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

export function EditorPage({ surveyId, survey, editor, context, role, user }: EditorPageProps) {
  if (editor.status === "loading") {
    return (
      <div className="ste-state">
        <Skeleton lines={8} label="Loading the draft" />
      </div>
    );
  }
  const draft = editor.draft;
  if (!draft) {
    return (
      <div className="ste-state">
        <EmptyState icon="warning" title="There's no draft to show">
          <p>{editor.error ?? "This survey has no working draft. An admin can set it up from the survey list."}</p>
        </EmptyState>
      </div>
    );
  }
  return (
    <EditorProvider surveyId={surveyId} survey={survey} editor={editor} draft={draft} context={context} role={role} user={user}>
      <div className="ste-workspace">
        <Toolbar />
        <div className="ste-columns">
          <aside className="ste-left" aria-label="Survey outline">
            <Outline />
          </aside>
          <section className="ste-centre" aria-label="Editor">
            <NodeEditor />
          </section>
          <aside className="ste-right" aria-label="Settings for the selection">
            <Inspector />
          </aside>
        </div>
        <ValidationPanel />
        <PublishDialog />
      </div>
    </EditorProvider>
  );
}
