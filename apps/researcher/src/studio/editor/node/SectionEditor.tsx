import { useCallback, useMemo, useState } from "react";
import { editTier, outline, removeSection, updateSection, type StudioDraft } from "@myself/studio";
import { Button } from "../../ui/kit.js";
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
      <header className="stn-node-head">
        <p className="stn-crumbs">
          Section {index + 1} of {draft.composition.sections.length}
        </p>
        <h2 className="stn-title" tabIndex={-1} data-editor-heading>
          {section.title || "Untitled section"}
        </h2>
      </header>
      <IssueMessages issues={issues.general} />
      <article className="stn-card stn-card-plain">
        <TextField
          label="Section title"
          field="title"
          value={section.title}
          inputClassName="stn-sectiontitle"
          readOnly={!ctx.canEdit}
          lockedReason={ctx.readOnlyReason}
          validate={validateTitle}
          hint="Participants see it in the progress bar as they move through the survey."
          issues={issues.byField.get("title")}
          onCommit={(title) =>
            ctx.run(`Rename the section ${sectionKey}`, (d) =>
              // Stored trimmed: no undo step for a space at the end (unchanged.ts).
              unlessUnchanged(d, updateSection(d, sectionKey, { title }).draft, (x) => x.composition.sections.find((s) => s.key === sectionKey)?.title),
            )
          }
        />
      </article>

      <Panel title="When it's shown" field="displayIf">
        <ConditionBuilder
          subject={{ kind: "section", sectionKey }}
          noun="section"
          expr={section.displayIf}
          readOnly={!ctx.canEdit || guarded !== null}
          lockedReason={
            guarded
              ? "This section holds a protected module (the consent or the participant identifiers), which every participant must see. A condition here would hide it too."
              : ctx.readOnlyReason
          }
          issues={issues.byField.get("displayIf")}
          onWrite={(next) => ctx.run(`Change when the section ${sectionKey} is shown`, (d) => updateSection(d, sectionKey, { displayIf: next }).draft)}
        />
      </Panel>

      <Panel
        title={`In this section · ${questionCount} question${questionCount === 1 ? "" : "s"}`}
        field="components"
        actions={
          <Button size="sm" icon="plus" onClick={() => setAdding(true)} disabled={!ctx.canEdit}>
            Add a question
          </Button>
        }
      >
        <IssueMessages issues={issues.byField.get("components")} />
        <NodeList blocks={blocks} sectionKey={sectionKey} withBlocks select={ctx.select} />
      </Panel>

      <Panel title="Delete section">
        {empty && draft.composition.sections.length > 1 ? (
          <>
            <p className="stn-flush">This section is empty, so deleting it loses nothing. You can undo it.</p>
            <div className="stn-row-actions">
              <Button variant="danger" icon="trash" onClick={remove} disabled={!ctx.canEdit}>
                Delete section
              </Button>
            </div>
          </>
        ) : (
          <p className="stn-hint">
            {empty
              ? "A survey needs at least one section."
              : "Only an empty section can be deleted, so nothing goes with it by accident. Move its questions to another section, or archive them, first."}
          </p>
        )}
      </Panel>
      {adding ? <AddQuestionDialog sectionKey={sectionKey} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
