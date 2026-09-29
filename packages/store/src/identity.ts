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

// ── The participant ID from name and date of birth (r8.0.0 on, D-52) ──────────

/**
 * From r8.0.0 there is no secret code: participants give their name, date of
 * birth and home address, and the ID is derived from the first three. The
 * address is left out on purpose — people move, and some young people live in
 * two homes, so it would split one person into two.
 *
 * The ID is a pseudonym, not an anonymisation: anyone holding a name and a date
 * of birth can recompute it. Different first names keep twins apart. A later
 * sitting under a different form of a name (Tom, Thomas) is a new ID until a
 * correction joins the two, as a mistyped code was.
 */
export interface NameAndBirth {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dob: string;
}

/**
 * A name as the ID reads it: letters and digits, lower case, accents removed —
 * so spacing, hyphens and apostrophes never split a person. "O'Neill-Bárta" ->
 * "oneillbarta"; "Sam2" stays apart from "Sam".
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Crockford base 32: no I, L, O or U, so an ID read aloud or copied by hand survives. */
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "P" + ten base-32 characters: never the shape of a secret code. */
export const DERIVED_ID_PATTERN = /^P[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * The participant ID for a name and date of birth, or null unless all three are
 * present and well formed — a partial key would join different people.
 */
export function deriveParticipantId(p: Partial<NameAndBirth>): string | null {
  const first = nameKey(p.firstName ?? "");
  const last = nameKey(p.lastName ?? "");
  const dob = (p.dob ?? "").trim();
  if (first === "" || last === "") return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dob)) return null;
  const digest = sha256(new TextEncoder().encode(`myself-participant-v1|${first}|${last}|${dob}`));
  let bits = 0;
  let value = 0;
  let out = "P";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 11) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 11) break;
  }
  return out;
}

/** Either kind of participant ID: a secret code (r1.0.0–r7.3.0) or a derived ID (r8.0.0 on). */
export function isParticipantId(value: string): boolean {
  return PARTICIPANT_CODE_PATTERN.test(value) || DERIVED_ID_PATTERN.test(value);
}

/**
 * SHA-256 (FIPS 180-4), synchronous and dependency-free: ingest runs in the
 * browser as well as on the server, and Web Crypto's digest is asynchronous.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = data.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [H[0]!, H[1]!, H[2]!, H[3]!, H[4]!, H[5]!, H[6]!, H[7]!];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, H[i]!);
  return out;
}
