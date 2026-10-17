/**
 * The staff PIN in front of the handover panel.
 *
 * WHY. The panel is reached by five taps on the build line, which a child can
 * stumble on or be shown, and from it every sitting on the iPad can be
 * exported, the iPad moved to another survey, and confirmed sittings cleared.
 * So the first time it is opened on a device, staff choose a PIN, and from then
 * on the panel asks for it.
 *
 * STORED ONLY AS A SALTED HASH (PBKDF2-SHA-256 through WebCrypto), in the
 * app's own database on this iPad, never sent anywhere. Four to eight digits
 * is a small space, so the hash is not what protects it: the lockout is. Five
 * wrong tries lock the panel for five minutes, and the count survives a reload.
 *
 * RESET is clearing the site's data (Settings → Safari → Advanced → Website
 * Data, or deleting the Home Screen app), which ALSO DELETES EVERY SITTING NOT
 * YET UPLOADED — see docs/15. There is deliberately no other way round it.
 *
 * Pure apart from WebCrypto, so the rules are unit tested without IndexedDB;
 * `lib/db.ts` keeps the record.
 */

export const PIN_PATTERN = /^[0-9]{4,8}$/;
/** OWASP's figure for PBKDF2-SHA-256, the same as the export file's. Stored per record so it can change. */
export const PIN_ITERATIONS = 600_000;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 5 * 60_000;

export interface PinRecord {
  /** Base64 of 16 random bytes. */
  salt: string;
  /** Base64 of the PBKDF2 output. */
  hash: string;
  iterations: number;
  /** Wrong tries since the last right one or the last lockout. */
  failures: number;
  /** ISO time the lockout ends, while there is one. */
  lockedUntil: string | null;
  createdAt: string;
}

export function pinComplaint(pin: string): string | null {
  return PIN_PATTERN.test(pin) ? null : "The PIN must be 4 to 8 digits.";
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function hashPin(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

/** A new record for a PIN staff have just chosen. Refuses one that is not 4–8 digits. */
export async function newPinRecord(pin: string, now: Date, iterations = PIN_ITERATIONS): Promise<PinRecord> {
  const problem = pinComplaint(pin);
  if (problem) throw new Error(problem);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: toBase64(salt),
    hash: await hashPin(pin, salt, iterations),
    iterations,
    failures: 0,
    lockedUntil: null,
    createdAt: now.toISOString(),
  };
}

/** Whether the panel is refusing tries, and until when. */
export function lockedUntil(record: PinRecord, now: Date): Date | null {
  if (!record.lockedUntil) return null;
  const until = new Date(record.lockedUntil);
  return until.getTime() > now.getTime() ? until : null;
}

export type PinAttempt =
  | { kind: "accepted"; record: PinRecord }
  | { kind: "refused"; record: PinRecord; triesLeft: number }
  | { kind: "locked"; record: PinRecord; until: Date };

/**
 * Try a PIN against the record, and say what the record becomes.
 *
 * While locked out nothing is checked at all — not even the right PIN — so the
 * lockout cannot be used to test guesses. The fifth wrong try starts the
 * lockout and resets the count, so the next five start after it ends.
 */
export async function tryPin(record: PinRecord, pin: string, now: Date): Promise<PinAttempt> {
  const locked = lockedUntil(record, now);
  if (locked) return { kind: "locked", record, until: locked };
  const given = PIN_PATTERN.test(pin) ? await hashPin(pin, fromBase64(record.salt), record.iterations) : "";
  if (given.length > 0 && sameText(given, record.hash)) {
    return { kind: "accepted", record: { ...record, failures: 0, lockedUntil: null } };
  }
  const failures = record.failures + 1;
  if (failures >= PIN_MAX_ATTEMPTS) {
    const until = new Date(now.getTime() + PIN_LOCKOUT_MS);
    return { kind: "locked", record: { ...record, failures: 0, lockedUntil: until.toISOString() }, until };
  }
  return { kind: "refused", record: { ...record, failures, lockedUntil: null }, triesLeft: PIN_MAX_ATTEMPTS - failures };
}

/** Compared in full whatever the first difference, out of habit rather than necessity. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
