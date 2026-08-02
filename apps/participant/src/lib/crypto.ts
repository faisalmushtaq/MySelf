/**
 * At-rest encryption for locally stored response payloads (AES-GCM via
 * WebCrypto). The device key is generated non-extractable on first launch and
 * persisted as a CryptoKey in IndexedDB (structured clone preserves
 * non-extractability).
 *
 * Scope (docs/05 §3, decision D-13): this protects against casual extraction
 * of the database. Server-side key escrow for recovery arrives with device
 * enrolment in the sync phase.
 */

export async function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  iv: Uint8Array;
  data: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify(value));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv, data };
}

export async function unseal<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv as BufferSource }, key, sealed.data as BufferSource);
  return JSON.parse(dec.decode(plaintext)) as T;
}
