import { activeReleaseDoc, publishedPaths, type ActiveReleaseDoc } from "@myself/schema";
import type { PublishedSource } from "./versions.js";

/**
 * Reading the study's published versions (D-54), over plain HTTPS.
 *
 * NO FIREBASE SDK, for the same reasons `device.ts` gives: the app's first
 * requirement is to work with no network, and a whole SDK to read two
 * documents is weight on every iPad. Firestore answers the same reads over its
 * REST API, and both documents are readable by anyone (`firestore.rules`), so
 * no credential is needed and nothing here depends on the device having one.
 *
 * `batchGet` rather than a GET on the document's URL, because a version's
 * document id is its hash, `sha256:…`, and a colon in the last segment of a
 * Google API path is read as a method name. Named in the body, it is just a
 * name.
 *
 * WHERE IS BAKED IN, like the upload endpoint: the project comes from the
 * build's Firebase config, so the survey cannot be pointed at somebody else's
 * questionnaire from the page. `MYSELF_FIRESTORE_HOST` points a test build at
 * the emulator.
 */

declare const __FIRESTORE_HOST__: string;
declare const __FIREBASE_PROJECT__: string;
declare const __STUDY__: string;

export interface StudyDatabase {
  /** `https://firestore.googleapis.com`, or the emulator. */
  host: string;
  project: string;
  study: string;
}

/** The study this build reads its live version from, or null when it has none. */
export function configuredStudy(): StudyDatabase | null {
  if (!__FIREBASE_PROJECT__ || !__FIRESTORE_HOST__) return null;
  return { host: __FIRESTORE_HOST__.replace(/\/$/, ""), project: __FIREBASE_PROJECT__, study: __STUDY__ || "ybm" };
}

/** Firestore's typed JSON, as its REST API returns a document's fields. */
type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { nullValue: null }
  | { mapValue: { fields?: Record<string, Value> } }
  | { arrayValue: { values?: Value[] } };

function plain(value: Value): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return plainFields(value.mapValue.fields ?? {});
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(plain);
  return undefined;
}

function plainFields(fields: Record<string, Value>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, plain(value)]));
}

/** The published versions of `study`, read over Firestore's REST API. */
export function studySource(study: StudyDatabase, transport: typeof fetch = fetch): PublishedSource {
  const database = `projects/${study.project}/databases/(default)`;

  /** One document, as plain values, or null when it does not exist. Throws when the study cannot be asked. */
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    const response = await transport(`${study.host}/v1/${database}/documents:batchGet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [`${database}/documents/${path}`] }),
      // Always the study's answer now, never a copy a cache kept.
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`the study's database answered ${response.status}`);
    const body: unknown = await response.json().catch(() => null);
    const entry = Array.isArray(body) ? (body[0] as { found?: { fields?: Record<string, Value> }; missing?: string }) : null;
    // A school's guest network answers with its own sign-in page. That is not
    // the study saying there is no version.
    if (!entry || (!entry.found && !entry.missing)) throw new Error("the reply did not come from the study");
    return entry.found ? plainFields(entry.found.fields ?? {}) : null;
  };

  return {
    async activeRelease(): Promise<ActiveReleaseDoc | null> {
      const document = await read(publishedPaths.activeRelease(study.study));
      if (!document) return null;
      const parsed = activeReleaseDoc.safeParse(document);
      if (!parsed.success) throw new Error("the active-version record is not in the expected shape");
      return parsed.data;
    },
    async release(hash: string): Promise<unknown> {
      return read(publishedPaths.release(study.study, hash));
    },
  };
}
