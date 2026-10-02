import { useEffect } from "react";
import { findQuestion } from "@myself/studio";
import { Button, EmptyState } from "../ui/kit.js";
import { useEditor } from "./context.js";
import { ArchivedQuestion } from "./node/ArchivedQuestion.js";
import { BlockEditor, findBlock } from "./node/BlockEditor.js";
import { CompletionEditor } from "./node/CompletionEditor.js";
import { useFocusRescue, usePendingFocus } from "./node/focus.js";
import { renameCandidates, useQuestionIdentity } from "./node/identity.js";
import { Overview } from "./node/Overview.js";
import { QuestionEditor } from "./node/QuestionEditor.js";
import { SectionEditor } from "./node/SectionEditor.js";
import { SettingsEditor } from "./node/SettingsEditor.js";
import { WelcomeEditor } from "./node/WelcomeEditor.js";
import "./node.css";

/**
 * The centre of the editor: whatever is selected, edited as the participant
 * will meet it — a question in large type, editable in place, a section with
 * its contents, the start and completion screens as screens.
 *
 * It also carries out jumps from the validation panel: once the selection is
 * drawn here and in the settings panel, the field at fault is focused.
 */
export function NodeEditor() {
  const ctx = useEditor();
  usePendingFocus();
  // REVIEW FIX: put focus back when an action removes the control holding it (focus.ts).
  useFocusRescue();
  const { selection, draft } = ctx;

  switch (selection?.kind) {
    case undefined:
      return <Overview />;
    case "welcome":
      return <WelcomeEditor />;
    case "completion":
      return <CompletionEditor />;
    case "settings":
      return <SettingsEditor />;
    case "section":
      return draft.composition.sections.some((s) => s.key === selection.sectionKey) ? (
        <SectionEditor key={selection.sectionKey} sectionKey={selection.sectionKey} />
      ) : (
        <Missing what="section" />
      );
    case "block":
      return findBlock(draft, selection) ? (
        <BlockEditor key={`${selection.sectionKey}:${selection.componentIndex}`} sectionKey={selection.sectionKey} componentIndex={selection.componentIndex} />
      ) : (
        <Missing what="block" />
      );
    case "question":
      return <QuestionNode itemKey={selection.itemKey} />;
  }
}

function QuestionNode({ itemKey }: { itemKey: string }) {
  const ctx = useEditor();
  const identity = useQuestionIdentity(itemKey);
  const live = findQuestion(ctx.draft, itemKey) !== null;
  const archived = live ? null : (ctx.draft.archived.find((a) => a.itemKey === itemKey) ?? null);
  const follow = !live && !archived ? (renameCandidates(itemKey).find((k) => findQuestion(ctx.draft, k)) ?? null) : null;

  // The ID was changed here and then undone (or redone): follow the question.
  useEffect(() => {
    if (follow) ctx.select({ kind: "question", itemKey: follow });
  }, [follow, ctx]);

  if (live) return <QuestionEditor key={identity} itemKey={itemKey} />;
  if (archived) return <ArchivedQuestion key={itemKey} record={archived} />;
  return <Missing what="question" />;
}

function Missing({ what }: { what: "question" | "section" | "block" }) {
  const { select } = useEditor();
  return (
    <div className="stn-node">
      <EmptyState
        icon="search"
        title={`This ${what} isn't in the draft any more`}
        action={
          <Button variant="secondary" onClick={() => select(null)}>
            Back to the overview
          </Button>
        }
      >
        <p>It may have been deleted, moved or renamed. Choose something from the outline.</p>
      </EmptyState>
    </div>
  );
}
