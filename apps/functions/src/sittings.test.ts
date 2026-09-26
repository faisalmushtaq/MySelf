import { describe, expect, it } from "vitest";
import { joinSession, paths, splitSession, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import type { DeviceSession } from "@myself/store";
import { deviceIdFor, sittingRefusal, storeSitting } from "./sittings.js";
// The upload shape is the shared wire contract, not this function's own idea of it.
import { sittingUpload } from "@myself/store";
import { RelayError, type Caller } from "./relay-policy.js";

/**
 * The write path the export always assumed existed.
 *
 * These run against a Firestore stand-in rather than an emulator: what is
 * worth testing is the ordering and the collision rule, both of which are
 * decisions in this file, and a test that needs a deploy is a test nobody
 * runs before deploying.
 */

const device: Caller = { uid: "dev_ipad_1", device: true, anonymous: false };
/** The normal case now: an iPad that opened the URL and signed itself in. */
const openDevice: Caller = { uid: "anon_abc123", device: true, anonymous: true };
const researcher: Caller = { uid: "res_1", device: false, anonymous: false };
const tester: Caller = { uid: "link_abc123", device: false, anonymous: false };

/** Enough Firestore to record what was written, in what order. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  let failParentWrite = false;
  let beforeTransaction: (() => void) | null = null;

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
    /** Run something the instant before the transaction body reads the parent. */
    raceIn: (f: () => void) => {
      beforeTransaction = f;
    },
    db: {
      doc: (path: string) => ({ ...ref(path), path }),
      batch,
      collection: (path: string) => ({
        add: async (value: Record<string, unknown>) => {
          (collections[path] ??= []).push(value);
        },
      }),
      /**
       * Enough of a transaction to test the decision, not the isolation.
       *
       * Firestore's own guarantee — re-run the body when the document moved
       * underneath it — is the provider's to keep, and a stand-in that pretended
       * to reproduce it would be testing the stand-in. What IS worth proving
       * here is that the conflict rules are applied to the document read inside
       * the body rather than to a stale one, so `beforeTransaction` lets a test
       * make the parent appear between the early check and the transaction. That
       * is exactly the interleaving a second iPad produces.
       */
      runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
        beforeTransaction?.();
        // `set` is synchronous and the write is not visible until commit, the
        // same as the real one — a stub whose `set` applied immediately would
        // hide a body that reads back its own uncommitted write, and one whose
        // `set` rejected would report a write failure in the wrong place.
        const queued: (() => void)[] = [];
        const tx = {
          get: async (r: { path: string }) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
          set: (r: { path: string }, value: Record<string, unknown>, options?: { merge?: boolean }) => {
            queued.push(() => {
              docs.set(r.path, options?.merge ? { ...(docs.get(r.path) ?? {}), ...value } : value);
              order.push(`set ${r.path}`);
            });
            return tx;
          },
        };
        const result = await body(tx);
        // Commit. A refused write fails here, after the body has run, which is
        // where Firestore reports it too.
        if (queued.length > 0 && failParentWrite) throw new Error("write refused");
        queued.forEach((f) => f());
        return result;
      },
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

/** The document the write path would produce, for seeding a race. */
const splitOf = (s: DeviceSession, deviceId: string): SessionDoc =>
  splitSession(s, deviceId, "ybm").doc;

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

describe("an iPad that nobody registered", () => {
  it("may file a sitting, because that is how somebody takes part", () => {
    // Requiring an owner to register each device first is a barrier in front of
    // the one thing this exists to do.
    expect(sittingRefusal(openDevice)).toBeNull();
  });

  it("is its own device, so the no-overwrite rules still apply to it", () => {
    // The whole reason it signs in at all: the collision rule turns on which
    // device a sitting came from, and that cannot rest on something claimable.
    expect(deviceIdFor(openDevice, undefined)).toBe("anon_abc123");
    expect(deviceIdFor(openDevice, "dev_somebody_elses_ipad")).toBe("anon_abc123");
  });

  it("is recorded as an open-URL sitting rather than a registered one", async () => {
    // Not a quality judgement, and nothing filters on it by default. It is here so
    // a study that cares can tell the two apart at all.
    const { db, docs } = fakeDb();
    await storeSitting(db, "ybm", session([event(0)]), openDevice.uid, new Date(), "open");
    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).enrolment).toBe("open");
  });

  it("records a registered device as registered", async () => {
    const { db, docs } = fakeDb();
    await storeSitting(db, "ybm", session([event(0)]), device.uid, new Date(), "enrolled");
    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).enrolment).toBe("enrolled");
  });

  it("is still not a tester link, which may not file one", async () => {
    expect(sittingRefusal(tester)).toMatch(/cannot file a survey sitting/);
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

  it("leaves no stale chunk behind when a later build packs the same events into fewer", async () => {
    // The legitimate way a re-upload produces fewer chunks: the events are the
    // same, but a change to the byte budget or the per-chunk cap repacks them.
    // A parent claiming ten chunks with eight present reads as complete to
    // `joinSession` — which counts — while carrying a stale tail.
    //
    // A log getting SHORTER cannot reach this path any more; that is refused as
    // a conflict, and it is what makes deleting chunks here safe.
    const { db, docs } = fakeDb();
    const long = Array.from({ length: 400 }, (_, i) => event(i, 4000));
    await storeSitting(db, "ybm", session(long), "dev_ipad_1");

    const written = [...docs.keys()].filter((k) => k.includes("/chunks/")).length;
    expect(written).toBeGreaterThan(1);

    // Pretend the previous build had spread the same sitting over more chunks.
    const parent = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    docs.set(paths.session("ybm", "ses_1"), { ...parent, chunkCount: written + 3 });
    for (let i = written; i < written + 3; i += 1) {
      docs.set(paths.sessionChunk("ybm", "ses_1", i), { sessionId: "ses_1", index: i, events: [] });
    }

    await storeSitting(db, "ybm", session(long), "dev_ipad_1");

    const left = [...docs.keys()].filter((k) => k.includes("/chunks/"));
    expect(left).toHaveLength(written);
    const after = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    const chunks = [...docs.entries()]
      .filter(([k]) => k.includes("/chunks/"))
      .map(([, v]) => v as unknown as ChunkDoc);
    expect(joinSession(after, chunks).events).toHaveLength(400);
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

/**
 * The failures that would have cost real data, and did not look like failures.
 *
 * Every one of these used to return `stored: true` and leave a shorter or
 * contradicted log in the dataset, with nothing downstream able to tell.
 */
describe("a sitting that contradicts the one already stored", () => {
  it("refuses a log that has got shorter, and keeps the longer one", async () => {
    // An iPad restored from a backup, or a checkpoint re-sent after the full
    // sitting already arrived. The parent is replaced outright and unused chunks
    // are deleted, so without this rule a complete sitting silently truncates.
    const { db, docs } = fakeDb();
    const whole = Array.from({ length: 9 }, (_, i) => event(i));
    await storeSitting(db, "ybm", session(whole), "dev_ipad_1");

    const outcome = await storeSitting(db, "ybm", session([event(0), event(1)]), "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: false, quarantined: true });
    expect(outcome.reason).toMatch(/never gets shorter/);
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(doc.eventCount).toBe(9);
  });

  it("leaves the good copy in the dataset rather than flagging it too", async () => {
    // The stored copy is the complete one. Quarantining it would drop a whole
    // sitting out of the export to punish a bad retry — the export skips
    // anything flagged.
    const { db, docs, collections } = fakeDb();
    await storeSitting(db, "ybm", session([event(0), event(1), event(2)]), "dev_ipad_1");
    await storeSitting(db, "ybm", session([event(0)]), "dev_ipad_1");

    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).quarantined).toBe(false);
    // Nothing is dropped, though: the short copy is filed with both counts.
    expect(collections[paths.quarantine("ybm")]?.[0]).toMatchObject({
      heldEvents: 3,
      arrivingEvents: 1,
      storedFlagged: false,
    });
  });

  it("accepts a sitting that has grown, which is what a checkpoint does", async () => {
    // The whole point of uploading a sitting while it is still running: the log
    // only ever gets longer, and each upload supersedes the last.
    const { db, docs } = fakeDb();
    await storeSitting(db, "ybm", { ...session([event(0), event(1)]), complete: false }, "dev_ipad_1");
    const outcome = await storeSitting(db, "ybm", session([event(0), event(1), event(2), event(3)]), "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: true, events: 4, quarantined: false });
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(doc.complete).toBe(true);
    expect(joinSession(doc, []).events).toHaveLength(4);
  });

  it("will not reopen a sitting that has already been finished", async () => {
    // A stale checkpoint arriving after the finished sitting must not turn a
    // complete sitting back into a partial one.
    const { db, docs } = fakeDb();
    const whole = [event(0), event(1), event(2)];
    await storeSitting(db, "ybm", session(whole), "dev_ipad_1");

    const outcome = await storeSitting(db, "ybm", { ...session(whole), complete: false }, "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: false, quarantined: true });
    expect((docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc).complete).toBe(true);
  });

  it("refuses a copy collected under a different release, and flags both", async () => {
    // Two copies of one sitting under different releases are not the same
    // instrument. Reading one through the other is how a renamed option code
    // becomes a silently wrong answer, so neither is trusted.
    const { db, docs } = fakeDb();
    const one = session([event(0), event(1)]);
    await storeSitting(db, "ybm", one, "dev_ipad_1");

    const outcome = await storeSitting(db, "ybm", { ...one, releaseHash: "sha256-different" }, "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: false, quarantined: true });
    expect(outcome.reason).toMatch(/release hash/);
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(doc.releaseHash).toBe("sha256-abc");
    expect(doc.quarantined).toBe(true);
  });
});

describe("two iPads handed over at the same moment", () => {
  it("refuses the loser of the race instead of letting it overwrite the winner", async () => {
    // The reason the decision is inside a transaction. Reading the parent,
    // deciding, and then writing it is three operations: both devices read
    // "nothing stored", both decide they may proceed, and the second silently
    // replaces the first. `raceIn` makes the other device's sitting appear in
    // exactly that window.
    const { db, docs, collections, raceIn } = fakeDb();
    const mine = session([event(0), event(1)]);

    raceIn(() => {
      raceIn(() => undefined);
      docs.set(paths.session("ybm", "ses_1"), {
        ...splitOf(session([event(0), event(1), event(2)]), "dev_ipad_2"),
      });
    });

    const outcome = await storeSitting(db, "ybm", mine, "dev_ipad_1");

    expect(outcome).toMatchObject({ stored: false, quarantined: true });
    const doc = docs.get(paths.session("ybm", "ses_1")) as unknown as SessionDoc;
    expect(doc.deviceId).toBe("dev_ipad_2");
    expect(collections[paths.quarantine("ybm")]).toHaveLength(1);
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
