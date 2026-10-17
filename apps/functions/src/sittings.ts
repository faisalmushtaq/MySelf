import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import {
  conflictWith,
  paths,
  splitSession,
  type ChunkDoc,
  type SessionDoc,
  type SittingConflict,
} from "@myself/firebase";
import { isSessionId, sittingUpload, type DeviceSession, type SittingOutcome } from "@myself/store";
import { research } from "./apps.js";
import { RelayError, type Caller } from "./relay-policy.js";
import { authenticate, cors } from "./relay.js";
import { studyForRequest } from "./studies.js";

/**
 * How many uploads one device may make in a day.
 *
 * Generous, because a device legitimately posts a lot: a sitting is checkpointed
 * every couple of minutes while it is being answered, so twenty sittings in a
 * school day is a few hundred uploads before anything has gone wrong.
 *
 * NOT A SECURITY BOUNDARY, and worth being honest about which one it is. Anyone
 * with the study's URL can obtain an anonymous identity, so this does not stop a
 * determined stranger — App Check is the control for that, and it is a project
 * setting rather than a line of code. What this stops is the accident: a loop in
 * a page, a device left syncing on a windowsill, a retry that never backs off.
 * Those cost the same as an attack and are far more likely.
 */
export const UPLOADS_PER_DEVICE_PER_DAY = 2_000;

/**
 * How far a device's clock may be out before the study says so.
 *
 * Five minutes, which is loose on purpose. Request latency, a slow school network and
 * an iPad that keeps time by RTC while offline all put seconds to a minute between the
 * two readings, and a warning that fires on those is a warning that gets filtered. What
 * this is for is the device that is out by hours or days — restored from a backup, or
 * with its clock set by hand — because that one dates a whole morning's sittings to the
 * wrong day and nothing else in the data reveals it.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * How far the device's clock was from the study's, or null if it did not say.
 *
 * Positive means the device is ahead. Returns null rather than zero for a missing or
 * unparseable value: zero would read as a device whose clock agreed, which is a claim
 * nobody made, and it is the direction that hides a problem.
 */
export function clockSkewMs(sentAt: string | undefined, receivedAt: Date): number | null {
  if (!sentAt) return null;
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) return null;
  return sent - receivedAt.getTime();
}

/** Whether that skew is large enough that the dataset's dates cannot be trusted. */
export function clockIsSuspect(skewMs: number | null): boolean {
  return skewMs !== null && Math.abs(skewMs) > CLOCK_SKEW_TOLERANCE_MS;
}

async function meterUploads(caller: Caller, study: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = research().doc(`${paths.audit(study)}_uploads/${day}_${caller.uid}`);
  const used = await research().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = ((snap.data()?.["uploads"] as number | undefined) ?? 0) + 1;
    tx.set(ref, { uploads: count, uid: caller.uid, day, at: FieldValue.serverTimestamp() }, { merge: true });
    return count;
  });
  if (used > UPLOADS_PER_DEVICE_PER_DAY) {
    throw new RelayError(
      429,
      "rate_limit",
      `${used - 1} uploads today is the limit for one device. The sittings are still on the device and nothing is lost.`,
    );
  }
}

/**
 * Storing a survey sitting.
 *
 * The gap this closes: `splitSession`, `joinSession` and the nightly export
 * were all written against `studies/{study}/sessions`, and nothing ever wrote
 * a document there. The export read an empty collection, the researcher view
 * ingested a JSON file carried off the iPad by hand, and the sentence in
 * `export.ts` — "until sync exists, the route from a device to the dataset is
 * a file" — was the whole truth. This is the write path.
 *
 * The file route stays. A school hall with no usable wifi is the normal case,
 * not the exception, and a device that cannot reach this must still be able to
 * hand its sittings over. Both routes land in the same documents, so a sitting
 * that arrives twice by two different roads is one sitting.
 *
 * Four things worth reading.
 *
 * IT IS IDEMPOTENT, and deliberately so rather than incidentally. `splitSession`
 * is deterministic — the same log always splits the same way — so a retried
 * upload overwrites identical documents. A device with a flaky connection can
 * post the same sitting ten times and the dataset has one of it.
 *
 * THE CHUNKS AND THE PARENT ARE WRITTEN TOGETHER, in one transaction, so a torn
 * write leaves nothing rather than half of something. An earlier version wrote the
 * chunks first and decided afterwards, which meant a refused upload had already
 * overwritten chunks the stored sitting still claimed — and since a chunk is
 * identified by its index, the result read back as a complete blend of two
 * different logs. That is the failure this whole file exists to prevent, so the
 * ordering is gone rather than documented.
 *
 * A TESTER LINK MAY NOT WRITE ONE. A link is a URL somebody was sent, and it
 * exists to pilot the narrative module before a study is fielded. Survey
 * sittings from an anonymous URL holder would be indistinguishable from real
 * ones in a research dataset, so they are refused here rather than marked —
 * `provenance` can separate model calls, but a sitting is the unit of
 * analysis and there is no version of this where a stranger contributes one.
 *
 * A CONTRADICTED SITTING IS QUARANTINED, not overwritten. Two devices claiming
 * one session id, two copies collected under different releases, a finished
 * sitting arriving as a partial one again, or a log that has got SHORTER: each
 * means something is wrong that a write cannot resolve, so the honest response
 * is to keep both facts and let a person look. `conflictWith` holds the four
 * rules and the write path has none of its own. The export already skips
 * quarantined sittings.
 *
 * THE DECISION IS MADE INSIDE A TRANSACTION, because read-then-decide-then-write
 * is three operations and two iPads handed over at the same moment is the normal
 * way this platform is used. Without it the loser of the race overwrites the
 * winner, which is precisely what the rules above exist to prevent.
 */


/**
 * The deepest a value may sit in a document, counted as the Admin SDK counts it:
 * path segments from the top-level field down, array indexes included (its
 * serializer refuses a path of more than MAX_DEPTH + 1 = 21 segments).
 */
const MAX_PATH_SEGMENTS = 21;

/**
 * The largest document this will try to write, by the same JSON byte count
 * `splitSession` packs to. Firestore's hard limit is 1 MiB (1,048,576 bytes)
 * including the document's name; JSON overcounts against Firestore's own
 * accounting, so a document under this fits. One event over it cannot be
 * stored however it is split, because an event is never divided.
 */
const MAX_WRITABLE_BYTES = 1_040_000;

const RESERVED_KEY = /^__.*__$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function utf8Bytes(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Why Firestore could never store this value, or null when it can.
 *
 * Each of these fails the write every time, however often it is retried, so a
 * sitting that has one is refused as permanently invalid instead of being
 * reported as a passing failure the device should post again (stress finding
 * 4). Checked before the transaction, so nothing is written for it.
 */
export function unstorableReason(value: unknown, path: string[] = [], inArray = false): string | null {
  const at = path.length > 0 ? ` at ${path.join(".")}` : "";
  if (path.length > MAX_PATH_SEGMENTS) return `it is nested more than ${MAX_PATH_SEGMENTS - 1} levels deep${at}`;
  if (typeof value === "string") {
    return LONE_SURROGATE.test(value) ? `it holds text that is not valid Unicode (a lone surrogate)${at}` : null;
  }
  if (Array.isArray(value)) {
    if (inArray) return `it holds a list directly inside a list${at}, which the database cannot store`;
    for (let i = 0; i < value.length; i++) {
      const problem = unstorableReason(value[i], [...path, String(i)], true);
      if (problem) return problem;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "") return `it has a field with an empty name${at}`;
      if (RESERVED_KEY.test(key)) return `it has a field named "${key.slice(0, 40)}"${at}, and names like __this__ are reserved`;
      if (LONE_SURROGATE.test(key)) return `it has a field name that is not valid Unicode (a lone surrogate)${at}`;
      // A map inside a list is a new value, so lists may hold maps holding lists.
      const problem = unstorableReason(inner, [...path, key], false);
      if (problem) return problem;
    }
  }
  return null;
}

/** Why this sitting's documents could never be written, or null when they can. */
export function unstorableSitting(doc: SessionDoc, chunks: readonly ChunkDoc[]): string | null {
  for (const [what, document] of [["sitting", doc] as const, ...chunks.map((c) => [`part ${c.index}`, c] as const)]) {
    const shape = unstorableReason(document);
    if (shape) return shape;
    if (utf8Bytes(document) > MAX_WRITABLE_BYTES) {
      return `one of its answers is too large to store (the ${what} it is in is over ${Math.floor(MAX_WRITABLE_BYTES / 1000)} kB)`;
    }
  }
  return null;
}

/**
 * Who the sitting is recorded as coming from.
 *
 * A device is its own identity. A researcher importing a file has to say which
 * iPad it came off, because "imported by Faisal" is not an answer to "which
 * device collected this" and the two get conflated the moment they are allowed
 * to be the same field.
 */
export function deviceIdFor(caller: Caller, claimed: string | undefined): string {
  if (caller.device) return caller.uid;
  if (!claimed) {
    throw new RelayError(
      400,
      "unknown",
      "say which device these sittings came off. An import from a file has to record the iPad that collected it.",
    );
  }
  // It names a quarantine document, so it is held to the session id's rule
  // (every installation id, `ipad_<ULID>` or a Firebase uid, fits it).
  if (!isSessionId(claimed)) throw new RelayError(400, "unknown", "that device id is not one this study can store");
  return claimed;
}

/**
 * Whether this caller may write survey sittings at all, and why not.
 *
 * An anonymous iPad may. A tester link may not, and that distinction survives
 * opening the study to any device: a link is a URL handed to somebody to PILOT
 * the narrative module before a study is fielded, its runs are stored as test
 * provenance and kept out of the dataset, and a sitting arriving on one would
 * contradict that on purpose. A participant's iPad is not in that position.
 */
export function sittingRefusal(caller: Caller): string | null {
  if (caller.uid.startsWith("link_")) {
    return "a tester link can try the module out, but it cannot file a survey sitting into the study's dataset";
  }
  return null;
}

/**
 * Store one sitting, and say what happened to it.
 *
 * Exported for the tests, which exercise the ordering and the quarantine rule
 * against a fake Firestore rather than by deploying.
 */
export async function storeSitting(
  db: FirebaseFirestore.Firestore,
  study: string,
  session: DeviceSession,
  deviceId: string,
  now = new Date(),
  provenance: SessionDoc["provenance"] = "imported",
): Promise<SittingOutcome> {
  // The id is a path segment; the contract checks it, and this holds for any
  // other caller (a `/` in it would address another sitting's documents).
  if (!isSessionId(session.sessionId)) throw new RelayError(400, "unknown", "that sitting's id is not one this study can store");
  const { doc, chunks } = splitSession(session, deviceId, study, now, provenance);
  const unstorable = unstorableSitting(doc, chunks);
  if (unstorable) {
    throw new RelayError(422, "invalid", `this sitting can never be stored as it is: ${unstorable}. Posting it again will not help.`, false);
  }

  const parentRef = db.doc(paths.session(study, session.sessionId));

  /**
   * The decision, the chunks and the parent, all together or none of them.
   *
   * THE ORDERING THIS REPLACES WAS QUIETLY UNSAFE. Chunks were written before the
   * transaction that decides, on the reasoning that a refused upload would leave chunks
   * nobody reads. That is true only when the refused upload has no chunks in common with
   * the stored sitting — and a chunk's id is its index, so a refused 500-event upload
   * (two chunks) over a stored 900-event one (four) overwrites chunks 0 and 1 and leaves
   * the parent still claiming four. `chunksComplete` counts indexes and finds all four
   * present, so `joinSession` returns a blend of two different logs and reports it as
   * whole. Silent corruption of a child's answers, which is the one outcome this file
   * exists to prevent.
   *
   * Putting the chunk writes inside the transaction removes the hazard rather than
   * narrowing it: a refused upload writes nothing at all. The cost is a ceiling —
   * Firestore allows about 10 MiB per transaction — and a sitting large enough to exceed
   * it now fails loudly instead of landing. That is the right direction for a failure,
   * and it is far outside anything real: a full YBM sitting is 54 kB, and the 700 kB
   * chunk budget means the ceiling is around a dozen chunks of the largest kind.
   *
   * Firestore re-runs the body when a document moved underneath it, so the loser of a
   * race between two devices sees the winner's parent and is refused — which is what
   * makes the collision rule hold when a rack of iPads is handed over together.
   */
  const verdict = await db.runTransaction(async (tx) => {
    const snap = await tx.get(parentRef);
    const before = snap.exists ? (snap.data() as SessionDoc) : null;

    const conflict = conflictWith(before, doc);
    if (conflict) return { conflict, before };

    for (const chunk of chunks) {
      tx.set(db.doc(paths.sessionChunk(study, session.sessionId, chunk.index)), chunk satisfies ChunkDoc);
    }

    /**
     * Anything a longer earlier upload left behind, removed in the same breath.
     *
     * A sitting repacked by a later build — a change to the byte budget or the per-chunk
     * cap puts the same events in fewer documents — would otherwise leave chunk 3 beside
     * a parent claiming three, and `joinSession` counts, so the sitting would read as
     * complete while carrying a stale tail. A log getting shorter cannot reach this:
     * `conflictWith` refuses that above, which is what makes deleting here safe.
     */
    for (let i = chunks.length; i < (before?.chunkCount ?? 0); i += 1) {
      tx.delete(db.doc(paths.sessionChunk(study, session.sessionId, i)));
    }

    // Stays quarantined once it has been: a later upload from the original
    // device must not clear a flag an earlier collision raised, because the
    // thing worth knowing is that a collision happened at all.
    const quarantined = before?.quarantined === true;
    tx.set(parentRef, { ...doc, quarantined, receivedAt: now.toISOString() } satisfies SessionDoc, { merge: false });
    return { conflict: null, before };
  });

  if (verdict.conflict) {
    return refuse(db, study, session, deviceId, doc, verdict.before, verdict.conflict, now);
  }

  return {
    sessionId: session.sessionId,
    stored: true,
    events: doc.eventCount,
    chunks: chunks.length,
    quarantined: verdict.before?.quarantined === true,
  };
}

/**
 * A sitting that may not land, kept anyway.
 *
 * Nothing is ever dropped on the floor: the copy that arrived is filed whole
 * under `/quarantine` so a person can compare it against what is stored, and
 * the device is told not to keep retrying.
 *
 * WHETHER THE STORED COPY IS FLAGGED TOO is `conflictWith`'s decision, not
 * this function's, and it is the difference between flagging a genuine
 * ambiguity and throwing away a complete sitting because a device sent a stale
 * checkpoint after it. `quarantined` is the only field a researcher may change
 * on a sitting, and this is the machine doing the same thing for the same
 * reason — so it is set with a merge, never replacing the sitting it marks.
 */
async function refuse(
  db: FirebaseFirestore.Firestore,
  study: string,
  session: DeviceSession,
  deviceId: string,
  doc: SessionDoc,
  stored: SessionDoc | null,
  conflict: SittingConflict,
  now: Date,
): Promise<SittingOutcome> {
  /**
   * ERROR only when the two copies are genuinely ambiguous.
   *
   * A second device claiming a session id, or two copies collected under different
   * releases, needs a person to look at it. A shorter or reopened log from the SAME
   * device does not: it is what a retry racing its own earlier attempt produces, and
   * the rule handled it correctly by keeping the longer copy. Logging that at ERROR
   * trains whoever reads production logs to ignore the line that matters.
   */
  const note = conflict.storedIsSuspect ? logger.error : logger.warn;
  note("a sitting was refused rather than allowed to replace one already stored", {
    sessionId: session.sessionId,
    reason: conflict.reason,
    heldDeviceId: stored?.deviceId ?? null,
    thenDevice: deviceId,
    heldEvents: stored?.eventCount ?? null,
    arrivingEvents: doc.eventCount,
    storedIsSuspect: conflict.storedIsSuspect,
  });

  /**
   * Both sides of the comparison, in the row itself. A reason without the two event
   * counts beside it sends whoever reads it back to the sittings to work out what
   * actually differed.
   *
   * THE ARRIVING LOG IS CARRIED ONLY IF IT FITS. Embedding it unconditionally meant a
   * spilled sitting — the ones over the 700 kB chunk budget — produced a quarantine
   * document over Firestore's 1 MiB limit, so the write failed and the evidence this
   * function promises to keep was the one thing lost. A truncated record that says it is
   * truncated is worth more than a failed write.
   *
   * KEYED ON THE SESSION, not appended. Repeated refusals of the same sitting — which a
   * device on a bad connection produces by the dozen — used to accumulate a full copy of
   * the log each time. One row per sitting, with a count of how often it has happened.
   */
  const asJson = JSON.stringify(session);
  // BYTES, not UTF-16 units. `length` counts code units, so a sitting full of non-ASCII
  // free text could pass a 700,000 check and still exceed Firestore's 1 MiB document
  // limit — the exact write failure the check exists to prevent.
  const bytes = Buffer.byteLength(asJson, "utf8");
  const room = 700_000;
  const truncated = bytes > room;

  /**
   * ONE ROW PER SITTING PER DEVICE, and the log stored as a string.
   *
   * Keyed on the sitting alone, a second device's refusal overwrote the first's copy —
   * losing the evidence this function exists to keep. Worse, Firestore deep-merges nested
   * maps, so a merged `arrivingSession` could end up holding one device's events beside
   * another's `completedAt`: a record of a sitting that never existed. Including the
   * device in the key keeps each one's copy, and repeated refusals from the same device
   * merge onto their own row and increment a counter instead of accumulating copies.
   *
   * The log goes in as JSON text rather than a map, which is what makes the merge safe:
   * a string is replaced whole. It is evidence for a person to read, not something to
   * query.
   */
  await db.doc(`${paths.quarantine(study)}/${session.sessionId}__${deviceId}`).set(
    {
      reason: conflict.reason,
      sessionId: session.sessionId,
      heldDeviceId: stored?.deviceId ?? null,
      heldEvents: stored?.eventCount ?? null,
      arrivingDeviceId: deviceId,
      arrivingEvents: doc.eventCount,
      storedFlagged: conflict.storedIsSuspect,
      refusals: FieldValue.increment(1),
      arrivingSessionTruncated: truncated,
      // Truncated to the head when it will not fit. The device still holds the whole
      // thing, and the refusal tells the operator to hand it over as a file.
      arrivingSessionJson: truncated
        ? JSON.stringify({ ...session, events: session.events.slice(0, 50) })
        : asJson,
      at: now.toISOString(),
    },
    { merge: true },
  );

  if (conflict.storedIsSuspect) {
    await db.doc(paths.session(study, session.sessionId)).set({ quarantined: true }, { merge: true });
  }

  return {
    sessionId: session.sessionId,
    stored: false,
    events: session.events.length,
    chunks: 0,
    quarantined: true,
    reason: conflict.reason,
  };
}

export const saveSitting = onRequest(
  { cors: false, maxInstances: 20, timeoutSeconds: 120, memory: "512MiB" },
  async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: { kind: "unknown", message: "post sittings here" } });
      return;
    }

    const started = Date.now();
    let caller: Caller | null = null;
    try {
      /**
       * The study these sittings started in (D-56), checked against the
       * registry before anything else: an unknown study is refused here, and
       * nothing is registered, counted or written in its name. Absent means the
       * default, which is what every upload before study spaces meant.
       *
       * A CLOSED study still takes sittings from an iPad it already knows —
       * `authenticate` refuses only a new installation — so nothing collected
       * before the closure is turned away (docs/16 §11.4).
       */
      const study = await studyForRequest(research(), (req.body as { study?: unknown } | undefined)?.study);

      // An iPad that signed itself in may file a sitting. That is the whole
      // participation model: somebody opens the URL and takes part.
      caller = await authenticate(req.headers.authorization, { allowAnonymous: true, study });
      const refusal = sittingRefusal(caller);
      if (refusal) throw new RelayError(403, "auth", refusal);

      const parsed = sittingUpload.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RelayError(
          400,
          "unknown",
          `that is not a set of sittings this accepts: ${issue?.path.join(".") ?? "body"} ${issue?.message ?? ""}`.trim(),
        );
      }
      const deviceId = deviceIdFor(caller, parsed.data.deviceId);
      await meterUploads(caller, study.study);
      const db = research();
      const now = new Date();

      /**
       * One at a time, and a failure on one does not lose the others.
       *
       * A handover is twenty sittings off an iPad at the end of a school day.
       * Refusing the whole upload because the eleventh has something odd in it
       * would mean nineteen children's answers stay on a device that is about
       * to be wiped, so each is reported on its own and the device deletes
       * only what it is told was stored.
       */
      const outcomes: SittingOutcome[] = [];
      for (const one of parsed.data.sittings) {
        try {
          outcomes.push(
            /**
             * From what the caller IS, not from whether it was anonymous.
             *
             * `caller.device` is true only for an iPad that presented its own credential;
             * a researcher importing a handover file is not a device. Deriving this from
             * `anonymous` had it exactly backwards, recording an imported file as having
             * come from a vouched-for device.
             */
            await storeSitting(db, study.study, one as DeviceSession, deviceId, now, caller.device ? "device" : "imported"),
          );
        } catch (error) {
          /**
           * Permanent or passing, said plainly.
           *
           * A sitting the database can never hold (too deep, a list in a list, a
           * reserved or empty field name, an answer over the size limit, broken
           * Unicode) used to be reported like a dropped connection, so the device
           * posted it again for ever and nobody was told. It is refused as
           * invalid, not retryable, with the reason, so the device can stop and
           * show it. Anything else may well work next time.
           */
          if (error instanceof RelayError && (error.status === 400 || error.status === 422)) {
            logger.warn("a sitting was refused as permanently invalid", { sessionId: one.sessionId, reason: error.message });
            outcomes.push({
              sessionId: one.sessionId,
              stored: false,
              events: one.events.length,
              chunks: 0,
              quarantined: false,
              retryable: false,
              reason: error.message,
            });
            continue;
          }
          logger.error("a sitting could not be stored", { sessionId: one.sessionId, error: String(error) });
          outcomes.push({
            sessionId: one.sessionId,
            stored: false,
            events: one.events.length,
            chunks: 0,
            quarantined: false,
            retryable: true,
            reason: "could not be written — it is still on the device, and posting it again is safe",
          });
        }
      }

      const stored = outcomes.filter((o) => o.stored).length;
      /**
       * A device whose clock is hours out is worth knowing about during fieldwork, not
       * at analysis. Every wall-clock timestamp in its sittings is wrong by the same
       * amount and nothing in the data says so, so this is the only place it becomes
       * visible — and the sittings named here are the ones affected.
       */
      const skewMs = clockSkewMs(parsed.data.sentAt, now);
      if (clockIsSuspect(skewMs)) {
        logger.warn("a device's clock disagrees with the study's", {
          deviceId,
          sentAt: parsed.data.sentAt,
          receivedAt: now.toISOString(),
          skewMs,
          sessionIds: outcomes.map((o) => o.sessionId),
        });
      }
      try {
        await db.collection(paths.audit(study.study)).add({
          action: "sittings.received",
          actor: caller.uid,
          deviceId,
          device: caller.device,
          offered: outcomes.length,
          stored,
          quarantined: outcomes.filter((o) => o.quarantined).length,
          sessionIds: outcomes.map((o) => o.sessionId),
          /**
           * The device's clock, the study's reading of the same moment, and the difference
           * between them — all three, deliberately.
           *
           * `receivedAt` is here rather than left to `at` because `at` is a server
           * timestamp resolved by Firestore when the write lands, which is some unknown
           * number of milliseconds after the request was read. `skewMs` was computed
           * against `now`, so a reader subtracting `sentAt` from `at` would get a
           * slightly different number and have no way to know which was meant. Writing
           * the reading the difference came from makes the row self-consistent.
           *
           * And the difference is stored as well as derivable because it is the thing
           * worth querying: "audit rows where the device was more than a minute out" is a
           * question about a number, not about a pair.
           */
          ...(parsed.data.sentAt ? { sentAt: parsed.data.sentAt, receivedAt: now.toISOString() } : {}),
          ...(skewMs === null ? {} : { clockSkewMs: skewMs }),
          at: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        // An audit row that cannot be written must not fail a handover that
        // otherwise worked. The device would re-send, and the sittings are
        // already stored.
        logger.error("saveSitting: could not write the audit row", error);
      }

      /**
       * When nothing in the request could ever be stored — the usual case, since a
       * device posts one sitting at a time — the request itself is refused, 422 and
       * not retryable, so a client that reads only the status still stops. A
       * handover with some sittings stored is answered 200, sitting by sitting.
       */
      const refused = outcomes.filter((o) => o.retryable === false);
      if (refused.length > 0 && refused.length === outcomes.length) {
        res.status(422).json({
          error: { kind: "invalid", message: refused.map((o) => `${o.sessionId}: ${o.reason}`).join("; "), retryable: false },
          stored,
          outcomes,
        });
        return;
      }
      res.status(200).json({ stored, outcomes });
    } catch (error) {
      if (error instanceof RelayError) {
        res.status(error.status).json({ error: { kind: error.kind, message: error.message } });
        return;
      }
      logger.error("saveSitting failed", error);
      res.status(500).json({ error: { kind: "unknown", message: "could not store those sittings" } });
    } finally {
      logger.info("saveSitting", { uid: caller?.uid ?? null, ms: Date.now() - started });
    }
  },
);
