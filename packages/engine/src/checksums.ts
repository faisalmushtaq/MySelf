/**
 * Check digits for the identifiers this platform links on.
 *
 * A regular expression proves a value is the right shape. It does not prove it
 * is a real identifier, and a well-formed wrong number is the dangerous case:
 * a mistyped NHS number that still looks like an NHS number will either fail to
 * match at the linkage stage — losing that child from the linked cohort — or,
 * far worse, match somebody else. Both identifiers below carry a check
 * character precisely so that a single mistyped digit can be caught at the
 * point of entry, which is the only place it is cheap to catch.
 *
 * These validate structure, never existence. A number that passes here may
 * still belong to nobody; that is for the linkage service to determine.
 */

/**
 * NHS number: ten digits, the last being a Modulus 11 check digit.
 *
 * Weight each of the first nine digits by 10 down to 2, sum, take modulo 11,
 * subtract from 11. A result of 11 means a check digit of 0; a result of 10
 * means the number is invalid and no such NHS number exists.
 */
export function isValidNhsNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^[0-9]{10}$/.test(digits)) return false;
  let total = 0;
  for (let i = 0; i < 9; i += 1) {
    total += Number(digits[i]) * (10 - i);
  }
  const remainder = total % 11;
  const check = 11 - remainder;
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(digits[9]);
}

/** Format an NHS number the way it is written on a letter: 943 476 5919. */
export function formatNhsNumber(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 10) return value;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

const UPN_LETTERS = "ABCDEFGHJKLMNPQRTUVWXYZ"; // no I, O, S — they read as 1, 0, 5

/**
 * UPN: a check letter followed by twelve characters.
 *
 * Positions 2-13 are weighted 2 to 13, summed, taken modulo 23, and the
 * remainder indexes the alphabet above — which omits I, O and S so a
 * handwritten register cannot be misread. The final three characters may be
 * letters in a temporary UPN, and are valued A=0, B=1, and so on.
 */
export function isValidUpn(value: string): boolean {
  const upn = value.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z][0-9]{11}[0-9A-Z]$/.test(upn)) return false;
  let total = 0;
  for (let i = 1; i < 13; i += 1) {
    const char = upn[i]!;
    const digit = /[0-9]/.test(char) ? Number(char) : char.charCodeAt(0) - 65;
    total += digit * (i + 1);
  }
  return UPN_LETTERS[total % 23] === upn[0];
}

export type ChecksumKind = "nhs_number" | "upn";

export function checksumValid(kind: ChecksumKind, value: string): boolean {
  return kind === "nhs_number" ? isValidNhsNumber(value) : isValidUpn(value);
}

/** What to tell someone whose number did not check out. */
export const checksumMessage: Record<ChecksumKind, string> = {
  nhs_number:
    "That doesn't look like a complete NHS number — it's 10 digits, and one of them appears to be different. Have another look at the card or letter.",
  upn: "That UPN doesn't check out — one character looks different from the one on the school's list.",
};
