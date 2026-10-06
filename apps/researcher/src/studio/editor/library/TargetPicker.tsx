import { useId } from "react";
import { shortText, type Outline } from "@myself/studio";
import type { TargetChoice } from "./model.js";

const NEW = "__new__";

/**
 * Where the piece goes: into a section, after one of its questions or at its
 * end, or as a new section. MyStory's section is never offered (it is always
 * last), and the model puts a new section before it and never before the
 * consent module.
 */
export function TargetPicker({
  o,
  value,
  onChange,
  defaultTitle,
  disabled,
}: {
  o: Outline;
  value: TargetChoice;
  onChange: (next: TargetChoice) => void;
  /** The title a new section starts with: the piece's own. */
  defaultTitle: string;
  disabled?: boolean;
}) {
  const whereId = useId();
  const posId = useId();
  const titleId = useId();
  const section = value.kind === "section" ? o.sections.find((s) => s.key === value.sectionKey) : null;
  const questions = section?.blocks.flatMap((b) => b.questions) ?? [];

  return (
    <div className="stl-target" role="group" aria-label="Where it goes">
      <div className="stl-target-field">
        <label htmlFor={whereId} className="st-field-label">
          Add to
        </label>
        <select
          id={whereId}
          className="st-select"
          disabled={disabled}
          value={value.kind === "section" ? value.sectionKey : NEW}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW) {
              const after = value.kind === "section" ? o.sections.find((s) => s.key === value.sectionKey)?.index : undefined;
              onChange({ kind: "new", title: defaultTitle, index: after === undefined ? null : after + 1 });
            } else onChange({ kind: "section", sectionKey: v, afterItemKey: null });
          }}
        >
          {o.sections.map((s) => (
            <option key={s.key} value={s.key}>
              {s.title || "Untitled section"}
            </option>
          ))}
          <option value={NEW}>A new section…</option>
        </select>
      </div>
      {value.kind === "section" ? (
        <div className="stl-target-field">
          <label htmlFor={posId} className="st-field-label">
            Position
          </label>
          <select
            id={posId}
            className="st-select"
            disabled={disabled}
            value={value.afterItemKey ?? ""}
            onChange={(e) => onChange({ ...value, afterItemKey: e.target.value || null })}
          >
            <option value="">At the end of the section</option>
            {questions.map((q) => (
              <option key={q.itemKey} value={q.itemKey}>
                After “{shortText(q.text || q.itemKey, 50)}”
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="stl-target-field">
          <label htmlFor={titleId} className="st-field-label">
            New section’s title
          </label>
          <input
            id={titleId}
            className="st-input"
            disabled={disabled}
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
            autoComplete="off"
          />
        </div>
      )}
    </div>
  );
}
