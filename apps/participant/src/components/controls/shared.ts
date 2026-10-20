import type { AnswerValue, TimeGridRow } from "@myself/engine";
import type { ItemDefinition, ResponseScale } from "@myself/schema";

/**
 * What the response controls share: the props contract every one of them takes,
 * the reduced-motion check that decides whether a choice moves the screen on by
 * itself, and `daysInWords`, the numeric control's read-back, which has tests of
 * its own. See `index.ts` for the controls.
 */

export interface ControlProps {
  item: ItemDefinition;
  scale?: ResponseScale | undefined;
  value?: AnswerValue | undefined;
  /** A time grid's rows: the options this participant chose at its source question. */
  rows?: readonly TimeGridRow[] | undefined;
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

export const prefersReducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
