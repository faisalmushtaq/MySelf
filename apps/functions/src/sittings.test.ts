import { describe, expect, it } from "vitest";
import { joinSession, paths, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import type { DeviceSession } from "@myself/store";
import { deviceIdFor, sittingRefusal, sittingUpload, storeSitting } from "./sittings.js";
import { RelayError, type Caller } from "./relay-policy.js";

/**
 * The write path the export always assumed existed.
 *
 * These run against a Firestore stand-in rather than an emulator: what is
 * worth testing is the ordering and the collision rule, both of which are
 * decisions in this file, and a test that needs a deploy is a test nobody
 * runs before deploying.
 */

const device: Caller = { uid: "dev_ipad_1", device: true };
const researcher: Caller = { uid: "res_1", device: false };
const tester: Caller = { uid: "link_abc123", device: false };

/** Enough Firestore to record what was written, in what order. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  let failParentWrite = false;

  const ref = (path: string) => ({
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    set: async (value: Record<string, unknown>, options?: { merge?: boolean }) => {
      if (failParentWrite && path.includes("/sessions/") && !path.includes("/chunks/")) {
        throw new Error("write refused");
      }
      // Firestore merges when asked to, and the collision path depends on it:
      // marking a sitting quarantined must not replace the sitting.
      docs.set(path, options?.merge ? { ...(docs.get(path) ?? {}), ...value } : value);
      order.push(`set ${path}`);
    },
  });

  const batch = () => {
    const queued: (() => void)[] = [];
    return {
      set: (r: { path: string }, value: Record<string, unknown>) =>
        queued.push(() => {
          docs.set(r.path, value);
          order.push(`set ${r.path}`);
        }),
      delete: (r: { path: string }) =>
        queued.push(() => {
          docs.delete(r.path);
          order.push(`delete ${r.path}`);
        }),
      commit: async () => queued.forEach((f) => f()),
    };
  };

  const collections: Record<string, Record<string, unknown>[]> = {};

  return {
    docs,
    order,
    collections,
    fail: (on: boolean) => {
      failParentWrite = on;
    },
    db: {
      doc: (path: string) => ({ ...ref(path), path }),
      batch,
      collection: (path: string) => ({
        add: async (value: Record<string, unknown>) => {
          (collections[path] ??= []).push(value);
        },
      }),
    } as unknown as FirebaseFirestore.Firestore,
  };
}

const event = (seq: number, chars = 10) => ({
  seq,
  type: "answer",
  itemKey: `inst.q${seq}`,
  payload: { value: "x".repeat(chars) },
  tWall: "2026-09-01T10:00:00.000Z",
  tMono: seq * 100,
});

const session = (events: ReturnType<typeof event>[], id = "ses_1"): DeviceSession => ({
  sessionId: id,
  studyCode: "YBM-ND2026",
  releaseKey: "ybm.wave1",
  releaseHash: "sha256-abc",
  startedAt: "2026-09-01T10:00:00.000Z",
  complete: true,
  events,
});

describe("who may file a survey sitting", () => {
  it("refuses a tester link, which belongs to nobody", () => {
    // A link is a URL somebody was sent. It can pilot the narrative module;
    // a sitting it filed would be indistinguishable from a real child's.
    expect(sittingRefusal(tester)).toMatch(/tester link/);
  });

  it("accepts an enrolled device and a member of the team", () => {
    expect(sittingRefusal(device)).toBeNull();
    expect(sittingRefusal(researcher)).toBeNull();
  });

  it("records a device as itself, whatever the body claims", () => {
    expect(deviceIdFor(device, "some_other_ipad")).toBe("dev_ipad_1");
  });

  it("makes an importing researcher say which iPad it came off", () => {
    expect(deviceIdFor(researcher, "dev_ipad_7")).toBe("dev_ipad_7");
    expect(() => deviceIdFor(researcher, undefined)).toThrow(RelayError);
  });
});

describe("what an upload may contain", () => {
  it("takes a handover of several sittings at once", () => {
    const parsed = sittingUpload.safeParse({ sittings: [session([event(0)]), session([event(0)], "ses_2")] });
    expect(parsed.success).toBe(true);
  });

  it("keeps an event type it has never heard of", () => {
    // A device that knows about an event this deployment does not must still
    // be able to hand it over: the reader interprets payloads, not this.
    const parsed = sittingUpload.safeParse({
      sittings: [session([{ ...event(0), type: "something_new", payload: { odd: { nested: true } } } as never])],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an empty upload rather than storing nothing quietly", () => {
    expect(sittingUpload.safeParse({ sittings: [] }).success).toBe(false);
  });
});

describe("storing one", () => {
  it("writes a sitting that can be read straight back", async () => {
    const { db, docs } = fakeDb();
    const outcome = await storeSitting(db, "ybm", session([event(0), event(1)]), "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: true, events: 2, chunks: 0, quarantined: false });
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(joinSession(doc, []).events).toHaveLength(2);
    expect(doc.deviceId).toBe("dev_ipad_1");
    // Always written, never absent: Firestore's `!=` skips documents without
    // the field, so an absent one reads as an empty study.
    expect(doc.quarantined).toBe(false);
  });

  it("is idempotent — the same sitting twice is one sitting", async () => {
    const { db, docs } = fakeDb();
    const one = session([event(0), event(1)]);
    await storeSitting(db, "ybm", one, "dev_ipad_1");
    const first = { ...(docs.get(paths.session("ybm", "ses_1")) as object) };
    await storeSitting(db, "ybm", one, "dev_ipad_1");
    const second = docs.get(paths.session("ybm", "ses_1"));

    expect(docs.size).toBe(1);
    // receivedAt moves; everything that is the sitting does not.
    expect({ ...second, receivedAt: null }).toEqual({ ...first, receivedAt: null });
  });

  it("writes the chunks before the parent that counts them", async () => {
    // The other order leaves a parent claiming chunks that never arrived,
    // which joinSession refuses — a sitting in the dataset nobody can read.
    const { db, order } = fakeDb();
    const long = Array.from({ length: 400 }, (_, i) => event(i, 4000));
    const outcome = await storeSitting(db, "ybm", session(long), "dev_ipad_1");

    expect(outcome.chunks).toBeGreaterThan(0);
    const parentAt = order.findIndex((o) => o === `set ${paths.session("ybm", "ses_1")}`);
    const lastChunkAt = order.map((o) => o.includes("/chunks/")).lastIndexOf(true);
    expect(lastChunkAt).toBeLessThan(parentAt);
  });

  it("leaves no stale chunk behind when a re-upload splits smaller", async () => {
    const { db, docs } = fakeDb();
    const long = Array.from({ length: 400 }, (_, i) => event(i, 4000));
    await storeSitting(db, "ybm", session(long), "dev_ipad_1");
    const chunked = [...docs.keys()].filter((k) => k.includes("/chunks/")).length;
    expect(chunked).toBeGreaterThan(1);

    // The same sitting, now short enough to fit inline.
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");
    const left = [...docs.keys()].filter((k) => k.includes("/chunks/"));
    expect(left).toEqual([]);

    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(() => joinSession(doc, [])).not.toThrow();
  });

  it("reads back a chunked sitting whole", async () => {
    const { db, docs } = fakeDb();
    const long = Array.from({ length: 400 }, (_, i) => event(i, 4000));
    await storeSitting(db, "ybm", session(long), "dev_ipad_1");

    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    const chunks = [...docs.entries()]
      .filter(([k]) => k.includes("/chunks/"))
      .map(([, v]) => v as unknown as ChunkDoc);
    expect(joinSession(doc, chunks).events).toHaveLength(400);
  });
});

describe("the same sitting from two devices", () => {
  it("keeps the copy already stored, rather than letting the second overwrite it", async () => {
    // Replacing one child's log with another's is the merge this platform
    // exists to never make. The second arrival has no better claim.
    const { db, docs, collections } = fakeDb();
    await storeSitting(db, "ybm", session([event(0), event(1)]), "dev_ipad_1");
    const outcome = await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_2");

    expect(outcome).toMatchObject({ stored: false, quarantined: true });
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(doc.deviceId).toBe("dev_ipad_1");
    expect(doc.eventCount).toBe(2);
    expect(doc.quarantined).toBe(true);
  });

  it("files the copy that arrived, so both survive for a person to compare", async () => {
    const { db, collections } = fakeDb();
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_2");

    const filed = collections[paths.quarantine("ybm")] ?? [];
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ heldDeviceId: "dev_ipad_1", arrivingDeviceId: "dev_ipad_2" });
  });

  it("stays quarantined when the first device uploads again", async () => {
    // The thing worth knowing is that a collision happened at all. A third
    // upload must not clear a flag the second raised.
    const { db, docs } = fakeDb();
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_2");
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");

    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).quarantined).toBe(true);
  });

  it("does not quarantine the ordinary case of the same device retrying", async () => {
    const { db, docs } = fakeDb();
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");
    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).quarantined).toBe(false);
  });
});

describe("when a write fails part way", () => {
  it("leaves chunks with no parent rather than a parent with no chunks", async () => {
    // Invisible: the export walks parents. The other way round is a sitting
    // that looks present and cannot be read.
    const { db, docs, fail } = fakeDb();
    fail(true);
    const long = Array.from({ length: 400 }, (_, i) => event(i, 4000));
    await expect(storeSitting(db, "ybm", session(long), "dev_ipad_1")).rejects.toThrow();

    expect(docs.has(paths.session("ybm", "ses_1"))).toBe(false);
    expect([...docs.keys()].every((k) => k.includes("/chunks/"))).toBe(true);
  });
});
