import { describe, expect, it, vi } from "vitest";
import {
  checkpointRunningSessions,
  synchroniseCompletedSessions,
  type SyncPersistence,
} from "./lib/sync.js";
import { RETRY_CEILING_MS, retryDelayMs } from "./lib/db.js";
import type { SyncSession } from "./lib/db.js";
import type { SyncTarget } from "./lib/device.js";

/**
 * A school hall, at nine in the morning.
 *
 * Every other sync test asks whether the protocol is right. This one asks what
 * happens when the network is the way it actually is in the place this runs: thirty
 * devices on one access point, a captive portal on the guest SSID, a connection that
 * completes the request and dies before the response, a gateway that answers
 * everything with its own error page.
 *
 * The rule under test is always the same one, and it is the only rule that keeps a
 * morning's data: a sitting is deleted from a device only when the study has
 * confirmed it stored every event. Everything here is a way for that confirmation to
 * look like it arrived when it did not.
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
    { seq: 1, type: "response.recorded", itemKey: "i.q1", tWall: "2026-08-22T09:01:00.000Z", tMono: 60_000 },
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

function store(
  calls: Calls,
  options: { completed?: SyncSession[]; running?: SyncSession[] } = {},
): SyncPersistence {
  return {
    target: async () => target,
    completedSessions: async () => options.completed ?? [session],
    runningSessions: async () => options.running ?? [],
    markSyncing: async (id) => void calls.transitions.push(`syncing:${id}`),
    markSynced: async (id) => void calls.transitions.push(`synced:${id}`),
    markFailed: async (id, reason) => void calls.errors.push(`${id}:${reason}`),
    markQuarantined: async (id, reason) => void calls.quarantine.push(`${id}:${reason}`),
    saveReceipt: async (r) => void calls.receipts.push(`${r.sessionId}:${r.events}`),
    saveCheckpoint: async (id, events) => void calls.checkpoints.push(`${id}:${events}`),
  };
}

const ok = (events = 2) =>
  new Response(
    JSON.stringify({
      stored: 1,
      outcomes: [{ sessionId: "ses_01", stored: true, events, chunks: 0, quarantined: false }],
    }),
    { status: 200 },
  );

/**
 * Run something with the device reporting no connection.
 *
 * `navigator.onLine` is a browser property and Node's `navigator` does not have one,
 * so it is defined for the duration rather than mocked — and it is restored
 * afterwards, because a global left set to false would silently switch off every
 * later test's network.
 */
async function offline(body: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
  try {
    await body();
  } finally {
    if (had) Object.defineProperty(navigator, "onLine", had);
    else delete (navigator as unknown as Record<string, unknown>)["onLine"];
  }
}

/** Nothing here may end with the device believing a sitting is safe to delete. */
const notConfirmed = (calls: Calls) => {
  expect(calls.transitions).not.toContain("synced:ses_01");
  expect(calls.receipts).toEqual([]);
};

describe("a captive portal, which is what a school guest network is", () => {
  it("does not mistake a login page for a successful upload", async () => {
    // The dangerous one. A portal answers 200 with HTML, so `response.ok` is true and
    // the device would have every reason to think it had handed the sitting over.
    const calls = noCalls();
    const transport = vi.fn(
      async () =>
        new Response("<!doctype html><title>Sign in to SchoolWiFi</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const report = await synchroniseCompletedSessions({
      storage: store(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.synced).toBe(0);
    expect(report.failed).toBe(1);
    notConfirmed(calls);
  });

  it("does not mistake a portal's JSON for an acknowledgement", async () => {
    // Some portals answer JSON. It parses, and says nothing about this sitting.
    const calls = noCalls();
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ status: "redirect", url: "https://portal" }), { status: 200 }),
    );

    await synchroniseCompletedSessions({ storage: store(calls), transport: transport as unknown as typeof fetch });
    // The message names the network rather than a missing field, because that is
    // what actually went wrong and what the operator can act on.
    expect(calls.errors[0]).toContain("did not come from the study");
    expect(calls.errors[0]).toContain("signing in");
    notConfirmed(calls);
  });

  it("does not accept an outcome for somebody else's sitting", async () => {
    const calls = noCalls();
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            stored: 1,
            outcomes: [{ sessionId: "ses_somebody_else", stored: true, events: 2, chunks: 0, quarantined: false }],
          }),
          { status: 200 },
        ),
    );

    await synchroniseCompletedSessions({ storage: store(calls), transport: transport as unknown as typeof fetch });
    expect(calls.errors[0]).toContain("did not say what happened");
    notConfirmed(calls);
  });
});

describe("a connection that dies part way", () => {
  it("treats a truncated response as a failure, not a success", async () => {
    // The request went, the server may even have stored it, and the response was cut
    // off. Retrying is safe because the write path is idempotent; believing it is not.
    const calls = noCalls();
    const transport = vi.fn(async () => new Response('{"stored":1,"outcomes":[{"sessionId":"ses_', { status: 200 }));

    await synchroniseCompletedSessions({ storage: store(calls), transport: transport as unknown as typeof fetch });
    expect(calls.errors).toHaveLength(1);
    notConfirmed(calls);
  });

  it("survives the fetch itself rejecting, which is what a dropped wifi cell does", async () => {
    const calls = noCalls();
    const transport = vi.fn(async () => {
      throw new TypeError("Load failed");
    });

    const report = await synchroniseCompletedSessions({
      storage: store(calls),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.failed).toBe(1);
    expect(calls.errors[0]).toContain("Load failed");
    notConfirmed(calls);
  });

  it("gives up on a request that hangs, rather than holding the device forever", async () => {
    // A saturated access point accepts the connection and then goes quiet. Without a
    // bounded request the sync would never return and the panel would say
    // "synchronising" for the rest of the day.
    const calls = noCalls();
    const transport = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

    const report = await synchroniseCompletedSessions({
      storage: store(calls),
      transport: transport as unknown as typeof fetch,
      timeoutMs: 40,
    });

    expect(report.failed).toBe(1);
    expect(calls.errors[0]).toContain("timed out");
    notConfirmed(calls);
  });
});

describe("a gateway between the device and the study", () => {
  for (const status of [301, 401, 403, 407, 429, 500, 502, 503, 504]) {
    it(`treats ${status} as something to retry rather than something to accept`, async () => {
      const calls = noCalls();
      const transport = vi.fn(async () => new Response("upstream says no", { status }));

      const report = await synchroniseCompletedSessions({
        storage: store(calls),
        transport: transport as unknown as typeof fetch,
      });

      expect(report.failed).toBe(1);
      expect(calls.errors[0]).toContain(String(status));
      notConfirmed(calls);
    });
  }
});

describe("wifi that comes and goes across a morning", () => {
  it("keeps a sitting queued through a run of failures and confirms it when one lands", async () => {
    const calls = noCalls();
    let attempt = 0;
    const transport = vi.fn(async () => {
      attempt += 1;
      if (attempt < 5) throw new TypeError("Load failed");
      return ok();
    });

    for (let i = 0; i < 5; i += 1) {
      await synchroniseCompletedSessions({
        storage: store(calls),
        transport: transport as unknown as typeof fetch,
      });
    }

    expect(calls.errors).toHaveLength(4);
    expect(calls.transitions).toContain("synced:ses_01");
    expect(calls.receipts).toEqual(["ses_01:2"]);
  });

  it("does not touch the network at all while the device is offline", async () => {
    const calls = noCalls();
    const transport = vi.fn();
    // Node's `navigator` has no `onLine`, so the property is defined rather than
    // spied on. Worth knowing: without this the offline branch is unreachable in a
    // node test, because `undefined === false` is false and the sync proceeds.
    await offline(async () => {
      const report = await synchroniseCompletedSessions({
        storage: store(calls),
        transport: transport as unknown as typeof fetch,
      });
      expect(report.outcomes).toEqual([{ kind: "offline" }]);
      expect(transport).not.toHaveBeenCalled();
      // And nothing was marked as even attempted, so no backoff was earned by a
      // failure that never happened.
      expect(calls.transitions).toEqual([]);
    });
  });

  it("checkpoints nothing while offline either", async () => {
    const calls = noCalls();
    const transport = vi.fn();
    await offline(async () => {
      const { completedAt: _done, ...running } = session;
      const report = await checkpointRunningSessions({
        storage: store(calls, { running: [{ ...running, complete: false }] }),
        transport: transport as unknown as typeof fetch,
      });
      expect(report).toEqual({ saved: 0, missed: 0 });
      expect(transport).not.toHaveBeenCalled();
    });
  });
});

describe("a handover of twenty sittings on a bad connection", () => {
  it("confirms the ones that landed and keeps the ones that did not", async () => {
    // The failure that matters here is all-or-nothing: refusing the whole handover
    // because the eleventh sitting failed would leave nineteen children's answers on
    // a device that is about to be wiped.
    const calls = noCalls();
    const sittings = Array.from({ length: 20 }, (_, i) => ({ ...session, sessionId: `ses_${i}` }));
    let call = 0;
    const transport = vi.fn(async () => {
      call += 1;
      // Every third request dies, which is roughly what a saturated hall looks like.
      if (call % 3 === 0) throw new TypeError("Load failed");
      const id = `ses_${call - 1}`;
      return new Response(
        JSON.stringify({
          stored: 1,
          outcomes: [{ sessionId: id, stored: true, events: 2, chunks: 0, quarantined: false }],
        }),
        { status: 200 },
      );
    });

    const report = await synchroniseCompletedSessions({
      storage: store(calls, { completed: sittings }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report.synced + report.failed).toBe(20);
    expect(report.synced).toBeGreaterThan(10);
    expect(report.failed).toBeGreaterThan(0);
    // Exactly the ones confirmed got a receipt, and no others.
    expect(calls.receipts).toHaveLength(report.synced);
    // Every sitting was attempted: none was skipped because an earlier one failed.
    expect(calls.transitions.filter((c) => c.startsWith("syncing:"))).toHaveLength(20);
  });

  it("reports each sitting's own fate rather than one verdict for the batch", async () => {
    const calls = noCalls();
    const sittings = [
      { ...session, sessionId: "ses_good" },
      { ...session, sessionId: "ses_held" },
      { ...session, sessionId: "ses_broken" },
    ];
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { sittings: { sessionId: string }[] };
      const id = body.sittings[0]!.sessionId;
      if (id === "ses_broken") throw new TypeError("Load failed");
      if (id === "ses_held") {
        return new Response(
          JSON.stringify({
            stored: 0,
            outcomes: [
              { sessionId: id, stored: false, events: 2, chunks: 0, quarantined: true, reason: "second device" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          stored: 1,
          outcomes: [{ sessionId: id, stored: true, events: 2, chunks: 0, quarantined: false }],
        }),
        { status: 200 },
      );
    });

    const report = await synchroniseCompletedSessions({
      storage: store(calls, { completed: sittings }),
      transport: transport as unknown as typeof fetch,
    });

    expect(report).toMatchObject({ synced: 1, quarantined: 1, failed: 1 });
    expect(calls.receipts).toEqual(["ses_good:2"]);
    expect(calls.quarantine).toEqual(["ses_held:second device"]);
    expect(calls.errors[0]).toContain("ses_broken");
  });
});

describe("how long a device waits before trying again", () => {
  it("backs off exponentially from thirty seconds", () => {
    const mid = () => 0.5;
    expect(retryDelayMs(1, mid)).toBe(30_000);
    expect(retryDelayMs(2, mid)).toBe(60_000);
    expect(retryDelayMs(3, mid)).toBe(120_000);
  });

  it("stops growing at ten minutes, because a school day is six hours", () => {
    // An hour was the previous ceiling, and it meant a device that had backed off
    // had effectively stopped trying for a sixth of the study.
    const mid = () => 0.5;
    for (const attempt of [8, 20, 500]) expect(retryDelayMs(attempt, mid)).toBe(RETRY_CEILING_MS);
    expect(RETRY_CEILING_MS).toBe(600_000);
  });

  it("jitters, so a rack of iPads that failed together does not retry together", () => {
    // Thirty devices on one access point fail at the same instant. Without jitter
    // they come back at the same instant and fail again for the same reason.
    expect(retryDelayMs(3, () => 0)).toBe(90_000);
    expect(retryDelayMs(3, () => 0.999999)).toBe(150_000);
    const spread = new Set(Array.from({ length: 40 }, () => retryDelayMs(3)));
    expect(spread.size).toBeGreaterThan(20);
  });

  it("never returns a wait of zero or a negative one", () => {
    for (const attempt of [0, 1, 2, 5, 12]) {
      for (const random of [0, 0.5, 0.999999]) {
        expect(retryDelayMs(attempt, () => random)).toBeGreaterThan(0);
      }
    }
  });
});
