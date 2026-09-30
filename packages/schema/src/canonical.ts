/**
 * Canonical JSON and the release content hash, in a form any runtime can use.
 *
 * A release is identified by `sha256:` over the canonical JSON of its manifest
 * with `hash` absent (docs/06 §1). The server computes it when it publishes;
 * the participant app recomputes it before it will render a release it
 * fetched, so a manifest altered in transit — or served from the wrong
 * document — is refused rather than shown to a child. Both sides have to agree
 * to the byte, so there is exactly one implementation of the serialisation,
 * here, and the digest comes from WebCrypto, which Node 22 and every browser
 * the study supports provide as `globalThis.crypto.subtle`.
 *
 * JCS-style: object keys sorted by UTF-16 code unit, no insignificant
 * whitespace, `undefined` members dropped (as JSON.stringify does).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The two WebCrypto pieces needed, typed locally: this package compiles
 * against plain ES2022 so it can be used from Node and from browsers without
 * either's type library.
 */
interface Web {
  crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  TextEncoder?: new () => { encode(input: string): Uint8Array };
}

/** `sha256:<hex>` of a value's canonical JSON, via WebCrypto. */
export async function contentHashAsync(value: unknown): Promise<string> {
  const web = globalThis as unknown as Web;
  const subtle = web.crypto?.subtle;
  if (!subtle || !web.TextEncoder) throw new Error("WebCrypto is not available here, so a release cannot be verified");
  const digest = await subtle.digest("SHA-256", new web.TextEncoder().encode(canonicalJson(value)));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Whether raw manifest JSON carries the hash of its own content.
 *
 * Deliberately over the RAW parsed JSON, not over a schema-parsed copy: zod
 * drops keys it does not know, so verifying a parsed manifest would fail for
 * any release that uses a field newer than the reader — or, worse, pass for a
 * manifest whose unknown fields had been tampered with.
 */
export async function verifyRawManifestHash(raw: unknown): Promise<boolean> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const { hash, ...body } = raw as Record<string, unknown>;
  if (typeof hash !== "string") return false;
  return (await contentHashAsync(body)) === hash;
}

/** The hex part of a `sha256:` hash — what the release store keys documents by. */
export function hashHex(hash: string): string {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}
