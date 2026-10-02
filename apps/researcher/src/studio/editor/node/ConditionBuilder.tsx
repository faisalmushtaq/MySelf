import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogicExpr } from "@myself/schema";
import { describeCondition, type ConditionJoin, type ConditionTest, type Issue } from "@myself/studio";
import { ConfirmDialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { Button, IconButton, InfoTip, Segmented } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import {
  buildLogic,
  earlierQuestions,
  emptyRule,
  optionChoices,
  parseCondition,
  retarget,
  ruleFor,
  ruleProblem,
  sameLogic,
  testLabel,
  valueInput,
  withTest,
  type BuilderState,
  type ConditionSubject,
  type EarlierQuestion,
  type RuleRow,
} from "./condition.js";
import { IssueMessages } from "./controls.js";

/**
 * "Show this question only if…" — a condition as a list of rules a researcher
 * can read and build without knowing the logic language underneath.
 *
 * Each rule is [an earlier question] [a test] [a value]; the rules are joined
 * by All or Any. A condition the simple form can't show exactly (nested
 * groups, a test on one part of an answer) is described in words and offered
 * for replacement or removal, never approximated — rewriting a condition the
 * builder only half understood would change who sees the question.
 */

export interface ConditionBuilderProps {
  subject: ConditionSubject;
  /** What the condition is on, for sentences: "question", "section", "block". */
  noun: "question" | "section" | "block" | "questionnaire";
  expr: LogicExpr | undefined;
  /** Write the condition (null removes it). Returns false if the model refused. */
  onWrite: (next: LogicExpr | null) => boolean;
  readOnly: boolean;
  /** Why it can't be changed, when read-only. */
  lockedReason?: ReactNode;
  issues?: readonly Issue[] | undefined;
}

export function ConditionBuilder({ subject, noun, expr, onWrite, readOnly, lockedReason, issues }: ConditionBuilderProps) {
  const ctx = useEditor();
  const draft = ctx.draft;
  const headingId = useId();
  const parsed = useMemo(() => parseCondition(expr), [expr]);
  const [state, setState] = useState<BuilderState | null>(() => (parsed.kind === "simple" ? parsed.state : null));
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const written = useRef<LogicExpr | undefined>(expr);
  // Keyed by the subject's value: callers pass a fresh object each render.
  const subjectKey = JSON.stringify(subject);
  const earlier = useMemo(() => earlierQuestions(draft, subject), [draft, subjectKey]);

  // A condition changed from elsewhere (undo, another editor, the model) is
  // taken as it now is; one this builder wrote is already what it shows.
  useEffect(() => {
    if (sameLogic(expr, written.current)) return;
    written.current = expr;
    const next = parseCondition(expr);
    setState(next.kind === "simple" ? next.state : null);
    setReplacing(false);
  }, [expr]);

  const update = (next: BuilderState | null) => {
    setState(next);
    if (!next || next.rows.length === 0) {
      setReplacing(false);
      if (expr !== undefined) {
        written.current = undefined;
        if (!onWrite(null)) written.current = expr;
      }
      setState(null);
      return;
    }
    const logic = buildLogic(next);
    if (logic && !sameLogic(logic, expr)) {
      written.current = logic;
      if (onWrite(logic)) setReplacing(false);
      else written.current = expr;
    }
  };

  const incomplete = state !== null && state.rows.some((r) => ruleProblem(r) !== null);
  const sentence = expr ? describeCondition(expr, draft) : null;
  const who = noun === "question" ? "this question" : noun === "section" ? "this section" : noun === "block" ? "this block" : "this questionnaire";

  let body: ReactNode;
  if (readOnly) {
    body = (
      <div className="stn-cond-readonly" data-field="displayIf" tabIndex={-1}>
        <p className={`stn-cond-sentence${sentence ? " set" : ""}`}>
          <Icon name="branch" size={14} />
          <span>{sentence ?? `Shown to everyone who reaches ${who}.`}</span>
        </p>
        {lockedReason ? (
          <p className="stn-inline-note">
            <Icon name="lock" size={14} /> <span>{lockedReason}</span>
          </p>
        ) : null}
      </div>
    );
  } else if (parsed.kind === "complex" && !replacing) {
    body = (
      <div className="stn-cond-readonly" data-field="displayIf" tabIndex={-1}>
        <p className="stn-cond-sentence set">
          <Icon name="branch" size={14} />
          <span>{sentence}</span>
        </p>
        <p className="stn-inline-note">
          Too complex for the simple builder, so it can't be edited here.
          <InfoTip
            text="This condition uses more than the simple builder can show — groups within groups, or one part of an answer — so it is shown in words. Replace it with a simple condition, or remove it."
            label="complex conditions"
          />
        </p>
        <div className="stn-row-actions">
          <Button
            size="sm"
            variant="secondary"
            icon="branch"
            onClick={() => {
              setReplacing(true);
              setState({ join: "all", rows: [emptyRule()] });
            }}
          >
            Replace with a simple condition
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmRemove(true)}>
            Remove condition
          </Button>
        </div>
      </div>
    );
  } else if (!state) {
    body = (
      <div className="stn-cond-none" data-field="displayIf" tabIndex={-1}>
        <p className="stn-cond-sentence">
          <Icon name="branch" size={14} />
          <span>Shown to everyone who reaches {who}.</span>
        </p>
        {earlier.length === 0 ? (
          <p className="stn-inline-note">
            Nothing with an answer is asked before {who}.
            <InfoTip text={`A condition can only use answers given earlier, and nothing with an answer is asked before ${who}.`} label="conditions" />
          </p>
        ) : (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setState({ join: "all", rows: [emptyRule()] })}>
            Add condition
          </Button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="stn-cond" data-field="displayIf">
        {state.rows.length > 1 ? (
          <div className="stn-cond-join">
            <span id={`${headingId}-join`}>Show {who} if</span>
            <Segmented<ConditionJoin>
              label="How the rules combine"
              value={state.join}
              options={[
                { value: "all", label: "All" },
                { value: "any", label: "Any" },
              ]}
              onChange={(join) => update({ ...state, join })}
            />
            <span>of these are true</span>
          </div>
        ) : (
          <p className="stn-cond-join">Show {who} only if</p>
        )}
        <ol className="stn-rules">
          {state.rows.map((row, i) => (
            <RuleEditor
              key={row.id}
              row={row}
              index={i}
              count={state.rows.length}
              earlier={earlier}
              onChange={(next) => update({ ...state, rows: state.rows.map((r) => (r.id === row.id ? next : r)) })}
              onRemove={() => update({ ...state, rows: state.rows.filter((r) => r.id !== row.id) })}
            />
          ))}
        </ol>
        <div className="stn-row-actions">
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setState({ ...state, rows: [...state.rows, emptyRule()] })}>
            Add rule
          </Button>
          {replacing ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setReplacing(false);
                setState(null);
              }}
            >
              Keep the current condition
            </Button>
          ) : null}
        </div>
        {sentence ? (
          <p className="stn-cond-sentence set" aria-live="polite">
            <Icon name="branch" size={14} />
            <span>
              {incomplete ? <span className="stn-cond-pending">Saved so far: </span> : null}
              {sentence}.
            </span>
          </p>
        ) : null}
        {incomplete ? (
          <p className="stn-inline-note">
            {expr ? "The saved condition stays" : "Nothing is saved"} until every rule has a question, a check and an answer.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="stn-condition" role="group" aria-labelledby={headingId}>
      <span id={headingId} className="st-sr">
        Condition for {who}
      </span>
      {body}
      <IssueMessages issues={issues} />
      {confirmRemove ? (
        <ConfirmDialog
          title="Remove this condition?"
          body={<p className="stn-flush">{`${who[0]!.toUpperCase()}${who.slice(1)} will be shown to everyone who reaches it. You can undo this.`}</p>}
          confirmLabel="Remove condition"
          destructive
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            written.current = undefined;
            if (!onWrite(null)) written.current = expr;
            else setState(null);
          }}
        />
      ) : null}
    </div>
  );
}

function RuleEditor({
  row,
  index,
  count,
  earlier,
  onChange,
  onRemove,
}: {
  row: RuleRow;
  index: number;
  count: number;
  earlier: EarlierQuestion[];
  onChange: (row: RuleRow) => void;
  onRemove: () => void;
}) {
  const { draft } = useEditor();
  const base = useId();
  const problemId = `${base}-problem`;
  const target = earlier.find((q) => q.itemKey === row.itemKey) ?? null;
  const problem = ruleProblem(row);
  const kind = valueInput(row);
  const tests: ConditionTest[] = target ? [...target.tests] : [];
  if (row.test && !tests.includes(row.test)) tests.push(row.test);
  const options = row.itemKey ? optionChoices(draft, row.itemKey) : [];
  const sections = groupBySection(earlier);
  const name = `Rule ${index + 1}${count > 1 ? ` of ${count}` : ""}`;

  return (
    // REVIEW FIX: the group is inside the list item, not on it — `<li role="group">`
    // stopped the rules being read as a list ("Rule 2 of 3" with no list around it).
    <li className="stn-rule">
      <div role="group" aria-label={name} aria-describedby={problem ? problemId : undefined}>
      <div className="stn-rule-fields">
        <select
          className="st-select stn-rule-question"
          aria-label={`${name}: question`}
          value={row.itemKey}
          onChange={(e) => {
            const q = earlier.find((x) => x.itemKey === e.target.value);
            if (q) onChange(row.itemKey ? retarget(draft, row, q) : ruleFor(draft, q));
          }}
        >
          <option value="" disabled>
            Choose an earlier question…
          </option>
          {row.itemKey && !target ? <option value={row.itemKey}>{row.itemKey} (not asked before this — choose another)</option> : null}
          {sections.map((s) => (
            <optgroup key={s.sectionKey} label={s.title}>
              {s.questions.map((q) => (
                <option key={q.itemKey} value={q.itemKey}>
                  {q.number}. {q.text}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          className="st-select stn-rule-test"
          aria-label={`${name}: check`}
          value={row.test}
          disabled={!row.itemKey}
          onChange={(e) => onChange(withTest(draft, row, e.target.value as ConditionTest))}
        >
          <option value="" disabled>
            Choose a check…
          </option>
          {tests.map((t) => (
            <option key={t} value={t}>
              {testLabel(t, target?.responseType)}
            </option>
          ))}
        </select>
        {kind === "option" ? (
          <select
            className="st-select stn-rule-value"
            aria-label={`${name}: option`}
            value={row.code === null ? "" : String(row.code)}
            onChange={(e) => onChange({ ...row, code: e.target.value === "" ? null : Number(e.target.value) })}
          >
            <option value="" disabled>
              Choose an option…
            </option>
            {row.code !== null && !options.some((o) => o.code === row.code) ? (
              <option value={String(row.code)}>Option {row.code} (no longer in the list)</option>
            ) : null}
            {options.map((o) => (
              <option key={o.code} value={String(o.code)}>
                {o.label}
              </option>
            ))}
          </select>
        ) : kind === "number" || kind === "text" ? (
          <input
            className="st-input stn-rule-value"
            aria-label={`${name}: ${kind === "number" ? "number" : "answer"}`}
            inputMode={kind === "number" ? "decimal" : undefined}
            value={row.value}
            onChange={(e) => onChange({ ...row, value: e.target.value })}
          />
        ) : null}
        <IconButton icon="trash" size="sm" label={`Remove ${name.toLowerCase()}`} onClick={onRemove} />
      </div>
      {problem ? (
        <p id={problemId} className="stn-rule-problem">
          Not saved yet: {problem}
        </p>
      ) : null}
      </div>
    </li>
  );
}

function groupBySection(questions: EarlierQuestion[]): { sectionKey: string; title: string; questions: EarlierQuestion[] }[] {
  const out: { sectionKey: string; title: string; questions: EarlierQuestion[] }[] = [];
  for (const q of questions) {
    let group = out[out.length - 1];
    if (!group || group.sectionKey !== q.sectionKey) {
      group = { sectionKey: q.sectionKey, title: q.sectionTitle, questions: [] };
      out.push(group);
    }
    group.questions.push(q);
  }
  return out;
}
