import { useEffect, useMemo, useRef, useState } from "react";
import type { AnswerValue } from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";

/**
 * Response controls. One component per response type, all sharing the same
 * contract: current value in, complete value out via onAnswer. Visual and
 * behavioural consistency across the survey is a design principle — these are
 * the ONLY renderings of each response type.
 */

export interface ControlProps {
  item: ItemDefinition;
  scale?: ResponseScale | undefined;
  value?: AnswerValue | undefined;
  onAnswer: (value: AnswerValue, autoAdvance: boolean) => void;
}

const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function SingleChoice({ item, scale, value, onAnswer }: ControlProps) {
  if (item.responseType !== "single_choice" || !scale) return null;
  const selected = value?.kind === "choice" ? value.code : undefined;
  const auto = item.autoAdvance && !prefersReducedMotion();
  const asPicker = item.presentation !== "cards" || scale.options.length > 12;

  if (asPicker) {
    return (
      <select
        className="picker"
        aria-label={item.stem.text}
        value={selected ?? ""}
        onChange={(e) => {
          if (e.target.value === "") return;
          onAnswer({ kind: "choice", code: Number(e.target.value) }, false);
        }}
      >
        <option value="" disabled>
          Choose…
        </option>
        {scale.options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="cards" role="radiogroup" aria-label={item.stem.text}>
      {scale.options.map((o) => (
        <button
          key={o.code}
          type="button"
          role="radio"
          aria-checked={selected === o.code}
          className={`card${selected === o.code ? " selected" : ""}${o.kind !== "substantive" ? " quiet" : ""}`}
          onClick={() => onAnswer({ kind: "choice", code: o.code }, auto)}
        >
          <span className="card-label">{o.label}</span>
          {selected === o.code && <span className="tick" aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
}

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
          {selected.length} of up to {max} selected
        </p>
      )}
      {scale.options.map((o) => (
        <button
          key={o.code}
          type="button"
          role="checkbox"
          aria-checked={selected.includes(o.code)}
          className={`card${selected.includes(o.code) ? " selected" : ""}`}
          onClick={() => toggle(o.code)}
        >
          <span className="card-label">{o.label}</span>
          {selected.includes(o.code) && <span className="tick" aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
}

export function SliderControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "slider") return null;
  const current = value?.kind === "number" ? value.value : undefined;
  const [touched, setTouched] = useState(current !== undefined);
  const display = current ?? Math.round((item.min + item.max) / 2);
  return (
    <div className="slider-wrap">
      <div className="slider-labels">
        <span>{item.minLabel ?? item.min}</span>
        <span>{item.maxLabel ?? item.max}</span>
      </div>
      <input
        type="range"
        min={item.min}
        max={item.max}
        step={item.step}
        value={display}
        aria-label={item.stem.text}
        onChange={(e) => {
          setTouched(true);
          onAnswer({ kind: "number", value: Number(e.target.value) }, false);
        }}
      />
      <output className="slider-value" aria-live="polite">
        {touched && item.showValue ? display : "—"}
      </output>
    </div>
  );
}

export function LadderControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "ladder") return null;
  const selected = value?.kind === "number" ? value.value : undefined;
  const rungs = Array.from({ length: item.rungs }, (_, i) => item.lowestValue + item.rungs - 1 - i);
  return (
    <div className="ladder" role="radiogroup" aria-label={item.stem.text}>
      {rungs.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={selected === r}
          aria-label={`Rung ${r} of ${item.lowestValue + item.rungs - 1}`}
          className={`rung${selected === r ? " selected" : ""}`}
          onClick={() => onAnswer({ kind: "number", value: r }, false)}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export function NumericControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "numeric") return null;
  const current = value?.kind === "number" ? String(value.value) : "";
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(current), [current]);

  const commit = (raw: string) => {
    setText(raw);
    if (raw.trim() === "") return;
    const n = Number(raw);
    if (Number.isNaN(n) || (item.integerOnly && !Number.isInteger(n))) {
      setError("Please enter a whole number");
      return;
    }
    if ((item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max)) {
      setError(`Please enter a number between ${item.min ?? "0"} and ${item.max ?? "∞"}`);
      return;
    }
    setError(null);
    onAnswer({ kind: "number", value: n }, false);
  };

  return (
    <div className="numeric-wrap">
      <input
        type="number"
        inputMode="numeric"
        className="text-input numeric"
        value={text}
        aria-label={item.stem.text}
        aria-invalid={error !== null}
        onChange={(e) => commit(e.target.value)}
      />
      {item.unitLabel && <span className="unit">{item.unitLabel}</span>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function DateControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "date") return null;
  const current = value?.kind === "date" ? value.iso : "";
  return (
    <input
      type="date"
      className="text-input"
      value={current}
      aria-label={item.stem.text}
      min={item.minYear ? `${item.minYear}-01-01` : undefined}
      max={item.maxYear ? `${item.maxYear}-12-31` : undefined}
      onChange={(e) => {
        if (e.target.value) onAnswer({ kind: "date", iso: e.target.value }, false);
      }}
    />
  );
}

export function TextControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "text_short" && item.responseType !== "text_long") return null;
  const current = value?.kind === "text" ? value.value : "";
  const [text, setText] = useState(current);
  const long = item.responseType === "text_long";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = (raw: string) => {
    setText(raw);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (raw.trim().length > 0) onAnswer({ kind: "text", value: raw }, false);
    }, 400); // debounce keystrokes; every commit is still an autosaved event
  };

  return (
    <div className="text-wrap">
      {long ? (
        <textarea
          className="text-input long"
          value={text}
          maxLength={item.maxChars}
          aria-label={item.stem.text}
          onChange={(e) => commit(e.target.value)}
          rows={6}
        />
      ) : (
        <input
          type="text"
          className="text-input"
          value={text}
          maxLength={item.maxChars}
          aria-label={item.stem.text}
          onChange={(e) => commit(e.target.value)}
        />
      )}
      {long && item.maxChars < 100000 && (
        <p className="hint">
          {text.length} / {item.maxChars}
        </p>
      )}
    </div>
  );
}

export function FormFieldsControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "form_fields") return null;
  const current = value?.kind === "fields" ? value.values : {};
  const [values, setValues] = useState<Record<string, string>>(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = (key: string, v: string) => {
    const next = { ...values, [key]: v };
    setValues(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (Object.values(next).some((x) => x.trim().length > 0)) onAnswer({ kind: "fields", values: next }, false);
    }, 400);
  };

  return (
    <div className="fields">
      {item.fields.map((f) => (
        <label key={f.key} className="field">
          <span className="field-label">{f.label}</span>
          <input
            type={f.kind === "numeric" ? "number" : "text"}
            className="text-input"
            maxLength={f.maxChars}
            value={values[f.key] ?? ""}
            onChange={(e) => commit(f.key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

/** Two-step group + rank (documented small-screen alternative to drag — docs/04 P3). */
export function RankGroupControl({ item, scale, value, onAnswer }: ControlProps) {
  if (item.responseType !== "rank_group" || !scale) return null;
  const rankedGroup = item.groups.find((g) => g.ranked) ?? item.groups[0]!;
  const otherGroup = item.groups.find((g) => g.key !== rankedGroup.key)!;

  const assignments = useMemo(
    () => (value?.kind === "group_rank" ? value.assignments : {}),
    [value],
  );
  const inRanked = scale.options
    .filter((o) => assignments[o.code]?.group === rankedGroup.key)
    .sort((a, b) => (assignments[a.code]?.rank ?? 0) - (assignments[b.code]?.rank ?? 0));

  const emit = (next: Record<number, { group: string; rank?: number }>) => {
    // Complete the assignment: unassigned options implicitly go to the other group.
    const full: Record<number, { group: string; rank?: number }> = {};
    for (const o of scale.options) full[o.code] = next[o.code] ?? { group: otherGroup.key };
    onAnswer({ kind: "group_rank", assignments: full }, false);
  };

  const toggle = (code: number) => {
    const next = { ...assignments };
    if (next[code]?.group === rankedGroup.key) {
      next[code] = { group: otherGroup.key };
      // re-rank remaining
      let rank = 1;
      for (const o of inRanked.filter((x) => x.code !== code)) next[o.code] = { group: rankedGroup.key, rank: rank++ };
    } else {
      next[code] = { group: rankedGroup.key, rank: inRanked.length + 1 };
    }
    emit(next);
  };

  const move = (code: number, dir: -1 | 1) => {
    const order = inRanked.map((o) => o.code);
    const i = order.indexOf(code);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
    const next = { ...assignments };
    order.forEach((c, idx) => (next[c] = { group: rankedGroup.key, rank: idx + 1 }));
    emit(next);
  };

  return (
    <div className="rank-group">
      <p className="hint">Step 1 — tap everything that applies to “{rankedGroup.label}”.</p>
      <div className="chips" role="group">
        {scale.options.map((o) => {
          const on = assignments[o.code]?.group === rankedGroup.key;
          return (
            <button key={o.code} type="button" aria-pressed={on} className={`chip${on ? " on" : ""}`} onClick={() => toggle(o.code)}>
              {o.label}
            </button>
          );
        })}
      </div>
      {inRanked.length > 1 && (
        <>
          <p className="hint">Step 2 — order them from most used (top) to least used.</p>
          <ol className="rank-list">
            {inRanked.map((o) => (
              <li key={o.code} className="rank-item">
                <span>{o.label}</span>
                <span className="rank-buttons">
                  <button type="button" aria-label={`Move ${o.label} up`} onClick={() => move(o.code, -1)}>
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${o.label} down`} onClick={() => move(o.code, 1)}>
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function CheckboxSetControl({ item, value, onAnswer }: ControlProps) {
  if (item.responseType !== "checkbox_set") return null;
  const checked = value?.kind === "checkboxes" ? value.checked : [];
  const toggle = (key: string) => {
    const next = checked.includes(key) ? checked.filter((k) => k !== key) : [...checked, key];
    onAnswer({ kind: "checkboxes", checked: next }, false);
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
