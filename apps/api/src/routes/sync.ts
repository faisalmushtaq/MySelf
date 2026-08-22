import { createHash } from "node:crypto";
import { canonicalJson } from "@myself/release";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { audit, type Device } from "../auth.js";

/**
 * Taking a batch of sittings off an iPad.
 *
 * Three properties this has to have, in order of how much damage their absence
 * does:
 *
 *   1. IDEMPOTENT. A retried upload on a school wifi must not double anyone's
 *      data. Events are keyed on (session, seq) and inserted with ON CONFLICT
 *      DO NOTHING, so a replay is a no-op by construction rather than because
 *      the device was careful.
 *   2. NEVER MERGES. If the same sitting arrives from a second device, or with
 *      different metadata, both copies are kept and the sitting is quarantined.
 *      No automatic resolution: a conflict here means two children may be
 *      involved, and picking one silently is the worst available outcome.
 *   3. ACKNOWLEDGED. The response says exactly which events were accepted and
 *      carries a hash of that list. The device only marks them synced after
 *      checking it, so a truncated response leaves the remainder queued.
 */

const eventShape = z.object({
  seq: z.number().int().min(0),
  type: z.string().min(1),
  itemKey: z.string().optional(),
  payload: z.unknown().optional(),
  tWall: z.string().min(1),
  tMono: z.number(),
});

const sessionShape = z.object({
  sessionId: z.string().min(1),
  studyCode: z.string().min(1),
  releaseKey: z.string().min(1),
  releaseHash: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  complete: z.boolean(),
  events: z.array(eventShape),
});

export const batchShape = z.object({
  format: z.string().optional(),
  exportedAt: z.string().optional(),
  app: z.string().optional(),
  sessions: z.array(sessionShape),
});

export type SyncBatch = z.infer<typeof batchShape>;

export interface SyncAck {
  batchId: string;
  accepted: { sessionId: string; events: number[] }[];
  quarantined: { sessionId: string; reason: string }[];
  ackHash: string;
  duplicate: boolean;
}

/**
 * Stable identity for a batch: same content from the same device, same id.
 *
 * Over the whole content, canonicalised — not over a summary of it. An earlier
 * version hashed only session ids and event counts, which gave two genuinely
 * different uploads the same id whenever they happened to have the same shape,
 * and the second was silently dropped as a replay. Cheap to get right; a
 * miserable class of bug to find in a term's worth of data.
 */
export function batchId(deviceId: string, batch: SyncBatch): string {
  const spine = [...batch.sessions]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((s) =>
      canonicalJson({
        sessionId: s.sessionId,
        studyCode: s.studyCode,
        releaseKey: s.releaseKey,
        releaseHash: s.releaseHash,
        startedAt: s.startedAt,
        completedAt: s.completedAt ?? null,
        complete: s.complete,
        events: [...s.events]
          .sort((x, y) => x.seq - y.seq)
          .map((e) => [e.seq, e.type, e.itemKey ?? null, e.payload === undefined ? null : e.payload]),
      }),
    )
    .join("|");
  return createHash("sha256").update(`${deviceId}\n${spine}`).digest("hex").slice(0, 32);
}

const ackHashOf = (accepted: SyncAck["accepted"]): string =>
  createHash("sha256")
    .update(JSON.stringify(accepted.map((a) => [a.sessionId, a.events]).sort()))
    .digest("hex");

export async function ingestBatch(db: Db, device: Device, batch: SyncBatch): Promise<SyncAck> {
  const id = batchId(device.deviceId, batch);

  const existing = await db.query<{ ack_hash: string; accepted: SyncAck["accepted"] }>(
    "SELECT ack_hash, accepted FROM research.sync_receipts WHERE batch_id = $1",
    [id],
  );
  if (existing.rows[0]) {
    // Already landed. Return the original acknowledgement rather than a blank
    // duplicate marker: a device that missed the first HTTP response still has
    // to verify every event before it may mark its local copy as synced.
    return {
      batchId: id,
      accepted: existing.rows[0].accepted,
      quarantined: [],
      ackHash: existing.rows[0].ack_hash,
      duplicate: true,
    };
  }

  const accepted: SyncAck["accepted"] = [];
  const quarantined: SyncAck["quarantined"] = [];
  let eventCount = 0;

  await db.transaction(async (tx) => {
    for (const session of batch.sessions) {
      const prior = await tx.query<{ device_id: string; release_hash: string; started_at: Date }>(
        "SELECT device_id, release_hash, started_at FROM research.sessions WHERE session_id = $1",
        [session.sessionId],
      );
      const seen = prior.rows[0];

      if (seen && seen.device_id !== device.deviceId) {
        // The same session identifier from two devices. Both copies are kept
        // and neither is trusted until somebody looks.
        await tx.query(
          "INSERT INTO research.quarantine (session_id, device_id, reason, payload) VALUES ($1, $2, $3, $4)",
          [session.sessionId, device.deviceId, "same sitting received from a second device", JSON.stringify(session)],
        );
        await tx.query("UPDATE research.sessions SET quarantined = true WHERE session_id = $1", [session.sessionId]);
        quarantined.push({ sessionId: session.sessionId, reason: "same sitting received from a second device" });
        continue;
      }

      if (seen && seen.release_hash !== session.releaseHash) {
        // One sitting cannot have been collected under two releases. Something
        // is wrong with the identifier, not with the answers.
        await tx.query(
          "INSERT INTO research.quarantine (session_id, device_id, reason, payload) VALUES ($1, $2, $3, $4)",
          [session.sessionId, device.deviceId, "release hash differs from the copy already stored", JSON.stringify(session)],
        );
        await tx.query("UPDATE research.sessions SET quarantined = true WHERE session_id = $1", [session.sessionId]);
        quarantined.push({ sessionId: session.sessionId, reason: "release hash differs from the copy already stored" });
        continue;
      }

      await tx.query(
        `INSERT INTO research.sessions
           (session_id, device_id, study, study_code, release_key, release_hash, started_at, completed_at, complete)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (session_id) DO UPDATE SET
           completed_at = COALESCE(EXCLUDED.completed_at, research.sessions.completed_at),
           complete = research.sessions.complete OR EXCLUDED.complete`,
        [
          session.sessionId,
          device.deviceId,
          device.study,
          session.studyCode,
          session.releaseKey,
          session.releaseHash,
          session.startedAt,
          session.completedAt ?? null,
          session.complete,
        ],
      );

      const events: number[] = [];
      for (const event of session.events) {
        const result = await tx.query(
          `INSERT INTO research.events (session_id, seq, type, item_key, payload, t_wall, t_mono)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (session_id, seq) DO NOTHING`,
          [
            session.sessionId,
            event.seq,
            event.type,
            event.itemKey ?? null,
            event.payload === undefined ? null : JSON.stringify(event.payload),
            event.tWall,
            Math.round(event.tMono),
          ],
        );
        // Only newly stored events are acknowledged; a device re-sending what
        // the server already has gets an honest empty list for them.
        if (result.rowCount > 0) events.push(event.seq);
      }
      eventCount += events.length;
      accepted.push({ sessionId: session.sessionId, events });
    }

    const hash = ackHashOf(accepted);
    await tx.query(
      `INSERT INTO research.sync_receipts (batch_id, device_id, session_count, event_count, ack_hash, accepted)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, device.deviceId, batch.sessions.length, eventCount, hash, JSON.stringify(accepted)],
    );
    await audit(tx, {
      actor: `device:${device.deviceId}`,
      action: "sync.batch",
      study: device.study,
      subject: id,
      detail: { sessions: batch.sessions.length, events: eventCount, quarantined: quarantined.length },
    });
  });

  return { batchId: id, accepted, quarantined, ackHash: ackHashOf(accepted), duplicate: false };
}

/** Every stored sitting, in the shape `@myself/store` ingests. */
export async function storedSessions(db: Db, study: string, includeQuarantined = false) {
  const { rows } = await db.query<{
    session_id: string;
    study_code: string;
    release_key: string;
    release_hash: string;
    started_at: Date;
    completed_at: Date | null;
    complete: boolean;
  }>(
    `SELECT session_id, study_code, release_key, release_hash, started_at, completed_at, complete
       FROM research.sessions
      WHERE study = $1 AND ($2 OR NOT quarantined)
      ORDER BY started_at`,
    [study, includeQuarantined],
  );

  const out = [];
  for (const row of rows) {
    const events = await db.query<{
      seq: number;
      type: string;
      item_key: string | null;
      payload: unknown;
      t_wall: Date;
      t_mono: string;
    }>(
      "SELECT seq, type, item_key, payload, t_wall, t_mono FROM research.events WHERE session_id = $1 ORDER BY seq",
      [row.session_id],
    );
    out.push({
      sessionId: row.session_id,
      studyCode: row.study_code,
      releaseKey: row.release_key,
      releaseHash: row.release_hash,
      startedAt: new Date(row.started_at).toISOString(),
      ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
      complete: row.complete,
      events: events.rows.map((e) => ({
        seq: e.seq,
        type: e.type,
        ...(e.item_key ? { itemKey: e.item_key } : {}),
        ...(e.payload === null ? {} : { payload: e.payload as Record<string, unknown> }),
        tWall: new Date(e.t_wall).toISOString(),
        tMono: Number(e.t_mono),
      })),
    });
  }
  return out;
}
