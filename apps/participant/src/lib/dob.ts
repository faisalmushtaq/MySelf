import type { PresentableUnit } from "@myself/engine";
import type { RecordedAnswer } from "./db.js";

/**
 * Who may carry on an unfinished sitting.
 *
 * THE HOLE THIS CLOSES. Resuming used to need only the participant code, so a
 * child who typed another child's code — a neighbour's, one read off a card,
 * or one guessed from the example on the start screen — was put back into that
 * child's sitting, and Back showed their name, date of birth and address. A
 * code is not a secret: it is printed, read aloud, and a few characters long.
 *
 * THE RULE, the simplest one that is safe:
 *
 *   - The sitting holds a date of birth: resume only once the same date is
 *     entered again (`verify`). Three wrong dates and the code cannot be
 *     resumed on this iPad until staff allow it in the handover panel.
 *   - It holds no date of birth and NO ANSWER AT ALL (stopped on the welcome
 *     or consent screens): resume as before (`open`). There is nothing on it
 *     to see, and nothing about the person to check against.
 *   - It holds answers but no date of birth (in YBM: stopped between the name
 *     and the date of birth; in a survey that never asks one: anywhere):
 *     never resumed (`fresh`). A new sitting starts under the code and the
 *     unfinished one stays on the iPad, uploading as the partial sitting it
 *     is. Re-answering a few screens is the cost; showing a stranger
 *     somebody's name is not one this rule will pay.
 *
 * And nothing on screen says which of those applied before the date is
 * confirmed: `open` and `fresh` both go straight into a survey, and `verify`
 * says only "To carry on, enter your date of birth".
 */

export const DOB_MAX_ATTEMPTS = 3;

export type ResumeRule = { kind: "verify"; dob: string } | { kind: "open" } | { kind: "fresh" };

/**
 * The question in this release that asks for the date of birth: a date item
 * marked identifying, preferring one stored as `dob` (YBM's `ybm_identity.dob`).
 */
export function dobUnit(units: readonly PresentableUnit[]): PresentableUnit | undefined {
  const dates = units.filter((u) => u.item.responseType === "date" && u.item.identifying);
  return dates.find((u) => u.item.variable === "dob" || u.item.key === "dob") ?? dates[0];
}

export const unitKey = (unit: PresentableUnit) => `${unit.instrument}.${unit.item.key}`;

/** A stored or typed date as the day it names, `YYYY-MM-DD`, or null if it is not one. */
export function dayOf(value: string | undefined): string | null {
  const day = (value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Whether a typed date is the one the sitting recorded. Same calendar day, nothing looser. */
export function dobMatches(recorded: string, typed: string): boolean {
  const a = dayOf(recorded);
  const b = dayOf(typed);
  return a !== null && b !== null && a === b;
}

/** Which of the three rules above a sitting falls under, from its decrypted answers. */
export function resumeRule(answers: ReadonlyMap<string, RecordedAnswer>, dobKey: string | undefined): ResumeRule {
  const dob = dobKey ? answers.get(dobKey) : undefined;
  if (dob?.status === "answered" && dob.value?.kind === "date") {
    const day = dayOf(dob.value.iso);
    if (day) return { kind: "verify", dob: day };
  }
  for (const answer of answers.values()) if (answer.status === "answered") return { kind: "fresh" };
  return { kind: "open" };
}

/** The wrong-date count kept per code on this iPad (lib/db.ts). */
export interface DobGuard {
  failures: number;
  /** Set on the last allowed wrong date; cleared only by staff. */
  lockedAt: string | null;
}

export type DobAttempt =
  | { kind: "accepted"; guard: null }
  | { kind: "refused"; guard: DobGuard; triesLeft: number }
  | { kind: "locked"; guard: DobGuard };

/**
 * Check a typed date of birth and say what the code's guard becomes. A locked
 * code is refused without looking at the date, so the right one cannot be
 * found by carrying on guessing. A right date clears the count.
 */
export function tryDob(recorded: string, typed: string, guard: DobGuard | null, now: Date): DobAttempt {
  if (guard?.lockedAt) return { kind: "locked", guard };
  if (dobMatches(recorded, typed)) return { kind: "accepted", guard: null };
  const failures = (guard?.failures ?? 0) + 1;
  if (failures >= DOB_MAX_ATTEMPTS) return { kind: "locked", guard: { failures, lockedAt: now.toISOString() } };
  return { kind: "refused", guard: { failures, lockedAt: null }, triesLeft: DOB_MAX_ATTEMPTS - failures };
}
