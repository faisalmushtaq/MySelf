import {
  completedSessionsForSync,
  acknowledgedEventSequences,
  markSessionQuarantined,
  markSessionSyncFailed,
  markSessionSynced,
  markSessionSyncing,
  recordSyncReceipt,
  syncConfiguration,
  type SyncConfiguration,
  type SyncSession,
} from "./db.js";

export interface SyncBatch {
  format: "myself.device.export.v1";
  exportedAt: string;
  app: string;
  sessions: SyncSession[];
}

export interface SyncAck {
  batchId: string;
  accepted: { sessionId: string; events: number[] }[];
  quarantined: { sessionId: string; reason: string }[];
  ackHash: string;
  duplicate: boolean;
}

export type SyncOutcome =
  | { kind: "synced"; sessionId: string; batchId: string; duplicate: boolean }
  | { kind: "quarantined"; sessionId: string; reason: string }
  | { kind: "failed"; sessionId: string; reason: string }
  | { kind: "not_configured" }
  | { kind: "offline" };

export interface SyncReport {
  outcomes: SyncOutcome[];
  synced: number;
  failed: number;
  quarantined: number;
}

export interface SyncPersistence {
  configuration(): Promise<SyncConfiguration | null>;
  completedSessions(force: boolean): Promise<SyncSession[]>;
  markSyncing(sessionId: string): Promise<void>;
  markSynced(sessionId: string, at: string): Promise<void>;
  markFailed(sessionId: string, reason: string, at: string): Promise<void>;
  markQuarantined(sessionId: string, reason: string, at: string): Promise<void>;
  acknowledgedSequences(sessionId: string): Promise<number[]>;
  saveReceipt(receipt: {
    batchId: string;
    sessionId: string;
    accepted: { sessionId: string; events: number[] }[];
    ackHash: string;
    verifiedAt: string;
  }): Promise<void>;
}

const persistence: SyncPersistence = {
  configuration: syncConfiguration,
  completedSessions: completedSessionsForSync,
  markSyncing: markSessionSyncing,
  markSynced: markSessionSynced,
  markFailed: markSessionSyncFailed,
  markQuarantined: markSessionQuarantined,
  acknowledgedSequences: acknowledgedEventSequences,
  saveReceipt: recordSyncReceipt,
};

export interface SyncOptions {
  /** Attempt sessions whose retry time has not yet arrived. Intended for the visible Sync now action. */
  force?: boolean;
  /** Primarily for deterministic tests. */
  now?: () => Date;
  /** Primarily for deterministic tests. */
  transport?: typeof fetch;
  /** A bounded request prevents a hung school connection from holding the UI forever. */
  timeoutMs?: number;
  /** A test seam; production calls use the encrypted device-backed persistence above. */
  storage?: SyncPersistence;
}

/**
 * Synchronise completed sessions one at a time. A completed sitting is retained
 * locally until the server acknowledgement has been checked and stored. Safari
 * cannot run this reliably in the background, so callers invoke it on launch,
 * connectivity restoration and from the explicit operator control.
 */
export async function synchroniseCompletedSessions(options: SyncOptions = {}): Promise<SyncReport> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { outcomes: [{ kind: "offline" }], synced: 0, failed: 0, quarantined: 0 };
  }

  const storage = options.storage ?? persistence;
  const configuration = await storage.configuration();
  if (!configuration) return { outcomes: [{ kind: "not_configured" }], synced: 0, failed: 0, quarantined: 0 };

  const now = options.now ?? (() => new Date());
  const transport = options.transport ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sessions = await storage.completedSessions(options.force ?? false);
  const outcomes: SyncOutcome[] = [];
  let synced = 0;
  let failed = 0;
  let quarantined = 0;

  for (const session of sessions) {
    const at = now().toISOString();
    await storage.markSyncing(session.sessionId);
    try {
      const acknowledged = await storage.acknowledgedSequences(session.sessionId);
      const batch: SyncBatch = {
        format: "myself.device.export.v1",
        exportedAt: at,
        app: "myself-participant",
        sessions: [session],
      };
      const ack = await upload(configuration, batch, transport, timeoutMs);
      const held = ack.quarantined.find((entry) => entry.sessionId === session.sessionId);
      if (held) {
        await storage.markQuarantined(session.sessionId, held.reason, at);
        outcomes.push({ kind: "quarantined", sessionId: session.sessionId, reason: held.reason });
        quarantined += 1;
        continue;
      }

      await verifyAcknowledgement(ack, session, acknowledged);
      await storage.saveReceipt({
        batchId: ack.batchId,
        sessionId: session.sessionId,
        accepted: ack.accepted,
        ackHash: ack.ackHash,
        verifiedAt: at,
      });
      await storage.markSynced(session.sessionId, at);
      outcomes.push({ kind: "synced", sessionId: session.sessionId, batchId: ack.batchId, duplicate: ack.duplicate });
      synced += 1;
    } catch (error) {
      const reason = explain(error);
      await storage.markFailed(session.sessionId, reason, at);
      outcomes.push({ kind: "failed", sessionId: session.sessionId, reason });
      failed += 1;
    }
  }

  return { outcomes, synced, failed, quarantined };
}

async function upload(
  configuration: SyncConfiguration,
  batch: SyncBatch,
  transport: typeof fetch,
  timeoutMs: number,
): Promise<SyncAck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await transport(`${configuration.endpoint.replace(/\/$/, "")}/sync/batches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuration.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isRecord(body) && typeof body["error"] === "string" ? `: ${body["error"]}` : "";
      throw new Error(`sync server returned ${response.status}${detail}`);
    }
    return parseAck(body);
  } finally {
    clearTimeout(timer);
  }
}

export async function acknowledgementHash(accepted: SyncAck["accepted"]): Promise<string> {
  // This is intentionally byte-for-byte the acknowledgement spine used by the
  // API. A client marks a session verified only after it independently derives
  // the same digest from the response it received.
  const text = JSON.stringify(accepted.map((entry) => [entry.sessionId, entry.events]).sort());
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAcknowledgement(ack: SyncAck, session: SyncSession, alreadyVerified: readonly number[] = []): Promise<void> {
  if (!ack.batchId || !/^[a-zA-Z0-9_-]+$/.test(ack.batchId)) throw new Error("server acknowledgement has an invalid batch id");
  if (await acknowledgementHash(ack.accepted) !== ack.ackHash) throw new Error("server acknowledgement checksum did not verify");

  const accepted = ack.accepted.find((entry) => entry.sessionId === session.sessionId);
  if (!accepted) throw new Error("server acknowledgement omitted the session");
  const prior = new Set(alreadyVerified);
  const expected = session.events
    .map((event) => event.seq)
    .filter((seq) => !prior.has(seq))
    .sort((a, b) => a - b);
  const received = [...accepted.events].sort((a, b) => a - b);
  if (expected.length !== received.length || expected.some((seq, index) => seq !== received[index])) {
    throw new Error("server acknowledgement did not confirm every event");
  }
}

function parseAck(value: unknown): SyncAck {
  if (!isRecord(value)) throw new Error("sync server returned an invalid acknowledgement");
  const accepted = Array.isArray(value["accepted"])
    ? value["accepted"].map((entry) => {
        if (!isRecord(entry) || typeof entry["sessionId"] !== "string" || !Array.isArray(entry["events"])) {
          throw new Error("sync server acknowledgement contains an invalid accepted entry");
        }
        const events = entry["events"];
        if (!events.every((event) => typeof event === "number" && Number.isInteger(event) && event >= 0)) {
          throw new Error("sync server acknowledgement contains an invalid event sequence");
        }
        return { sessionId: entry["sessionId"], events: events as number[] };
      })
    : null;
  const quarantined = Array.isArray(value["quarantined"])
    ? value["quarantined"].map((entry) => {
        if (!isRecord(entry) || typeof entry["sessionId"] !== "string" || typeof entry["reason"] !== "string") {
          throw new Error("sync server acknowledgement contains an invalid quarantine entry");
        }
        return { sessionId: entry["sessionId"], reason: entry["reason"] };
      })
    : null;
  if (
    typeof value["batchId"] !== "string" ||
    typeof value["ackHash"] !== "string" ||
    typeof value["duplicate"] !== "boolean" ||
    !accepted ||
    !quarantined
  ) {
    throw new Error("sync server returned an incomplete acknowledgement");
  }
  return { batchId: value["batchId"], accepted, quarantined, ackHash: value["ackHash"], duplicate: value["duplicate"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "sync request timed out";
  if (error instanceof Error) return error.message;
  return "sync failed for an unknown reason";
}
