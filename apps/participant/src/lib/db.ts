import Dexie, { type EntityTable } from "dexie";
import type { AnswerValue } from "@myself/engine";
import type { ResponseStatus, SessionState } from "@myself/schema";
import { generateDeviceKey, seal, unseal, type Sealed } from "./crypto.js";
import {
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  normaliseAccessibilityPreferences,
  type AccessibilityPreferences,
} from "./accessibility.js";
import { ulid } from "./ulid.js";
import type { DeviceEventUpload, SittingUploadItem } from "@myself/store";

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

/**
 * This device's self-issued credential — see `identity.ts`.
 *
 * Stored beside the AES key on purpose. The two have the same lifetime, and that
 * is what makes the identity safe to rely on: there is no way to lose the
 * credential while keeping readable sittings.
 */
interface InstallRow {
  id: "install";
  installId: string;
  secret: string;
  createdAt: string;
}

/** How much of a still-running sitting the server has a copy of. */
interface CheckpointRow {
  sessionId: string;
  events: number;
  at: string;
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

/**
 * The server's confirmation, kept.
 *
 * A sitting is only deleted from this device once a row exists here saying the
 * study stored it and how many events it stored — so "has this been handed over"
 * is answerable from the device itself, months later, without asking the server.
 */
interface SyncReceiptRow {
  sessionId: string;
  events: number;
  chunks: number;
  verifiedAt: string;
}

interface AccessibilityRow extends AccessibilityPreferences {
  id: "participant";
  updatedAt: string;
}

/** How the handover panel names this device. */
export interface Enrolment {
  deviceId: string;
  /** When the device issued itself an identity, which is its first launch. */
  firstSyncedAt: string;
}


/**
 * What an upload looks like, which is the shared wire contract and not this file's
 * own idea of it.
 *
 * This was declared here as well as in `@myself/store` and in the function — three
 * descriptions of one protocol. They had already drifted: the payload was `unknown`
 * here and an object in the contract, so this end would have compiled while sending
 * something the server refuses.
 */
export type SyncEvent = DeviceEventUpload;
export type SyncSession = SittingUploadItem;

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
  install!: EntityTable<InstallRow, "id">;
  sync_state!: EntityTable<SyncStateRow, "sessionId">;
  receipts!: EntityTable<SyncReceiptRow, "sessionId">;
  checkpoints!: EntityTable<CheckpointRow, "sessionId">;
  accessibility!: EntityTable<AccessibilityRow, "id">;

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
    this.version(3).stores({
      sessions: "sessionId, participantCode, state, updatedAt",
      events: "eventId, sessionId, [sessionId+seq]",
      device: "id",
      sync_config: "id",
      sync_state: "sessionId, nextAttemptAt, syncedAt, quarantinedAt",
      sync_receipts: "batchId, sessionId, verifiedAt",
      accessibility: "id, updatedAt",
    });
    /**
     * Version 4: a self-issued identity, checkpoints, and receipts that mean
     * something.
     *
     * `sync_config` held an endpoint and a bearer token for a server that was never
     * deployed. `sync_receipts` was keyed on a batch id the study's actual write path
     * does not issue. Both go.
     *
     * THE NEW RECEIPTS TABLE HAS A NEW NAME, AND THAT IS NOT COSMETIC. Re-keying
     * `sync_receipts` from `batchId` to `sessionId` looked like the obvious migration
     * and would have bricked every device that had ever opened the app: Dexie refuses a
     * primary-key change outright — `getSchemaDiff` throws `Upgrade: Not yet support for
     * changing primary key` — and it throws BEFORE any `.upgrade()` callback runs, so
     * there is no hook from which to clear the table first. The database would simply
     * fail to open, on a device holding sittings, with no way in.
     *
     * So the old table is dropped and `receipts` is created beside it. Dropping and
     * adding are both things Dexie will do.
     *
     * Nothing worth keeping is lost: no sitting was ever successfully synchronised
     * through the old shape, and a receipt keyed on the wrong thing is worse than none.
     * An upgraded device treats its queued sittings as unconfirmed and sends them again,
     * which `saveSitting` is idempotent about. Sittings and their event logs are
     * untouched — an iPad upgraded mid-study keeps everything a child answered.
     */
    this.version(4).stores({
      sessions: "sessionId, participantCode, state, updatedAt",
      events: "eventId, sessionId, [sessionId+seq]",
      device: "id",
      sync_config: null,
      sync_receipts: null,
      install: "id",
      sync_state: "sessionId, nextAttemptAt, syncedAt, quarantinedAt",
      receipts: "sessionId, verifiedAt",
      checkpoints: "sessionId, at",
      accessibility: "id, updatedAt",
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

export async function accessibilityPreferences(): Promise<AccessibilityPreferences> {
  const stored = await db.accessibility.get("participant");
  return normaliseAccessibilityPreferences(stored ?? DEFAULT_ACCESSIBILITY_PREFERENCES);
}

export async function saveAccessibilityPreferences(preferences: AccessibilityPreferences): Promise<AccessibilityPreferences> {
  const normalised = normaliseAccessibilityPreferences(preferences);
  await db.accessibility.put({ id: "participant", ...normalised, updatedAt: new Date().toISOString() });
  return normalised;
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

/**
 * Remember which iPad this is, for the operator's benefit.
 *
 * Written after the device has actually signed in, so the id in this row is one
 * the server issued rather than one this app made up.
 */
/**
 * What this device is, for the operator to read off the screen.
 *
 * Derived from the credential rather than stored twice. The panel shows it so a
 * researcher looking at a sitting in the dataset can match it to the iPad in their
 * hand, and so "has this device ever reached the study" has a visible answer.
 */
export async function deviceSummary(): Promise<Enrolment | null> {
  const row = await db.install.get("install");
  return row ? { deviceId: row.installId, firstSyncedAt: row.createdAt } : null;
}

/** Materialise queued sittings only when their retry window allows another attempt. */
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
  return materialise(allowed.sort((a, b) => a.startedAt.localeCompare(b.startedAt)), true);
}

/**
 * Sittings still being answered that have moved on since their last checkpoint.
 *
 * Only ones that have actually grown: re-sending an unchanged log would cost a
 * request per pass per open sitting and tell the server nothing it does not
 * already hold. The oldest go first, because a sitting that has been open longest
 * is the one with most to lose.
 */
export async function runningSessionsForCheckpoint(): Promise<SyncSession[]> {
  const running = await db.sessions.where("state").equals("in_progress").toArray();
  const behind: SessionRow[] = [];
  for (const session of running) {
    if (session.eventCount === 0) continue;
    const checkpoint = await db.checkpoints.get(session.sessionId);
    if ((checkpoint?.events ?? 0) < session.eventCount) behind.push(session);
  }
  return materialise(behind.sort((a, b) => a.startedAt.localeCompare(b.startedAt)), false);
}

/** Decrypt a set of sittings into the shape the server accepts. */
async function materialise(rows: readonly SessionRow[], complete: boolean): Promise<SyncSession[]> {
  const key = await deviceKey();
  const out: SyncSession[] = [];
  for (const session of rows) {
    const events = await db.events.where("sessionId").equals(session.sessionId).sortBy("seq");
    const output: SyncEvent[] = [];
    for (const event of events) {
      /**
       * Unsealed as an object, which is what every payload this app writes is.
       *
       * Typed rather than `unknown` because the wire contract says `Record<string,
       * unknown>`, and the loose type here was hiding that: this end compiled while
       * being able to send a bare string the server's schema refuses.
       */
      const payload = event.payload
        ? await unseal<Record<string, unknown>>(key, event.payload)
        : undefined;
      output.push({
        seq: event.seq,
        type: event.type,
        ...(event.itemKey === undefined ? {} : { itemKey: event.itemKey }),
        ...(payload === undefined ? {} : { payload }),
        tWall: event.tWall,
        tMono: event.tMono,
      });
    }
    out.push({
      sessionId: session.sessionId,
      studyCode: session.participantCode,
      releaseKey: session.releaseKey,
      releaseHash: session.releaseHash,
      startedAt: session.startedAt,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      complete,
      events: output,
    });
  }
  return out;
}

export async function recordCheckpoint(sessionId: string, events: number, at: string): Promise<void> {
  await db.checkpoints.put({ sessionId, events, at });
}

export async function markSessionSyncing(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction("rw", db.sessions, db.sync_state, async () => {
    await requiredSession(sessionId);
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

export async function recordSyncReceipt(receipt: SyncReceiptRow): Promise<void> {
  await db.receipts.put(receipt);
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

/**
 * Sittings this device is still the only copy of.
 *
 * What the handover panel counts down to zero. A sitting is "held" until the
 * study has confirmed it — so a quarantined one counts, because the server
 * refused it and a person has to look, and a `synced_verified` one does not.
 */
export async function heldSessionCount(): Promise<number> {
  const all = await db.sessions.toArray();
  return all.filter((s) => s.state !== "synced_verified").length;
}

export interface Erasure {
  sessions: number;
  events: number;
}

/**
 * May this device stop being the only copy of this sitting?
 *
 * Pure, and separate from the deletion it authorises, because this is the one
 * decision in the app whose failure mode is silent and permanent. Three things
 * must all hold, and each rules out a real way a sitting could otherwise be lost:
 *
 *   - the sitting's own state says the study confirmed it, so a queued, failed
 *     or quarantined sitting can never be selected;
 *   - a receipt exists, so a state written by some other path is not enough;
 *   - and the receipt's event count matches what is on the device NOW, so a
 *     sitting that grew after it was confirmed — a checkpoint confirmed, then
 *     more answers recorded — is held until the longer version is confirmed too.
 */
export function safeToForget(
  session: Pick<SessionRow, "state" | "eventCount">,
  receipt: { events: number } | undefined,
): boolean {
  if (session.state !== "synced_verified") return false;
  if (!receipt) return false;
  return receipt.events === session.eventCount;
}

/**
 * Delete the sittings the study has confirmed it holds, and nothing else.
 *
 * WHY THIS EXISTS. Without it an iPad accumulates every child's answers for the
 * whole study, and the only way to clear one is to delete the app or clear
 * Safari's data — which also destroys the AES key in `device`, making any
 * sitting that had NOT been handed over permanently unreadable. So the blunt
 * instrument is not just untidy, it is the one that loses data.
 *
 * SAFE BY CONSTRUCTION, not by the caller being careful. It deletes a sitting
 * only where a receipt exists for it AND the receipt's event count matches what
 * is on the device AND the row says `synced_verified`. There is no argument for
 * "delete everything" and no way to ask for one: a sitting the server has not
 * confirmed cannot be selected by this function at all, whatever the operator
 * taps.
 *
 * The receipt is KEPT. It is small, it is the evidence that this device handed
 * that sitting over, and a device that forgot would have no way to answer "did
 * this one ever arrive" months later.
 */
export async function forgetConfirmedSessions(): Promise<Erasure> {
  const confirmed: SessionRow[] = [];
  for (const session of await db.sessions.toArray()) {
    const receipt = await db.receipts.get(session.sessionId);
    if (safeToForget(session, receipt)) confirmed.push(session);
  }
  if (confirmed.length === 0) return { sessions: 0, events: 0 };

  let events = 0;
  await db.transaction("rw", db.sessions, db.events, db.sync_state, db.checkpoints, async () => {
    for (const session of confirmed) {
      events += await db.events.where("sessionId").equals(session.sessionId).delete();
      await db.sessions.delete(session.sessionId);
      await db.sync_state.delete(session.sessionId);
      await db.checkpoints.delete(session.sessionId);
    }
  });
  return { sessions: confirmed.length, events };
}

async function requiredSession(sessionId: string): Promise<SessionRow> {
  const session = await db.sessions.get(sessionId);
  if (!session) throw new Error(`session '${sessionId}' does not exist`);
  return session;
}

/**
 * How long to wait before trying an upload again.
 *
 * Exponential from 30 seconds, jittered, and capped — the cap is the part that
 * matters in a school. A hall where the wifi is saturated at 9am produces a run of
 * failures on every device at once, and an uncapped schedule would have them all
 * retrying in lockstep forever. The jitter spreads a rack of iPads that failed
 * together so they do not all come back at the same instant and fail together again.
 *
 * THE CEILING IS TEN MINUTES, not an hour. An hour is the right ceiling for a
 * background job on a server and the wrong one here: a school day is six hours, an
 * iPad is handed back at the end of it, and a device that has backed off to an hour
 * has effectively stopped trying for a sixth of the study. Ten minutes bounds the
 * cost of a hopeless retry at six attempts an hour while keeping a device that is
 * merely between wifi cells from waiting out the morning.
 *
 * And it is only ever the floor on waiting. Wifi returning, or the operator asking,
 * bypasses it — see `clearBackoff`.
 */
export const RETRY_CEILING_MS = 10 * 60 * 1000;

export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), RETRY_CEILING_MS);
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * Forget every scheduled wait, because something changed.
 *
 * Called when the device comes back online. A backoff is a guess about how long a
 * problem will last, and the network returning is direct evidence that the guess is
 * stale — a device that had backed off to ten minutes should not sit on a hall's
 * newly working wifi waiting out a delay it chose while there was none.
 *
 * The attempt COUNT is kept, so a genuinely broken endpoint still backs off again
 * from where it was rather than restarting at thirty seconds on every flap.
 */
export async function clearBackoff(): Promise<number> {
  const waiting = await db.sync_state.filter((row) => row.nextAttemptAt !== undefined).toArray();
  if (waiting.length === 0) return 0;
  await db.transaction("rw", db.sync_state, async () => {
    for (const row of waiting) {
      const { nextAttemptAt: _dropped, ...rest } = row;
      await db.sync_state.put(rest);
    }
  });
  return waiting.length;
}

