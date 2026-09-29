import { useEffect, useMemo, useRef, useState } from "react";
import { Illustration } from "./illustrations.js";
import { normalisePostcode, type AnswerValue, type StreetList, type StreetMatch } from "@myself/engine";
import { postcodeList } from "../lib/postcodes.js";
import { streetList as loadStreets } from "../lib/streets.js";
import { ABSOLUTE_MAX_AGE_YEARS, type ItemDefinition, type ResponseScale } from "@myself/schema";

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
  /**
   * `autoAdvance` moves the screen on after a short pause; a number sets the
   * pause, for a control whose last input deserves to be seen landing first.
   */
  onAnswer: (value: AnswerValue, autoAdvance: boolean | { afterMs: number }) => void;
  /**
   * Controls that can hold an unusable draft report it here, so the screen can
   * refuse to advance. `ok` is false while anything on screen fails its format
   * rule; `complete` is false while a required part is still empty. Without
   * this a participant could fix a field into an invalid state and continue,
   * leaving the last valid value stored while the screen showed something else.
   */
  onValidity?: ((state: { ok: boolean; complete: boolean }) => void) | undefined;
  /** Enter on a typed answer moves on, matching how choices auto-advance. */
  onSubmit?: (() => void) | undefined;
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

  // Spectrum: options laid along a left-to-right axis so the arrangement
  // itself conveys the answer (used for handedness).
  if (item.presentation === "spectrum") {
    const ordered = item.spectrumReverse ? [...scale.options].reverse() : scale.options;
    const chosen = ordered.find((o) => o.code === selected);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const middle = ordered.length % 2 === 1 ? ordered[(ordered.length - 1) / 2] : undefined;
    return (
      <div className="spectrum" role="radiogroup" aria-label={item.stem.text}>
        <div className="spectrum-row">
          {ordered.map((o) => (
            <button
              key={o.code}
              type="button"
              role="radio"
              aria-checked={selected === o.code}
              // The visible label is hidden on narrow screens, where the axis
              // has no room for five of them — so the accessible name has to
              // carry the whole answer regardless of what is on screen.
              aria-label={o.label}
              className={`spectrum-option${selected === o.code ? " selected" : ""}`}
              onClick={() => onAnswer({ kind: "choice", code: o.code }, auto)}
            >
              <span className="spectrum-dot" aria-hidden="true" />
              <span className="spectrum-label">{o.label}</span>
            </button>
          ))}
        </div>
        {/* Narrow screens keep the left-to-right axis — that arrangement IS the
            question — and drop to anchors plus a readout of the choice,
            because five labels cannot sit side by side on a phone. The MIDDLE
            anchor is named as well as the two ends (D-32): without it, "both
            equally" is an unlabelled dot between two labelled extremes, which
            is exactly the answer least likely to be picked by someone who
            cannot see what it means. Hidden by CSS once the full labels fit. */}
        <div className="spectrum-ends" aria-hidden="true">
          <span>{first?.label}</span>
          {middle && middle !== first && middle !== last && <span>{middle.label}</span>}
          <span>{last?.label}</span>
        </div>
        <p className="spectrum-status" aria-live="polite">
          {chosen ? chosen.label : "Tap anywhere along the line"}
        </p>
      </div>
    );
  }

  // Numbered row (D-53): 0-10 in one line, with the published groupings drawn
  // beneath as brackets — the SQS's Terrible / Poor / Fair / Good / Excellent.
  // Each number's accessible name carries its band, since the brackets are
  // decoration a screen reader never meets.
  if (item.presentation === "numbered") {
    const options = scale.options;
    const bands = scale.bands ?? [];
    const bandOf = (code: number) => bands.find((b) => code >= b.from && code <= b.to);
    const column = (code: number) => options.findIndex((o) => o.code === code) + 1;
    const chosen = options.find((o) => o.code === selected);
    const cols = { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` };
    return (
      <div className="numbered" role="radiogroup" aria-label={item.stem.text}>
        <div className="numbered-row" style={cols}>
          {options.map((o) => {
            const band = bandOf(o.code);
            return (
              <button
                key={o.code}
                type="button"
                role="radio"
                aria-checked={selected === o.code}
                aria-label={band ? `${o.label}, ${band.label}` : o.label}
                className={`numbered-option${selected === o.code ? " selected" : ""}`}
                onClick={() => onAnswer({ kind: "choice", code: o.code }, auto)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {bands.length > 0 && (
          <div className="numbered-bands" style={cols} aria-hidden="true">
            {bands.map((b) => (
              <span
                key={b.label}
                className={`numbered-band${b.from === b.to ? " single" : ""}`}
                style={{ gridColumn: `${column(b.from)} / ${column(b.to) + 1}` }}
              >
                <span className="band-bracket" />
                <span className="band-label">{b.label}</span>
              </span>
            ))}
          </div>
        )}
        <p className="numbered-status" aria-live="polite">
          {chosen ? `${chosen.label}${bandOf(chosen.code) ? ` — ${bandOf(chosen.code)!.label}` : ""}` : "\u00a0"}
        </p>
      </div>
    );
  }

  // Compact chips: many short labels (months, ages) laid out in a wrapping
  // grid. Everything is visible at once and answered in a single tap, where a
  // menu would hide the options behind one.
  if (item.presentation === "compact") {
    return (
      <div className="chip-grid" role="radiogroup" aria-label={item.stem.text}>
        {scale.options.map((o) => (
          <button
            key={o.code}
            type="button"
            role="radio"
            aria-checked={selected === o.code}
            className={`chip${selected === o.code ? " selected" : ""}${o.kind !== "substantive" ? " wide" : ""}`}
            onClick={() => onAnswer({ kind: "choice", code: o.code }, auto)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  // Menus are the exception, chosen deliberately in the library — never a
  // fallback triggered by option count.
  const asPicker = item.presentation === "dropdown" || item.presentation === "wheel";

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

  // Choosing a rung moves on, the same as tapping an option card. The advance
  // is held until the finger lifts, so dragging up and down the ladder to find
  // the right rung never jumps the screen mid-decision; arrow keys adjust
  // without advancing, and Enter continues.
  const pick = (v: number, settle: boolean) => {
    if (v !== selected || settle) onAnswer({ kind: "number", value: v }, settle);
  };
  const lastPicked = useRef<number | undefined>(undefined);
  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const v = lastPicked.current;
    if (v !== undefined) onAnswer({ kind: "number", value: v }, true);
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
          const v = valueFromY(e.clientY, e.currentTarget);
          lastPicked.current = v;
          pick(v, false);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const v = valueFromY(e.clientY, e.currentTarget);
          lastPicked.current = v;
          pick(v, false);
        }}
        onPointerUp={release}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          const cur = selected ?? item.lowestValue - 1 + Math.ceil(item.rungs / 2);
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault();
            pick(Math.min(top, cur + 1), false);
          } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault();
            pick(Math.max(item.lowestValue, cur - 1), false);
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

/**
 * A number of days as a person would say it: "1 year, 1 month and 5 days".
 * Months are taken as 30 days and years as 365 — it is read back as "about",
 * to make a slipped digit obvious, not to be a calendar.
 */
export function daysInWords(n: number): string {
  const years = Math.floor(n / 365);
  const months = Math.floor((n - years * 365) / 30);
  const days = n - years * 365 - months * 30;
  const unit = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const parts = [
    ...(years ? [unit(years, "year")] : []),
    ...(months ? [unit(months, "month")] : []),
    ...(days || (!years && !months) ? [unit(days, "day")] : []),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
}

export function NumericControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  if (item.responseType !== "numeric") return null;
  const current = value?.kind === "number" ? String(value.value) : "";
  const [text, setText] = useState(current);
  const [error, setError] = useState<string | null>(null);
  // An unusually large answer is read back and confirmed before moving on
  // (D-53). One already saved was confirmed when it was given.
  const [confirmed, setConfirmed] = useState<number | null>(value?.kind === "number" ? value.value : null);
  const [checking, setChecking] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setText(current), [current]);
  const needsCheck = (n: number, ok: number | null) =>
    item.confirmAbove !== undefined && n > item.confirmAbove && n !== ok;

  // Only characters that can form a valid answer are accepted at all: a
  // participant cannot type or paste "12e5" or "--3" and be told off later.
  const allowNegative = (item.min ?? 0) < 0;
  const clean = (raw: string) => {
    let s = raw.replace(item.integerOnly ? /[^0-9-]/g : /[^0-9.-]/g, "");
    if (!allowNegative) s = s.replace(/-/g, "");
    else s = s[0] === "-" ? `-${s.slice(1).replace(/-/g, "")}` : s.replace(/-/g, "");
    const dot = s.indexOf(".");
    if (dot !== -1) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, "")}`;
    return s;
  };

  const commit = (input: string) => {
    const raw = clean(input);
    setText(raw);
    if (raw.trim() === "" || raw === "-" || raw === ".") {
      // Nothing usable on screen: valid so far, but not an answer yet, so a
      // hard-required item stays blocked rather than keeping a stale value.
      setError(null);
      onValidity?.({ ok: true, complete: false });
      return;
    }
    const n = Number(raw);
    if (Number.isNaN(n) || (item.integerOnly && !Number.isInteger(n))) {
      setError("Please enter a whole number");
      onValidity?.({ ok: false, complete: false });
      return;
    }
    if ((item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max)) {
      setError(`Please enter a number between ${item.min ?? "0"} and ${item.max ?? "∞"}`);
      onValidity?.({ ok: false, complete: false });
      return;
    }
    setError(null);
    // Recorded as typed either way — it is what the participant said — but the
    // screen holds until they confirm a large one.
    const check = needsCheck(n, confirmed);
    setChecking(check ? n : null);
    onValidity?.({ ok: !check, complete: !check });
    onAnswer({ kind: "number", value: n }, false);
  };

  const unit = item.unitLabel ?? "";
  const readBack = (n: number) =>
    /^days?$/i.test(unit) ? `That's about ${daysInWords(n)}.` : `You typed ${n}${unit ? ` ${unit}` : ""}.`;

  return (
    <div className="numeric-wrap">
      <input
        ref={inputRef}
        // Never type="number": it ignores maxLength, accepts "e"/"+"/"-", and
        // reports an empty value for text the participant can still see.
        type="text"
        inputMode={item.integerOnly ? "numeric" : "decimal"}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="text-input numeric"
        value={text}
        aria-label={item.stem.text}
        aria-invalid={error !== null}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit(text);
          onSubmit?.();
        }}
      />
      {item.unitLabel && <span className="unit">{item.unitLabel}</span>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {checking !== null && !error && (
        <div className="number-check" role="status">
          <p className="number-check-text">
            {readBack(checking)} Is that right?
          </p>
          <div className="confirm-row">
            <button
              type="button"
              className="confirm-postcode"
              onClick={() => {
                setConfirmed(checking);
                setChecking(null);
                onValidity?.({ ok: true, complete: true });
              }}
            >
              Yes, that&apos;s right
            </button>
            <button
              type="button"
              className="confirm-postcode"
              onClick={() => {
                inputRef.current?.focus();
                inputRef.current?.select();
              }}
            >
              No — I&apos;ll change it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DateControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (item.responseType !== "date") return null;
  const current = value?.kind === "date" ? value.iso : "";

  /** Age plausibility, checked against today. Blocks typos, not real lives. */
  /**
   * Bounds handed to the native picker so impossible dates cannot be chosen
   * in the first place — prevention, with the checks below as the backstop.
   */
  const today = new Date();
  const iso0 = (d: Date) => d.toISOString().slice(0, 10);
  // The oldest age is capped here as well as in the schema. A release cannot
  // be published above the ceiling, and if one somehow arrives that way — an
  // older manifest, a hand-edited file — the control still refuses it.
  const maxAge = Math.min(item.maxAgeYears ?? ABSOLUTE_MAX_AGE_YEARS, ABSOLUTE_MAX_AGE_YEARS);
  const latest =
    item.minAgeYears !== undefined
      ? iso0(new Date(today.getFullYear() - item.minAgeYears, today.getMonth(), today.getDate()))
      : iso0(today); // never the future
  const earliest = iso0(new Date(today.getFullYear() - maxAge, today.getMonth(), today.getDate()));

  const check = (iso: string): string | null => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "Please enter a date as day, month and year";
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const before =
      now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
    if (before) age -= 1;
    if (d > now) return "That date is in the future — please check the year";
    if (item.minAgeYears !== undefined && age < item.minAgeYears) {
      return `That would make you ${age} — please check the year you were born`;
    }
    if (age > maxAge) {
      return age > ABSOLUTE_MAX_AGE_YEARS
        ? "Please check the year — that date is too long ago"
        : "Please check the year you were born";
    }
    return null;
  };

  /** Whole years from a date, for reading the age back to the participant. */
  const ageOf = (iso: string): number | null => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const before =
      now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate());
    return before ? age - 1 : age;
  };
  const shownAge = current && error === null ? ageOf(current) : null;

  return (
    <div className="date-wrap">
      <input
        ref={inputRef}
        type="date"
        className="text-input"
        value={current}
        aria-label={item.stem.text}
        aria-invalid={error !== null}
        min={earliest}
        max={latest}
        onChange={(e) => {
          const iso = e.target.value;
          if (!iso) return;
          const problem = check(iso);
          setError(problem);
          onValidity?.({ ok: problem === null, complete: problem === null });
          if (!problem) onAnswer({ kind: "date", iso }, false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {/* Read the date back as an age. A date typed a digit wrong usually
          still looks like a date, but "that makes you 51" does not look like
          you — so the mistake is obvious at the moment it can be fixed. */}
      {shownAge !== null && (
        <div className="date-confirm" role="status">
          <p className="date-age">
            Great — that makes you {shownAge} year{shownAge === 1 ? "" : "s"} old.
          </p>
          <button
            type="button"
            className="date-amend"
            onClick={() => {
              const el = inputRef.current;
              if (!el) return;
              el.focus();
              // showPicker is not in every engine; focus alone is the fallback.
              (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
            }}
          >
            That&apos;s not right — change it
          </button>
        </div>
      )}
    </div>
  );
}

export function TextControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  if (item.responseType !== "text_short" && item.responseType !== "text_long") return null;
  const current = value?.kind === "text" ? value.value : "";
  const [text, setText] = useState(current);
  const long = item.responseType === "text_long";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patternOf = item.responseType === "text_short" ? item.pattern : undefined;
  const patternHint = item.responseType === "text_short" ? item.patternHint : undefined;

  const commit = (input: string) => {
    const raw = input.slice(0, item.maxChars); // autofill can exceed maxLength
    setText(raw);
    if (patternOf && raw.trim().length > 0 && !new RegExp(patternOf).test(raw.trim())) {
      setError(patternHint ?? "Please check the format");
      onValidity?.({ ok: false, complete: false });
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    setError(null);
    onValidity?.({ ok: true, complete: raw.trim().length > 0 });
    pending.current = raw;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      if (raw.trim().length > 0) onAnswer({ kind: "text", value: raw }, false);
    }, 400); // debounce keystrokes; every commit is still an autosaved event
  };

  /** Record the current text now, without waiting for the debounce. */
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    const raw = pending.current;
    pending.current = null;
    if (raw !== null && raw.trim().length > 0) onAnswer({ kind: "text", value: raw }, false);
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
          autoComplete="off"
          autoCorrect="off"
          aria-label={item.stem.text}
          onChange={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            flush();
            onSubmit?.();
          }}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {long && item.maxChars < 100000 && (
        <p className="hint">
          {text.length} / {item.maxChars}
        </p>
      )}
    </div>
  );
}

export function FormFieldsControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  if (item.responseType !== "form_fields") return null;
  const current = value?.kind === "fields" ? value.values : {};
  const [values, setValues] = useState<Record<string, string>>(current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, string> | null>(null);

  // A postcode field is checked against the release's list (D-52). One the list
  // does not know is questioned, never refused, in two steps: is it typed
  // correctly, and is the home really outside the area? Only a participant who
  // says yes to both moves on with it, and it is kept as typed. A postcode
  // already saved was confirmed when it was given, so a return visit does not
  // ask again.
  const check = item.postcodeCheck;
  const list = check ? postcodeList(check.asset) : null;
  const saved = check ? normalisePostcode(current[check.field] ?? "") : null;
  /** The postcode the participant said is typed correctly (step one). */
  const [typedRight, setTypedRight] = useState<string | null>(saved);
  /** The postcode the participant said is outside the area (step two). */
  const [confirmed, setConfirmed] = useState<string | null>(saved);
  const postcodeInput = useRef<HTMLInputElement | null>(null);
  const postcodeState = (vals: Record<string, string>, confirmedPostcode: string | null) => {
    if (!check || !list) return { normal: null, area: null, needsConfirm: false };
    const normal = normalisePostcode(vals[check.field] ?? "");
    const area = normal ? list.lookup(normal) : null;
    return { normal, area, needsConfirm: normal !== null && area === null && confirmedPostcode !== normal };
  };

  // Someone who doesn't know their postcode can say so, and find their street
  // in the release's list instead (D-53). The match they choose is recorded
  // beside the fields; a street the list does not know is kept as typed.
  const streets = check ? item.streetCheck : undefined;
  const [noPostcode, setNoPostcode] = useState(
    streets !== undefined && !(current[check!.field] ?? "").trim() && Boolean(current[streets.areaKey] || current[streets.districtKey]),
  );
  const [streetList, setStreetList] = useState<StreetList | null>(null);
  const [streetQuery, setStreetQuery] = useState("");
  const streetInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!noPostcode || !streets) return;
    let live = true;
    void loadStreets(streets.asset).then((l) => live && setStreetList(l));
    return () => {
      live = false;
    };
  }, [noPostcode, streets?.asset]);
  // Searched a beat after typing stops, not on every keystroke.
  useEffect(() => {
    if (!noPostcode || !streets) return;
    const t = setTimeout(() => setStreetQuery(values[streets.field] ?? ""), 250);
    return () => clearTimeout(t);
  }, [noPostcode, streets?.field, values[streets?.field ?? ""]]);
  const chosenStreet = streets && values[streets.areaKey] !== undefined ? values : null;
  const matches = useMemo(
    () => (streetList && noPostcode && !chosenStreet && streetQuery.trim() ? streetList.search(streetQuery, 5) : []),
    [streetList, noPostcode, chosenStreet, streetQuery],
  );

  const report = (next: Record<string, string>, confirmedPostcode: string | null) => {
    if (item.responseType !== "form_fields") return;
    // Validity is judged across the whole form, not just the field just typed
    // in: a single bad entry must block the screen even if the others are fine.
    const anyBad = item.fields.some((f) => {
      const raw = (next[f.key] ?? "").trim();
      return f.pattern !== undefined && raw.length > 0 && !new RegExp(f.pattern).test(raw);
    });
    const allRequiredPresent = item.fields.every((f) => !f.required || (next[f.key] ?? "").trim().length > 0);
    // An emptied form is not an answer: it goes the way of any blank item.
    const anyPresent = Object.values(next).some((x) => x.trim().length > 0);
    const ok = !anyBad && !postcodeState(next, confirmedPostcode).needsConfirm;
    onValidity?.({ ok, complete: ok && allRequiredPresent && anyPresent });
  };
  const postcode = postcodeState(values, confirmed);

  /** Put a new set of values on screen, check it, and autosave it after a pause. */
  const apply = (next: Record<string, string>, nextErrors: Record<string, string>) => {
    setValues(next);
    setErrors(nextErrors);
    report(next, confirmed);
    if (Object.keys(nextErrors).length > 0) {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      if (Object.values(next).some((x) => x.trim().length > 0)) onAnswer({ kind: "fields", values: next }, false);
    }, 400);
  };

  /** The values without a chosen street match: it no longer describes what is typed. */
  const withoutMatch = (vals: Record<string, string>) => {
    if (!streets) return vals;
    const { [streets.areaKey]: _area, [streets.districtKey]: _district, ...rest } = vals;
    return rest;
  };

  const commit = (key: string, raw: string) => {
    if (item.responseType !== "form_fields") return;
    // Truncate here, not only via maxLength: iOS AutoFill/QuickType inserts
    // values programmatically and bypasses the attribute entirely.
    // A numeric field never holds a letter: strip rather than accept-and-scold.
    const field = item.fields.find((f) => f.key === key);
    const cleaned = field?.kind === "numeric" ? raw.replace(/[^0-9]/g, "") : raw;
    const v = field ? cleaned.slice(0, field.maxChars) : cleaned;
    let next = { ...values, [key]: v };
    // Changing the street, or giving a postcode after all, undoes a match.
    if (streets && (key === streets.field || (key === check?.field && v.trim()))) next = withoutMatch(next);
    if (streets && key === check?.field && v.trim() && noPostcode) setNoPostcode(false);
    const bad = field?.pattern && v.trim().length > 0 && !new RegExp(field.pattern).test(v.trim());
    const nextErrors = { ...errors };
    if (bad) nextErrors[key] = field?.patternHint ?? "Please check the format";
    else delete nextErrors[key];
    apply(next, nextErrors);
  };

  const dontKnowPostcode = () => {
    if (!check) return;
    const nextErrors = { ...errors };
    delete nextErrors[check.field];
    setNoPostcode(true);
    setTypedRight(null);
    apply({ ...values, [check.field]: "" }, nextErrors);
    streetInput.current?.focus();
  };

  const chooseStreet = (m: StreetMatch) => {
    if (!streets) return;
    apply({ ...values, [streets.field]: m.street, [streets.areaKey]: m.area, [streets.districtKey]: m.outward }, errors);
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

  /** Offered wherever the postcode is empty or unknown to the list, never once it is found. */
  const offerDontKnow =
    streets !== undefined && !noPostcode && (postcode.normal === null ? !(values[check!.field] ?? "").trim() || !!errors[check!.field] : postcode.needsConfirm);

  return (
    <div className="fields">
      {item.fields.map((f) => {
        const isPostcode = check !== undefined && f.key === check.field;
        const isStreet = streets !== undefined && f.key === streets.field;
        const noteId = `${item.key}-${f.key}-note`;
        const note = isPostcode
          ? noPostcode
            ? "That's fine — type your street below and choose it from the list."
            : !errors[f.key] && postcode.normal
              ? postcode.area
                ? `✓ ${postcode.area.ward}, ${postcode.area.district}`
                : postcode.needsConfirm
                  ? typedRight === postcode.normal
                    ? `Is your home outside ${check!.areaName}?`
                    : `We can't find ${postcode.normal} in ${check!.areaName}. Check it's typed correctly.`
                  : `✓ Kept as you gave it — outside ${check!.areaName}`
              : null
          : isStreet && noPostcode
            ? chosenStreet
              ? `✓ ${values[streets!.field]}, ${values[streets!.areaKey]}${values[streets!.districtKey] ? ` (${values[streets!.districtKey]})` : ""}`
              : !(values[f.key] ?? "").trim()
                ? null
                : streetList === null
                  ? "Looking for your street…"
                  : matches.length > 0
                    ? "Is it one of these?"
                    : streetQuery.trim().replace(/[^A-Za-z]/g, "").length >= 3
                      ? `We can't find that street in ${check!.areaName}. Check the spelling — or carry on, and we'll keep it as you typed it.`
                      : null
            : null;
        return (
          <div key={f.key} className="field-group">
            <label className="field">
              <span className="field-label">{f.label}</span>
              <input
                // Always type=text: type=number ignores maxLength and accepts "e",
                // "+" and "-". inputMode drives the on-screen keyboard instead.
                type="text"
                inputMode={f.kind === "numeric" || /^\^\[0-9\]/.test(f.pattern ?? "") ? "numeric" : "text"}
                className="text-input"
                maxLength={f.maxChars}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={values[f.key] ?? ""}
                aria-invalid={errors[f.key] !== undefined}
                aria-describedby={isPostcode || isStreet ? noteId : undefined}
                ref={isPostcode ? postcodeInput : isStreet ? streetInput : undefined}
                onChange={(e) => commit(f.key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  // Enter walks down the form, then moves on from the last field.
                  const inputs = Array.from(
                    e.currentTarget.closest(".fields")?.querySelectorAll("input") ?? [],
                  ) as HTMLInputElement[];
                  const at = inputs.indexOf(e.currentTarget);
                  const next = inputs[at + 1];
                  if (next) {
                    next.focus();
                    return;
                  }
                  if (timer.current) clearTimeout(timer.current);
                  const draft = pending.current;
                  pending.current = null;
                  if (draft && Object.values(draft).some((x) => x.trim().length > 0)) {
                    onAnswer({ kind: "fields", values: draft }, false);
                  }
                  onSubmit?.();
                }}
              />
              {errors[f.key] && (
                <span className="error" role="alert">
                  {errors[f.key]}
                </span>
              )}
            </label>
            {(isPostcode || (isStreet && noPostcode)) && (
              // Said back, not shouted: the area a postcode lies in, or a request to
              // check one the list does not know (D-52); the street found (D-53).
              <p id={noteId} className="field-note" aria-live="polite">
                {note}
              </p>
            )}
            {isPostcode && !noPostcode && !errors[f.key] && postcode.needsConfirm && typedRight !== postcode.normal && (
              <div className="confirm-row">
                <button type="button" className="confirm-postcode" onClick={() => setTypedRight(postcode.normal)}>
                  It&apos;s typed correctly
                </button>
                {offerDontKnow && (
                  <button type="button" className="confirm-postcode" onClick={dontKnowPostcode}>
                    I don&apos;t know my postcode
                  </button>
                )}
              </div>
            )}
            {isPostcode && !noPostcode && !errors[f.key] && postcode.needsConfirm && typedRight === postcode.normal && (
              <div className="confirm-row">
                <button
                  type="button"
                  className="confirm-postcode"
                  onClick={() => {
                    setConfirmed(postcode.normal);
                    report(values, postcode.normal);
                  }}
                >
                  Yes, my home is outside {check!.areaName}
                </button>
                <button
                  type="button"
                  className="confirm-postcode"
                  onClick={() => {
                    setTypedRight(null);
                    postcodeInput.current?.focus();
                  }}
                >
                  No — I&apos;ll check my postcode
                </button>
              </div>
            )}
            {isPostcode && offerDontKnow && !postcode.needsConfirm && (
              <button type="button" className="dont-know" onClick={dontKnowPostcode}>
                I don&apos;t know my postcode
              </button>
            )}
            {isStreet && matches.length > 0 && (
              <ul className="street-matches" aria-label="Streets that match">
                {matches.map((m) => (
                  <li key={`${m.street}|${m.area}|${m.outward}`}>
                    <button type="button" className="street-match" onClick={() => chooseStreet(m)}>
                      <span className="street-name">{m.street}</span>
                      <span className="street-area">
                        {m.area}
                        {m.outward ? ` · ${m.outward}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
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
