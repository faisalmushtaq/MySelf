import { useMemo, useState } from "react";
import { outline, summariseIssues } from "@myself/studio";
import { Icon, type IconName } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import type { Selection } from "../selection.js";
import { AddQuestionDialog } from "./AddQuestion.js";

/**
 * What the centre shows with nothing selected: the survey at a glance, and
 * where to start.
 */
export function Overview() {
  const ctx = useEditor();
  const { draft } = ctx;
  const o = useMemo(() => outline(draft), [draft]);
  const [adding, setAdding] = useState(false);
  const counts = useMemo(() => {
    let questions = 0;
    let conditional = 0;
    const licensed = new Set<string>();
    for (const s of o.sections) {
      for (const b of s.blocks) {
        if (b.tier === "locked") licensed.add(b.instrument);
        for (const q of b.questions) {
          questions += 1;
          if (q.hasCondition) conditional += 1;
        }
      }
    }
    return { questions, conditional, licensed: licensed.size };
  }, [o]);
  const { errors, warnings } = summariseIssues(ctx.issues);

  const go = (selection: Selection) => ctx.select(selection);
  const shortcuts: { icon: IconName; label: string; hint: string; selection: Selection }[] = [
    { icon: "welcome", label: "Start screen", hint: "The participant code and who to contact", selection: { kind: "welcome" } },
    { icon: "flag", label: "Completion screens", hint: "The thank-you and the review screen", selection: { kind: "completion" } },
    { icon: "settings", label: "Survey settings", hint: "Title and going back", selection: { kind: "settings" } },
  ];

  return (
    <div className="stn-node stn-overview">
      <header className="stn-node-head">
        <p className="stn-crumbs">Survey</p>
        <h2 className="stn-title stn-title-lg" tabIndex={-1} data-editor-heading>
          {draft.composition.title}
        </h2>
        <p className="stn-lead">Select a question on the left, or add one.</p>
      </header>

      <dl className="stn-stats">
        <div>
          <dt>Sections</dt>
          <dd>{o.sections.length}</dd>
        </div>
        <div>
          <dt>Questions</dt>
          <dd>{counts.questions}</dd>
        </div>
        <div>
          <dt>Shown only to some</dt>
          <dd>{counts.conditional}</dd>
        </div>
        <div>
          <dt>Licensed questionnaires</dt>
          <dd>{counts.licensed}</dd>
        </div>
        <div>
          <dt>Archived</dt>
          <dd>{o.archived.length}</dd>
        </div>
      </dl>

      <div className="stn-row-actions">
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)} disabled={!ctx.canEdit}>
          Add a question
        </Button>
        {errors + warnings > 0 ? (
          <Button variant="secondary" icon={errors > 0 ? "error" : "warning"} onClick={() => ctx.setValidationOpen(true)}>
            {errors > 0 ? `${errors} problem${errors === 1 ? "" : "s"} to fix` : `${warnings} thing${warnings === 1 ? "" : "s"} to check`}
          </Button>
        ) : null}
      </div>

      <ul className="stn-shortcuts">
        {shortcuts.map((s) => (
          <li key={s.label}>
            <button type="button" className="stn-shortcut" onClick={() => go(s.selection)}>
              <Icon name={s.icon} size={20} />
              <span>
                <strong>{s.label}</strong>
                <span>{s.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <section aria-labelledby="stn-overview-sections">
        <h3 id="stn-overview-sections" className="stn-eyebrow">
          Sections
        </h3>
        <ol className="stn-sectionlist">
          {o.sections.map((s) => {
            const n = s.blocks.reduce((sum, b) => sum + b.questions.length, 0);
            return (
              <li key={s.key}>
                <button type="button" className="stn-sectionlink" onClick={() => go({ kind: "section", sectionKey: s.key })}>
                  <span className="stn-sectionlink-title">{s.title}</span>
                  <span className="stn-sectionlink-meta">
                    {n} question{n === 1 ? "" : "s"}
                    {s.hasCondition ? " · shown only to some" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      {adding ? <AddQuestionDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
