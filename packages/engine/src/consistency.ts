import type { CrossCheck, ItemDefinition, OptionLimit, ResponseScale, ScaleOption } from "@myself/schema";
import type { AnswerStore, AnswerValue } from "./answers.js";

/**
 * Answers that depend on earlier answers.
 *
 * Two jobs, both pure, both shared by the device and the server so a session
 * can be re-evaluated years later and reach the same conclusions:
 *
 *   - cross-checks: a later answer that contradicts an earlier one is caught
 *     while the participant is still here to say which is right
 *   - option limits: options a given participant could not truthfully choose
 *     are not offered at all
 *
 * Both fail *open*. If the earlier answer is missing or unusable, nothing is
 * blocked and nothing is hidden: a rule that cannot be evaluated must never
 * become an obstacle, and it must never quietly narrow what someone can say.
 */

/** Whole years elapsed from `iso` to `now`, or null if the date is unusable. */
export function ageInYears(iso: string, now: Date): number | null {
  const born = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(born.getTime())) return null;
  let age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age < 0 ? null : age;
}

/** Calendar month (1-12) of a date answer, or null if there isn't one. */
function monthOf(value: AnswerValue | undefined): number | null {
  if (value?.kind !== "date") return null;
  const d = new Date(`${value.iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getMonth() + 1;
}

/**
 * The message for the first cross-check this answer fails, or null if it is
 * consistent with everything it is checked against.
 */
export function checkConsistency(
  item: ItemDefinition,
  value: AnswerValue,
  scale: ResponseScale | undefined,
  store: AnswerStore,
): string | null {
  for (const check of item.crossChecks ?? []) {
    if (check.kind === "matches_month_of_date") {
      const expected = monthOf(store.get(check.against)?.value);
      if (expected === null) continue; // nothing to check against — allow
      const chosen = chosenValue(value, scale);
      if (chosen === null) continue;
      if (chosen !== expected) return check.message;
    }
  }
  return null;
}

/** The quantity a single-choice answer denotes, via its option's `value`. */
function chosenValue(value: AnswerValue, scale: ResponseScale | undefined): number | null {
  if (value.kind !== "choice" || !scale) return null;
  const option = scale.options.find((o) => o.code === value.code);
  return option?.value ?? null;
}

/**
 * The options this participant should be offered. Options that denote no
 * quantity — "I'm not sure", "Prefer not to say" — are always kept: they are
 * escapes, not claims, and filtering them would take away the honest answer.
 */
export function visibleOptions(
  limit: OptionLimit | undefined,
  options: ScaleOption[],
  store: AnswerStore,
  now: Date,
): ScaleOption[] {
  if (!limit) return options;
  if (limit.kind === "at_most_age_now") {
    const dob = store.get(limit.from)?.value;
    if (dob?.kind !== "date") return options;
    const age = ageInYears(dob.iso, now);
    if (age === null) return options;
    const kept = options.filter((o) => o.value === undefined || o.value <= age);
    // Never leave someone with nothing to choose: if the rule would empty the
    // list (an implausible age slipped through), offer everything instead.
    return kept.some((o) => o.value !== undefined) ? kept : options;
  }
  return options;
}

export type { CrossCheck, OptionLimit };
