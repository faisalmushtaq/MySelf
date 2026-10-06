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
  /**
   * The study registry (D-56, docs/16 §11.4): one document per study space,
   * `studies/{study}`, holding its title and whether it is open. Public by
   * `get`, so an iPad can tell a closed study before anybody types a code;
   * listed only by the project's people; written only by functions. The
   * deployment's default study (`ybm`) counts as registered and open with no
   * document at all, which is why nothing had to be written for it.
   */
  studies: () => "studies",
  study: (study: string) => `studies/${study}`,

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

  /**
   * Narrative runs, one document each — docs/08 §9.3.
   *
   * Their own collection rather than a field on the sitting. They arrive later
   * and only where there is connectivity, so attaching one must not mean
   * re-uploading 54 kB of survey log over a school wifi, and an analysis that
   * does not want narratives never pays to read them. A measured run is 12.3 kB
   * median, 20.1 kB at the largest, so one document is never near the limit.
   */
  narratives: (study: string) => `studies/${study}/narratives`,
  narrative: (study: string, sessionId: string) => `studies/${study}/narratives/${sessionId}`,

  /**
   * Spoken answers, in Storage rather than Firestore.
   *
   * A few seconds of Opus is tens of kilobytes and a long answer is hundreds —
   * an order of magnitude more than the whole text log of a sitting, and not
   * something to carry in a document that gets read on every analysis pass.
   *
   * Laid out under the session so a run's audio is one prefix: it can be
   * listened to together, exported together, and DELETED TOGETHER, which is
   * the operation that matters most for a recording of a child's voice.
   */
  voiceNotes: (study: string, sessionId: string) => `studies/${study}/voice/${sessionId}`,
  voiceNote: (study: string, sessionId: string, clipId: string, extension: string) =>
    `studies/${study}/voice/${sessionId}/${clipId}.${extension}`,

  /**
   * MySelf Studio — docs/16 §5.2.
   *
   * Surveys, their working draft and their published versions, beside the
   * sittings rather than inside them. Nothing here is a response: a sitting
   * keeps pointing at the release it was collected under by hash, and these
   * documents are how that hash is found again.
   *
   * TWO OF THEM ARE PUBLIC, and only by `get`: the pointer that says which
   * release is live, and the immutable manifests it points at. Those are what a
   * participant's device downloads — the same content it used to receive
   * compiled into the app. Everything else is readable only by people on the
   * Studio list, and every write except a draft edit goes through a function.
   */
  studioSurveys: (study: string) => `studies/${study}/surveys`,
  studioSurvey: (study: string, surveyId: string) => `studies/${study}/surveys/${surveyId}`,
  studioDraft: (study: string, surveyId: string) => `studies/${study}/surveys/${surveyId}/draft/current`,
  studioVersions: (study: string, surveyId: string) => `studies/${study}/surveys/${surveyId}/versions`,
  studioVersion: (study: string, surveyId: string, version: string) =>
    `studies/${study}/surveys/${surveyId}/versions/${version}`,
  studioPresence: (study: string, surveyId: string) => `studies/${study}/surveys/${surveyId}/presence`,
  studioPresenceOf: (study: string, surveyId: string, uid: string) =>
    `studies/${study}/surveys/${surveyId}/presence/${uid}`,
  publishedPointer: (study: string, surveyId: string) => `studies/${study}/published/${surveyId}`,
  publicReleases: (study: string) => `studies/${study}/publicReleases`,
  /** Keyed by the hex part of the hash — see `hashHex` in @myself/schema. */
  publicRelease: (study: string, hashHex: string) => `studies/${study}/publicReleases/${hashHex}`,
  studioMembers: (study: string) => `studies/${study}/studioMembers`,
  /** Keyed by the lower-cased email address, which is what the rules look up. */
  studioMember: (study: string, email: string) => `studies/${study}/studioMembers/${email.trim().toLowerCase()}`,
  studioAccessConfig: (study: string) => `studies/${study}/studioAccess/config`,
  studioAudit: (study: string) => `studies/${study}/studioAudit`,

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
  /**
   * Set when the same sitting arrives from a second device.
   *
   * ALWAYS WRITTEN, never left absent — and required, so the type will not let
   * it be forgotten. Firestore's `!=` operator silently excludes documents that
   * lack the field, so a query for "not quarantined" against optional data
   * returns almost nothing and looks like an empty study rather than an error.
   * A field that is always present cannot be walked into that way.
   */
  quarantined: boolean;
  /**
   * How this sitting reached the study.
   *
   * `"device"` — an iPad presented the credential it issued itself, which is how a
   * fielded sitting arrives. `"imported"` — a member of the research team uploaded a
   * handover file from a device that could not reach the network.
   *
   * IT USED TO SAY `"open" | "enrolled"`, and that distinction died with `enrolDevice`:
   * no device is registered in advance any more, so every sitting was `"open"` and the
   * field discriminated nothing. Worse, it was derived from whether the CALLER was
   * anonymous, so a researcher importing a file — who is signed in — was recorded as
   * `"enrolled"`, labelling an unregistered iPad's sitting as having come from a
   * vouched-for device. Exactly backwards.
   *
   * What remains is worth recording: a sitting that arrived over the network was filed by
   * a device that proved which device it was, and one that arrived by file was filed by a
   * person who said so. Neither is a quality judgement and nothing filters on it by
   * default — a sitting handed over on a USB stick from a hall with no wifi is as real as
   * any other — but an analysis that wants to know can ask.
   */
  provenance: "device" | "imported";
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
export function splitSession(
  session: DeviceSession,
  deviceId: string,
  study: string,
  now = new Date(),
  /**
   * Defaults to `"imported"` on purpose. A caller that forgets then understates what it
   * knows — "a person put this here" — rather than claiming a device proved itself when
   * nothing checked.
   */
  provenance: SessionDoc["provenance"] = "imported",
): SplitSession {
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
    quarantined: false,
    provenance,
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
 * Why an incoming sitting may not replace the one already stored.
 */
export interface SittingConflict {
  /** Said plainly enough to appear in a device's own sync panel. */
  reason: string;
  /**
   * Whether the copy ALREADY STORED is now suspect as well.
   *
   * This is the field that decides whether good data stays in the dataset, so
   * it is worth being explicit about. Two devices claiming one session id, or
   * two copies collected under different releases, mean nothing can say which
   * copy is the real one — so the stored copy is flagged too and a person
   * looks. A shorter or reopened log from the SAME device is different: there
   * the stored copy is the more complete one, and flagging it would drop a
   * whole sitting out of the export to punish a bad retry.
   */
  storedIsSuspect: boolean;
}

/**
 * Whether an incoming sitting conflicts with one already stored.
 *
 * The same rule as the Postgres server: a sitting that contradicts the copy
 * already held is quarantined rather than merged. Kept as a pure function so
 * the decision is identical whether it is made in a Cloud Function, in the
 * browser, or in a test — and so that the four ways a sitting can be
 * contradicted are in one readable list rather than spread across a write path.
 *
 * FOUR RULES, AND THE LAST TWO ARE WHY THIS EXISTS.
 *
 * A SECOND DEVICE has no better claim than the first. Replacing one child's log
 * with another's is the merge this platform exists to never make.
 *
 * A DIFFERENT RELEASE means the two copies are not the same instrument. Reading
 * one through the other is how a renamed option code becomes a silently wrong
 * answer, so neither is trusted until a person has looked.
 *
 * A COMPLETE SITTING IS NEVER REOPENED. A device re-sending an earlier, still
 * running copy of a sitting it has since finished must not turn a finished
 * sitting back into a partial one.
 *
 * AND A LOG NEVER GETS SHORTER. This is the one that would have cost real data.
 * The write path replaces the stored document outright and deletes any chunks
 * the new split does not use, so a device that had been restored from a backup,
 * or that re-sent a checkpoint after the full sitting had already arrived,
 * would have quietly truncated a complete log to a partial one — with a
 * successful response, nothing in the export looking wrong, and the shorter
 * version analysed. Event counts only ever rise, so a fall is a fault.
 */
export function conflictWith(stored: SessionDoc | null, incoming: SessionDoc): SittingConflict | null {
  if (!stored) return null;
  if (stored.deviceId !== incoming.deviceId) {
    return { reason: "same sitting received from a second device", storedIsSuspect: true };
  }
  if (stored.releaseHash !== incoming.releaseHash) {
    return { reason: "release hash differs from the copy already stored", storedIsSuspect: true };
  }
  if (stored.complete && !incoming.complete) {
    return {
      reason: "the copy already stored is a finished sitting and this one is still in progress",
      storedIsSuspect: false,
    };
  }
  if (incoming.eventCount < stored.eventCount) {
    return {
      reason: `this copy carries ${incoming.eventCount} events and the copy already stored carries ${stored.eventCount} — a sitting never gets shorter`,
      storedIsSuspect: false,
    };
  }
  return null;
}
