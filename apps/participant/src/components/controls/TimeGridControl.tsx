import { useEffect, useRef, useState } from "react";
import { formatMinutes, readTimeEntry, splitMinutes, timeGridMax, type AnswerValue } from "@myself/engine";
import type { ControlProps } from "./shared.js";

type Entry = { hours: string; minutes: string };

/**
 * Hours and minutes for each option chosen earlier, on one screen, with each
 * row's total read back as it is typed — the matrix a participant would expect
 * from a paper or Qualtrics form, but only with the rows that apply to them.
 *
 * A table, so a screen reader announces the app and the column for every box.
 * Like the form control, it saves a beat after typing stops, never while a box
 * holds something that is not a time, and reports its validity so the screen
 * holds while it does.
 */
export function TimeGridControl({ item, rows, value, onAnswer, onValidity, onSubmit }: ControlProps) {
  if (item.responseType !== "time_grid") return null;
  const shown = rows ?? [];
  const max = timeGridMax(item);
  const saved = value?.kind === "time_grid" ? value.minutes : {};
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(shown.map((r) => [String(r.code), splitMinutes(saved[String(r.code)])])),
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<AnswerValue | null>(null);

  const read = (all: Record<string, Entry>) =>
    shown.map((r) => {
      const e = all[String(r.code)] ?? { hours: "", minutes: "" };
      return { row: r, entry: e, ...readTimeEntry(e.hours, e.minutes, max) };
    });

  /** Validity across every row; the answer to save, or null while one is wrong or all are empty. */
  const judge = (all: Record<string, Entry>) => {
    const judged = read(all);
    const ok = judged.every((j) => !j.error);
    const filled = judged.filter((j) => j.minutes !== null).length;
    // Hard-required means every row; otherwise any row is an answer, and a
    // grid left wholly empty goes the way of any blank question.
    const complete = ok && (item.required === "hard" ? filled === shown.length && shown.length > 0 : filled > 0);
    const answer: AnswerValue | null =
      ok && filled > 0
        ? { kind: "time_grid", minutes: Object.fromEntries(judged.map((j) => [String(j.row.code), j.minutes])) }
        : null;
    return { ok, complete, answer };
  };

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) onAnswer(next, false);
  };

  useEffect(() => () => flush(), []);

  const change = (code: number, part: keyof Entry, raw: string) => {
    // Digits only, at most two: nobody's hours or minutes need a third, and a
    // stray letter is ignored rather than scolded.
    const text = raw.replace(/[^0-9]/g, "").slice(0, 2);
    const next = { ...entries, [String(code)]: { ...(entries[String(code)] ?? { hours: "", minutes: "" }), [part]: text } };
    setEntries(next);
    const { ok, complete, answer } = judge(next);
    onValidity?.({ ok, complete });
    pending.current = answer;
    if (timer.current) clearTimeout(timer.current);
    if (answer) timer.current = setTimeout(flush, 400);
  };

  const judged = read(entries);
  return (
    <div className="time-grid-wrap">
      <table className="time-grid">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Item</span>
            </th>
            <th scope="col">Hours</th>
            <th scope="col">Minutes</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {judged.map(({ row, entry, minutes, error, field }) => {
            const id = `${item.key}-${row.code}`;
            const errorId = `${id}-error`;
            const box = (part: keyof Entry, unit: string) => (
              <input
                // Never type="number": see NumericControl.
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={2}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="time-grid-input"
                value={entry[part]}
                aria-label={`${row.label}, ${unit}`}
                aria-invalid={error !== undefined && (field === part || field === "both")}
                aria-describedby={error ? errorId : undefined}
                onChange={(e) => change(row.code, part, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  // Enter moves through the boxes, then on, as in a form.
                  const inputs = Array.from(
                    e.currentTarget.closest(".time-grid")?.querySelectorAll("input") ?? [],
                  ) as HTMLInputElement[];
                  const at = inputs.indexOf(e.currentTarget);
                  const following = inputs[at + 1];
                  if (following) {
                    following.focus();
                    return;
                  }
                  flush();
                  onSubmit?.();
                }}
              />
            );
            return [
              <tr key={id} className={error ? "invalid" : undefined}>
                <th scope="row" className="time-grid-label">
                  {row.label}
                </th>
                <td>{box("hours", "hours")}</td>
                <td>{box("minutes", "minutes")}</td>
                <td className="time-grid-total">
                  <output aria-label={`${row.label}, total`}>{minutes === null ? "—" : formatMinutes(minutes)}</output>
                </td>
              </tr>,
              error ? (
                <tr key={`${id}-e`} className="time-grid-error-row">
                  <td colSpan={4}>
                    <p id={errorId} className="error" role="alert">
                      {row.label}: {error}
                    </p>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
