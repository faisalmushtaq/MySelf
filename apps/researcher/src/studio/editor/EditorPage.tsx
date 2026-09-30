import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StudioRole, SurveyDoc } from "@myself/studio";
import type { DraftEditor, Loadable, PublishedContext, StudioUser } from "../data/index.js";
import { Icon } from "../ui/icons.js";
import { EmptyState, Skeleton } from "../ui/kit.js";
import { EditorProvider, useEditor } from "./context.js";
import { Inspector } from "./Inspector.js";
import { NodeEditor } from "./NodeEditor.js";
import { focusSoon } from "./node/focus.js";
import { Outline } from "./Outline.js";
import { PublishDialog } from "./PublishDialog.js";
import { encodeSelection } from "./selection.js";
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
        <Columns />
        <ValidationPanel />
        <PublishDialog />
      </div>
    </EditorProvider>
  );
}

/**
 * The three columns. On a phone they stack, and the outline — some 150 rows —
 * folds behind a "Questions" button above the editor, so opening a question
 * shows that question, not the middle of a long list. It folds away again as
 * soon as something is chosen from it. Wider windows never see the button.
 */
function Columns() {
  const { selection } = useEditor();
  const selected = encodeSelection(selection);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const open = useRef(outlineOpen);
  open.current = outlineOpen;
  // Folding the list away also hides the row that had focus. Carry focus on to
  // the heading of what was chosen, so a keyboard or screen-reader user lands
  // there rather than on <body>.
  useEffect(() => {
    if (!open.current) return;
    setOutlineOpen(false);
    if (document.getElementById("ste-outline")?.contains(document.activeElement)) focusSoon("[data-editor-heading]");
  }, [selected]);
  // Unfolded, the list opens at the selection, in the middle of its own box
  // (the page itself stays where it is).
  useLayoutEffect(() => {
    if (!outlineOpen) return;
    const column = document.getElementById("ste-outline");
    const row = column?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"] > .sto-row');
    if (!column || !row) return;
    const box = column.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    column.scrollTop += at.top - box.top - (box.height - at.height) / 2;
  }, [outlineOpen]);
  return (
    <div className={`ste-columns${outlineOpen ? " is-outline-open" : ""}`}>
      <button
        type="button"
        className="ste-outline-toggle"
        aria-expanded={outlineOpen}
        aria-controls="ste-outline"
        onClick={() => setOutlineOpen((open) => !open)}
      >
        <Icon name="section" size={16} />
        <span>Questions</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <aside id="ste-outline" className="ste-left" aria-label="Survey outline">
        <Outline />
      </aside>
      <section className="ste-centre" aria-label="Editor">
        <NodeEditor />
      </section>
      <aside className="ste-right" aria-label="Settings for the selection">
        <Inspector />
      </aside>
    </div>
  );
}
