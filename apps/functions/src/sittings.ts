import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { paths, splitSession, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import type { DeviceSession } from "@myself/store";
import { STUDY, research } from "./apps.js";
import { RelayError, type Caller } from "./relay-policy.js";
import { authenticate, cors } from "./relay.js";

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
 * CHUNKS ARE WRITTEN BEFORE THE PARENT. A failure between the two leaves
 * chunks nobody reads, which is invisible: the export walks parents. The other
 * order leaves a parent claiming chunks that never arrived, which `joinSession`
 * refuses — correctly, but it means a sitting sitting in the dataset that
 * cannot be read. Stale chunks from an earlier, longer upload are deleted after
 * the parent is written, for the same reason.
 *
 * A TESTER LINK MAY NOT WRITE ONE. A link is a URL somebody was sent, and it
 * exists to pilot the narrative module before a study is fielded. Survey
 * sittings from an anonymous URL holder would be indistinguishable from real
 * ones in a research dataset, so they are refused here rather than marked —
 * `provenance` can separate model calls, but a sitting is the unit of
 * analysis and there is no version of this where a stranger contributes one.
 *
 * THE SAME SITTING FROM TWO DEVICES IS QUARANTINED, not overwritten. It means
 * a session id collided or a device was restored from a backup, and either way
 * the honest response is to keep both facts and let a person look. The export
 * already skips quarantined sittings.
 */

/**
 * One event, as the device wrote it.
 *
 * Generous about payloads and strict about shape, the same discipline as the
 * narrative records: a sitting refused because one payload had an unexpected
 * key would lose everything a child answered, which is worse than storing
 * something odd. Payloads are opaque here — the reader interprets them, and a
 * device that knows about an event type this deployment does not must still be
 * able to hand it over.
 */
const deviceEvent = z.object({
  seq: z.number().int().min(0),
  type: z.string().min(1).max(80),
  itemKey: z.string().max(200).optional(),
  payload: z.record(z.unknown()).optional(),
  tWall: z.string().min(1).max(40),
  tMono: z.number(),
});

/**
 * A sitting. The caps are guards rather than budgets: a full YBM sitting is
 * about 900 events and 54 kB, so nothing legitimate comes close.
 */
const sitting = z.object({
  sessionId: z.string().min(1).max(120),
  studyCode: z.string().min(1).max(120),
  releaseKey: z.string().min(1).max(120),
  releaseHash: z.string().min(1).max(200),
  startedAt: z.string().min(1).max(40),
  completedAt: z.string().max(40).optional(),
  complete: z.boolean(),
  events: z.array(deviceEvent).max(20_000),
});

export const sittingUpload = z.object({
  /**
   * Which device these came off.
   *
   * Taken from the caller when the caller IS a device, and only read from the
   * body when a member of the research team is importing a file — where the
   * originating iPad is a fact about the data that would otherwise be lost.
   * A device cannot claim to be a different device.
   */
  deviceId: z.string().min(1).max(120).optional(),
  sittings: z.array(sitting).min(1).max(50),
});

export type SittingUpload = z.infer<typeof sittingUpload>;

/** One sitting's outcome, so a device knows what to delete and what to retry. */
export interface SittingOutcome {
  sessionId: string;
  stored: boolean;
  events: number;
  chunks: number;
  quarantined: boolean;
  reason?: string;
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
  return claimed;
}

/** Whether this caller may write survey sittings at all, and why not. */
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
): Promise<SittingOutcome> {
  const { doc, chunks } = splitSession(session, deviceId, study, now);

  const parentRef = db.doc(paths.session(study, session.sessionId));
  const existing = await parentRef.get();
  const before = existing.exists ? (existing.data() as SessionDoc) : null;

  /**
   * The same sitting, from somewhere else.
   *
   * The stored copy is NOT overwritten. Two devices holding one session id
   * means the id collided or an iPad was restored from a backup, and in
   * neither case does the second arrival have a better claim than the first —
   * replacing one child's log with another's is the merge this platform exists
   * to never make.
   *
   * So both facts survive: the copy already here is marked quarantined, which
   * takes it out of the export, and the copy that just arrived is filed whole
   * under `/quarantine` for a person to compare. That is the same outcome the
   * Firestore rules produce for a device writing directly — they refuse the
   * second device's update and the client files the copy it was holding — and
   * the two write paths must not disagree about something this consequential.
   */
  if (before !== null && before.deviceId !== deviceId) {
    logger.error("the same sitting arrived from two devices", {
      sessionId: session.sessionId,
      firstDevice: before.deviceId,
      thenDevice: deviceId,
    });
    await db.collection(paths.quarantine(study)).add({
      reason: "the same session id arrived from a second device",
      sessionId: session.sessionId,
      heldDeviceId: before.deviceId,
      arrivingDeviceId: deviceId,
      arrivingSession: session,
      at: now.toISOString(),
    });
    // Marked, and nothing else touched. `quarantined` is the only field a
    // researcher may change on a sitting, and this is the machine doing the
    // same thing for the same reason.
    await parentRef.set({ quarantined: true }, { merge: true });
    return {
      sessionId: session.sessionId,
      stored: false,
      events: session.events.length,
      chunks: 0,
      quarantined: true,
      reason: "another device has already filed this sitting — both copies are kept and flagged for review",
    };
  }

  // Stays quarantined once it has been: a later upload from the original
  // device must not clear a flag an earlier collision raised, because the
  // thing worth knowing is that a collision happened at all.
  const quarantined = before?.quarantined === true;

  // Chunks first — see the note at the top of this file.
  if (chunks.length > 0) {
    const writing = db.batch();
    for (const chunk of chunks) {
      writing.set(db.doc(paths.sessionChunk(study, session.sessionId, chunk.index)), chunk satisfies ChunkDoc);
    }
    await writing.commit();
  }

  await parentRef.set({ ...doc, quarantined, receivedAt: now.toISOString() } satisfies SessionDoc, { merge: false });

  /**
   * Anything a longer earlier upload left behind.
   *
   * A sitting re-uploaded after events were pruned, or split differently by a
   * later build, would otherwise leave chunk 3 sitting next to a parent that
   * claims three chunks — and `joinSession` counts, so the sitting would read
   * as complete while carrying a stale tail. Deleted after the parent is
   * written, so a failure here leaves the readable state rather than a gap.
   */
  const stale = (before?.chunkCount ?? 0) - chunks.length;
  if (stale > 0) {
    const clearing = db.batch();
    for (let i = chunks.length; i < (before?.chunkCount ?? 0); i += 1) {
      clearing.delete(db.doc(paths.sessionChunk(study, session.sessionId, i)));
    }
    await clearing.commit();
  }

  return {
    sessionId: session.sessionId,
    stored: true,
    events: doc.eventCount,
    chunks: chunks.length,
    quarantined,
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
      caller = await authenticate(req.headers.authorization);
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
          outcomes.push(await storeSitting(db, STUDY, one as DeviceSession, deviceId, now));
        } catch (error) {
          logger.error("a sitting could not be stored", { sessionId: one.sessionId, error: String(error) });
          outcomes.push({
            sessionId: one.sessionId,
            stored: false,
            events: one.events.length,
            chunks: 0,
            quarantined: false,
            reason: "could not be written — it is still on the device, and posting it again is safe",
          });
        }
      }

      const stored = outcomes.filter((o) => o.stored).length;
      try {
        await db.collection(paths.audit(STUDY)).add({
          action: "sittings.received",
          actor: caller.uid,
          deviceId,
          device: caller.device,
          offered: outcomes.length,
          stored,
          quarantined: outcomes.filter((o) => o.quarantined).length,
          sessionIds: outcomes.map((o) => o.sessionId),
          at: FieldValue.serverTimestamp(),
        });
      } catch (error) {
        // An audit row that cannot be written must not fail a handover that
        // otherwise worked. The device would re-send, and the sittings are
        // already stored.
        logger.error("saveSitting: could not write the audit row", error);
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
