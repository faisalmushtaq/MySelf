import { prefersReducedMotion, type ControlProps } from "./shared.js";

export function CheckboxSetControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "checkbox_set") return null;
  const checked = value?.kind === "checkboxes" ? value.checked : [];
  const required = item.statements.filter((s) => s.required).map((s) => s.key);
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
  };
  return (
    <div className="consent-list">
      {item.statements.map((s) => (
        <label key={s.key} className={`consent-item${checked.includes(s.key) ? " on" : ""}`}>
          <input type="checkbox" checked={checked.includes(s.key)} onChange={() => toggle(s.key)} />
          <span>{s.text.text}</span>
        </label>
      ))}
    </div>
  );
}
