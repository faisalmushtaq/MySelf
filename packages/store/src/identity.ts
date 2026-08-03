import { z } from "zod";

/**
 * Participant identity across time.
 *
 * The whole point of the secret code is that the same person answering a year
 * later can be linked to themselves without us holding a name against their
 * answers. That linkage is this file, and it is the part of the platform that
 * a mistake would be most expensive in: a wrong join silently merges two
 * children's data, and nobody would ever see it.
 *
 * So the rules here are deliberately strict and total:
 *   - the code is derived from the four components the participant gave, in a
 *     fixed order, normalised the same way every time
 *   - anything that cannot be derived completely produces NO code, not a
 *     partial one — a half-formed key would join on the wrong people
 *   - names and dates of birth never enter it
 */

/** Month names accepted for the birth-month component, in canonical order. */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

export const secretCodeParts = z.object({
  /** First two letters of the mother's first name. */
  motherInitials: z.string(),
  /** First digit of the house number. */
  houseDigit: z.string(),
  /** Birth month: a name, or a number 1-12, or a canonical code 1-12. */
  birthMonth: z.union([z.string(), z.number()]),
  /** Last two letters of the postcode. */
  postcodeLetters: z.string(),
});

export type SecretCodeParts = z.infer<typeof secretCodeParts>;

/** Month as 1-12, or null when the input names no month at all. */
export function monthNumber(value: string | number): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;
  const raw = value.trim().toLowerCase();
  if (raw === "") return null;
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 12 ? n : null;
  }
  // Accept full names and three-letter abbreviations ("sep", "sept").
  const index = MONTHS.findIndex((m) => m === raw || m.startsWith(raw.slice(0, 3)));
  return index === -1 ? null : index + 1;
}

/**
 * The participant's code: initials + house digit + zero-padded month +
 * postcode letters, upper-cased. "JA" + "1" + "01" + "CD" -> "JA101CD".
 *
 * Returns null unless every component is present and well formed. A code that
 * is missing a piece is not a weaker key, it is a different key — and it would
 * collide with every other participant missing the same piece.
 */
export function deriveParticipantCode(parts: Partial<SecretCodeParts>): string | null {
  const initials = (parts.motherInitials ?? "").trim().toUpperCase();
  const digit = (parts.houseDigit ?? "").trim();
  const postcode = (parts.postcodeLetters ?? "").trim().toUpperCase();
  const month = parts.birthMonth === undefined ? null : monthNumber(parts.birthMonth);

  if (!/^[A-Z]{2}$/.test(initials)) return null;
  if (!/^[0-9]$/.test(digit)) return null;
  if (month === null) return null;
  if (!/^[A-Z]{2}$/.test(postcode)) return null;

  return `${initials}${digit}${String(month).padStart(2, "0")}${postcode}`;
}

/** The shape a derived code always has, for validating one from elsewhere. */
export const PARTICIPANT_CODE_PATTERN = /^[A-Z]{2}[0-9][0-9]{2}[A-Z]{2}$/;

export function isParticipantCode(value: string): boolean {
  return PARTICIPANT_CODE_PATTERN.test(value);
}
