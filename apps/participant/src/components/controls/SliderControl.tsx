import { useState } from "react";
import type { ControlProps } from "./shared.js";

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
