/**
 * The address finder, from the iPad's side (D-81).
 *
 * While someone types in "Start typing your address" (D-80), this asks the
 * study's `findAddress` function for whole West Yorkshire addresses, and fetches
 * the one they choose. It is an extra, never a requirement: offline, in a build
 * without a study, or the first time the finder fails, it answers null and goes
 * quiet for the rest of the session, and the street list on the iPad answers
 * instead. A child never sees an error from it.
 *
 * It holds no credential of its own. The app hands it the iPad's at startup
 * (`provideAddressCredential`, main.tsx), so this module never reaches the
 * device's identity or storage, and the Studio's preview, which renders the
 * same screens with nothing handed over, never asks at all.
 */

export interface FoundAddress {
  house: string;
  street: string;
  postcode: string;
  area: string;
  postcodeDistrict: string;
  uprn: string;
}

export interface Suggestion {
  id: string;
  label: string;
}

interface Options {
  url?: string;
  credential?: () => Promise<string | null>;
  online?: () => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Set once the finder has failed: for the rest of the session the street list answers alone. */
let down = false;

/** For tests: forget that the finder failed. */
export function resetAddressFinder(): void {
  down = false;
}

/** Where the finder answers in this build; empty where there is none (the preview, the Studio). */
const BUILT_URL = typeof __ADDRESS_URL__ === "string" ? __ADDRESS_URL__ : "";
const BUILT_STUDY = typeof __STUDY__ === "string" ? __STUDY__ : "";

/** Whether this build has a finder to ask at all. */
export const addressFinderBuilt = Boolean(BUILT_URL);

/** The iPad's credential, as `Authorization` sends it; set by the app at startup. */
let credentialSource: (() => Promise<string | null>) | null = null;

export function provideAddressCredential(source: () => Promise<string | null>): void {
  credentialSource = source;
}

async function ask<T>(body: Record<string, string>, opts: Options): Promise<T | null> {
  const url = opts.url ?? BUILT_URL;
  const online = opts.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  if (down || !url || !online()) return null;
  const source = opts.credential ?? credentialSource;
  const credential = source ? await source() : null;
  if (!credential) return null;
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: credential },
      body: JSON.stringify({ ...body, ...(BUILT_STUDY ? { study: BUILT_STUDY } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
    });
    if (!res.ok) {
      down = true;
      return null;
    }
    const answer = (await res.json()) as { status?: string } & T;
    if (answer.status === "unavailable") down = true;
    return answer;
  } catch {
    // No reply in time, or no network after all.
    down = true;
    return null;
  }
}

/** Addresses matching what has been typed; null when the finder cannot answer, so the street list should. */
export async function suggestAddresses(text: string, opts: Options = {}): Promise<Suggestion[] | null> {
  const search = text.replace(/\s+/g, " ").trim();
  if (search.replace(/[^A-Za-z0-9]/g, "").length < 3) return null;
  const answer = await ask<{ status: string; suggestions?: Suggestion[] }>({ search }, opts);
  return answer?.status === "suggestions" && Array.isArray(answer.suggestions) ? answer.suggestions : null;
}

/** The whole address for a suggestion chosen; null when it could not be fetched. */
export async function pickAddress(id: string, opts: Options = {}): Promise<FoundAddress | null> {
  const answer = await ask<{ status: string; address?: FoundAddress }>({ pick: id }, opts);
  return answer?.status === "picked" && answer.address ? answer.address : null;
}
