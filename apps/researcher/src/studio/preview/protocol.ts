import { releaseManifest, type ReleaseManifest } from "@myself/schema";

/**
 * What the Studio and the preview frame say to each other — docs/16 §5.6.
 *
 * The frame is a separate document so that the participant's stylesheet, and
 * nothing of the Studio's, applies inside it. The two talk only by
 * `postMessage`, and each side accepts a message only when all three hold:
 *
 * - it came from this origin (a page on any other site is ignored);
 * - it came from the one window expected — the Studio listens only to its own
 *   iframe, the frame only to its parent — so another tab on the same origin,
 *   or another frame on the page, cannot drive either side;
 * - it has exactly the shape below. Anything else is dropped without comment:
 *   a message that is not ours is not an error, it is somebody else's.
 *
 * The nonce ties replies to the load they answer. Every load gets a new one,
 * and state carrying an old nonce — sent by the frame just before a restart —
 * is ignored rather than painted over the new run.
 */

export const MSG_LOAD = "studio-preview:load";
export const MSG_GOTO = "studio-preview:goto";
export const MSG_STATE = "studio-preview:state";
export const MSG_READY = "studio-preview:ready";

/** Where a load starts: an item key, one of the two end screens, or the start screen. */
export type StartAt = string | null;
export const START_FINISH = "finish";
export const START_REVIEW = "review";

/** Studio → frame: run this release from here, forgetting everything before. */
export interface LoadMessage {
  type: typeof MSG_LOAD;
  nonce: string;
  manifest: ReleaseManifest;
  startAt: StartAt;
}

/**
 * Studio → frame: move to this screen, keeping the answers given so far.
 *
 * Separate from a load, which starts over. Clicking a question in the path
 * panel should put the researcher there with the answers that decide what is
 * shown intact, or seeing why something is hidden would mean answering
 * everything again.
 */
export interface GotoMessage {
  type: typeof MSG_GOTO;
  nonce: string;
  /** An item key, "finish" or "review". */
  target: string;
}

/** Frame → Studio: the frame is listening and can take a load. */
export interface ReadyMessage {
  type: typeof MSG_READY;
}

export const PHASES = ["start", "running", "checkin", "pace", "review", "finished", "error"] as const;
export type PreviewPhase = (typeof PHASES)[number];

export const VISIBILITIES = ["shown", "hidden", "not_reached"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Frame → Studio: where the run is and what has been answered. */
export interface StateMessage {
  type: typeof MSG_STATE;
  nonce: string;
  phase: PreviewPhase;
  /** Unit index on screen (running), or the one a check-in returns to; otherwise null. */
  index: number | null;
  itemKey: string | null;
  /** Item key → the answer as a participant would read it back, shortened. */
  answers: Record<string, string>;
  visibility: Record<string, Visibility>;
  /** Set with phase "error": why the frame could not show this release. */
  error?: string;
}

// Generous bounds, there to keep a malformed message from being expensive
// rather than to police real ones: r7.1.0 has 170 units.
const MAX_KEY = 200;
const MAX_ENTRIES = 5000;
const MAX_ANSWER = 400;
const MAX_ERROR = 4000;

const NONCE = /^[A-Za-z0-9_-]{8,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isShortString = (v: unknown, max = MAX_KEY): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isNonce = (v: unknown): v is string => typeof v === "string" && NONCE.test(v);

/** A fresh nonce for one load. */
export function newNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  // Only reached outside a secure context. The nonce matches replies to loads,
  // it is not a secret, so this does not need to be unguessable.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(8, "0");
}

/**
 * Whether a message event came from where it should.
 *
 * `source` is compared by identity. A null expected source never matches, so
 * a Studio whose iframe has gone accepts nothing rather than everything.
 */
export function fromExpected(
  event: { origin: string; source: unknown },
  expected: { origin: string; source: unknown },
): boolean {
  return expected.source != null && event.source === expected.source && event.origin === expected.origin;
}

export function parseLoad(data: unknown): LoadMessage | null {
  if (!isRecord(data) || data["type"] !== MSG_LOAD || !isNonce(data["nonce"])) return null;
  const startAt = data["startAt"];
  if (startAt !== null && !isShortString(startAt)) return null;
  // The manifest is parsed in full, not trusted because the Studio compiled
  // it: whatever reaches the participant's components has passed the same
  // schema the participant app holds a release to.
  const parsed = releaseManifest.safeParse(data["manifest"]);
  if (!parsed.success) return null;
  return { type: MSG_LOAD, nonce: data["nonce"], manifest: parsed.data, startAt };
}

export function parseGoto(data: unknown): GotoMessage | null {
  if (!isRecord(data) || data["type"] !== MSG_GOTO || !isNonce(data["nonce"])) return null;
  if (!isShortString(data["target"])) return null;
  return { type: MSG_GOTO, nonce: data["nonce"], target: data["target"] };
}

export function isReady(data: unknown): data is ReadyMessage {
  return isRecord(data) && data["type"] === MSG_READY;
}

export function parseState(data: unknown): StateMessage | null {
  if (!isRecord(data) || data["type"] !== MSG_STATE || !isNonce(data["nonce"])) return null;
  const phase = data["phase"];
  if (typeof phase !== "string" || !(PHASES as readonly string[]).includes(phase)) return null;
  const index = data["index"];
  if (index !== null && !(typeof index === "number" && Number.isInteger(index) && index >= 0)) return null;
  const itemKey = data["itemKey"];
  if (itemKey !== null && !isShortString(itemKey)) return null;

  const answers = data["answers"];
  if (!isRecord(answers)) return null;
  const answerEntries = Object.entries(answers);
  if (answerEntries.length > MAX_ENTRIES) return null;
  if (!answerEntries.every(([k, v]) => k.length <= MAX_KEY && typeof v === "string" && v.length <= MAX_ANSWER)) {
    return null;
  }

  const visibility = data["visibility"];
  if (!isRecord(visibility)) return null;
  const visibilityEntries = Object.entries(visibility);
  if (visibilityEntries.length > MAX_ENTRIES) return null;
  if (
    !visibilityEntries.every(
      ([k, v]) => k.length <= MAX_KEY && typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v),
    )
  ) {
    return null;
  }

  const error = data["error"];
  if (error !== undefined && !(typeof error === "string" && error.length <= MAX_ERROR)) return null;

  return {
    type: MSG_STATE,
    nonce: data["nonce"],
    phase: phase as PreviewPhase,
    index: index as number | null,
    itemKey: itemKey as string | null,
    answers: answers as Record<string, string>,
    visibility: visibility as Record<string, Visibility>,
    ...(error !== undefined ? { error: error as string } : {}),
  };
}

/**
 * A cheap fingerprint of a release, to tell "the draft was saved again" from
 * "what a participant would see has changed". Only the second restarts the
 * preview.
 *
 * cyrb53 over the JSON: not cryptographic, and it does not need to be — a
 * collision costs one missed restart, which the Restart button fixes. r7.1.0
 * serialises to about 130 kB, which this hashes in a couple of milliseconds.
 */
export function fingerprint(manifest: unknown): string {
  const text = JSON.stringify(manifest) ?? "";
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}
