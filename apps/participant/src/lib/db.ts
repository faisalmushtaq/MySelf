import Dexie, { type EntityTable } from "dexie";
import type { AnswerValue } from "@myself/engine";
import type { ResponseStatus, SessionState } from "@myself/schema";
import { generateDeviceKey, seal, unseal, type Sealed } from "./crypto.js";
import { ulid } from "./ulid.js";

/**
 * Local storage (IndexedDB via Dexie). Events are append-only and their
 * payloads are AES-GCM sealed; session rows carry only operational metadata.
 * Autosave is transactional: event append + session update commit together.
 */

export interface SessionRow {
  sessionId: string;
  participantCode: string;
  releaseKey: string;
  releaseHash: string;
  state: SessionState;
  currentIndex: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  eventCount: number;
}

export interface EventRow {
  eventId: string;
  sessionId: string;
  seq: number;
  type: string;
  itemKey?: string; // "<instrument>.<item>"
  payload?: Sealed;
  tWall: string;
  tMono: number;
}

interface DeviceRow {
  id: "device";
  key: CryptoKey;
  createdAt: string;
}

class MySelfDb extends Dexie {
  sessions!: EntityTable<SessionRow, "sessionId">;
  events!: EntityTable<EventRow, "eventId">;
  device!: EntityTable<DeviceRow, "id">;

  constructor() {
    super("myself");
    this.version(1).stores({
      sessions: "sessionId, participantCode, state, updatedAt",
      events: "eventId, sessionId, [sessionId+seq]",
      device: "id",
    });
  }
}

export const db = new MySelfDb();

let cachedKey: CryptoKey | null = null;

export async function deviceKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const existing = await db.device.get("device");
  if (existing) {
    cachedKey = existing.key;
    return existing.key;
  }
  const key = await generateDeviceKey();
  await db.device.put({ id: "device", key, createdAt: new Date().toISOString() });
  cachedKey = key;
  return key;
}

export interface RecordedAnswer {
  status: ResponseStatus;
  value?: AnswerValue;
}

export async function createSession(participantCode: string, releaseKey: string, releaseHash: string): Promise<SessionRow> {
  const now = new Date().toISOString();
  const row: SessionRow = {
    sessionId: `ses_${ulid()}`,
    participantCode,
    releaseKey,
    releaseHash,
    state: "in_progress",
    currentIndex: 0,
    startedAt: now,
    updatedAt: now,
    eventCount: 0,
  };
  await db.sessions.add(row);
  return row;
}

export async function findResumableSession(participantCode: string, releaseHash: string): Promise<SessionRow | undefined> {
  const rows = await db.sessions
    .where("participantCode")
    .equals(participantCode)
    .filter((s) => s.state === "in_progress" && s.releaseHash === releaseHash)
    .toArray();
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

// Serialise writes so rapid successive answers can never race on `seq`.
let writeQueue: Promise<unknown> = Promise.resolve();

/** Append an event and update the session row in one transaction (autosave). */
export function appendEvent(...args: Parameters<typeof appendEventInner>): Promise<void> {
  const next = writeQueue.then(() => appendEventInner(...args));
  writeQueue = next.catch(() => undefined);
  return next;
}

async function appendEventInner(
  session: SessionRow,
  type: string,
  itemKey: string | undefined,
  payload: unknown | undefined,
  currentIndex: number,
  tMono: number,
): Promise<void> {
  const key = await deviceKey();
  const sealed = payload === undefined ? undefined : await seal(key, payload);
  await db.transaction("rw", db.events, db.sessions, async () => {
    const seq = session.eventCount;
    const eventRow: EventRow = {
      eventId: `evt_${ulid()}`,
      sessionId: session.sessionId,
      seq,
      type,
      tWall: new Date().toISOString(),
      tMono,
      ...(itemKey !== undefined ? { itemKey } : {}),
      ...(sealed !== undefined ? { payload: sealed } : {}),
    };
    await db.events.add(eventRow);
    session.eventCount = seq + 1;
    session.currentIndex = currentIndex;
    session.updatedAt = eventRow.tWall;
    await db.sessions.put({ ...session });
  });
}

export async function completeSession(session: SessionRow): Promise<void> {
  const now = new Date().toISOString();
  session.state = "completed_locally";
  session.completedAt = now;
  session.updatedAt = now;
  await db.sessions.put({ ...session });
}

/** Rebuild the current answers map from the encrypted event log (resume path). */
export async function loadAnswers(sessionId: string): Promise<Map<string, RecordedAnswer>> {
  const key = await deviceKey();
  const events = await db.events.where("sessionId").equals(sessionId).sortBy("seq");
  const answers = new Map<string, RecordedAnswer>();
  for (const e of events) {
    if (!e.itemKey) continue;
    if (e.type === "response.recorded" || e.type === "response.changed") {
      if (e.payload) {
        const value = await unseal<AnswerValue>(key, e.payload);
        answers.set(e.itemKey, { status: "answered", value });
      }
    } else if (e.type === "item.skipped") {
      answers.set(e.itemKey, { status: "skipped" });
    } else if (e.type === "item.declined") {
      answers.set(e.itemKey, { status: "declined" });
    }
  }
  return answers;
}

export async function countStoredSessions(): Promise<{ inProgress: number; completed: number }> {
  const all = await db.sessions.toArray();
  return {
    inProgress: all.filter((s) => s.state === "in_progress").length,
    completed: all.filter((s) => s.state === "completed_locally").length,
  };
}
