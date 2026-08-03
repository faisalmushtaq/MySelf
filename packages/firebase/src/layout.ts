import type { DeviceSession, DeviceEvent } from "@myself/store";

/**
 * How the study is laid out in Firestore, and why.
 *
 * TWO PROJECTS, NOT TWO COLLECTIONS. The research data and the identity data
 * live in separate Firebase projects with separate IAM. On Postgres the
 * equivalent control was a database role with no grant on the identity schema;
 * here it is a project boundary, which is the strongest thing Firebase offers.
 * A rule is a file one bad edit away from being wrong. A project somebody's
 * credentials do not reach is not.
 *
 * ONE DOCUMENT PER SITTING. A whole event log is around 54 kB — a fiftieth of
 * the 1 MiB document limit — so a sitting is one document and deriving the
 * dataset costs one read per sitting rather than one per event. That is the
 * difference between a study that fits comfortably in the free tier and one
 * that does not: 1,000 sittings read as 1,000 documents, not 295,000.
 *
 * WITH A SPILL FOR THE UNUSUAL ONE. A sitting that somebody left open across a
 * fortnight can carry far more events than a normal one. Rather than let a
 * document approach the hard limit and fail the write — losing the sitting at
 * the moment it is handed over — the log spills into numbered chunk documents
 * beneath it. Normal sittings never touch this path.
 */

/** Comfortably under the 1 MiB hard limit, leaving room for metadata. */
export const MAX_DOCUMENT_BYTES = 700_000;

/**
 * Upper bound on events per chunk, so a spilled log stays a handful of reads.
 *
 * A bound on count alone is not enough: chunks are packed to a byte budget as
 * well, because 250 ordinary events and 250 events carrying long free-text
 * answers are two very different documents, and only the byte size is what
 * Firestore refuses.
 */
export const EVENTS_PER_CHUNK = 250;

export const paths = {
  /** research project */
  sessions: (study: string) => `studies/${study}/sessions`,
  session: (study: string, sessionId: string) => `studies/${study}/sessions/${sessionId}`,
  sessionChunks: (study: string, sessionId: string) => `studies/${study}/sessions/${sessionId}/chunks`,
  sessionChunk: (study: string, sessionId: string, index: number) =>
    `studies/${study}/sessions/${sessionId}/chunks/${String(index).padStart(4, "0")}`,
  corrections: (study: string) => `studies/${study}/corrections`,
  assignments: (study: string) => `studies/${study}/assignments`,
  assignment: (study: string, sessionId: string) => `studies/${study}/assignments/${sessionId}`,
  devices: (study: string) => `studies/${study}/devices`,
  device: (study: string, deviceId: string) => `studies/${study}/devices/${deviceId}`,
  quarantine: (study: string) => `studies/${study}/quarantine`,
  audit: (study: string) => `studies/${study}/audit`,

  /** identity project — a different Firebase project entirely */
  participants: (study: string) => `studies/${study}/participants`,
  participant: (study: string, code: string) => `studies/${study}/participants/${code}`,
  claims: (study: string) => `studies/${study}/claims`,
  claim: (study: string, sessionId: string) => `studies/${study}/claims/${sessionId}`,
  relationships: (study: string) => `studies/${study}/relationships`,
  accessLog: (study: string) => `studies/${study}/accessLog`,
} as const;

/** A sitting as one Firestore document. */
export interface SessionDoc {
  sessionId: string;
  deviceId: string;
  study: string;
  studyCode: string;
  releaseKey: string;
  releaseHash: string;
  startedAt: string;
  completedAt?: string;
  complete: boolean;
  /** Events held inline. Empty when the log spilled into chunks. */
  events: DeviceEvent[];
  /** How many chunk documents follow this one; 0 for the normal case. */
  chunkCount: number;
  eventCount: number;
  receivedAt: string;
  /** Set when the same sitting arrives from a second device. */
  quarantined?: boolean;
}

export interface ChunkDoc {
  sessionId: string;
  index: number;
  events: DeviceEvent[];
}

/**
 * Size of a document as Firestore will see it, near enough.
 *
 * JSON length overcounts slightly against Firestore's own accounting, which is
 * the direction to err in: a document that spills a little early is fine, one
 * that exceeds the hard limit fails the write and loses a sitting at the moment
 * it is handed over.
 */
const byteLength = (value: unknown): number => {
  const json = JSON.stringify(value);
  // No TextEncoder in every runtime this package is loaded into, so count
  // UTF-8 bytes directly.
  let bytes = 0;
  for (const char of json) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

export interface SplitSession {
  doc: SessionDoc;
  chunks: ChunkDoc[];
}

/**
 * Turn a device's session into the documents to write.
 *
 * Deterministic: the same session always splits the same way, so a retried
 * upload overwrites identical documents rather than producing a second,
 * differently-shaped copy of the same sitting.
 */
export function splitSession(session: DeviceSession, deviceId: string, study: string, now = new Date()): SplitSession {
  const ordered = [...session.events].sort((a, b) => a.seq - b.seq);
  const base: Omit<SessionDoc, "events" | "chunkCount"> = {
    sessionId: session.sessionId,
    deviceId,
    study,
    studyCode: session.studyCode,
    releaseKey: session.releaseKey,
    releaseHash: session.releaseHash,
    startedAt: session.startedAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    complete: session.complete,
    eventCount: ordered.length,
    receivedAt: now.toISOString(),
  };

  if (byteLength({ ...base, events: ordered }) <= MAX_DOCUMENT_BYTES) {
    return { doc: { ...base, events: ordered, chunkCount: 0 }, chunks: [] };
  }

  // Packed to a byte budget, not just a count. Chunking on count alone let a
  // log of long free-text answers produce a chunk over the document limit —
  // which fails the write and loses the sitting the spill exists to save.
  const chunks: ChunkDoc[] = [];
  let current: DeviceEvent[] = [];
  let currentBytes = 0;
  const overhead = byteLength({ sessionId: session.sessionId, index: 9999, events: [] });

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ sessionId: session.sessionId, index: chunks.length, events: current });
    current = [];
    currentBytes = 0;
  };

  for (const event of ordered) {
    const size = byteLength(event) + 1;
    const wouldExceed = currentBytes + size + overhead > MAX_DOCUMENT_BYTES;
    if (current.length > 0 && (wouldExceed || current.length >= EVENTS_PER_CHUNK)) flush();
    current.push(event);
    currentBytes += size;
  }
  flush();

  return { doc: { ...base, events: [], chunkCount: chunks.length }, chunks };
}

/**
 * Whether every chunk a sitting claims is actually present.
 *
 * The one way a spilled sitting could lose data quietly is a torn write: the
 * session document lands saying it has four chunks, and only three of them
 * make it. The log would then be short by a few hundred events and nothing
 * would look wrong. So the count is checked rather than trusted.
 */
export function chunksComplete(doc: SessionDoc, chunks: ChunkDoc[]): boolean {
  if (doc.chunkCount === 0) return true;
  const indexes = new Set(chunks.map((c) => c.index));
  if (indexes.size !== doc.chunkCount) return false;
  for (let i = 0; i < doc.chunkCount; i += 1) if (!indexes.has(i)) return false;
  return true;
}

/**
 * Put a sitting back together from its document and any chunks.
 *
 * Throws rather than returning a short log. A truncated sitting that enters
 * the dataset looking complete is the worst outcome available here — it would
 * be analysed, and nothing downstream could tell. A loud failure is recoverable:
 * the device still holds its copy, and the sitting can be re-synced.
 */
export function joinSession(doc: SessionDoc, chunks: ChunkDoc[] = []): DeviceSession {
  if (!chunksComplete(doc, chunks)) {
    throw new Error(
      `sitting ${doc.sessionId} is incomplete: it claims ${doc.chunkCount} chunks and ${chunks.length} arrived — do not use this log`,
    );
  }
  const events =
    doc.chunkCount === 0
      ? doc.events
      : [...chunks].sort((a, b) => a.index - b.index).flatMap((c) => c.events);
  return {
    sessionId: doc.sessionId,
    studyCode: doc.studyCode,
    releaseKey: doc.releaseKey,
    releaseHash: doc.releaseHash,
    startedAt: doc.startedAt,
    ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
    complete: doc.complete,
    events: [...events].sort((a, b) => a.seq - b.seq),
  };
}

/**
 * Whether an incoming sitting conflicts with one already stored.
 *
 * The same rule as the Postgres server: a sitting arriving from a second
 * device, or contradicting the release it was collected under, is quarantined
 * rather than merged. Kept as a pure function so the decision is identical
 * whether it is made in a Cloud Function, in the browser, or in a test.
 */
export function conflictWith(stored: SessionDoc | null, incoming: SessionDoc): string | null {
  if (!stored) return null;
  if (stored.deviceId !== incoming.deviceId) return "same sitting received from a second device";
  if (stored.releaseHash !== incoming.releaseHash) return "release hash differs from the copy already stored";
  return null;
}
