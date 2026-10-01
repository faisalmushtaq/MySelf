import { useRef } from "react";
import type { ControlProps } from "./shared.js";

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
