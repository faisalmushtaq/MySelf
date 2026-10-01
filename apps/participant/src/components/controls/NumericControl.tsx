import { useEffect, useRef, useState } from "react";
import { daysInWords, type ControlProps } from "./shared.js";

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
