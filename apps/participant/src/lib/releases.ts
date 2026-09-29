import {
  hashHex,
  instrumentVersion,
  moduleDefinition,
  releaseManifest,
  responseScale,
  scoringDefinition,
  sha256,
  verifyRawManifestHash,
  type ReleaseManifest,
} from "@myself/schema";
import { z } from "zod";
import builtInJson from "../../../../releases/ybm_nd2026_standard_r8.0.0.manifest.json";
import {
  getCachedRelease,
  getReleaseState,
  pruneCachedReleases,
  putCachedRelease,
  saveReleaseState,
  type CachedReleaseRow,
  type ReleaseStateRow,
} from "./db.js";
import { flattenManifest } from "./flatten.js";
import { POSTCODE_LISTS } from "./postcodes.js";

/**
 * Which release this device runs, and how a new one gets here (docs/16 §5.3).
 *
 * THE RULES, and each one is somebody's morning:
 *
 *   - A DEVICE NEVER WAITS ON THE NETWORK. What the start screen shows is decided
 *     from this device's own storage; the study is asked afterwards, in the
 *     background, with a timeout. A school hall with no signal gets exactly what
 *     it got yesterday.
 *   - A RELEASE IS RENDERED ONLY AFTER IT IS PROVED. Its hash is recomputed over
 *     the raw JSON, every question, scale and scoring rule is validated, and this
 *     build must be able to render what it asks for. Anything short of that is
 *     refused and the release already running carries on — a bad publish costs
 *     the new version, never a child's sitting.
 *   - A SITTING KEEPS ITS RELEASE. What changes here is which release a NEW
 *     sitting starts under; resuming one is App's business, through
 *     `releaseForHash`, and is always under the sitting's own hash.
 *   - THE BUILT-IN RELEASE (r8.0.0) IS THE FLOOR. With nothing published, nothing
 *     cached, or anything at all going wrong, the app renders what it rendered
 *     before any of this existed.
 *
 * The network and the cache are injected (`releaseService`), so everything here
 * except the Dexie wiring at the bottom runs in the unit suite.
 */

/**
 * The renderer capabilities this build has (D-49): 0.1.0 is every release to
 * r7.1.0, 0.2.0 adds placements that show a subset of a form's questions, which
 * `flattenManifest` follows. Declared here rather than imported from
 * `@myself/release/gate` because this is a statement about THIS build — a test
 * holds the two lists equal, so the gate can never stamp a version the app
 * does not know.
 */
export const SUPPORTED_ENGINE_VERSIONS = ["0.1.0", "0.2.0"] as const;

/**
 * Where a release came from:
 *   - built-in: compiled into this app;
 *   - cached: downloaded on an earlier visit and verified again when read back;
 *   - live: downloaded and verified since this page loaded.
 */
export type ReleaseSource = "built-in" | "cached" | "live";

export interface LoadedRelease {
  manifest: ReleaseManifest;
  hash: string;
  source: ReleaseSource;
}

/**
 * The fallback. Parsed at load exactly as App.tsx always parsed it, so a device
 * with nothing published renders byte-for-byte what it did before this module.
 */
export const BUILT_IN: LoadedRelease = (() => {
  const manifest = releaseManifest.parse(builtInJson);
  return { manifest, hash: manifest.hash ?? "", source: "built-in" };
})();

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type Verification =
  | { ok: true; manifest: ReleaseManifest; raw: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Whether a downloaded manifest may be rendered. Never throws.
 *
 * `expectedHash` is the hash the study's pointer named. The raw JSON must carry
 * it and must hash to it: a manifest served from the wrong document, altered in
 * transit or altered in storage is refused before it is even parsed. The hash is
 * checked over the RAW object (`verifyRawManifestHash`), because zod drops keys
 * it does not know and a check over a parsed copy would pass a manifest whose
 * unknown fields had been changed.
 *
 * Nothing is mutated: zod returns new objects, and the raw JSON is what App
 * flattens, exactly as it always flattened the built-in manifest.
 */
const assetHashes = new Map<string, Promise<string>>();

/** `sha256:<hex>` of a bundled file, over its UTF-8 bytes as the release pins it; computed once. */
function bundledAssetHash(key: string, text: string): Promise<string> {
  let hash = assetHashes.get(key);
  if (!hash) {
    hash = crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((digest) => {
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `sha256:${hex}`;
    });
    assetHashes.set(key, hash);
  }
  return hash;
}

export async function verifyRelease(
  json: string,
  expectedHash: string,
  options: { surveyId?: string } = {},
): Promise<Verification> {
  try {
    return await verify(json, expectedHash, options);
  } catch (error) {
    return { ok: false, reason: `it could not be checked (${explain(error)})` };
  }
}

async function verify(json: string, expectedHash: string, options: { surveyId?: string }): Promise<Verification> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return refuse("it is not valid JSON");
  }
  if (!isRecord(raw)) return refuse("it is not a release manifest");
  if (raw["hash"] !== expectedHash) {
    return refuse(`it carries the hash ${String(raw["hash"]).slice(0, 19)}…, not the ${expectedHash.slice(0, 19)}… the study published`);
  }
  if (!(await verifyRawManifestHash(raw))) {
    return refuse("its content does not match its hash, so it was changed after it was published");
  }

  /**
   * Engine support before the schema, for the sake of the reason given. A release
   * that needs a newer renderer may well use fields this build's schema does not
   * know; "this iPad needs the newer app" is the true explanation and "invalid"
   * would send somebody looking for a broken release.
   */
  const release = isRecord(raw["release"]) ? raw["release"] : {};
  const engine = release["engineVersion"];
  if (typeof engine !== "string" || !(SUPPORTED_ENGINE_VERSIONS as readonly string[]).includes(engine)) {
    return refuse(`it needs survey engine ${String(engine)}, and this version of the app renders ${SUPPORTED_ENGINE_VERSIONS.join(" and ")}`);
  }

  const parsed = releaseManifest.safeParse(raw);
  if (!parsed.success) return refuse(`it does not match the release format (${firstIssue(parsed.error)})`);
  const manifest = parsed.data;

  if (options.surveyId !== undefined && manifest.release.assessment !== options.surveyId) {
    return refuse(`it is a release of '${manifest.release.assessment}', not '${options.surveyId}'`);
  }

  // Every frozen question, in full. The manifest schema holds instruments as
  // `unknown`, so without this a malformed question would first be noticed by
  // the screen trying to draw it in front of a child.
  for (const [refKey, def] of Object.entries(manifest.instruments)) {
    const schema = isRecord(def) && def["kind"] === "module" ? moduleDefinition : instrumentVersion;
    const result = schema.safeParse(def);
    if (!result.success) return refuse(`'${refKey}' is not a valid instrument (${firstIssue(result.error)})`);
  }
  for (const [key, scale] of Object.entries(manifest.scales)) {
    const result = responseScale.safeParse(scale);
    if (!result.success) return refuse(`scale '${key}' is not valid (${firstIssue(result.error)})`);
  }
  for (const [key, scoring] of Object.entries(manifest.scoring)) {
    const result = scoringDefinition.safeParse(scoring);
    if (!result.success) return refuse(`scoring '${key}' is not valid (${firstIssue(result.error)})`);
  }
  // Every file the release pins must be one this build carries, byte for byte
  // (D-52). A postcode list the app does not have would quietly switch the
  // check off; a different one would check against the wrong list.
  for (const [key, pin] of Object.entries(manifest.assets)) {
    const text = POSTCODE_LISTS[key];
    if (text === undefined) return refuse(`it needs the file '${key}', which this version of the app does not carry`);
    if ((await bundledAssetHash(key, text)) !== pin.sha256) {
      return refuse(`its file '${key}' is not the one this version of the app carries`);
    }
  }

  let units: ReturnType<typeof flattenManifest>["units"];
  try {
    units = flattenManifest(manifest).units;
  } catch (error) {
    return refuse(`its questions cannot be laid out (${explain(error)})`);
  }

  // What the screens assume without checking: every option list a question
  // names is in the release, and every format rule compiles. The publish gate
  // ensures both; a manifest that got past it some other way would otherwise
  // show a question with no options, or throw the moment a child typed.
  const patterns: [string, string][] = [];
  if (manifest.composition.participantCode) patterns.push(["the participant code", manifest.composition.participantCode.pattern]);
  for (const unit of units) {
    const item = unit.item;
    const where = `${unit.instrument}.${item.key}`;
    if ("scale" in item && !(item.scale in manifest.scales)) return refuse(`${where} uses scale '${item.scale}', which it does not include`);
    if (item.responseType === "text_short" && item.pattern !== undefined) patterns.push([where, item.pattern]);
    if (item.responseType === "form_fields") {
      for (const field of item.fields) if (field.pattern !== undefined) patterns.push([`${where}.${field.key}`, field.pattern]);
    }
  }
  for (const [where, pattern] of patterns) {
    try {
      new RegExp(pattern);
    } catch {
      return refuse(`the format rule for ${where} is not a valid pattern`);
    }
  }

  return { ok: true, manifest, raw };
}

// ---------------------------------------------------------------------------
// The study's public documents (Firestore REST, docs/16 §5.2)
// ---------------------------------------------------------------------------

/** What `published/{surveyId}` says is live. Only the hash is required. */
export interface PublishedPointer {
  hash: string;
  version: string | null;
  releaseKey: string | null;
  engineVersion: string | null;
  generation: number | null;
  publishedAt: string | null;
}

const stringField = z.object({ stringValue: z.string() });

const pointerDocument = z.object({
  fields: z.object({
    hash: z.object({ stringValue: sha256 }),
    version: stringField.optional(),
    releaseKey: stringField.optional(),
    engineVersion: stringField.optional(),
    // Firestore's REST API writes 64-bit integers as strings.
    generation: z.object({ integerValue: z.union([z.string(), z.number()]) }).optional(),
    publishedAt: z.object({ timestampValue: z.string() }).optional(),
  }),
});

const releaseDocument = z.object({
  fields: z.object({
    manifest: stringField,
    hash: stringField.optional(),
  }),
});

/** A pointer document as the REST API returns it, or null when it is not one. */
export function parsePointerDocument(body: unknown): PublishedPointer | null {
  const parsed = pointerDocument.safeParse(body);
  if (!parsed.success) return null;
  const f = parsed.data.fields;
  const generation = f.generation ? Number(f.generation.integerValue) : null;
  return {
    hash: f.hash.stringValue,
    version: f.version?.stringValue ?? null,
    releaseKey: f.releaseKey?.stringValue ?? null,
    engineVersion: f.engineVersion?.stringValue ?? null,
    generation: generation !== null && Number.isFinite(generation) ? generation : null,
    publishedAt: f.publishedAt?.timestampValue ?? null,
  };
}

/** A release document: the manifest as the exact string stored, and the hash it was stored under. */
export function parseReleaseDocument(body: unknown): { manifest: string; hash: string | null } | null {
  const parsed = releaseDocument.safeParse(body);
  if (!parsed.success) return null;
  return { manifest: parsed.data.fields.manifest.stringValue, hash: parsed.data.fields.hash?.stringValue ?? null };
}

export interface FetchOptions {
  transport?: typeof fetch;
  /** A school's wifi can hang a request indefinitely; nothing waits on this, but it should still end. */
  timeoutMs?: number;
}

export type PointerResult =
  | { kind: "pointer"; pointer: PublishedPointer }
  | { kind: "none" }
  | { kind: "unreachable"; reason: string };

export type ReleaseDocResult =
  | { kind: "release"; json: string; storedHash: string | null }
  | { kind: "none" }
  | { kind: "unreachable"; reason: string };

/**
 * Said when a reply is not a Firestore document at all. Same wording, and the
 * same reason, as a sync reply that did not come from the study (lib/sync.ts): a
 * school's guest network answers 200 with a login page, and naming a missing
 * field would send somebody looking for a bug in the study.
 */
const NOT_FROM_THE_STUDY = "the reply did not come from the study — this network may need signing in to";

export async function fetchPointer(source: string, surveyId: string, options: FetchOptions = {}): Promise<PointerResult> {
  const reply = await getDocument(`${source}/published/${encodeURIComponent(surveyId)}`, options);
  if (reply.kind !== "found") return reply;
  const pointer = parsePointerDocument(reply.body);
  return pointer ? { kind: "pointer", pointer } : { kind: "unreachable", reason: NOT_FROM_THE_STUDY };
}

export async function fetchReleaseDocument(source: string, hash: string, options: FetchOptions = {}): Promise<ReleaseDocResult> {
  const reply = await getDocument(`${source}/publicReleases/${hashHex(hash)}`, options);
  if (reply.kind !== "found") return reply;
  const doc = parseReleaseDocument(reply.body);
  return doc ? { kind: "release", json: doc.manifest, storedHash: doc.hash } : { kind: "unreachable", reason: NOT_FROM_THE_STUDY };
}

type DocumentReply = { kind: "found"; body: unknown } | { kind: "none" } | { kind: "unreachable"; reason: string };

/**
 * One GET, bounded. A 404 means the document does not exist — for the pointer,
 * that nothing has been published — and anything else that is not a JSON reply
 * is "could not ask", which keeps the current release.
 *
 * A plain GET with only an Accept header, so the browser sends it without a
 * CORS preflight: one round trip on a slow hall network rather than two.
 */
async function getDocument(url: string, options: FetchOptions): Promise<DocumentReply> {
  const transport = options.transport ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await transport(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 404) return { kind: "none" };
    if (!response.ok) return { kind: "unreachable", reason: `the study replied ${response.status}` };
    const body: unknown = await response.json().catch(() => undefined);
    if (body === undefined) return { kind: "unreachable", reason: NOT_FROM_THE_STUDY };
    return { kind: "found", body };
  } catch (error) {
    return { kind: "unreachable", reason: explain(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The service: what to show, and looking for something newer
// ---------------------------------------------------------------------------

export type CheckOutcome =
  /** This build was made with no study to ask (the public preview, the e2e build). */
  | { kind: "not_configured" }
  | { kind: "offline" }
  | { kind: "nothing_published" }
  | { kind: "up_to_date"; hash: string; version: string | null }
  /** A different release is now the one new sittings start under. */
  | { kind: "activated"; hash: string; version: string | null }
  /** The study's live release was looked at and will not be used. */
  | { kind: "refused"; hash: string; version: string | null; reason: string }
  | { kind: "unreachable"; reason: string }
  /** This device could not keep what it downloaded. */
  | { kind: "failed"; reason: string };

export interface CheckRecord {
  at: string;
  outcome: CheckOutcome;
}

export interface RefreshResult {
  record: CheckRecord;
  /** The release a new sitting should start under now. */
  activeHash: string;
}

/** The cache, as the service needs it. Dexie in the app; a Map in the tests. */
export interface ReleaseCache {
  get(hash: string): Promise<CachedReleaseRow | undefined>;
  put(row: CachedReleaseRow): Promise<void>;
  state(): Promise<ReleaseStateRow | undefined>;
  saveState(patch: Partial<Omit<ReleaseStateRow, "id">>): Promise<void>;
}

export interface ReleaseServiceOptions {
  builtIn: LoadedRelease;
  cache: ReleaseCache;
  /** Firestore REST base for `studies/{study}`; empty means never ask. */
  source: string;
  surveyId: string;
  transport?: typeof fetch;
  online?: () => boolean;
  now?: () => Date;
  timeoutMs?: number;
}

export interface ActiveState {
  activeHash: string;
  checkedAt: string | null;
  lastResult: CheckRecord | null;
}

export interface ReleaseService {
  /** What the start screen shows now, from this device alone. Never throws, never waits on the network. */
  resolveStartupRelease(): Promise<LoadedRelease>;
  /** Ask the study what is live, and take it if it is new and proves itself. Never throws. */
  refreshActiveRelease(): Promise<RefreshResult>;
  /** The built-in release if the hash is its, else a verified cached one, else null. */
  releaseForHash(hash: string): Promise<LoadedRelease | null>;
  /** A cached release, verified again as it is read back; null if absent or no longer acceptable. */
  cachedRelease(hash: string): Promise<LoadedRelease | null>;
  /** Verify a manifest and keep it. Returns the verification; stores only what passed. */
  cacheRelease(json: string, hash: string): Promise<Verification>;
  setActiveHash(hash: string): Promise<void>;
  activeState(): Promise<ActiveState>;
}

export function releaseService(options: ReleaseServiceOptions): ReleaseService {
  const { builtIn, cache, source, surveyId } = options;
  const online = options.online ?? (() => true);
  const now = options.now ?? (() => new Date());
  const fetchOptions: FetchOptions = {
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };

  /**
   * Releases verified since this page loaded, by hash.
   *
   * RE-VERIFIED ON READ, ONCE PER LAUNCH. A cached manifest is checked in full
   * again the first time it is read after the app starts — hash, schema, engine,
   * layout — because the rules it must pass belong to the build reading it, not
   * the one that stored it: an app rolled back to a build that renders less must
   * not trust what a newer build accepted. It costs about what parsing the
   * built-in manifest at start-up always cost. After that it is remembered here:
   * a hash names immutable content, and this build's rules do not change while it
   * runs, so a second check could only give the same answer.
   *
   * WHAT IS REMEMBERED IS THE CHECK, NOT THE COPY. The row is still looked up on
   * every read (one keyed IndexedDB get), because pruning can delete it while this
   * page runs. Answering from memory alone once let a release that had been
   * pruned — A, dropped when B went live with no sitting left under A, then
   * brought back by a rollback to A — be made active and have sittings started
   * under it, with nothing on the device to open it from at the next launch: the
   * start screen fell back to the built-in release and those sittings could not
   * be resumed. Now a pruned release counts as not held, and is downloaded and
   * stored again before anything uses it.
   */
  const verified = new Map<string, LoadedRelease>();

  const cachedRelease = async (hash: string): Promise<LoadedRelease | null> => {
    try {
      const row = await cache.get(hash);
      if (!row) {
        verified.delete(hash);
        return null;
      }
      const known = verified.get(hash);
      if (known) return known;
      const result = await verifyRelease(row.json, hash, { surveyId });
      if (!result.ok) return null;
      const loaded: LoadedRelease = { manifest: result.manifest, hash, source: "cached" };
      verified.set(hash, loaded);
      return loaded;
    } catch {
      return null;
    }
  };

  const releaseForHash = async (hash: string): Promise<LoadedRelease | null> => {
    if (hash === builtIn.hash) return builtIn;
    return cachedRelease(hash);
  };

  const storedActiveHash = async (): Promise<string> => {
    try {
      return (await cache.state())?.activeHash ?? builtIn.hash;
    } catch {
      return builtIn.hash;
    }
  };

  const resolveStartupRelease = async (): Promise<LoadedRelease> => {
    try {
      const active = await storedActiveHash();
      if (active === builtIn.hash) return builtIn;
      return (await cachedRelease(active)) ?? builtIn;
    } catch {
      return builtIn;
    }
  };

  const cacheRelease = async (json: string, hash: string): Promise<Verification> => {
    const result = await verifyRelease(json, hash, { surveyId });
    if (!result.ok) return result;
    await cache.put({
      hash,
      releaseKey: result.manifest.release.key,
      version: result.manifest.release.version,
      json,
      cachedAt: now().toISOString(),
    });
    return result;
  };

  const setActiveHash = async (hash: string): Promise<void> => {
    await cache.saveState({ activeHash: hash });
  };

  /** Everything between "ask" and "an answer", with no side effect but the cache and the pointer. */
  const check = async (activeHash: string): Promise<CheckOutcome> => {
    if (!source) return { kind: "not_configured" };
    if (!online()) return { kind: "offline" };

    const reply = await fetchPointer(source, surveyId, fetchOptions);
    if (reply.kind === "none") return { kind: "nothing_published" };
    if (reply.kind === "unreachable") return reply;
    const pointer = reply.pointer;
    const { hash } = pointer;

    // Already running it — provided it can still be loaded. A cached release
    // that has gone missing, or that this build no longer accepts, is fetched
    // and judged again rather than reported as current.
    if (hash === activeHash && (hash === builtIn.hash || (await cachedRelease(hash)))) {
      return { kind: "up_to_date", hash, version: pointer.version };
    }

    // Moving back to something this device already holds — a rollback to the
    // built-in release, or to one downloaded before — needs no download.
    const held = await releaseForHash(hash);
    if (held) {
      await setActiveHash(hash);
      return { kind: "activated", hash, version: held.manifest.release.version };
    }

    // The pointer says what the release needs; there is no point downloading a
    // manifest this build is going to refuse. The manifest's own claim is still
    // checked below, because the pointer is not what the hash covers.
    if (pointer.engineVersion !== null && !(SUPPORTED_ENGINE_VERSIONS as readonly string[]).includes(pointer.engineVersion)) {
      return {
        kind: "refused",
        hash,
        version: pointer.version,
        reason: `it needs survey engine ${pointer.engineVersion}, and this version of the app renders ${SUPPORTED_ENGINE_VERSIONS.join(" and ")}`,
      };
    }

    const doc = await fetchReleaseDocument(source, hash, fetchOptions);
    if (doc.kind === "none") {
      return { kind: "refused", hash, version: pointer.version, reason: "the study names it as live but does not hold it" };
    }
    if (doc.kind === "unreachable") return doc;
    if (doc.storedHash !== null && doc.storedHash !== hash) {
      return { kind: "refused", hash, version: pointer.version, reason: "the study holds it under a different hash" };
    }

    let result: Verification;
    try {
      result = await cacheRelease(doc.json, hash);
    } catch (error) {
      // Verified but not kept. It is not made active: a sitting started under a
      // release this device cannot read back could not be resumed.
      return { kind: "failed", reason: `the new version could not be stored on this device (${explain(error)})` };
    }
    if (!result.ok) return { kind: "refused", hash, version: pointer.version, reason: result.reason };

    verified.set(hash, { manifest: result.manifest, hash, source: "live" });
    await setActiveHash(hash);
    return { kind: "activated", hash, version: result.manifest.release.version };
  };

  const refresh = async (): Promise<RefreshResult> => {
    const before = await storedActiveHash();
    let outcome: CheckOutcome;
    try {
      outcome = await check(before);
    } catch (error) {
      outcome = { kind: "failed", reason: explain(error) };
    }
    const record: CheckRecord = { at: now().toISOString(), outcome };
    try {
      await cache.saveState({ checkedAt: record.at, lastResult: record });
    } catch {
      // The handover panel shows the in-memory result either way.
    }
    return { record, activeHash: outcome.kind === "activated" ? outcome.hash : before };
  };

  /**
   * One check at a time. The start screen asks on mount, on every return, when
   * the network comes back and on a timer; overlapping those would download the
   * same manifest twice and race two writes of the active pointer.
   */
  let inFlight: Promise<RefreshResult> | null = null;
  const refreshActiveRelease = (): Promise<RefreshResult> => {
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  const activeState = async (): Promise<ActiveState> => {
    try {
      const state = await cache.state();
      return {
        activeHash: state?.activeHash ?? builtIn.hash,
        checkedAt: state?.checkedAt ?? null,
        lastResult: asCheckRecord(state?.lastResult),
      };
    } catch {
      return { activeHash: builtIn.hash, checkedAt: null, lastResult: null };
    }
  };

  return {
    resolveStartupRelease,
    refreshActiveRelease,
    releaseForHash,
    cachedRelease,
    cacheRelease,
    setActiveHash,
    activeState,
  };
}

/**
 * What the handover panel says about the last look at the study. Plain words for
 * whoever is holding the iPad; the detail is in the reason.
 */
export function describeCheck(outcome: CheckOutcome): string {
  switch (outcome.kind) {
    case "not_configured":
      return "this build does not look for new versions of the survey.";
    case "offline":
      return "offline, so it will look for a new version when there is a connection.";
    case "nothing_published":
      return "the study has not published a version, so the one built into this app is used.";
    case "up_to_date":
      return "up to date.";
    case "activated":
      return `release ${outcome.version ?? outcome.hash.slice(7, 19)} was downloaded and verified; sittings that start from now use it.`;
    case "refused":
      return `the study's live version${outcome.version ? ` (${outcome.version})` : ""} was not used, because ${outcome.reason}. The version shown above carries on.`;
    case "unreachable":
      return `could not reach the study (${outcome.reason}).`;
    case "failed":
      return `${outcome.reason}.`;
  }
}

/** A stored check result, if it still has the shape this build writes. */
function asCheckRecord(value: unknown): CheckRecord | null {
  if (!isRecord(value) || typeof value["at"] !== "string" || !isRecord(value["outcome"])) return null;
  return typeof value["outcome"]["kind"] === "string" ? (value as unknown as CheckRecord) : null;
}

function refuse(reason: string): Verification {
  return { ok: false, reason };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "unknown problem";
  return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "the request timed out";
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// This app's instance: the Dexie cache and the build's configuration
// ---------------------------------------------------------------------------

declare const __SURVEY_SOURCE__: string;
declare const __SURVEY_ID__: string;

const service = releaseService({
  builtIn: BUILT_IN,
  cache: { get: getCachedRelease, put: putCachedRelease, state: getReleaseState, saveState: saveReleaseState },
  source: __SURVEY_SOURCE__,
  surveyId: __SURVEY_ID__,
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
});

export const {
  resolveStartupRelease,
  refreshActiveRelease,
  releaseForHash,
  cachedRelease,
  cacheRelease,
  setActiveHash,
  activeState,
} = service;

/**
 * Drop cached releases that no sitting on this device, and no screen, can use.
 * `keep` is whatever the caller has in use. Never throws: a release kept a
 * little longer than needed costs a few hundred kilobytes.
 */
export async function pruneReleases(keep: readonly string[]): Promise<string[]> {
  try {
    return await pruneCachedReleases(keep);
  } catch {
    return [];
  }
}
