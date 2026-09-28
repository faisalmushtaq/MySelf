import { useCallback, useId, type ReactNode } from "react";
import type { ItemDefinition } from "@myself/schema";
import { findQuestion, uniqueSlug, updateQuestion, type Issue, type QuestionPatch } from "@myself/studio";
import { Button, IconButton } from "../../ui/kit.js";
import { useEditor } from "../context.js";
import { IssueMessages, useSyncedText } from "./controls.js";
import { focusSoon } from "./focus.js";

/**
 * The lists some question types carry besides options: consent statements,
 * the boxes of a form, the groups of a sort. Each row's key is what the data
 * records, so it is shown and never changed; its words and settings can be.
 *
 * Every change rebuilds the list from the draft the operation is given, never
 * from what this component last rendered, so two quick edits cannot undo each
 * other.
 */

type Statement = Extract<ItemDefinition, { responseType: "checkbox_set" }>["statements"][number];
type FormField = Extract<ItemDefinition, { responseType: "form_fields" }>["fields"][number];
type Group = Extract<ItemDefinition, { responseType: "rank_group" }>["groups"][number];

/** Apply a change to one of a question's lists, reading the list from the draft being changed. */
function useListWriter<K extends "statements" | "fields" | "groups", T>(itemKey: string, field: K, label: string) {
  const ctx = useEditor();
  return useCallback(
    (change: (list: T[]) => T[]) =>
      ctx.run(label, (d) => {
        const item = findQuestion(d, itemKey)?.item as Record<string, unknown> | undefined;
        const list = (item?.[field] as T[] | undefined) ?? [];
        return updateQuestion(d, itemKey, { [field]: change(structuredClone(list)) } as QuestionPatch).draft;
      }),
    [ctx, itemKey, field, label],
  );
}

function RowControls({
  index,
  count,
  noun,
  min,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  noun: string;
  min: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="stn-list-controls">
      <IconButton icon="arrow-up" size="sm" label={`Move ${noun} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index - 1)} />
      <IconButton icon="arrow-down" size="sm" label={`Move ${noun} ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)} />
      <IconButton
        icon="trash"
        size="sm"
        variant="danger"
        label={count <= min ? `Can't remove ${noun} ${index + 1}: at least ${min} needed` : `Remove ${noun} ${index + 1}`}
        aria-disabled={count <= min ? true : undefined}
        onClick={() => {
          if (count > min) onRemove();
        }}
      />
    </div>
  );
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [x] = next.splice(from, 1);
  if (x !== undefined) next.splice(to, 0, x);
  return next;
}

/** A text box in a list row that writes as it is typed. */
function RowText({
  value,
  onCommit,
  label,
  multiline,
  part,
  required,
  describedBy,
}: {
  value: string;
  onCommit: (text: string) => void;
  label: string;
  multiline?: boolean;
  part: string;
  required?: string;
  describedBy?: string;
}) {
  const validate = useCallback((t: string) => (required && !t.trim() ? required : null), [required]);
  const synced = useSyncedText(value, onCommit, validate);
  return (
    <>
      {multiline ? (
        <textarea className="st-input stn-list-text" rows={2} data-part={part} aria-label={label} aria-describedby={describedBy} {...synced.bind} />
      ) : (
        <input className="st-input" data-part={part} aria-label={label} aria-describedby={describedBy} autoComplete="off" {...synced.bind} />
      )}
      {synced.localError ? <IssueMessages local={synced.localError} /> : null}
    </>
  );
}

function ListFrame({ field, issues, children, footer }: { field: string; issues: readonly Issue[] | undefined; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="stn-list" data-field={field} tabIndex={-1}>
      <ol className="stn-list-rows">{children}</ol>
      <IssueMessages issues={issues} />
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consent statements
// ---------------------------------------------------------------------------

export function StatementsEditor({ itemKey, statements, editable, issues }: { itemKey: string; statements: Statement[]; editable: boolean; issues?: readonly Issue[] | undefined }) {
  const write = useListWriter<"statements", Statement>(itemKey, "statements", `Edit the statements of ${itemKey}`);
  const hintId = useId();
  if (!editable) {
    return (
      <ListFrame field="statements" issues={issues}>
        {statements.map((s) => (
          <li key={s.key} className="stn-list-row readonly" data-row-key={s.key}>
            <span className="stn-tick" aria-hidden="true" />
            <div className="stn-list-main">
              <p className="stn-flush stn-prewrap">{s.text.text}</p>
              <p className="stn-list-meta">
                {s.required === false ? "Optional to tick" : "Must be ticked to continue"} · Stored as <code>{s.key}</code>
              </p>
            </div>
          </li>
        ))}
      </ListFrame>
    );
  }
  const add = () => {
    const taken = new Set(statements.map((s) => s.key));
    const key = uniqueSlug("statement", taken, 64);
    if (write((list) => [...list, { key, text: { text: "New statement" }, required: true }])) {
      focusSoon(`[data-field="statements"] [data-row-key="${key}"] [data-part="text"]`, { select: true });
    }
  };
  return (
    <ListFrame
      field="statements"
      issues={issues}
      footer={
        <div className="stn-row-actions">
          <Button size="sm" icon="plus" onClick={add}>
            Add a statement
          </Button>
          <span id={hintId} className="stn-hint">
            Each statement's ID is how its tick is stored, so it stays the same when the words change.
          </span>
        </div>
      }
    >
      {statements.map((s, i) => (
        <li key={s.key} className="stn-list-row" data-row-key={s.key}>
          <span className="stn-tick" aria-hidden="true" />
          <div className="stn-list-main">
            <RowText
              value={s.text.text}
              multiline
              part="text"
              label={`Statement ${i + 1}`}
              describedBy={hintId}
              required="A statement needs some text. The last text is kept until you type some."
              onCommit={(text) => write((list) => list.map((x) => (x.key === s.key ? { ...x, text: { ...x.text, text } } : x)))}
            />
            <div className="stn-list-meta">
              <label className="stn-inline-check">
                <input
                  type="checkbox"
                  checked={s.required !== false}
                  onChange={(e) => write((list) => list.map((x) => (x.key === s.key ? { ...x, required: e.target.checked } : x)))}
                />
                Must be ticked to continue
              </label>
              <span>
                Stored as <code>{s.key}</code>
              </span>
            </div>
          </div>
          <RowControls
            index={i}
            count={statements.length}
            noun="statement"
            min={1}
            onMove={(to) => {
              if (write((list) => move(list, i, to))) focusSoon(`[data-row-key="${s.key}"] [data-part="text"]`);
            }}
            onRemove={() => write((list) => list.filter((x) => x.key !== s.key))}
          />
        </li>
      ))}
    </ListFrame>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function FieldsEditor({ itemKey, fields, editable, issues }: { itemKey: string; fields: FormField[]; editable: boolean; issues?: readonly Issue[] | undefined }) {
  const write = useListWriter<"fields", FormField>(itemKey, "fields", `Edit the boxes of ${itemKey}`);
  if (!editable) {
    return (
      <ListFrame field="fields" issues={issues}>
        {fields.map((f) => (
          <li key={f.key} className="stn-list-row readonly" data-row-key={f.key}>
            <div className="stn-list-main">
              <p className="stn-flush">{f.label}</p>
              <p className="stn-list-meta">
                {f.kind === "numeric" ? "Number" : "Text"} · {f.required ? "Must be filled in" : "Optional"} · up to {f.maxChars ?? 100}{" "}
                characters · Stored as <code>{f.key}</code>
              </p>
            </div>
          </li>
        ))}
      </ListFrame>
    );
  }
  const add = () => {
    const key = uniqueSlug("field", new Set(fields.map((f) => f.key)), 64);
    if (write((list) => [...list, { key, label: "New box", kind: "text", required: false, maxChars: 100 }])) {
      focusSoon(`[data-field="fields"] [data-row-key="${key}"] [data-part="label"]`, { select: true });
    }
  };
  return (
    <ListFrame
      field="fields"
      issues={issues}
      footer={
        <div className="stn-row-actions">
          <Button size="sm" icon="plus" onClick={add}>
            Add a box
          </Button>
        </div>
      }
    >
      {fields.map((f, i) => (
        <li key={f.key} className="stn-list-row" data-row-key={f.key}>
          <div className="stn-list-main">
            <RowText
              value={f.label}
              part="label"
              label={`Label of box ${i + 1}`}
              required="A box needs a label. The last label is kept until you type one."
              onCommit={(label) => write((list) => list.map((x) => (x.key === f.key ? { ...x, label } : x)))}
            />
            <div className="stn-list-meta">
              <select
                className="stn-kind-select"
                aria-label={`What box ${i + 1} takes`}
                value={f.kind ?? "text"}
                onChange={(e) => write((list) => list.map((x) => (x.key === f.key ? { ...x, kind: e.target.value as "text" | "numeric" } : x)))}
              >
                <option value="text">Text</option>
                <option value="numeric">Number</option>
              </select>
              <label className="stn-inline-check">
                <input
                  type="checkbox"
                  checked={f.required ?? false}
                  onChange={(e) => write((list) => list.map((x) => (x.key === f.key ? { ...x, required: e.target.checked } : x)))}
                />
                Must be filled in
              </label>
              <span>
                Stored as <code>{f.key}</code>
              </span>
            </div>
          </div>
          <RowControls
            index={i}
            count={fields.length}
            noun="box"
            min={1}
            onMove={(to) => write((list) => move(list, i, to))}
            onRemove={() => write((list) => list.filter((x) => x.key !== f.key))}
          />
        </li>
      ))}
    </ListFrame>
  );
}

// ---------------------------------------------------------------------------
// Groups of a sort
// ---------------------------------------------------------------------------

export function GroupsEditor({ itemKey, groups, editable, issues }: { itemKey: string; groups: Group[]; editable: boolean; issues?: readonly Issue[] | undefined }) {
  const write = useListWriter<"groups", Group>(itemKey, "groups", `Edit the groups of ${itemKey}`);
  if (!editable) {
    return (
      <ListFrame field="groups" issues={issues}>
        {groups.map((g) => (
          <li key={g.key} className="stn-list-row readonly" data-row-key={g.key}>
            <div className="stn-list-main">
              <p className="stn-flush">{g.label}</p>
              <p className="stn-list-meta">
                {g.ranked ? "Ranked within the group" : "Not ranked"} · Stored as <code>{g.key}</code>
              </p>
            </div>
          </li>
        ))}
      </ListFrame>
    );
  }
  const add = () => {
    const key = uniqueSlug("group", new Set(groups.map((g) => g.key)), 64);
    if (write((list) => [...list, { key, label: "New group", ranked: false }])) {
      focusSoon(`[data-field="groups"] [data-row-key="${key}"] [data-part="label"]`, { select: true });
    }
  };
  return (
    <ListFrame
      field="groups"
      issues={issues}
      footer={
        <div className="stn-row-actions">
          <Button size="sm" icon="plus" onClick={add}>
            Add a group
          </Button>
        </div>
      }
    >
      {groups.map((g, i) => (
        <li key={g.key} className="stn-list-row" data-row-key={g.key}>
          <div className="stn-list-main">
            <RowText
              value={g.label}
              part="label"
              label={`Name of group ${i + 1}`}
              required="A group needs a name. The last name is kept until you type one."
              onCommit={(label) => write((list) => list.map((x) => (x.key === g.key ? { ...x, label } : x)))}
            />
            <div className="stn-list-meta">
              <label className="stn-inline-check">
                <input
                  type="checkbox"
                  checked={g.ranked ?? false}
                  onChange={(e) => write((list) => list.map((x) => (x.key === g.key ? { ...x, ranked: e.target.checked } : x)))}
                />
                Participants rank the options in this group
              </label>
              <span>
                Stored as <code>{g.key}</code>
              </span>
            </div>
          </div>
          <RowControls
            index={i}
            count={groups.length}
            noun="group"
            min={2}
            onMove={(to) => write((list) => move(list, i, to))}
            onRemove={() => write((list) => list.filter((x) => x.key !== g.key))}
          />
        </li>
      ))}
    </ListFrame>
  );
}
