import { useState } from "react";
import { prefersReducedMotion, type ControlProps } from "./shared.js";

/**
 * More statements than this are shown one at a time (D-100). A long consent set
 * as one list is taller than an iPad screen, so a participant had to scroll
 * before they could start; one statement at a time always fits, and each tick
 * moves straight on to the next.
 */
export const ONE_AT_A_TIME_ABOVE = 3;

export function CheckboxSetControl({ item, value, onAnswer }: ControlProps) {
  const statements = item.responseType === "checkbox_set" ? item.statements : [];
  const checked = value?.kind === "checkboxes" ? value.checked : [];
  // Open on the first statement still to tick; on a finished set, the last.
  const [at, setAt] = useState(() => {
    const first = statements.findIndex((s) => !checked.includes(s.key));
    return first === -1 ? Math.max(0, statements.length - 1) : first;
  });
  if (item.responseType !== "checkbox_set") return null;
  const required = statements.filter((s) => s.required).map((s) => s.key);
  const paged = statements.length > ONE_AT_A_TIME_ABOVE;

  const toggle = (key: string) => {
    const next = checked.includes(key) ? checked.filter((k) => k !== key) : [...checked, key];
    // Only the tick that completes the set moves on (D-53): coming back to a
    // finished set, or unticking and reticking, does not throw anyone forward
    // unasked. The pause lets the last tick be seen landing.
    const completes =
      item.autoAdvance === true &&
      !prefersReducedMotion() &&
      !checked.includes(key) &&
      required.every((k) => next.includes(k)) &&
      !required.every((k) => checked.includes(k));
    onAnswer({ kind: "checkboxes", checked: next }, completes ? { afterMs: 450 } : false);
    // One at a time: a tick goes on to the next statement still to tick.
    if (paged && !checked.includes(key)) {
      const after = statements.findIndex((s, i) => i > at && !next.includes(s.key));
      const any = statements.findIndex((s) => !next.includes(s.key));
      if (after !== -1) setAt(after);
      else if (any !== -1) setAt(any);
    }
  };

  const row = (s: (typeof statements)[number]) => (
    <label key={s.key} className={`consent-item${checked.includes(s.key) ? " on" : ""}`}>
      <input type="checkbox" checked={checked.includes(s.key)} onChange={() => toggle(s.key)} />
      <span>{s.text.text}</span>
    </label>
  );

  if (!paged) return <div className="consent-list">{statements.map(row)}</div>;

  const current = statements[Math.min(at, statements.length - 1)]!;
  return (
    <div className="consent-list paged">
      <p className="consent-count" aria-live="polite">
        Statement {at + 1} of {statements.length}
      </p>
      <div className="consent-current" key={current.key}>
        {row(current)}
      </div>
      <div className="consent-steps" aria-hidden="true">
        {statements.map((s, i) => (
          <span
            key={s.key}
            className={`consent-step${checked.includes(s.key) ? " on" : ""}${i === at ? " here" : ""}`}
          />
        ))}
      </div>
      <div className="consent-nav">
        {at > 0 && (
          <button type="button" className="consent-prev" onClick={() => setAt(at - 1)}>
            ‹ Previous statement
          </button>
        )}
        {at < statements.length - 1 && checked.includes(current.key) && (
          <button type="button" className="consent-fwd" onClick={() => setAt(at + 1)}>
            Next statement ›
          </button>
        )}
      </div>
    </div>
  );
}
