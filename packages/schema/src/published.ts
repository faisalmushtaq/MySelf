import { z } from "zod";
import { releaseManifest, type ReleaseManifest } from "./assessment.js";
import { sha256 } from "./identifiers.js";

/**
 * Versions published from the dashboard (D-54), as everything here reads them.
 *
 * The dashboard's functions write a published version into this study's
 * database with the Admin SDK. The participant app, the functions, the
 * researcher view and `scripts/pull-releases.mjs` all read it back. They share
 * this one description of where it lives, what it looks like and when it may
 * be trusted, so the four readers cannot drift apart on any of those.
 *
 * NOTHING HERE TRUSTS THE DATABASE. A published version is only used once its
 * manifest hashes to the hash it was published under, and that hash is the
 * same canonical-JSON SHA-256 that `packages/release` puts on every release it
 * cuts. So a version from the dashboard and one cut with `publish.mjs` are
 * checked in exactly the same way.
 */

/** Where published versions live in the survey's `(default)` database. */
export const publishedPaths = {
  /** One document per published version, keyed by its content hash. */
  releases: (study: string) => `studies/${study}/releases`,
  release: (study: string, hash: string) => `studies/${study}/releases/${hash}`,
  /** Which version new sittings use. */
  activeRelease: (study: string) => `studies/${study}/config/activeRelease`,
};

/**
 * `studies/{study}/releases/{hash}`.
 *
 * Only the hash and the manifest are needed to use a version; the rest is
 * provenance for people. So the rest is read loosely: a missing `notes`, or a
 * `publishedAt` stored as a timestamp rather than a string, must not stop a
 * sitting from being read.
 */
export const publishedReleaseDoc = z.object({
  hash: sha256,
  /** The whole manifest as JSON, including its own `hash`. */
  manifestJson: z.string().min(1),
  version: z.string().optional(),
  key: z.string().optional(),
  study: z.string().optional(),
  publishedAt: z.unknown().optional(),
  publishedBy: z.string().optional(),
  engineVersion: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
});
export type PublishedReleaseDoc = z.infer<typeof publishedReleaseDoc>;

/** `studies/{study}/config/activeRelease`. */
export const activeReleaseDoc = z.object({
  hash: sha256,
  version: z.string().optional(),
  key: z.string().optional(),
  activatedAt: z.unknown().optional(),
  activatedBy: z.string().optional(),
});
export type ActiveReleaseDoc = z.infer<typeof activeReleaseDoc>;

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, undefined
 * members dropped.
 *
 * A COPY OF `packages/release/src/canonical.ts`, ON PURPOSE. That file uses
 * Node's `crypto` and is vendored unchanged into the dashboard, so it cannot be
 * the one a browser imports. `packages/release/src/web-hash.test.ts` holds the
 * two to the same answer on every committed manifest, so a change to one that
 * is not made to the other fails there rather than in the field.
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
 * The content hash of a manifest, computed with its own `hash` left out.
 *
 * WebCrypto rather than Node's `crypto`, so the same code runs on an iPad, in a
 * researcher's browser and in the functions (Node 22 has it as a global).
 */
export async function manifestContentHash(manifest: unknown): Promise<string> {
  const body = { ...(manifest as Record<string, unknown>) };
  delete body["hash"];
  const bytes = new TextEncoder().encode(canonicalJson(body));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Whether an engine can run a release built for another engine version.
 *
 * The rule: the same MAJOR, and a MINOR no newer than this engine's. A MINOR
 * adds something a release may use, such as a new response type, so an older
 * engine cannot run a release that needs it. A PATCH changes nothing a release
 * can ask for, so it is ignored. A different MAJOR is a different engine.
 */
export function engineCanRun(engine: string, required: string): boolean {
  const ours = /^(\d+)\.(\d+)\.(\d+)$/.exec(engine);
  const theirs = /^(\d+)\.(\d+)\.(\d+)$/.exec(required);
  if (!ours || !theirs) return false;
  return ours[1] === theirs[1] && Number(theirs[2]) <= Number(ours[2]);
}

export type OpenedRelease =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; problem: string };

/**
 * Check a published manifest and parse it, or say why it cannot be used.
 *
 * In order, and each is a reason to refuse:
 *   - it is JSON;
 *   - its content hashes to `expectedHash`, the hash it was published and
 *     asked for under, and says so in its own `hash` field;
 *   - the release schema accepts it;
 *   - when `engineVersion` is given, that engine can run it.
 *
 * The hash is checked before the schema so that a tampered manifest is
 * reported as tampered, not as merely malformed.
 */
export async function openPublishedManifest(
  manifestJson: string,
  expectedHash: string,
  options: { engineVersion?: string } = {},
): Promise<OpenedRelease> {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    return { ok: false, problem: "its manifest is not JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problem: "its manifest is not an object" };
  }
  const computed = await manifestContentHash(raw);
  if (computed !== expectedHash) {
    return { ok: false, problem: `its content hashes to ${computed.slice(0, 19)}…, not ${expectedHash.slice(0, 19)}…` };
  }
  if ((raw as { hash?: unknown }).hash !== expectedHash) {
    return { ok: false, problem: "its manifest carries a different hash from the one it was published under" };
  }
  const parsed = releaseManifest.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, problem: `the release schema refuses it (${first ? `${first.path.join(".")}: ${first.message}` : "no detail"})` };
  }
  const required = parsed.data.release.engineVersion;
  if (options.engineVersion !== undefined && !engineCanRun(options.engineVersion, required)) {
    return { ok: false, problem: `it needs engine ${required}, and this build has ${options.engineVersion}` };
  }
  return { ok: true, manifest: parsed.data };
}

/** The same checks, starting from the database document. */
export async function openPublishedRelease(
  document: unknown,
  options: { expectedHash?: string; engineVersion?: string } = {},
): Promise<OpenedRelease> {
  const doc = publishedReleaseDoc.safeParse(document);
  if (!doc.success) return { ok: false, problem: "it is not a published-version document" };
  const expectedHash = options.expectedHash ?? doc.data.hash;
  if (doc.data.hash !== expectedHash) {
    return { ok: false, problem: "it is filed under a different hash from the one asked for" };
  }
  return openPublishedManifest(doc.data.manifestJson, expectedHash, options);
}
