import { Illustration } from "../illustrations.js";
import { prefersReducedMotion, type ControlProps } from "./shared.js";

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
