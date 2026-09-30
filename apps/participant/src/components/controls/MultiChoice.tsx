import type { ControlProps } from "./shared.js";

export function MultiChoice({ item, scale, value, onAnswer }: ControlProps) {
  if (item.responseType !== "multi_choice" || !scale) return null;
  const selected = value?.kind === "multi" ? value.codes : [];
  const max = item.maxSelections;

  const toggle = (code: number) => {
    const next = selected.includes(code) ? selected.filter((c) => c !== code) : [...selected, code];
    if (max !== undefined && next.length > max) return;
    onAnswer({ kind: "multi", codes: next }, false);
  };

  return (
    <div className="cards" role="group" aria-label={item.stem.text}>
      {max !== undefined && (
        <p className="hint" aria-live="polite">
          Choose up to {max} — {selected.length} selected
        </p>
      )}
      {scale.options.map((o) => {
        const on = selected.includes(o.code);
        return (
          <button
            key={o.code}
            type="button"
            role="checkbox"
            aria-checked={on}
            className={`card${on ? " selected" : ""}`}
            onClick={() => toggle(o.code)}
          >
            <span className="card-label">{o.label}</span>
            {on && (
              <span className="tick" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
