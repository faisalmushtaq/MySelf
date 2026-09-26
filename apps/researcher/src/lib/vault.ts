/**
 * The identity vault.
 *
 * WHAT THIS IS FOR. The researcher view holds the only identifying data in the
 * platform: given and family names, dates of birth, UPNs, NHS numbers, and every
 * code a child has ever typed. All of it sat in IndexedDB in the clear, in a
 * browser with no sign-in, no lock and no timeout, on a laptop that goes home in
 * a bag. The participant app — which holds strictly less sensitive data — has
 * encrypted its storage since the first version.
 *
 * The rest of the platform separates identity properly: it lives in a different
 * Firebase project with different IAM, reachable only server-side. This is that
 * boundary's one weak end, and it is the end a person actually uses.
 *
 * SEALED FIELD BY FIELD, NOT DATABASE BY DATABASE. Dexie has no encrypted-store
 * mode, and encrypting the whole table would mean decrypting all of it to answer
 * anything. So each person's identifying fields travel as one sealed blob and the
 * participant code stays in the clear as the key — the code is already the join
 * used everywhere else, it is in the sittings and the export, and pretending it
 * is a secret here while it is a filename there would be theatre.
 *
 * NOTHING BREAKS BY DOING IT. Every lookup in this app is either `get(code)` or a
 * full scan filtered in memory: the `familyName` and `upn` Dexie indexes are
 * declared and never actually used as indexes. So sealing those fields costs no
 * query — which is the only reason this could be a small change rather than a
 * rewrite of the linkage tab.
 *
 * THE PASSPHRASE IS NEVER STORED. What is stored is a random salt and a verifier:
 * a known string sealed under the derived key, so a wrong passphrase is reported
 * as a wrong passphrase instead of surfacing later as a person whose name is
 * mojibake. The key lives in memory for the length of a session at the laptop and
 * goes when the tab does.
 */

const KDF_ITERATIONS = 600_000;
const VERIFIER = "myself.identity.vault.v1";

export interface VaultRecord {
  id: "vault";
  salt: string;
  iterations: number;
  /** VERIFIER, sealed. Proves a passphrase without storing it. */
  check: { iv: string; data: string };
  createdAt: string;
}

export interface Sealed {
  iv: string;
  data: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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

export async function sealWith(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value))),
  );
  return { iv: toBase64(iv), data: toBase64(data) };
}

export async function openWith<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv) as BufferSource },
    key,
    fromBase64(sealed.data) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** A first passphrase, for a vault that does not exist yet. */
export async function createVault(passphrase: string): Promise<{ record: VaultRecord; key: CryptoKey }> {
  const complaint = passphraseComplaint(passphrase);
  if (complaint) throw new Error(complaint);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(passphrase, salt, KDF_ITERATIONS);
  return {
    record: {
      id: "vault",
      salt: toBase64(salt),
      iterations: KDF_ITERATIONS,
      check: await sealWith(key, VERIFIER),
      createdAt: new Date().toISOString(),
    },
    key,
  };
}

/**
 * Unlock an existing vault, or say plainly that the passphrase is wrong.
 *
 * Distinguishable from a damaged store precisely because the verifier's plaintext
 * is known: if it decrypts to anything other than VERIFIER the store is damaged,
 * and if it will not decrypt at all the passphrase is wrong.
 */
export async function openVault(record: VaultRecord, passphrase: string): Promise<CryptoKey> {
  const key = await derive(passphrase, fromBase64(record.salt), record.iterations);
  let check: string;
  try {
    check = await openWith<string>(key, record.check);
  } catch {
    throw new Error("that is not the passphrase this vault was locked with");
  }
  if (check !== VERIFIER) throw new Error("this vault's contents are damaged and were not opened");
  return key;
}

export function passphraseComplaint(passphrase: string): string | null {
  if (passphrase.trim().length < 12) return "use at least 12 characters — a phrase of real words is ideal";
  return null;
}
