import { useMemo, useState } from "react";
import { outline } from "@myself/studio";
import { Icon, type IconName } from "../../ui/icons.js";
import { Button } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { useLibraryUi } from "../library/LibraryContext.js";
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
  const library = useLibraryUi();
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

  const go = (selection: Selection) => ctx.select(selection);
  const shortcuts: { icon: IconName; label: string; hint: string; selection: Selection }[] = [
    { icon: "welcome", label: "Start screen", hint: "The participant code and who to contact", selection: { kind: "welcome" } },
    {
      icon: "story",
      label: "MyStory",
      hint: o.mystory ? `On, at the end: ${o.mystory.id}` : "Off. A conversation at the end of the survey",
      selection: { kind: "mystory" },
    },
    { icon: "flag", label: "Completion screens", hint: "The thank-you and the review screen", selection: { kind: "completion" } },
    { icon: "settings", label: "Survey settings", hint: "Title and going back", selection: { kind: "settings" } },
  ];

  const stats = [
    { label: "Sections", value: o.sections.length },
    { label: "Questions", value: counts.questions },
    { label: "Conditional", value: counts.conditional },
    { label: "Licensed", value: counts.licensed },
    { label: "Archived", value: o.archived.length },
  ];

  return (
    <div className="stn-node stn-overview">
      <header className="stn-pagehead stn-pagehead-actions">
        <div>
          <h2 className="stn-title" tabIndex={-1} data-editor-heading>
            {draft.composition.title}
          </h2>
          <p className="stn-lead">Select a question on the left, or add one.</p>
        </div>
        <div className="stn-row-actions">
          <Button size="sm" variant="secondary" icon="library" onClick={() => library.openDrawer()}>
            Library
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)} disabled={!ctx.canEdit}>
            Add question
          </Button>
        </div>
      </header>

      <dl className="stn-stats">
        {stats.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd className="st-num">{s.value}</dd>
          </div>
        ))}
      </dl>

      {library.updates.length > 0 ? (
        <section className="stn-panel" aria-labelledby="stn-overview-updates">
          <header className="stn-panel-head">
            <h3 id="stn-overview-updates" className="stn-panel-title">
              Library updates
            </h3>
          </header>
          <ul className="stn-linklist">
            {library.updates.map((u) => {
              const title = library.modules.get(u.moduleId)?.title ?? u.moduleId;
              return (
                <li key={u.importId}>
                  <button type="button" className="stn-linkrow" onClick={() => library.review(u)}>
                    <Icon name="library" size={16} />
                    <span className="stn-linkrow-title">A newer version of ‘{title}’ is in the library (v{u.to})</span>
                    <span className="stn-linkrow-meta">Review</span>
                    <Icon name="chevron-right" size={14} className="st-icon stn-linkrow-chevron" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="stn-panel" aria-labelledby="stn-overview-screens">
        <header className="stn-panel-head">
          <h3 id="stn-overview-screens" className="stn-panel-title">
            Screens and settings
          </h3>
        </header>
        <ul className="stn-linklist">
          {shortcuts.map((s) => (
            <li key={s.label}>
              <button type="button" className="stn-linkrow" onClick={() => go(s.selection)}>
                <Icon name={s.icon} size={16} />
                <span className="stn-linkrow-title">{s.label}</span>
                <span className="stn-linkrow-meta">{s.hint}</span>
                <Icon name="chevron-right" size={14} className="st-icon stn-linkrow-chevron" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="stn-panel" aria-labelledby="stn-overview-sections">
        <header className="stn-panel-head">
          <h3 id="stn-overview-sections" className="stn-panel-title">
            Sections
          </h3>
        </header>
        <ol className="stn-linklist">
          {o.sections.map((s, i) => {
            const n = s.blocks.reduce((sum, b) => sum + b.questions.length, 0);
            return (
              <li key={s.key}>
                <button type="button" className="stn-linkrow" onClick={() => go({ kind: "section", sectionKey: s.key })}>
                  <span className="stn-linkrow-num st-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="stn-linkrow-title">{s.title}</span>
                  <span className="stn-linkrow-meta">
                    {s.hasCondition ? (
                      <span className="stn-linkrow-if" title="Shown only to some participants">
                        <Icon name="branch" size={14} />
                        <span className="st-sr">Shown only to some · </span>
                      </span>
                    ) : null}
                    <span className="st-num">
                      {n} question{n === 1 ? "" : "s"}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={14} className="st-icon stn-linkrow-chevron" />
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
