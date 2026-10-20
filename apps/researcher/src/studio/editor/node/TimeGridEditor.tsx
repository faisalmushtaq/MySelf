import { useId, useMemo } from "react";
import type { ItemDefinition } from "@myself/schema";
import { gridSourceRef, gridSources, liveQuestions, type StudioDraft } from "@myself/studio";
import { useEditor } from "../context.js";
import { IssueMessages } from "./controls.js";
import type { FieldIssues } from "./issues.js";
import type { WriteQuestion } from "./QuestionEditor.js";

type TimeGrid = Extract<ItemDefinition, { responseType: "time_grid" }>;

/** "12. Which of these apps do you use?" — how the editor names a question elsewhere. */
function nameOf(draft: StudioDraft, itemKey: string): string {
  const q = liveQuestions(draft).find((x) => x.itemKey === itemKey);
  if (!q) return itemKey;
  const text = q.item.stem.text.length > 70 ? `${q.item.stem.text.slice(0, 69)}…` : q.item.stem.text;
  return `${q.position + 1}. ${text}`;
}

/**
 * Where a time grid's rows come from: an earlier sorting question and one of
 * its groups, or an earlier multiple-choice question. Only questions asked
 * before the grid are offered, since only their answers exist by then.
 */
export function TimeGridEditor({
  itemKey,
  item,
  issues,
  write,
  editable,
}: {
  itemKey: string;
  item: TimeGrid;
  issues: FieldIssues;
  write: WriteQuestion;
  editable: boolean;
}) {
  const { draft } = useEditor();
  const base = useId();
  const sources = useMemo(() => gridSources(draft, itemKey), [draft, itemKey]);
  const from = item.rowsFrom;
  const currentKey = `${from.instrument}.${from.item}`;
  const current = sources.find((s) => s.itemKey === currentKey);
  const pointsAtItself = currentKey === itemKey;
  const groups = current?.item.responseType === "rank_group" ? current.item.groups : [];
  const fieldIssues = issues.byField.get("rowsFrom");
  const problemId = `${base}-problem`;

  return (
    <div className="stn-grid-source" data-field="rowsFrom">
      <p className="stn-answer-note">
        Participants give hours and minutes for each option they chose at the question below, on one screen. Each
        row is stored in minutes as <code>{item.variable}_&lt;code&gt;</code>; options they did not choose are
        recorded as not shown. If they chose none, the question is skipped.
      </p>
      <div className="stn-field">
        <label className="stn-label" htmlFor={`${base}-source`}>
          Rows come from
        </label>
        <select
          id={`${base}-source`}
          className="st-select"
          value={pointsAtItself ? "" : currentKey}
          disabled={!editable}
          aria-describedby={fieldIssues?.length ? problemId : undefined}
          onChange={(e) => {
            const chosen = sources.find((s) => s.itemKey === e.target.value);
            if (chosen) write(`Choose where the rows of ${itemKey} come from`, () => ({ rowsFrom: gridSourceRef(chosen.itemKey, chosen.item) }));
          }}
        >
          <option value="" disabled>
            {sources.length ? "Choose an earlier question…" : "No sorting or multiple-choice question comes before this one"}
          </option>
          {!pointsAtItself && !current ? (
            <option value={currentKey}>{currentKey} (not asked before this — choose another)</option>
          ) : null}
          {sources.map((s) => (
            <option key={s.itemKey} value={s.itemKey}>
              {nameOf(draft, s.itemKey)}
              {s.item.responseType === "rank_group" ? " (sorting)" : " (multiple choice)"}
            </option>
          ))}
        </select>
      </div>
      {groups.length > 0 ? (
        <div className="stn-field">
          <label className="stn-label" htmlFor={`${base}-group`}>
            Using the options sorted into
          </label>
          <select
            id={`${base}-group`}
            className="st-select"
            value={from.group ?? ""}
            disabled={!editable}
            onChange={(e) =>
              current && write(`Choose the group the rows of ${itemKey} come from`, () => ({ rowsFrom: gridSourceRef(current.itemKey, current.item, e.target.value) }))
            }
          >
            {from.group && !groups.some((g) => g.key === from.group) ? <option value={from.group}>{from.group} (no longer a group)</option> : null}
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <IssueMessages id={problemId} issues={fieldIssues} />
    </div>
  );
}
