import { findQuestion } from "@myself/studio";
import { useEditor } from "./context.js";
import { BlockInspector } from "./inspector/BlockInspector.js";
import { QuestionInspector } from "./inspector/QuestionInspector.js";
import { SectionInspector } from "./inspector/SectionInspector.js";
import { ArchivedFacts, SurveyFacts } from "./inspector/SurveyFacts.js";
import { findBlock } from "./node/BlockEditor.js";
import { useQuestionIdentity } from "./node/identity.js";
import "./inspector.css";

/**
 * The settings panel: for whatever is selected, the settings that change how
 * it works rather than what it says — only those its kind has, each with what
 * it does in a sentence. With nothing selected, the survey at a glance.
 */
export function Inspector() {
  const { selection, draft } = useEditor();
  switch (selection?.kind) {
    case undefined:
      return <SurveyFacts />;
    case "welcome":
      return (
        <SurveyFacts tip="The start screen is the first thing participants see. Its text is edited in the centre; use Preview to see it exactly as they will." />
      );
    case "completion":
      return <SurveyFacts tip="Participants reach the completion screens once every question they are shown has been answered or skipped." />;
    case "settings":
      return <SurveyFacts />;
    case "section":
      return draft.composition.sections.some((s) => s.key === selection.sectionKey) ? (
        <SectionInspector key={selection.sectionKey} sectionKey={selection.sectionKey} />
      ) : null;
    case "block":
      return findBlock(draft, selection) ? (
        <BlockInspector key={`${selection.sectionKey}:${selection.componentIndex}`} sectionKey={selection.sectionKey} componentIndex={selection.componentIndex} />
      ) : null;
    case "question":
      return <QuestionPanel itemKey={selection.itemKey} />;
  }
}

function QuestionPanel({ itemKey }: { itemKey: string }) {
  const { draft } = useEditor();
  const identity = useQuestionIdentity(itemKey);
  if (findQuestion(draft, itemKey)) return <QuestionInspector key={identity} itemKey={itemKey} stableId={identity} />;
  const archived = draft.archived.find((a) => a.itemKey === itemKey);
  return archived ? <ArchivedFacts record={archived} /> : null;
}
