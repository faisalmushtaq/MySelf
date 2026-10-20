import { useRef, useState } from "react";
import { ABSOLUTE_MAX_AGE_YEARS } from "@myself/schema";
import type { ControlProps } from "./shared.js";

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
  // Someone is still the oldest age until the day before their next birthday,
  // so the earliest date is a day after (maxAge + 1) years ago.
  const earliest = iso0(new Date(today.getFullYear() - maxAge - 1, today.getMonth(), today.getDate() + 1));
  const range =
    item.minAgeYears !== undefined && item.maxAgeYears !== undefined
      ? `This survey is for people aged ${item.minAgeYears} to ${maxAge}`
      : null;

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
      return range ? `That would make you ${age}. ${range}: please check the year you were born.` : `That would make you ${age} — please check the year you were born`;
    }
    if (age > maxAge) {
      if (age > ABSOLUTE_MAX_AGE_YEARS) return "Please check the year — that date is too long ago";
      return range ? `That would make you ${age}. ${range}: please check the year you were born.` : "Please check the year you were born";
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
