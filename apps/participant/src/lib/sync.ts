import {
  completedSessionsForSync,
  markSessionQuarantined,
  markSessionSyncFailed,
  markSessionSynced,
  markSessionSyncing,
  recordCheckpoint,
  recordSyncReceipt,
  runningSessionsForCheckpoint,
  type SyncSession,
} from "./db.js";
import { syncTarget, type SyncTarget } from "./device.js";
import {
  confirmationProblem,
  sittingsResponse,
  type SittingOutcome,
  type SittingsResponse,
  type SittingUpload,
} from "@myself/store";

/**
 * Getting a sitting off this iPad and into the study.
 *
 * ONE SITTING PER REQUEST. A handover is twenty sittings at the end of a school
 * day over school wifi, and a single request carrying all of them is one dropped
 * connection away from having achieved nothing. One at a time means the
 * nineteenth failing costs the nineteenth.
 *
 * A SITTING IS KEPT LOCALLY UNTIL THE SERVER HAS CONFIRMED IT. Not until the
 * request returned 200 — until the response says, for this session id, that it
 * was stored and how many events it stored. `verifyOutcome` compares that count
 * against what was sent and refuses anything short. That comparison is the whole
 * guarantee: without it a truncated upload reads as a success on both ends and
 * the missing events are discovered by nobody.
 *
 * THE SERVER MAY REFUSE, AND REFUSAL IS NOT FAILURE. `quarantined` means the
 * study already holds a copy of this sitting that this one contradicts — a
 * second device, a different release, a log that has got shorter. Retrying
 * cannot help and deleting would lose evidence, so the sitting stops here in a
 * state a researcher can see, and the server keeps both copies.
 *
 * Safari cannot run any of this in the background, so callers invoke it on
 * launch, on connectivity returning, and from the explicit operator control.
 */

/**
 * The wire format is `@myself/store`'s, not this file's.
 *
 * It used to be declared here as well as in the function, which is two descriptions
 * of one protocol with nothing making them agree — and the failure is silent: a
 * device that reads a field the server stopped sending confirms sittings the study
 * does not have, and then deletes them.
 */
export type { SittingOutcome, SittingsResponse } from "@myself/store";

export type SyncOutcome =
  | { kind: "synced"; sessionId: string; events: number }
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
  target(): Promise<SyncTarget | null>;
  completedSessions(force: boolean): Promise<SyncSession[]>;
  runningSessions(): Promise<SyncSession[]>;
  markSyncing(sessionId: string): Promise<void>;
  markSynced(sessionId: string, at: string): Promise<void>;
  markFailed(sessionId: string, reason: string, at: string): Promise<void>;
  markQuarantined(sessionId: string, reason: string, at: string): Promise<void>;
  saveReceipt(receipt: {
    sessionId: string;
    events: number;
    chunks: number;
    verifiedAt: string;
  }): Promise<void>;
  saveCheckpoint(sessionId: string, events: number, at: string): Promise<void>;
}

const persistence: SyncPersistence = {
  target: syncTarget,
  completedSessions: completedSessionsForSync,
  runningSessions: runningSessionsForCheckpoint,
  markSyncing: markSessionSyncing,
  markSynced: markSessionSynced,
  markFailed: markSessionSyncFailed,
  markQuarantined: markSessionQuarantined,
  saveReceipt: recordSyncReceipt,
  saveCheckpoint: recordCheckpoint,
};

/**
 * One upload of one sitting at a time, from this device.
 *
 * FOUND BY A STRESS TEST, and it is a real flaw rather than a test artefact. A sitting
 * grows while it is being answered, so two overlapping checkpoints send two different
 * lengths of the same log: the longer lands first and the shorter is then refused as
 * "a sitting never gets shorter". Nothing is lost — that refusal is the no-overwrite
 * rule doing its job — but the device learns nothing from the round trip, records no
 * checkpoint, and sends again. On a slow connection, where an upload takes longer than
 * the interval between them, that is a device talking over itself indefinitely.
 *
 * The guard lives here rather than in the caller because the invariant belongs to the
 * protocol, not to a component: there are now three callers between them (launch, the
 * timer during a sitting, and the network returning), and an invariant enforced by
 * every caller separately is one a fourth caller will break.
 */
/**
 * ONE FLAG, NOT TWO. They were separate, which meant a checkpoint of a sitting and the
 * completed upload of that same sitting could be in flight together — which is the race
 * the guard exists to prevent, arriving between the two functions instead of within one.
 * Both send the same documents, so they share the lock.
 */
let busy = false;

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
 * Send every finished sitting that is waiting, one at a time.
 */
export async function synchroniseCompletedSessions(options: SyncOptions = {}): Promise<SyncReport> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { outcomes: [{ kind: "offline" }], synced: 0, failed: 0, quarantined: 0 };
  }
  // Already uploading something. A second pass would re-send sittings the first is
  // mid-way through and race its own uploads.
  if (busy) return { outcomes: [], synced: 0, failed: 0, quarantined: 0 };
  busy = true;

  const storage = options.storage ?? persistence;
  try {
    return await drain(storage, options);
  } finally {
    busy = false;
  }
}

async function drain(storage: SyncPersistence, options: SyncOptions): Promise<SyncReport> {
  const target = await storage.target();
  if (!target) return { outcomes: [{ kind: "not_configured" }], synced: 0, failed: 0, quarantined: 0 };

  const now = options.now ?? (() => new Date());
  const sessions = await storage.completedSessions(options.force ?? false);
  const outcomes: SyncOutcome[] = [];
  let synced = 0;
  let failed = 0;
  let quarantined = 0;

  for (const session of sessions) {
    const at = now().toISOString();
    await storage.markSyncing(session.sessionId);
    try {
      const outcome = await post(target, session, options);

      if (outcome.quarantined) {
        const reason = outcome.reason ?? "the study already holds a copy of this sitting that this one contradicts";
        await storage.markQuarantined(session.sessionId, reason, at);
        outcomes.push({ kind: "quarantined", sessionId: session.sessionId, reason });
        quarantined += 1;
        continue;
      }

      verifyOutcome(outcome, session);
      await storage.saveReceipt({
        sessionId: session.sessionId,
        events: outcome.events,
        chunks: outcome.chunks,
        verifiedAt: at,
      });
      await storage.markSynced(session.sessionId, at);
      outcomes.push({ kind: "synced", sessionId: session.sessionId, events: outcome.events });
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

export interface CheckpointReport {
  /** Sittings whose progress so far now has a copy on the server. */
  saved: number;
  /** Attempts that did not land. Nothing is lost; the next pass tries again. */
  missed: number;
}

/**
 * Put a copy of every sitting still in progress on the server.
 *
 * WHY A HALF-FINISHED SITTING IS WORTH UPLOADING. Without this, the only
 * sittings the study ever holds are the ones that reached the end. A child who
 * stops halfway, an iPad whose battery goes, a device that is dropped or lost, a
 * session left open when the hall is packed up — every one of those is a
 * morning's data that existed only on one device, and the first anyone knows of
 * it is that there is no record. A checkpoint bounds the loss to whatever was
 * answered since the last one.
 *
 * IT DOES NOT TOUCH THE SESSION'S STATE. A sitting being checkpointed is still
 * `in_progress`: it is still resumable, it still finishes normally, and it still
 * goes through the ordinary queue when it does. The upload says `complete:
 * false`, and the server's rules make the later, longer copy supersede this one
 * while refusing anything shorter — so a checkpoint can never come back to
 * overwrite the finished sitting it preceded.
 *
 * AND IT IS SILENT. The participant is answering questions. A failed checkpoint
 * is not their problem, is not an error anybody needs to see, and costs nothing
 * but the next attempt.
 */
export async function checkpointRunningSessions(options: SyncOptions = {}): Promise<CheckpointReport> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { saved: 0, missed: 0 };
  // Anything still in flight is already sending a copy of some sitting — possibly this
  // one. Sending a second, longer copy alongside it makes the two race, and the loser is
  // refused.
  if (busy) return { saved: 0, missed: 0 };
  busy = true;

  const storage = options.storage ?? persistence;
  try {
    return await sendCheckpoints(storage, options);
  } finally {
    busy = false;
  }
}

async function sendCheckpoints(storage: SyncPersistence, options: SyncOptions): Promise<CheckpointReport> {
  const target = await storage.target();
  if (!target) return { saved: 0, missed: 0 };

  const now = options.now ?? (() => new Date());
  const sessions = await storage.runningSessions();
  let saved = 0;
  let missed = 0;

  for (const session of sessions) {
    try {
      const outcome = await post(target, { ...session, complete: false }, options);
      if (!outcome.stored) {
        missed += 1;
        continue;
      }
      verifyOutcome(outcome, session);
      await storage.saveCheckpoint(session.sessionId, session.events.length, now().toISOString());
      saved += 1;
    } catch {
      // Deliberately swallowed: see the note above. The events stay on the
      // device and the next pass sends them.
      missed += 1;
    }
  }

  return { saved, missed };
}

async function post(
  target: SyncTarget,
  session: SyncSession,
  options: SyncOptions,
): Promise<SittingOutcome> {
  const transport = options.transport ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await transport(target.url, {
      method: "POST",
      headers: {
        authorization: target.credential,
        "content-type": "application/json",
      },
      // The installation id travels in the body as well as being proved by the
      // credential, so a handover file — which carries no credential — files
      // under the same device as a network upload from the same iPad.
      /**
       * `sentAt` is this device's clock at the moment of the request, so the study can
       * pair it with its own and tell a device with a wrong clock from one that simply
       * held its data for days. Read here rather than earlier: a queued upload may wait
       * a long time behind a retry backoff, and a stale reading would manufacture the
       * skew it exists to detect.
       */
      body: JSON.stringify({
        deviceId: target.installId,
        sentAt: new Date().toISOString(),
        sittings: [session],
      } satisfies SittingUpload),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`sync server returned ${response.status}${detailOf(body)}`);
    const parsed = parseResponse(body);
    const outcome = parsed.outcomes.find((entry) => entry.sessionId === session.sessionId);
    if (!outcome) throw new Error("the server did not say what happened to this sitting");
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Did the study actually take everything this device sent?
 *
 * The rule itself lives in `@myself/store` beside the wire format, because it is the
 * rule that decides whether a sitting may be deleted from an iPad and both ends
 * should be reading the same one. This is the throwing wrapper the sync loop wants.
 */
export function verifyOutcome(outcome: SittingOutcome, session: SyncSession): void {
  const problem = confirmationProblem(outcome, session.events.length);
  if (problem) throw new Error(problem);
}

function parseResponse(value: unknown): SittingsResponse {
  const parsed = sittingsResponse.safeParse(value);
  if (!parsed.success) {
    /**
     * A captive portal is the reason this message is about the response rather than
     * about a field.
     *
     * A school's guest network answers 200 with an HTML login page, or with JSON of
     * its own. Naming the first failing key would send whoever reads the panel looking
     * for a bug in the study's server, when what happened is that the iPad never
     * reached it.
     */
    throw new Error("the reply did not come from the study — this network may need signing in to");
  }
  return parsed.data;
}

function detailOf(body: unknown): string {
  if (!isRecord(body)) return "";
  const error = body["error"];
  if (typeof error === "string") return `: ${error}`;
  if (isRecord(error) && typeof error["message"] === "string") return `: ${error["message"]}`;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "sync request timed out";
  if (error instanceof Error) return error.message;
  return "sync failed for an unknown reason";
}

/** Only for tests, which need each case to start with nothing in flight. */
export function resetInFlightForTests(): void {
  busy = false;
}
