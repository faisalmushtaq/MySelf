import { describe, expect, it, vi } from "vitest";
import {
  acknowledgementHash,
  synchroniseCompletedSessions,
  type SyncPersistence,
} from "./lib/sync.js";
import type { SyncConfiguration, SyncSession } from "./lib/db.js";

const configuration: SyncConfiguration = {
  endpoint: "https://research.example.test/",
  token: "a".repeat(48),
  configuredAt: "2026-08-22T10:00:00.000Z",
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
}

function fakeStore(calls: Calls, suppliedConfiguration: SyncConfiguration | null = configuration): SyncPersistence {
  return {
    configuration: async () => suppliedConfiguration,
    completedSessions: async () => [session],
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
    acknowledgedSequences: async () => [],
    saveReceipt: async (receipt) => {
      calls.receipts.push(`${receipt.sessionId}:${receipt.batchId}`);
    },
  };
}

describe("participant synchronisation", () => {
  it("marks a session verified only after its acknowledgement checksum and full event list are confirmed", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const accepted = [{ sessionId: session.sessionId, events: [0, 1] }];
    const ackHash = await acknowledgementHash(accepted);
    const transport = vi.fn(async () =>
      new Response(JSON.stringify({ batchId: "batch_01", accepted, quarantined: [], ackHash, duplicate: false }), { status: 201 }),
    );

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls),
      transport: transport as unknown as typeof fetch,
      now: () => new Date("2026-08-22T10:00:00.000Z"),
    });

    expect(report).toMatchObject({ synced: 1, failed: 0, quarantined: 0 });
    expect(calls.transitions).toEqual(["syncing:ses_01", "synced:ses_01"]);
    expect(calls.receipts).toEqual(["ses_01:batch_01"]);
    expect(calls.errors).toEqual([]);
    expect(transport).toHaveBeenCalledWith(
      "https://research.example.test/sync/batches",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${configuration.token}` }) }),
    );
  });

  it("accepts a replayed acknowledgement when the first HTTP response was lost", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const accepted = [{ sessionId: session.sessionId, events: [0, 1] }];
    const ackHash = await acknowledgementHash(accepted);
    const transport = vi.fn(async () =>
      new Response(JSON.stringify({ batchId: "batch_01", accepted, quarantined: [], ackHash, duplicate: true }), { status: 200 }),
    );

    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(report.outcomes).toEqual([{ kind: "synced", sessionId: "ses_01", batchId: "batch_01", duplicate: true }]);
    expect(calls.transitions.at(-1)).toBe("synced:ses_01");
  });

  it("verifies only newly accepted events after a completed session is amended", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const amended: SyncSession = {
      ...session,
      events: [...session.events, { seq: 2, type: "response.changed", itemKey: "ybm.item_1", tWall: "2026-08-22T09:11:00.000Z", tMono: 660_000 }],
    };
    const accepted = [{ sessionId: amended.sessionId, events: [2] }];
    const ackHash = await acknowledgementHash(accepted);
    const storage: SyncPersistence = {
      ...fakeStore(calls),
      completedSessions: async () => [amended],
      acknowledgedSequences: async () => [0, 1],
    };
    const transport = vi.fn(async () =>
      new Response(JSON.stringify({ batchId: "batch_02", accepted, quarantined: [], ackHash, duplicate: false }), { status: 201 }),
    );

    const report = await synchroniseCompletedSessions({ storage, transport: transport as unknown as typeof fetch });

    expect(report.synced).toBe(1);
    expect(calls.transitions.at(-1)).toBe("synced:ses_01");
  });

  it("keeps a session in the retry queue when the server response is unsuccessful", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: "temporary maintenance" }), { status: 503 }));

    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(report).toMatchObject({ synced: 0, failed: 1, quarantined: 0 });
    expect(calls.errors[0]).toContain("temporary maintenance");
    expect(calls.receipts).toEqual([]);
  });

  it("refuses a response with a tampered acknowledgement checksum", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const transport = vi.fn(async () =>
      new Response(
        JSON.stringify({
          batchId: "batch_01",
          accepted: [{ sessionId: session.sessionId, events: [0, 1] }],
          quarantined: [],
          ackHash: "0".repeat(64),
          duplicate: false,
        }),
        { status: 201 },
      ),
    );

    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(report.failed).toBe(1);
    expect(calls.errors[0]).toContain("checksum did not verify");
    expect(calls.transitions).not.toContain("synced:ses_01");
  });

  it("quarantines a conflicted session without marking it synchronised", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const ackHash = await acknowledgementHash([]);
    const transport = vi.fn(async () =>
      new Response(
        JSON.stringify({
          batchId: "batch_01",
          accepted: [],
          quarantined: [{ sessionId: session.sessionId, reason: "same session on another device" }],
          ackHash,
          duplicate: false,
        }),
        { status: 201 },
      ),
    );

    const report = await synchroniseCompletedSessions({ storage: fakeStore(calls), transport: transport as unknown as typeof fetch });

    expect(report).toMatchObject({ synced: 0, failed: 0, quarantined: 1 });
    expect(calls.quarantine).toEqual(["ses_01:same session on another device"]);
    expect(calls.transitions).not.toContain("synced:ses_01");
  });

  it("does not attempt network transfer before a device is enrolled", async () => {
    const calls: Calls = { transitions: [], receipts: [], errors: [], quarantine: [] };
    const transport = vi.fn();

    const report = await synchroniseCompletedSessions({
      storage: fakeStore(calls, null),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.outcomes).toEqual([{ kind: "not_configured" }]);
    expect(transport).not.toHaveBeenCalled();
  });
});
