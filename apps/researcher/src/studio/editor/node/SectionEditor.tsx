import { useCallback, useMemo, useState } from "react";
import { editTier, outline, removeSection, updateSection, type StudioDraft } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { Button, InfoTip } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { AddQuestionDialog } from "./AddQuestion.js";
import { ConditionBuilder } from "./ConditionBuilder.js";
import { IssueMessages, Panel, TextField } from "./controls.js";
import { sectionIssues } from "./issues.js";
import { NodeList } from "./NodeList.js";
import { unlessUnchanged } from "./unchanged.js";

/**
 * A section: its title (participants see it in the progress bar), when it is
 * shown, and what is in it.
 */

/** The protected module a section holds, if any: a condition on the section would hide it too. */
export function protectedIn(draft: StudioDraft, sectionKey: string): string | null {
  const section = draft.composition.sections.find((s) => s.key === sectionKey);
  for (const c of section?.components ?? []) {
    if ((c.kind === "instrument" || c.kind === "module") && editTier(draft, c.ref.instrument) === "protected") return c.ref.instrument;
  }
  return null;
}

export function SectionEditor({ sectionKey }: { sectionKey: string }) {
  const ctx = useEditor();
  const { draft } = ctx;
  const index = draft.composition.sections.findIndex((s) => s.key === sectionKey);
  const section = draft.composition.sections[index]!;
  const issues = useMemo(() => sectionIssues(ctx.issues, sectionKey), [ctx.issues, sectionKey]);
  const blocks = useMemo(() => outline(draft).sections[index]?.blocks ?? [], [draft, index]);
  const [adding, setAdding] = useState(false);
  const guarded = protectedIn(draft, sectionKey);
  const validateTitle = useCallback((text: string) => (text.trim() ? null : "A section needs a title: participants see it in the progress bar."), []);
  const empty = section.components.length === 0;
  const questionCount = blocks.reduce((n, b) => n + b.questions.length, 0);

  const remove = () => {
    if (ctx.run(`Delete the section “${section.title}”`, (d) => removeSection(d, sectionKey).draft)) {
      ctx.announce(`Deleted the section “${section.title}”. Undo brings it back.`);
      ctx.select(null);
    }
  };

  return (
    <div className="stn-node">
      <header className="stn-head">
        <h2 className="stn-meta" tabIndex={-1} data-editor-heading>
          <span className="st-num">
            Section {index + 1} of {draft.composition.sections.length}
          </span>
          <span className="st-sr">: {section.title || "Untitled section"}</span>
          <span className="stn-meta-id">{sectionKey}</span>
        </h2>
      </header>
      <IssueMessages issues={issues.general} />
      <div className="stn-canvas">
        <TextField
          label="Section title"
          hideLabel
          className="stn-field-stem"
          field="title"
          value={section.title}
          inputClassName="stn-sectiontitle"
          placeholder="Section title"
          readOnly={!ctx.canEdit}
          lockedReason={ctx.readOnlyReason}
          validate={validateTitle}
          hint="Shown to participants in the progress bar."
          issues={issues.byField.get("title")}
          onCommit={(title) =>
            ctx.run(`Rename the section ${sectionKey}`, (d) =>
              // Stored trimmed: no undo step for a space at the end (unchanged.ts).
              unlessUnchanged(d, updateSection(d, sectionKey, { title }).draft, (x) => x.composition.sections.find((s) => s.key === sectionKey)?.title),
            )
          }
        />
      </div>

      <Panel
        title={`Questions · ${questionCount}`}
        field="components"
        actions={
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)} disabled={!ctx.canEdit}>
            Add question
          </Button>
        }
      >
        <IssueMessages issues={issues.byField.get("components")} />
        <NodeList blocks={blocks} sectionKey={sectionKey} withBlocks select={ctx.select} />
      </Panel>

      <Panel
        title="Condition"
        field="displayIf"
        info="Conditions can only use answers given earlier. To skip ahead, hide the questions in between — the survey always moves forward."
      >
        <ConditionBuilder
          subject={{ kind: "section", sectionKey }}
          noun="section"
          expr={section.displayIf}
          readOnly={!ctx.canEdit || guarded !== null}
          lockedReason={
            guarded
              ? "It holds a protected module (the consent or the participant identifiers) that every participant must see."
              : ctx.readOnlyReason
          }
          issues={issues.byField.get("displayIf")}
          onWrite={(next) => ctx.run(`Change when the section ${sectionKey} is shown`, (d) => updateSection(d, sectionKey, { displayIf: next }).draft)}
        />
      </Panel>

      <Panel title="Delete section">
        {empty && draft.composition.sections.length > 1 ? (
          <div className="stn-actionrow">
            <p className="stn-flush stn-muted">It's empty, so nothing is lost. You can undo it.</p>
            <Button variant="secondary" className="stn-danger-btn" icon="trash" onClick={remove} disabled={!ctx.canEdit}>
              Delete section
            </Button>
          </div>
        ) : (
          <p className="stn-inline-note">
            <Icon name="lock" size={14} />
            {empty ? "A survey needs at least one section." : "Only an empty section can be deleted."}
            {empty ? null : (
              <InfoTip
                text="So nothing goes with it by accident. Move its questions to another section, or archive them, first."
                label="deleting a section"
              />
            )}
          </p>
        )}
      </Panel>
      {adding ? <AddQuestionDialog sectionKey={sectionKey} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
