import { useId, useMemo, type ReactNode } from "react";
import { outline, pickable, type StudioDraft, type StudioFragment } from "@myself/studio";
import { Icon } from "../../ui/icons.js";
import { InfoTip } from "../../ui/kit.js";
import { fragmentQuestions, impliedPick, matches, matchingQuestions, pickKey, togglePick } from "./model.js";

/**
 * What a piece holds, before it is added: a published version's sections,
 * blocks and questions with a tick for each thing that can be taken, or a
 * saved module's or validated questionnaire's questions, which are taken
 * whole.
 */

/**
 * A published version, to pick from. Any question of an editable block can be
 * ticked on its own; a licensed questionnaire or a protected module only whole,
 * so its block carries the tick, a padlock and the reason (`pickable`). A whole
 * section can be ticked too. With a search, only matching questions are shown;
 * what is ticked stays ticked.
 */
export function ReleasePicker({
  source,
  query,
  picked,
  onPicked,
}: {
  source: StudioDraft;
  query: string;
  picked: ReadonlySet<string>;
  onPicked: (next: Set<string>) => void;
}) {
  const o = useMemo(() => outline(source), [source]);
  const reasons = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const s of o.sections) {
      for (const b of s.blocks) {
        for (const q of b.questions) {
          const r = pickable(source, q.itemKey);
          out.set(q.itemKey, r.ok ? null : r.reason);
        }
      }
    }
    return out;
  }, [source, o]);
  const found = useMemo(() => (query.trim() ? matchingQuestions(source, o, query) : null), [source, o, query]);
  const toggle = (key: string) => onPicked(togglePick(o, picked, key));
  const shown = o.sections
    .map((s) => ({ ...s, blocks: s.blocks.filter((b) => !found || b.questions.some((q) => found.has(q.itemKey))) }))
    .filter((s) => s.blocks.length > 0);

  if (o.sections.every((s) => s.blocks.length === 0)) {
    return <p className="stl-empty-line">This version has no questions to copy.</p>;
  }
  return (
    <div className="stl-pick">
      {found ? (
        <p className="stl-meta" role="status">
          {found.size === 0 ? "No questions in this version match." : `${found.size === 1 ? "1 question matches" : `${found.size} questions match`}.`}
        </p>
      ) : null}
      {shown.map((s) => {
        const wholeSection = picked.has(pickKey.section(s.key));
        const count = s.blocks.reduce((n, b) => n + b.questions.length, 0);
        return (
          <section key={s.key} className="stl-src-section" aria-label={`Section: ${s.title}`}>
            <Check
              className="stl-check-section"
              checked={wholeSection}
              onChange={() => toggle(pickKey.section(s.key))}
              label={
                <>
                  <span className="stl-check-title">{s.title}</span>
                  <span className="stl-meta">
                    {count === 1 ? "1 question" : `${count} questions`} · whole section
                  </span>
                </>
              }
              srLabel={`Whole section: ${s.title}`}
            />
            {s.blocks.map((b) => {
              const editable = b.tier === "editable";
              const blockReason = editable ? null : (reasons.get(b.questions[0]?.itemKey ?? "") ?? "Taken only whole.");
              const blockTicked = picked.has(pickKey.block(s.key, b.componentIndex));
              const blockImplied = impliedPick(picked, s.key);
              const questions = found ? b.questions.filter((q) => found.has(q.itemKey)) : b.questions;
              return (
                <div key={b.componentIndex} className="stl-src-block">
                  <div className="stl-blockhead">
                    <Check
                      checked={blockImplied || blockTicked}
                      disabled={blockImplied}
                      onChange={() => toggle(pickKey.block(s.key, b.componentIndex))}
                      label={
                        <>
                          <span className="stl-check-title">{b.name}</span>
                          <span className="stl-meta">{b.questions.length === 1 ? "1 question" : `${b.questions.length} questions`} · whole block</span>
                        </>
                      }
                      srLabel={`Whole block: ${b.name}`}
                    />
                    {blockReason ? (
                      <span className="stl-lock">
                        <Icon name="lock" size={14} />
                        <span>{b.tier === "locked" ? "Licensed · whole only" : "Protected · whole only"}</span>
                        <InfoTip text={blockReason} label={`why “${b.name}” is taken whole`} />
                      </span>
                    ) : null}
                  </div>
                  <ul className="stl-questions">
                    {questions.map((q) => {
                      const implied = blockImplied || blockTicked;
                      const own = reasons.get(q.itemKey) === null;
                      return (
                        <li key={q.itemKey}>
                          {own ? (
                            <Check
                              checked={implied || picked.has(pickKey.question(q.itemKey))}
                              disabled={implied}
                              onChange={() => toggle(pickKey.question(q.itemKey))}
                              label={
                                <>
                                  <span className="stl-q-text">{q.text || "Untitled question"}</span>
                                  <span className="stl-q-id">{q.itemKey}</span>
                                </>
                              }
                            />
                          ) : (
                            <div className="stl-q-row stl-q-whole">
                              <span className="stl-q-text">{q.text || "Untitled question"}</span>
                              <span className="stl-q-id">{q.itemKey}</span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** A checkbox row: the box, then what it takes. */
function Check({
  checked,
  disabled,
  onChange,
  label,
  srLabel,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: ReactNode;
  /** A fuller name for screen readers than the visible text. */
  srLabel?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`stl-check${className ? ` ${className}` : ""}${disabled ? " is-implied" : ""}`}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={srLabel} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** A saved module's or a validated questionnaire's questions: taken whole, so listed without ticks. */
export function FragmentQuestions({ fragment, query }: { fragment: StudioFragment; query: string }) {
  const all = useMemo(() => fragmentQuestions(fragment), [fragment]);
  const shown = query.trim() ? all.filter((q) => matches(query, q.text, q.itemKey, q.variable, q.block)) : all;
  const blocks = [...new Set(shown.map((q) => q.block))];
  return (
    <div className="stl-pick">
      {query.trim() ? (
        <p className="stl-meta" role="status">
          {shown.length === 0 ? "No questions in it match." : `${shown.length} of ${all.length} questions match.`}
        </p>
      ) : null}
      {blocks.map((block) => (
        <div key={block} className="stl-src-block">
          {fragment.blocks.length > 1 ? <p className="stl-blockname">{block}</p> : null}
          <ol className="stl-questions stl-questions-numbered">
            {shown
              .filter((q) => q.block === block)
              .map((q) => (
                <li key={q.itemKey}>
                  <div className="stl-q-row">
                    <span className="stl-q-text">{q.text || "Untitled question"}</span>
                    <span className="stl-q-id">
                      {q.itemKey} · {q.variable}
                    </span>
                  </div>
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
