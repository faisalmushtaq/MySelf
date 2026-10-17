import { describe, expect, it, vi } from "vitest";
import {
  checkpointRunningSessions,
  synchroniseCompletedSessions,
  verifyOutcome,
  type SittingOutcome,
  type SyncPersistence,
} from "./lib/sync.js";
import type { SyncSession } from "./lib/db.js";
import type { SyncTarget } from "./lib/device.js";

/**
 * What a device may stop holding, and when.
 *
 * Every test here is about the same question: after this exchange, is it safe
 * for this iPad to believe the study has the sitting? The answer has to be no
 * unless the server said so about THIS session id, with the event count to
 * prove it — a 200 is not an answer, and neither is a count that is short.
 */

const target: SyncTarget = {
  url: "https://europe-west2-myself-research.cloudfunctions.net/saveSitting",
  installId: "ipad_01JABCDEF",
  credential: "Device ipad_01JABCDEF.a-secret-this-device-generated",
};

const session: SyncSession = {
  sessionId: "ses_01",
  studyCode: "NDC0042",
  releaseKey: "ybm_r7",
  releaseHash: "sha256:abc",
  startedAt: "2026-08-22T09:00:00.000Z",
  completedAt: "2026-08-22T09:10:00.000Z",
  complete: true,
  events: [
    { seq: 0, type: "session.started", tWall: "2026-08-22T09:00:00.000Z", tMono: 0 },
    {
      seq: 1,
      type: "response.recorded",
      itemKey: "ybm.item_1",
      payload: { value: { kind: "choice", code: 2 } },
      tWall: "2026-08-22T09:01:00.000Z",
      tMono: 60_000,
    },
  ],
};

interface Calls {
  transitions: string[];
  receipts: string[];
  errors: string[];
  quarantine: string[];
  checkpoints: string[];
}

const noCalls = (): Calls => ({ transitions: [], receipts: [], errors: [], quarantine: [], checkpoints: [] });

function fakeStore(
  calls: Calls,
  options: { target?: SyncTarget | null; completed?: SyncSession[]; running?: SyncSession[] } = {},
): SyncPersistence {
  return {
    target: async () => (options.target === undefined ? target : options.target),
    completedSessions: async () => options.completed ?? [session],
    runningSessions: async () => options.running ?? [],
    markSyncing: async (id) => {
      calls.transitions.push(`syncing:${id}`);
    },
    markSynced: async (id) => {
      calls.transitions.push(`synced:${id}`);
    },
    markFailed: async (id, reason) => {
      calls.errors.push(`${id}:${reason}`);
    },
    markQuarantined: async (id, reason) => {
      calls.quarantine.push(`${id}:${reason}`);
    },
    saveReceipt: async (receipt) => {
      calls.receipts.push(`${receipt.sessionId}:${receipt.events}`);
    },
    saveCheckpoint: async (id, events) => {
      calls.checkpoints.push(`${id}:${events}`);
    },
  };
}

/** A `saveSitting` reply, as the function actually shapes one. */
const reply = (outcomes: Partial<SittingOutcome>[], status = 200) =>
  new Response(
    JSON.stringify({
      stored: outcomes.filter((o) => o.stored !== false).length,
      outcomes: outcomes.map((o) => ({
        sessionId: "ses_01",
        stored: true,
        events: 2,
        chunks: 0,
        quarantined: false,
        ...o,
      })),
    }),
    { status },
  );

describe("handing a finished sitting over to the study", () => {
  it("marks it confirmed only once the server says how many events it stored", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
      now: () => new Date("2026-08-22T10:00:00.000Z"),
    });

    expect(report).toMatchObject({ synced: 1, failed: 0, quarantined: 0 });
    expect(calls.transitions).toEqual(["syncing:ses_01", "synced:ses_01"]);
    expect(calls.receipts).toEqual(["ses_01:2"]);
    expect(calls.errors).toEqual([]);
  });

  it("posts to saveSitting as the enrolled device, one sitting per request", async () => {
    // One at a time: a handover is twenty sittings over school wifi, and a
    // single request carrying all of them is one dropped connection away from
    // having achieved nothing.
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));

    await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.url);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(target.credential);
    const body = JSON.parse(init.body as string) as { deviceId: string; sittings: SyncSession[] };
    expect(body.sittings).toHaveLength(1);
    expect(body.sittings[0]).toMatchObject({ sessionId: "ses_01", complete: true });
    // The installation id travels in the body too, so a handover file from this
    // same iPad — which carries no credential — files under the same device.
    expect(body.deviceId).toBe("ipad_01JABCDEF");
  });

  it("refuses to believe a reply that stored fewer events than were sent", async () => {
    // The check that matters. A truncated upload otherwise reads as a success on
    // both ends and the missing events are discovered by nobody.
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ events: 1 }]));

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toMatchObject({ synced: 0, failed: 1 });
    expect(calls.errors[0]).toContain("stored 1 of the 2 events");
    expect(calls.transitions).not.toContain("synced:ses_01");
    expect(calls.receipts).toEqual([]);
  });

  it("refuses a reply that does not mention this sitting at all", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ sessionId: "ses_somebody_else" }]));

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.failed).toBe(1);
    expect(calls.errors[0]).toContain("did not say what happened");
  });

  it("is safe to repeat: a second upload of a stored sitting confirms it again", async () => {
    // `saveSitting` is idempotent, so a device whose first response was lost
    // re-sends and gets the same answer rather than a conflict.
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));

    await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });
    await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(calls.transitions.filter((c) => c === "synced:ses_01")).toHaveLength(2);
    expect(calls.errors).toEqual([]);
  });

  it("keeps a sitting queued when the server is temporarily unwell", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () =>
      new Response(JSON.stringify({ error: { kind: "unknown", message: "temporary maintenance" } }), { status: 503 }),
    );

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toMatchObject({ synced: 0, failed: 1, quarantined: 0 });
    expect(calls.errors[0]).toContain("temporary maintenance");
    expect(calls.receipts).toEqual([]);
  });

  it("does not reach the network before this iPad has been enrolled", async () => {
    const calls = noCalls();
    const transport = vi.fn();

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls, { target: null }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.outcomes).toEqual([{ kind: "not_configured" }]);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("when the study already holds a copy of this sitting", () => {
  it("stops retrying and says why, rather than failing forever", async () => {
    // A second device, a different release, a log that has got shorter: the
    // server refuses, keeps both copies, and no amount of retrying changes it.
    const calls = noCalls();
    const transport = vi.fn(async () =>
      reply([
        {
          stored: false,
          quarantined: true,
          reason: "same sitting received from a second device",
        },
      ]),
    );

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toMatchObject({ synced: 0, failed: 0, quarantined: 1 });
    expect(calls.quarantine).toEqual(["ses_01:same sitting received from a second device"]);
    expect(calls.transitions).not.toContain("synced:ses_01");
    // Not confirmed, so nothing on this device becomes deletable.
    expect(calls.receipts).toEqual([]);
  });

  it("does not treat a refusal as confirmation even when the count matches", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ stored: false, quarantined: true, events: 2, reason: "held" }]));

    await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(calls.receipts).toEqual([]);
    expect(calls.quarantine).toEqual(["ses_01:held"]);
  });
});

describe("when the study says a sitting can never be stored as it is", () => {
  it("sets it aside with the reason instead of retrying for ever", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ stored: false, events: 0, retryable: false, reason: "text that is not valid Unicode" }], 422));

    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(report).toMatchObject({ synced: 0, failed: 0, quarantined: 1 });
    expect(calls.quarantine).toEqual(["ses_01:the study can't store this sitting as it is: text that is not valid Unicode"]);
    expect(calls.errors).toEqual([]);
    expect(calls.receipts).toEqual([]);
  });

  it("still retries a passing failure", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => new Response("{}", { status: 503 }));
    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });
    expect(report).toMatchObject({ failed: 1, quarantined: 0 });
  });
});

describe("a sitting still being answered", () => {
  const { completedAt: _finished, ...unfinished } = session;
  const running: SyncSession = { ...unfinished, complete: false };

  it("is copied to the study as incomplete, so a lost iPad costs less than a morning", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));

    const report = await checkpointRunningSessions({
      storage: fakeStore(calls, { running: [running] }),
      transport: transport as unknown as typeof fetch,
      now: () => new Date("2026-08-22T09:05:00.000Z"),
    });

    expect(report).toEqual({ saved: 1, missed: 0 });
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { sittings: SyncSession[] };
    expect(body.sittings[0]?.complete).toBe(false);
    expect(calls.checkpoints).toEqual(["ses_01:2"]);
  });

  it("never moves the sitting out of the state that makes it resumable", async () => {
    // A checkpointed sitting is still in progress: still resumable, still
    // finishing normally, still going through the ordinary queue when it does.
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));

    await checkpointRunningSessions({
      storage: fakeStore(calls, { running: [running] }),
      transport: transport as unknown as typeof fetch,
    });

    expect(calls.transitions).toEqual([]);
    expect(calls.errors).toEqual([]);
    expect(calls.quarantine).toEqual([]);
    expect(calls.receipts).toEqual([]);
  });

  it("stays quiet when a checkpoint cannot be sent", async () => {
    // The participant is answering questions. A failed checkpoint is not their
    // problem and costs nothing but the next attempt.
    const calls = noCalls();
    const transport = vi.fn(async () => {
      throw new TypeError("Load failed");
    });

    const report = await checkpointRunningSessions({
      storage: fakeStore(calls, { running: [running] }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toEqual({ saved: 0, missed: 1 });
    expect(calls.checkpoints).toEqual([]);
    expect(calls.errors).toEqual([]);
  });

  it("does not record a checkpoint the server only partly stored", async () => {
    // Otherwise the next pass would think those events were already safe and
    // never send them again.
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ events: 1 }]));

    const report = await checkpointRunningSessions({
      storage: fakeStore(calls, { running: [running] }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toEqual({ saved: 0, missed: 1 });
    expect(calls.checkpoints).toEqual([]);
  });

  it("does nothing at all on a device that was never enrolled", async () => {
    const calls = noCalls();
    const transport = vi.fn();

    const report = await checkpointRunningSessions({
      storage: fakeStore(calls, { target: null, running: [running] }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toEqual({ saved: 0, missed: 0 });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("verifyOutcome", () => {
  const outcome = (over: Partial<SittingOutcome> = {}): SittingOutcome => ({
    sessionId: "ses_01",
    stored: true,
    events: 2,
    chunks: 0,
    quarantined: false,
    ...over,
  });

  it("passes a sitting stored whole", () => {
    expect(() => verifyOutcome(outcome(), session)).not.toThrow();
  });

  it("rejects one the server did not store", () => {
    expect(() => verifyOutcome(outcome({ stored: false, reason: "no" }), session)).toThrow(/no/);
  });

  it("rejects one stored short", () => {
    expect(() => verifyOutcome(outcome({ events: 1 }), session)).toThrow(/stored 1 of the 2/);
  });

  it("rejects one stored long, which means the two disagree about the sitting", () => {
    expect(() => verifyOutcome(outcome({ events: 3 }), session)).toThrow(/stored 3 of the 2/);
  });
});

describe("which study a sitting is filed into (D-56)", () => {
  it("sends the study the sitting started in beside it, never inside the sitting", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));
    await synchroniseCompletedSessions({
      storage: fakeStore(calls, { completed: [{ ...session, study: "future" }] }),
      transport: transport as unknown as typeof fetch,
    });
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { study?: string; sittings: Record<string, unknown>[] };
    expect(body.study).toBe("future");
    expect(body.sittings[0]).not.toHaveProperty("study");
    expect(body.sittings[0]).toMatchObject({ sessionId: "ses_01" });
  });

  it("sends a checkpoint of a running sitting to its own study too", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{ events: 2 }]));
    await checkpointRunningSessions({
      storage: fakeStore(calls, { running: [{ ...session, complete: false, study: "future" }] }),
      transport: transport as unknown as typeof fetch,
    });
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { study?: string }).study).toBe("future");
  });

  it("sends no study for a sitting that has none, exactly as before", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => reply([{}]));
    await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });
    const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("study");
  });
});
