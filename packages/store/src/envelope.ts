/**
 * The handover file, encrypted.
 *
 * WHY. A device that cannot reach the study hands its sittings over as a file,
 * and that file was plaintext JSON: every answer a child gave, moving between an
 * iPad and a laptop by AirDrop, a USB stick or an email, with nothing but a
 * comment in the code asking for it to be treated carefully. The device's own
 * database is AES-GCM sealed; the file it writes was not, which made the
 * encryption at rest largely decorative — the data left by the unlocked door.
 *
 * SHARED BY BOTH APPS, from here, rather than implemented twice. A format with
 * two implementations has two chances to disagree about an iteration count or a
 * base64 boundary, and the failure would be a file the researcher view cannot
 * open on the one day it matters.
 *
 * THE PASSPHRASE IS THE STUDY'S, NOT THE DEVICE'S. Every iPad on a study uses the
 * same one, so a researcher with six devices on a table types it six times rather
 * than keeping six secrets, and the researcher view needs one phrase to read
 * whatever arrives. It is never stored on the device: it is typed at export and
 * typed again at import, and an iPad that is lost surrenders no way to read the
 * files it wrote.
 *
 * FORGETTING IT IS RECOVERABLE, which is what makes it safe to insist on. A file
 * nobody can open is not lost data: exporting does not remove anything from the
 * device, so the sitting is still there and can be exported again. That is the
 * whole reason this can be the only format rather than an option somebody turns
 * on for the careful days.
 *
 * PBKDF2 WITH A PER-FILE SALT. Not because a study passphrase is a good secret —
 * it is typed by people, so it is not — but because the work factor is what
 * stands between a guessable phrase and an offline attack on a file that has
 * fallen out of a bag. 600,000 iterations of SHA-256 is the current OWASP figure
 * and costs well under a second on an iPad.
 */

const KDF_ITERATIONS = 600_000;

export const ENCRYPTED_FORMAT = "myself.device.export.v1.encrypted";

export interface EncryptedEnvelope {
  format: typeof ENCRYPTED_FORMAT;
  /** When the file was written, in the clear so a folder of them sorts. */
  exportedAt: string;
  /**
   * How many sittings are inside.
   *
   * In the clear deliberately: a researcher checking that a handover produced
   * the expected number of sittings should not have to decrypt to find out, and
   * a count reveals nothing about anybody.
   */
  sittings: number;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  iv: string;
  data: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  // Chunked: a spread over a 3 MB log exceeds the argument limit and throws a
  // RangeError that reads like a corrupt export rather than a big one.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A passphrase somebody will actually be able to type onto an iPad twice.
 *
 * Long rather than fiddly: length is what a work factor multiplies, and a phrase
 * with a symbol somebody cannot find on an iPad keyboard gets written on a
 * whiteboard instead.
 */
export function passphraseComplaint(passphrase: string): string | null {
  if (passphrase.trim().length < 12) return "use at least 12 characters — a short phrase of real words is ideal";
  return null;
}

export async function sealExport(payload: unknown, passphrase: string, sittings: number): Promise<EncryptedEnvelope> {
  const complaint = passphraseComplaint(passphrase);
  if (complaint) throw new Error(complaint);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passphrase, salt, KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));

  return {
    format: ENCRYPTED_FORMAT,
    exportedAt: new Date().toISOString(),
    sittings,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: toBase64(salt) },
    iv: toBase64(iv),
    data: toBase64(data),
  };
}

/** Whether a parsed file is one of these, without trusting it any further. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["format"] === ENCRYPTED_FORMAT &&
    typeof record["iv"] === "string" &&
    typeof record["data"] === "string" &&
    typeof record["kdf"] === "object"
  );
}

/**
 * Open one, or say which of the two things went wrong.
 *
 * A wrong passphrase and a damaged file both surface from WebCrypto as the same
 * bare `OperationError`, and the two call for opposite responses — type it again,
 * or go back to the device that wrote this. GCM cannot actually tell them apart,
 * so this does not pretend to: it says so, and names both next steps, which is
 * more use than a word that might be wrong.
 */
export async function openExport(envelope: EncryptedEnvelope, passphrase: string): Promise<unknown> {
  const { kdf } = envelope;
  if (kdf?.name !== "PBKDF2" || kdf.hash !== "SHA-256" || !Number.isInteger(kdf.iterations)) {
    throw new Error("this file was written by a version of the app this one cannot read");
  }
  // A file could otherwise ask for a billion iterations and hang the importer.
  if (kdf.iterations < 100_000 || kdf.iterations > 5_000_000) {
    throw new Error("this file asks for an unreasonable amount of key work and was not opened");
  }

  const key = await keyFrom(passphrase, fromBase64(kdf.salt), kdf.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource },
      key,
      fromBase64(envelope.data) as BufferSource,
    );
  } catch {
    throw new Error(
      "could not open this file: either the passphrase is not the one it was written with, or the file has been damaged in transit",
    );
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
