/**
 * The home address, as the identity partition carries it (r8.0.0 on, D-52).
 *
 * Ingest files the answer as one identity row whose value is the JSON of the
 * fields the participant gave — `{postcode, house, street}`, any part absent.
 * Everything that keeps it (the Firebase identity service, the API's identity
 * schema, the researcher view) reads it through here, so a malformed value is
 * dropped the same way everywhere instead of being stored as a string.
 */
export interface HomeAddress {
  postcode?: string;
  house?: string;
  street?: string;
}

const PARTS = ["postcode", "house", "street"] as const;

/** The address in an identity row's value, or null when it holds nothing usable. Kept as given, trimmed. */
export function parseHomeAddress(raw: string | null | undefined): HomeAddress | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: HomeAddress = {};
  for (const part of PARTS) {
    const v = (parsed as Record<string, unknown>)[part];
    if (typeof v === "string" && v.trim() !== "") out[part] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/** One line for a person reading it: "12 Hyde Park Road, LS6 2AA". */
export function formatHomeAddress(address: HomeAddress | null | undefined): string | null {
  if (!address) return null;
  const line = [address.house, address.street].filter(Boolean).join(" ");
  const out = [line, address.postcode].filter(Boolean).join(", ");
  return out === "" ? null : out;
}
