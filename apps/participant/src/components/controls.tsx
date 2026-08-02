import { useEffect, useMemo, useRef, useState } from "react";
import { Illustration } from "./illustrations.js";
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

  // Illustrated grid: participants choose by looking, not by reading a code.
  if (item.presentation === "grid") {
    return (
      <div className="tile-grid" role="radiogroup" aria-label={item.stem.text}>
        {scale.options.map((o) => (
          <button
            key={o.code}
            type="button"
            role="radio"
            aria-checked={selected === o.code}
            aria-label={o.description ? `${o.label} — ${o.description}` : o.label}
            className={`tile${selected === o.code ? " selected" : ""}`}
            onClick={() => onAnswer({ kind: "choice", code: o.code }, auto)}
          >
            <span className="tile-art">{o.illustration && <Illustration token={o.illustration} />}</span>
            <span className="tile-label">{o.label}</span>
            {o.description && <span className="tile-desc">{o.description}</span>}
          </button>
        ))}
      </div>
    );
  }

  const asPicker = item.presentation === "dropdown" || item.presentation === "wheel" || scale.options.length > 12;

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
          {selected === o.code && (
            <span className="tick" aria-hidden="true">
              ✓
            </span>
          )}
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

/**
 * MacArthur ladder: an actual drawn ladder the participant taps — or drags a
 * finger up and down — rather than an abstract slider. The metaphor is the
 * instrument, so the picture is the control. Anchor labels sit at each end so
 * no explanation is needed, and arrow keys move a rung at a time.
 */
export function LadderControl({ item, value, onAnswer }: ControlProps) {
  const dragging = useRef(false);
  if (item.responseType !== "ladder") return null;

  const top = item.lowestValue + item.rungs - 1;
  const selected = value?.kind === "number" ? value.value : undefined;
  const rungs = Array.from({ length: item.rungs }, (_, i) => top - i); // top-down

  const RUNG_H = 44;
  const PAD = 14;
  const W = 260;
  const H = item.rungs * RUNG_H + PAD * 2;
  const railInset = 34;

  const valueFromY = (clientY: number, el: SVGSVGElement): number => {
    const box = el.getBoundingClientRect();
    const y = ((clientY - box.top) / box.height) * H;
    const idx = Math.floor((y - PAD) / RUNG_H);
    return Math.min(top, Math.max(item.lowestValue, top - Math.min(item.rungs - 1, Math.max(0, idx))));
  };

  const pick = (v: number) => {
    if (v !== selected) onAnswer({ kind: "number", value: v }, false);
  };

  return (
    <div className="ladder-wrap">
      {item.topLabel && <p className="ladder-anchor top">{item.topLabel}</p>}
      <svg
        className="ladder-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W }}
        role="slider"
        tabIndex={0}
        aria-label={item.stem.text}
        aria-valuemin={item.lowestValue}
        aria-valuemax={top}
        aria-valuenow={selected ?? undefined}
        aria-valuetext={selected === undefined ? "No rung chosen yet" : `Rung ${selected} of ${top}`}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(valueFromY(e.clientY, e.currentTarget));
        }}
        onPointerMove={(e) => {
          if (dragging.current) pick(valueFromY(e.clientY, e.currentTarget));
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          const cur = selected ?? item.lowestValue - 1 + Math.ceil(item.rungs / 2);
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault();
            pick(Math.min(top, cur + 1));
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault();
            pick(Math.max(item.lowestValue, cur - 1));
          }
        }}
      >
        {/* rails */}
        <line x1={railInset} y1={PAD} x2={railInset} y2={H - PAD} className="ladder-rail" />
        <line x1={W - railInset} y1={PAD} x2={W - railInset} y2={H - PAD} className="ladder-rail" />
        {rungs.map((r, i) => {
          const cy = PAD + i * RUNG_H + RUNG_H / 2;
          const on = selected === r;
          return (
            <g key={r} className={`ladder-rung${on ? " selected" : ""}`}>
              {on && (
                <rect
                  x={railInset - 12}
                  y={cy - RUNG_H / 2 + 3}
                  width={W - railInset * 2 + 24}
                  height={RUNG_H - 6}
                  rx={6}
                  className="ladder-highlight"
                />
              )}
              <line x1={railInset} y1={cy} x2={W - railInset} y2={cy} className="ladder-step" />
              <text x={W / 2} y={cy} className="ladder-number" textAnchor="middle" dominantBaseline="central">
                {r}
              </text>
            </g>
          );
        })}
      </svg>
      {item.bottomLabel && <p className="ladder-anchor bottom">{item.bottomLabel}</p>}
      <p className="ladder-status" aria-live="polite">
        {selected === undefined ? "Tap a rung on the ladder" : `You chose rung ${selected}`}
      </p>
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
  const pending = useRef<string | null>(null);

  const commit = (raw: string) => {
    setText(raw);
    pending.current = raw;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      if (raw.trim().length > 0) onAnswer({ kind: "text", value: raw }, false);
    }, 400); // debounce keystrokes; every commit is still an autosaved event
  };

  // Flush on unmount so advancing before the debounce elapses never drops the
  // last keystrokes. The captured onAnswer belongs to this item, so the value
  // is always recorded against the question it was typed for.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const raw = pending.current;
      if (raw !== null && raw.trim().length > 0) onAnswer({ kind: "text", value: raw }, false);
    },
    [],
  );

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
  const pending = useRef<Record<string, string> | null>(null);

  const commit = (key: string, v: string) => {
    const next = { ...values, [key]: v };
    setValues(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      if (Object.values(next).some((x) => x.trim().length > 0)) onAnswer({ kind: "fields", values: next }, false);
    }, 400);
  };

  // Flush pending field edits on unmount (see TextControl).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const next = pending.current;
      if (next && Object.values(next).some((x) => x.trim().length > 0)) {
        onAnswer({ kind: "fields", values: next }, false);
      }
    },
    [],
  );

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
