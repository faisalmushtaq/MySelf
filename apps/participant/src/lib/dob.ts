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
 *     entered again, with the initials of the name it holds (`verify`; D-75),
 *     and the participant has said yes to "is this you?" on seeing the name. Three wrong dates and the code cannot be
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

export type ResumeRule = { kind: "verify"; dob: string; who: Who } | { kind: "open" } | { kind: "fresh" };

/**
 * WHO A SITTING IS (D-75). Twins share a date of birth, so a code and a date
 * were not enough: one twin carried on the other's sitting, and nothing said
 * whose it was until the end. So a sitting that holds a name is also checked
 * by the initials typed with the date, and, once both match, the first name
 * is shown ("Welcome back, Sam — is this you?") before anything else is.
 */
export interface Who {
  /** As recorded, for the "is this you?" screen; null if none was given. */
  firstName: string | null;
  /** The initials the name gives, upper case, letters only; null when there is nothing to check. */
  initials: { first: string | null; last: string[] } | null;
}

/** The questions in this release that ask for the first and last name: identifying short-text items stored as first_name / last_name. */
export function nameKeys(units: readonly PresentableUnit[]): { first?: string; last?: string } {
  const named = (name: string) =>
    units.find((u) => u.item.identifying && u.item.responseType === "text_short" && (u.item.variable === name || u.item.key === name));
  const first = named("first_name");
  const last = named("last_name");
  return { ...(first ? { first: unitKey(first) } : {}), ...(last ? { last: unitKey(last) } : {}) };
}

/** A name's letters, accents taken off, upper case: "Zoë-Ann" -> "ZOEANN". */
const letters = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z\s'-]/g, "");

/** The first letter of each part of a name: "de Silva" -> ["D", "S"], "O'Neill" -> ["O"]. */
const wordInitials = (text: string) =>
  letters(text)
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^A-Z]/g, "")[0])
    .filter((c): c is string => Boolean(c));

const textAnswer = (answers: ReadonlyMap<string, RecordedAnswer>, key: string | undefined) => {
  const a = key ? answers.get(key) : undefined;
  return a?.status === "answered" && a.value?.kind === "text" && a.value.value.trim() ? a.value.value.trim() : null;
};

/** Who a sitting is, from its answers. */
export function whoOf(answers: ReadonlyMap<string, RecordedAnswer>, keys: { first?: string; last?: string }): Who {
  const firstName = textAnswer(answers, keys.first);
  const lastName = textAnswer(answers, keys.last);
  const first = firstName ? (wordInitials(firstName)[0] ?? null) : null;
  const last = lastName ? wordInitials(lastName) : [];
  return { firstName, initials: first || last.length > 0 ? { first, last } : null };
}

/** Initials for the staff list: "S.K.", or null. */
export function initialsLabel(who: Who): string | null {
  if (!who.initials) return null;
  const parts = [who.initials.first, who.initials.last[0] ?? null].filter(Boolean);
  return parts.length ? `${parts.join(".")}.` : null;
}

/**
 * Whether typed initials are this sitting's. The first letter is the first
 * name's; the last is any part of the surname's ("de Silva": D or S). A middle
 * initial in between is allowed. Nothing typed never matches a sitting that has
 * initials to check.
 */
export function initialsMatch(who: Who, typed: string): boolean {
  if (!who.initials) return true;
  const t = letters(typed).replace(/[^A-Z]/g, "");
  const { first, last } = who.initials;
  if (first && last.length > 0) return t.length >= 2 && t[0] === first && last.includes(t[t.length - 1]!);
  if (first) return t[0] === first;
  return t.length > 0 && last.includes(t[t.length - 1]!);
}

/** Whether the screen should ask for initials at all. */
export const asksInitials = (who: Who) => who.initials !== null;

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
export function resumeRule(
  answers: ReadonlyMap<string, RecordedAnswer>,
  dobKey: string | undefined,
  names: { first?: string; last?: string } = {},
): ResumeRule {
  const dob = dobKey ? answers.get(dobKey) : undefined;
  if (dob?.status === "answered" && dob.value?.kind === "date") {
    const day = dayOf(dob.value.iso);
    if (day) return { kind: "verify", dob: day, who: whoOf(answers, names) };
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
export function tryDob(recorded: string, typed: string, guard: DobGuard | null, now: Date, initials?: { who: Who; typed: string }): DobAttempt {
  if (guard?.lockedAt) return { kind: "locked", guard };
  // One answer for both: a wrong try never says which of the two was right.
  if (dobMatches(recorded, typed) && (!initials || initialsMatch(initials.who, initials.typed))) return { kind: "accepted", guard: null };
  const failures = (guard?.failures ?? 0) + 1;
  if (failures >= DOB_MAX_ATTEMPTS) return { kind: "locked", guard: { failures, lockedAt: now.toISOString() } };
  return { kind: "refused", guard: { failures, lockedAt: null }, triesLeft: DOB_MAX_ATTEMPTS - failures };
}
