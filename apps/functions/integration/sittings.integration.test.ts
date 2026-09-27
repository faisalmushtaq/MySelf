import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { joinSession, paths, type ChunkDoc, type SessionDoc } from "@myself/firebase";
import type { DeviceSession, DeviceEvent } from "@myself/store";
import { storeSitting } from "../src/sittings.js";

/**
 * The write path, against a real Firestore.
 *
 * The unit suite runs `storeSitting` against a stand-in, which is right for the
 * ordering and the branch logic. It cannot prove the thing the platform actually
 * promises: that two iPads handed over at the same instant cannot overwrite each
 * other. That resolution happens inside a Firestore transaction, and only a real
 * database has real contention.
 *
 * So this suite is about the cases where a fake would lie — concurrency, document
 * limits, the spill into chunks, and what a torn write leaves behind.
 */

const STUDY = "ybm";

let app: App;
let db: Firestore;

beforeAll(() => {
  // `emulators:exec` sets FIRESTORE_EMULATOR_HOST; the admin SDK picks it up and
  // needs no credentials. Failing loudly here beats silently writing to a project.
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" }, `integration-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection(`studies/${STUDY}/sessions`));
  await db.recursiveDelete(db.collection(`studies/${STUDY}/quarantine`));
});

const event = (seq: number, chars = 20): DeviceEvent => ({
  seq,
  type: "response.recorded",
  itemKey: `inst.q${seq}`,
  payload: { value: { kind: "choice", code: seq % 5 } , note: "x".repeat(chars) },
  tWall: new Date(Date.UTC(2026, 8, 1, 10, 0, seq % 60)).toISOString(),
  tMono: seq * 1_000,
});

const sitting = (events: DeviceEvent[], over: Partial<DeviceSession> = {}): DeviceSession => ({
  sessionId: "ses_integration_1",
  studyCode: "NDC0042",
  releaseKey: "ybm_nd2026_standard_r7_0_1",
  releaseHash: "sha256:b51b5b29c6ee2146623a4dc701c14954cdce9de1ba1689f32ee02a1bd0fa9013",
  startedAt: "2026-09-01T10:00:00.000Z",
  completedAt: "2026-09-01T10:20:00.000Z",
  complete: true,
  events,
  ...over,
});

/** Read a sitting back the way the export does, chunks included. */
async function readBack(sessionId: string): Promise<DeviceSession> {
  const parent = await db.doc(paths.session(STUDY, sessionId)).get();
  const doc = parent.data() as SessionDoc;
  const chunks =
    doc.chunkCount > 0
      ? (await db.collection(paths.sessionChunks(STUDY, sessionId)).get()).docs.map((c) => c.data() as ChunkDoc)
      : [];
  return joinSession(doc, chunks);
}

const many = (n: number, chars = 20) => Array.from({ length: n }, (_, i) => event(i, chars));

describe("storing a sitting in a real database", () => {
  it("round trips every event, in order, with its payload intact", async () => {
    const outcome = await storeSitting(db, STUDY, sitting(many(120)), "ipad_a", new Date(), "device");
    expect(outcome).toMatchObject({ stored: true, events: 120, quarantined: false });

    const back = await readBack("ses_integration_1");
    expect(back.events).toHaveLength(120);
    expect(back.events.map((e) => e.seq)).toEqual([...Array(120).keys()]);
    // The payload is the science. A store that reorders or re-types it is useless
    // however reliable it is.
    expect(back.events[7]!.payload).toEqual(sitting(many(120)).events[7]!.payload);
    expect(back.studyCode).toBe("NDC0042");
    expect(back.complete).toBe(true);
  });

  it("is idempotent across repeated uploads of the same sitting", async () => {
    const one = sitting(many(50));
    for (let i = 0; i < 5; i += 1) await storeSitting(db, STUDY, one, "ipad_a", new Date(), "device");

    const sessions = await db.collection(paths.sessions(STUDY)).get();
    expect(sessions.size).toBe(1);
    expect((await readBack("ses_integration_1")).events).toHaveLength(50);
  });

  it("spills a long sitting into chunks and still reads back whole", async () => {
    // A sitting left open across a fortnight, or one with long free-text answers.
    // The spill exists so the write does not fail at the 1 MiB document limit —
    // which would lose the sitting at the moment it is handed over.
    const outcome = await storeSitting(db, STUDY, sitting(many(900, 900)), "ipad_a", new Date(), "device");
    expect(outcome.chunks).toBeGreaterThan(1);
    expect(outcome.events).toBe(900);

    const back = await readBack("ses_integration_1");
    expect(back.events).toHaveLength(900);
    expect(back.events.map((e) => e.seq)).toEqual([...Array(900).keys()]);
  });

  it("accepts a sitting that grew, which is what a checkpoint becomes", async () => {
    // The real sequence on a device: checkpointed while being answered, then
    // finished. Each upload supersedes the last and the log only grows.
    await storeSitting(db, STUDY, sitting(many(30), { complete: false }), "ipad_a", new Date(), "device");
    await storeSitting(db, STUDY, sitting(many(60), { complete: false }), "ipad_a", new Date(), "device");
    const final = await storeSitting(db, STUDY, sitting(many(90)), "ipad_a", new Date(), "device");

    expect(final).toMatchObject({ stored: true, events: 90 });
    const back = await readBack("ses_integration_1");
    expect(back.events).toHaveLength(90);
    expect(back.complete).toBe(true);
  });

  it("refuses a shorter log and keeps the longer one", async () => {
    await storeSitting(db, STUDY, sitting(many(90)), "ipad_a", new Date(), "device");
    const short = await storeSitting(db, STUDY, sitting(many(10)), "ipad_a", new Date(), "device");

    expect(short).toMatchObject({ stored: false, quarantined: true });
    expect((await readBack("ses_integration_1")).events).toHaveLength(90);
    // The good copy stays in the dataset; only the short arrival is filed.
    const parent = (await db.doc(paths.session(STUDY, "ses_integration_1")).get()).data() as SessionDoc;
    expect(parent.quarantined).toBe(false);
  });

  it("leaves no stale chunk when a shorter-chunked upload is refused", async () => {
    // The dangerous combination: a spilled sitting, then a shorter upload. If the
    // refusal happened after the chunk cleanup, the stored sitting would be left
    // claiming chunks that had been deleted and `joinSession` would refuse it.
    await storeSitting(db, STUDY, sitting(many(900, 900)), "ipad_a", new Date(), "device");
    const before = await readBack("ses_integration_1");

    await storeSitting(db, STUDY, sitting(many(20)), "ipad_a", new Date(), "device");

    const after = await readBack("ses_integration_1");
    expect(after.events).toHaveLength(before.events.length);
  });
});

describe("a refused upload must leave the stored sitting alone", () => {
  /**
   * The corruption the previous write ordering allowed.
   *
   * Chunks used to be written before the transaction that decides, on the reasoning that
   * a refused upload leaves chunks nobody reads. That holds only when the refused upload
   * has no chunks in common with the stored sitting — and a chunk is identified by its
   * index, so a shorter-but-still-chunked upload overwrote the low chunks and left the
   * parent claiming the original count. `chunksComplete` counts indexes, finds them all
   * present, and `joinSession` returns a blend of two different logs reported as whole.
   *
   * The earlier test for this used a shorter upload that fitted inline, so it wrote no
   * chunks at all and passed against the broken ordering. This one is chunked on both
   * sides, which is the case that actually bit.
   */
  it("does not overwrite the low chunks of a longer stored sitting", async () => {
    const whole = await storeSitting(db, STUDY, sitting(many(900, 900)), "ipad_a", new Date(), "device");
    expect(whole.chunks).toBeGreaterThan(2);
    const before = await readBack("ses_integration_1");

    // Shorter, and still large enough to spill into chunks of its own.
    const shorter = sitting(many(500, 900));
    const refused = await storeSitting(db, STUDY, shorter, "ipad_a", new Date(), "device");
    expect(refused).toMatchObject({ stored: false, quarantined: true });

    const after = await readBack("ses_integration_1");
    expect(after.events).toHaveLength(before.events.length);
    // Not merely the right length — the right events, which is what a blend would fail.
    expect(after.events.map((e) => e.seq)).toEqual(before.events.map((e) => e.seq));
    expect(JSON.stringify(after.events)).toBe(JSON.stringify(before.events));
  });

  it("does not overwrite them when a second device is the one refused", async () => {
    await storeSitting(db, STUDY, sitting(many(900, 900)), "ipad_a", new Date(), "device");
    const before = await readBack("ses_integration_1");

    const refused = await storeSitting(db, STUDY, sitting(many(500, 900)), "ipad_b", new Date(), "device");
    expect(refused.stored).toBe(false);

    const after = await readBack("ses_integration_1");
    expect(JSON.stringify(after.events)).toBe(JSON.stringify(before.events));
  });

  it("writes nothing at all when it is refused, not even orphan chunks", async () => {
    // A refused upload used to leave its chunks behind. They were harmless only by
    // accident; now the transaction means there is nothing to be harmless about.
    await storeSitting(db, STUDY, sitting(many(900, 900)), "ipad_a", new Date(), "device");
    const parent = (await db.doc(paths.session(STUDY, "ses_integration_1")).get()).data() as SessionDoc;
    const chunkCountBefore = (await db.collection(paths.sessionChunks(STUDY, "ses_integration_1")).get()).size;
    expect(chunkCountBefore).toBe(parent.chunkCount);

    await storeSitting(db, STUDY, sitting(many(500, 900)), "ipad_b", new Date(), "device");

    const chunkCountAfter = (await db.collection(paths.sessionChunks(STUDY, "ses_integration_1")).get()).size;
    expect(chunkCountAfter).toBe(chunkCountBefore);
  });
});

describe("what a refusal leaves behind for a person to read", () => {
  it("keeps one row per device rather than letting the second overwrite the first", async () => {
    // Keyed on the sitting alone, a second device's filed copy replaced the first's, which
    // loses exactly the evidence this exists to keep.
    await storeSitting(db, STUDY, sitting(many(20)), "ipad_a", new Date(), "device");
    await storeSitting(db, STUDY, sitting(many(20)), "ipad_b", new Date(), "device");
    await storeSitting(db, STUDY, sitting(many(20)), "ipad_c", new Date(), "device");

    const filed = await db.collection(paths.quarantine(STUDY)).get();
    expect(filed.size).toBe(2);
    expect(new Set(filed.docs.map((d) => d.data()["arrivingDeviceId"]))).toEqual(
      new Set(["ipad_b", "ipad_c"]),
    );
  });

  it("counts repeated refusals from one device instead of storing the log again", async () => {
    // A device on a bad connection refuses the same sitting by the dozen. Appending a copy
    // each time is how a quarantine collection outgrows the dataset it guards.
    await storeSitting(db, STUDY, sitting(many(40)), "ipad_a", new Date(), "device");
    for (let i = 0; i < 4; i += 1) {
      await storeSitting(db, STUDY, sitting(many(10)), "ipad_a", new Date(), "device");
    }

    const filed = await db.collection(paths.quarantine(STUDY)).get();
    expect(filed.size).toBe(1);
    expect(filed.docs[0]!.data()["refusals"]).toBe(4);
  });

  it("files a spilled sitting without exceeding the document limit", async () => {
    // Embedding the whole log meant a spilled sitting produced a quarantine document over
    // 1 MiB, so the write failed and the evidence was the one thing lost.
    await storeSitting(db, STUDY, sitting(many(1_400, 900)), "ipad_a", new Date(), "device");
    const refused = await storeSitting(db, STUDY, sitting(many(30)), "ipad_a", new Date(), "device");
    expect(refused.stored).toBe(false);

    const filed = await db.collection(paths.quarantine(STUDY)).get();
    expect(filed.size).toBe(1);
    // It landed, which is the assertion — a document over the limit would have thrown.
    expect(filed.docs[0]!.data()["sessionId"]).toBe("ses_integration_1");
  });

  it("truncates an arriving log too big to store, and says that it did", async () => {
    await storeSitting(db, STUDY, sitting(many(2_000, 900)), "ipad_a", new Date(), "device");
    await storeSitting(db, STUDY, sitting(many(1_500, 900)), "ipad_b", new Date(), "device");

    const filed = await db.collection(paths.quarantine(STUDY)).get();
    const row = filed.docs.find((d) => d.data()["arrivingDeviceId"] === "ipad_b")!.data();
    expect(row["arrivingSessionTruncated"]).toBe(true);
    // Still says how long the real thing was, so nobody mistakes the head for all of it.
    expect(row["arrivingEvents"]).toBe(1_500);
    expect(JSON.parse(row["arrivingSessionJson"] as string).events).toHaveLength(50);
  });
});

describe("two iPads, one session id", () => {
  it("keeps the first and files the second, in a real transaction", async () => {
    await storeSitting(db, STUDY, sitting(many(40)), "ipad_a", new Date(), "device");
    const second = await storeSitting(db, STUDY, sitting(many(40)), "ipad_b", new Date(), "device");

    expect(second).toMatchObject({ stored: false, quarantined: true });
    const parent = (await db.doc(paths.session(STUDY, "ses_integration_1")).get()).data() as SessionDoc;
    expect(parent.deviceId).toBe("ipad_a");
    // Both copies are suspect here, because nothing can say which child this was.
    expect(parent.quarantined).toBe(true);

    const filed = await db.collection(paths.quarantine(STUDY)).get();
    expect(filed.size).toBe(1);
    expect(filed.docs[0]!.data()).toMatchObject({ heldDeviceId: "ipad_a", arrivingDeviceId: "ipad_b" });
    // Against a real Firestore, so the increment is a real increment.
    expect(filed.docs[0]!.data()["refusals"]).toBe(1);
  });

  /**
   * The test the fake Firestore could not write.
   *
   * Read the parent, decide, write it is three operations. Two devices uploading
   * the same session id at the same instant both read "nothing stored", both decide
   * they may proceed, and without a transaction the second silently replaces the
   * first. That is reachable exactly when the platform is used as intended — a rack
   * of iPads handed over together at the end of a school day.
   */
  it("resolves a genuine race to exactly one winner", async () => {
    const results = await Promise.all([
      storeSitting(db, STUDY, sitting(many(40)), "ipad_a", new Date(), "device"),
      storeSitting(db, STUDY, sitting(many(40)), "ipad_b", new Date(), "device"),
    ]);

    const stored = results.filter((r) => r.stored);
    const refused = results.filter((r) => !r.stored);
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.quarantined).toBe(true);

    // And whichever won, the stored sitting is one device's log and not a blend.
    const parent = (await db.doc(paths.session(STUDY, "ses_integration_1")).get()).data() as SessionDoc;
    expect(["ipad_a", "ipad_b"]).toContain(parent.deviceId);
    expect((await readBack("ses_integration_1")).events).toHaveLength(40);
  });

  it("survives six devices racing for the same id", async () => {
    // A session id collision across a whole rack, which is the pathological case.
    // Exactly one may end up stored, and the log must be readable afterwards.
    const devices = ["a", "b", "c", "d", "e", "f"].map((d) => `ipad_${d}`);
    const results = await Promise.all(
      devices.map((deviceId) => storeSitting(db, STUDY, sitting(many(25)), deviceId, new Date(), "device")),
    );

    expect(results.filter((r) => r.stored)).toHaveLength(1);
    expect(results.filter((r) => r.quarantined)).toHaveLength(5);
    expect((await readBack("ses_integration_1")).events).toHaveLength(25);
  });
});

describe("one iPad, uploading twice at once", () => {
  it("does not corrupt a sitting when a retry overlaps the first attempt", async () => {
    // A flaky connection produces exactly this: the first request has not returned,
    // the retry fires, and both are in flight against the same documents. Both are
    // the same device and the same log, so both may succeed — what must not happen
    // is a half-written sitting.
    const one = sitting(many(200, 200));
    const results = await Promise.all([
      storeSitting(db, STUDY, one, "ipad_a", new Date(), "device"),
      storeSitting(db, STUDY, one, "ipad_a", new Date(), "device"),
      storeSitting(db, STUDY, one, "ipad_a", new Date(), "device"),
    ]);

    for (const result of results) expect(result.stored).toBe(true);
    const back = await readBack("ses_integration_1");
    expect(back.events).toHaveLength(200);
    expect(back.events.map((e) => e.seq)).toEqual([...Array(200).keys()]);
  });

  it("does not lose events when a checkpoint and the finished sitting overlap", async () => {
    // The device checkpoints at 60 events, and while that is in flight the
    // participant finishes and the full sitting is sent. Whichever lands second,
    // the stored copy must not be the shorter one.
    const results = await Promise.all([
      storeSitting(db, STUDY, sitting(many(60), { complete: false }), "ipad_a", new Date(), "device"),
      storeSitting(db, STUDY, sitting(many(140)), "ipad_a", new Date(), "device"),
    ]);

    // One of the two may be refused — a checkpoint arriving after the finished
    // sitting is a contradiction and is supposed to be refused — but the stored
    // sitting must be the complete one either way.
    expect(results.some((r) => r.stored)).toBe(true);
    const back = await readBack("ses_integration_1");
    expect(back.events).toHaveLength(140);
    expect(back.complete).toBe(true);
  });
});

describe("many sittings at once, as a handover produces", () => {
  it("stores twenty distinct sittings from one device without mixing them", async () => {
    const sittings = Array.from({ length: 20 }, (_, i) =>
      sitting(many(40 + i), { sessionId: `ses_handover_${i}`, studyCode: `NDC00${String(i).padStart(2, "0")}` }),
    );

    const outcomes = await Promise.all(
      sittings.map((one) => storeSitting(db, STUDY, one, "ipad_a", new Date(), "device")),
    );
    expect(outcomes.every((o) => o.stored)).toBe(true);

    // Each sitting has its own length and its own code. Mixing would be invisible
    // in a count, so both are checked per sitting.
    for (let i = 0; i < 20; i += 1) {
      const back = await readBack(`ses_handover_${i}`);
      expect(back.events).toHaveLength(40 + i);
      expect(back.studyCode).toBe(`NDC00${String(i).padStart(2, "0")}`);
    }
  });
});
