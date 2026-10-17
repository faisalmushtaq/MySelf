import { useEffect, useRef, useState } from "react";
import { truncateText } from "../../lib/text.js";
import type { ControlProps } from "./shared.js";

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
    // Autofill can exceed maxLength; cut whole characters, never half an emoji.
    const raw = truncateText(input, item.maxChars);
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
