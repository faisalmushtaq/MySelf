import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ABSOLUTE_MAX_AGE_YEARS } from "@myself/schema";
import type { ControlProps } from "./shared.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The day, month and year a stored date names, as the dropdowns hold them ("" for unset). */
function partsOf(iso: string): { d: string; m: string; y: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? { y: String(Number(match[1])), m: String(Number(match[2])), d: String(Number(match[3])) } : { d: "", m: "", y: "" };
}

/**
 * A date as three dropdowns — day, month, year — rather than the browser's
 * date picker, which children found hard to work (field feedback, D-77): on an
 * iPad it opens on today and has to be scrolled back years, a month at a time
 * or through a wheel. Three lists of plain numbers and month names are what a
 * school form looks like. The years offered are only the ones the survey's
 * ages allow, newest first.
 */
export function DateControl({ item, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  const [error, setError] = useState<string | null>(null);
  const dayRef = useRef<HTMLSelectElement | null>(null);
  const current = value?.kind === "date" ? value.iso : "";
  const [parts, setParts] = useState(() => partsOf(current));
  // A new answer from outside (a resumed sitting, going Back) shows in the lists.
  useEffect(() => {
    if (current) setParts(partsOf(current));
  }, [current]);
  if (item.responseType !== "date") return null;

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

  const firstYear = Number(earliest.slice(0, 4));
  const lastYear = Number(latest.slice(0, 4));
  const years: number[] = [];
  for (let y = lastYear; y >= firstYear; y -= 1) years.push(y);

  /** A choice in one list: once all three are chosen, the date is checked and kept. */
  const choose = (patch: Partial<typeof parts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    if (!next.d || !next.m || !next.y) {
      setError(null);
      onValidity?.({ ok: true, complete: false });
      return;
    }
    const day = Number(next.d);
    const month = Number(next.m);
    const year = Number(next.y);
    // 31 April and 29 February in a non-leap year are not dates.
    if (new Date(year, month - 1, day).getDate() !== day) {
      setError(`${MONTHS[month - 1]} ${year} has no day ${day} — please check the day`);
      onValidity?.({ ok: false, complete: false });
      return;
    }
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const problem = check(iso);
    setError(problem);
    onValidity?.({ ok: problem === null, complete: problem === null });
    if (!problem) onAnswer({ kind: "date", iso }, false);
  };

  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit?.();
    }
  };

  return (
    <div className="date-wrap">
      <div className="date-parts" role="group" aria-label={item.stem.text}>
        <label className="date-part">
          <span>Day</span>
          <select ref={dayRef} className="date-day" value={parts.d} aria-invalid={error !== null} onChange={(e) => choose({ d: e.target.value })} onKeyDown={enter}>
            <option value="">Day</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={String(d)}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="date-part date-part-month">
          <span>Month</span>
          <select className="date-month" value={parts.m} aria-invalid={error !== null} onChange={(e) => choose({ m: e.target.value })} onKeyDown={enter}>
            <option value="">Month</option>
            {MONTHS.map((name, i) => (
              <option key={name} value={String(i + 1)}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="date-part">
          <span>Year</span>
          <select className="date-year" value={parts.y} aria-invalid={error !== null} onChange={(e) => choose({ y: e.target.value })} onKeyDown={enter}>
            <option value="">Year</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>
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
            onClick={() => dayRef.current?.focus()}
          >
            That&apos;s not right — change it
          </button>
        </div>
      )}
    </div>
  );
}
