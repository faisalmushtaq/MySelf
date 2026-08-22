import Dexie, { type EntityTable } from "dexie";
import type { AnswerValue } from "@myself/engine";
import type { ResponseStatus, SessionState } from "@myself/schema";
import { generateDeviceKey, seal, unseal, type Sealed } from "./crypto.js";
import { ulid } from "./ulid.js";

/**
 * Local storage, backed by IndexedDB. Research payloads and the device sync
 * token are AES-GCM sealed. Session rows carry only the metadata required to
 * resume a survey and make its local retention state visible to the operator.
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
  itemKey?: string;
  payload?: Sealed;
  tWall: string;
  tMono: number;
}

interface DeviceRow {
  id: "device";
  key: CryptoKey;
  createdAt: string;
}

interface SyncConfigRow {
  id: "sync";
  endpoint: string;
  token: Sealed;
  configuredAt: string;
}

interface SyncStateRow {
  sessionId: string;
  attempt: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  syncedAt?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
}

interface SyncReceiptRow {
  batchId: string;
  sessionId: string;
  accepted: { sessionId: string; events: number[] }[];
  ackHash: string;
  verifiedAt: string;
}

export interface SyncConfiguration {
  endpoint: string;
  token: string;
  configuredAt: string;
}

export interface SyncEvent {
  seq: number;
  type: string;
  itemKey?: string;
  payload?: unknown;
  tWall: string;
  tMono: number;
}

export interface SyncSession {
  sessionId: string;
  studyCode: string;
  releaseKey: string;
  releaseHash: string;
  startedAt: string;
  completedAt?: string;
  complete: boolean;
  events: SyncEvent[];
}

export interface StoredSessionCounts {
  inProgress: number;
  completed: number;
  awaitingSync: number;
  syncing: number;
  syncFailed: number;
  syncedVerified: number;
  quarantined: number;
}

class MySelfDb extends Dexie {
  sessions!: EntityTable<SessionRow, "sessionId">;
  events!: EntityTable<EventRow, "eventId">;
  device!: EntityTable<DeviceRow, "id">;
  sync_config!: EntityTable<SyncConfigRow, "id">;
  sync_state!: EntityTable<SyncStateRow, "sessionId">;
  sync_receipts!: EntityTable<SyncReceiptRow, "batchId">;

  constructor() {
    super("myself");
    this.version(1).stores({
      sessions: "sessionId, participantCode, state, updatedAt",
      events: "eventId, sessionId, [sessionId+seq]",
      device: "id",
    });
    this.version(2).stores({
      sessions: "sessionId, participantCode, state, updatedAt",
      events: "eventId, sessionId, [sessionId+seq]",
      device: "id",
      sync_config: "id",
      sync_state: "sessionId, nextAttemptAt, syncedAt, quarantinedAt",
      sync_receipts: "batchId, sessionId, verifiedAt",
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
    .filter((session) => session.state === "in_progress" && session.releaseHash === releaseHash)
    .toArray();
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

// Serialise writes so rapid successive answers can never race on sequence.
let writeQueue: Promise<unknown> = Promise.resolve();

/** Append an event and update the session row in one transaction. */
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

/** A complete sitting moves directly to the durable upload queue. */
export async function completeSession(session: SessionRow): Promise<void> {
  const now = new Date().toISOString();
  session.state = "awaiting_sync";
  session.completedAt = now;
  session.updatedAt = now;
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    await db.sessions.put({ ...session });
    await db.sync_state.put({ sessionId: session.sessionId, attempt: 0 });
  });
}

/** Rebuild the current answers map from the encrypted event log. */
export async function loadAnswers(sessionId: string): Promise<Map<string, RecordedAnswer>> {
  const key = await deviceKey();
  const events = await db.events.where("sessionId").equals(sessionId).sortBy("seq");
  const answers = new Map<string, RecordedAnswer>();
  for (const event of events) {
    if (!event.itemKey) continue;
    if (event.type === "response.recorded" || event.type === "response.changed") {
      if (event.payload) {
        const sealed = await unseal<{ value: AnswerValue }>(key, event.payload);
        if (sealed.value) answers.set(event.itemKey, { status: "answered", value: sealed.value });
      }
    } else if (event.type === "item.skipped") {
      answers.set(event.itemKey, { status: "skipped" });
    } else if (event.type === "item.declined") {
      answers.set(event.itemKey, { status: "declined" });
    }
  }
  return answers;
}

/** Store the enrolment configuration locally. The bearer token is encrypted at rest. */
export async function configureSync(endpointInput: string, tokenInput: string): Promise<void> {
  const endpoint = normaliseEndpoint(endpointInput);
  const token = tokenInput.trim();
  if (token.length < 32) throw new Error("device token is too short");
  const key = await deviceKey();
  await db.sync_config.put({ id: "sync", endpoint, token: await seal(key, token), configuredAt: new Date().toISOString() });
}

export async function clearSyncConfiguration(): Promise<void> {
  await db.sync_config.delete("sync");
}

export async function syncConfiguration(): Promise<SyncConfiguration | null> {
  const row = await db.sync_config.get("sync");
  if (!row) return null;
  const token = await unseal<string>(await deviceKey(), row.token);
  return { endpoint: row.endpoint, token, configuredAt: row.configuredAt };
}

/** Materialise queued sessions only when their retry window allows another attempt. */
export async function completedSessionsForSync(force: boolean): Promise<SyncSession[]> {
  const now = Date.now();
  const queued = await db.sessions
    .filter((session) => session.state === "awaiting_sync" || session.state === "sync_failed")
    .toArray();
  const allowed: SessionRow[] = [];
  for (const session of queued) {
    const state = await db.sync_state.get(session.sessionId);
    if (force || !state?.nextAttemptAt || Date.parse(state.nextAttemptAt) <= now) allowed.push(session);
  }
  const key = await deviceKey();
  const materialised: SyncSession[] = [];
  for (const session of allowed.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const events = await db.events.where("sessionId").equals(session.sessionId).sortBy("seq");
    const output: SyncEvent[] = [];
    for (const event of events) {
      const payload = event.payload ? await unseal<unknown>(key, event.payload) : undefined;
      output.push({
        seq: event.seq,
        type: event.type,
        ...(event.itemKey === undefined ? {} : { itemKey: event.itemKey }),
        ...(payload === undefined ? {} : { payload }),
        tWall: event.tWall,
        tMono: event.tMono,
      });
    }
    materialised.push({
      sessionId: session.sessionId,
      studyCode: session.participantCode,
      releaseKey: session.releaseKey,
      releaseHash: session.releaseHash,
      startedAt: session.startedAt,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      complete: true,
      events: output,
    });
  }
  return materialised;
}

export async function markSessionSyncing(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    const session = await requiredSession(sessionId);
    const previous = await db.sync_state.get(sessionId);
    await db.sessions.update(sessionId, { state: "syncing", updatedAt: now });
    await db.sync_state.put({
      sessionId,
      attempt: (previous?.attempt ?? 0) + 1,
      lastAttemptAt: now,
      ...(previous?.syncedAt ? { syncedAt: previous.syncedAt } : {}),
    });
  });
}

export async function markSessionSynced(sessionId: string, at: string): Promise<void> {
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    await requiredSession(sessionId);
    const previous = await db.sync_state.get(sessionId);
    await db.sessions.update(sessionId, { state: "synced_verified", updatedAt: at });
    await db.sync_state.put({
      sessionId,
      attempt: previous?.attempt ?? 1,
      syncedAt: at,
      ...(previous?.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
    });
  });
}

export async function markSessionSyncFailed(sessionId: string, reason: string, at: string): Promise<void> {
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    await requiredSession(sessionId);
    const previous = await db.sync_state.get(sessionId);
    const attempt = previous?.attempt ?? 1;
    await db.sessions.update(sessionId, { state: "sync_failed", updatedAt: at });
    await db.sync_state.put({
      sessionId,
      attempt,
      lastAttemptAt: previous?.lastAttemptAt ?? at,
      nextAttemptAt: new Date(Date.parse(at) + retryDelayMs(attempt)).toISOString(),
      lastError: reason.slice(0, 500),
    });
  });
}

export async function markSessionQuarantined(sessionId: string, reason: string, at: string): Promise<void> {
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    await requiredSession(sessionId);
    const previous = await db.sync_state.get(sessionId);
    await db.sessions.update(sessionId, { state: "quarantined", updatedAt: at });
    await db.sync_state.put({
      sessionId,
      attempt: previous?.attempt ?? 1,
      quarantinedAt: at,
      quarantineReason: reason.slice(0, 500),
      ...(previous?.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
    });
  });
}

export async function acknowledgedEventSequences(sessionId: string): Promise<number[]> {
  const receipts = await db.sync_receipts.where("sessionId").equals(sessionId).toArray();
  const sequences = new Set<number>();
  for (const receipt of receipts) {
    for (const entry of receipt.accepted) {
      if (entry.sessionId === sessionId) for (const sequence of entry.events) sequences.add(sequence);
    }
  }
  return [...sequences].sort((a, b) => a - b);
}

export async function recordSyncReceipt(receipt: SyncReceiptRow): Promise<void> {
  await db.sync_receipts.put(receipt);
}

export async function countStoredSessions(): Promise<StoredSessionCounts> {
  const all = await db.sessions.toArray();
  const count = (state: SessionState) => all.filter((session) => session.state === state).length;
  return {
    inProgress: count("in_progress"),
    completed: all.filter((session) => session.state !== "in_progress" && session.state !== "not_started").length,
    awaitingSync: count("awaiting_sync"),
    syncing: count("syncing"),
    syncFailed: count("sync_failed"),
    syncedVerified: count("synced_verified"),
    quarantined: count("quarantined"),
  };
}

async function requiredSession(sessionId: string): Promise<SessionRow> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error(`session '${sessionId}' does not exist`);
  return session;
}

function retryDelayMs(attempt: number): number {
  const ceiling = 60 * 60 * 1000;
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), ceiling);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function normaliseEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("sync endpoint must be a complete URL");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("sync endpoint must use HTTPS outside local development");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}
