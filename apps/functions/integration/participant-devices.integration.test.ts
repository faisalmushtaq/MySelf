import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import type { DeviceEvent, DeviceSession } from "@myself/store";
import { storeNarrative, type NarrativeRun } from "../src/narratives.js";
import { authenticate, meter, meterDevice } from "../src/relay.js";
import { RelayError, type Caller } from "../src/relay-policy.js";
import { storeSitting } from "../src/sittings.js";

/**
 * A participant's iPad talking to MyStory (D-55), against a real Firestore.
 *
 * The unit suite has the decisions. This has the two things only a database can
 * show: that the study's ceiling holds when a hall of iPads — or a stranger with
 * a script — calls at the same instant, and that two devices racing for one
 * conversation leave it with one owner. The ceiling is the only thing between a
 * URL that circulated and an unbounded bill, so "usually" is not good enough.
 *
 * The DEFAULT app, unlike the other suites, because `authenticate` and `meter`
 * reach Firestore the way the deployed functions do — through `research()` —
 * and this is the one place that path is exercised against a real database.
 */

const STUDY = "ybm";

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" });
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const collection of ["devices", "audit_relayDevices", "audit_relay", "narratives", "sessions", "quarantine"]) {
    await db.recursiveDelete(db.collection(`studies/${STUDY}/${collection}`));
  }
});

const ipad = (n: number | string): Caller => ({ uid: `ipad_${n}`, device: true, anonymous: true });
const NOW = new Date("2026-10-06T10:00:00Z");
const counts = (id: string) => db.doc(`${paths.audit(STUDY)}_relayDevices/${id}`).get();

/** Every outcome of a batch of calls made at once, refusals by which limit. */
async function allAtOnce(calls: Promise<void>[]): Promise<{ through: number; refused: Record<string, number> }> {
  const settled = await Promise.allSettled(calls);
  const refused: Record<string, number> = {};
  let through = 0;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      through += 1;
      continue;
    }
    // Anything but a limit's refusal — a transaction that gave up under contention,
    // say — is a failure of the thing under test, not a refusal.
    if (!(outcome.reason instanceof RelayError) || !outcome.reason.limit) throw outcome.reason;
    refused[outcome.reason.limit] = (refused[outcome.reason.limit] ?? 0) + 1;
  }
  return { through, refused };
}

describe("a participant's iPad at the relay's door", () => {
  it("is admitted on its own credential, registered first-writer-wins like a sitting's", async () => {
    const caller = await authenticate(`Device ipad_01ABC.${"a".repeat(43)}`, { allowDeviceCredential: true });
    expect(caller).toEqual({ uid: "ipad_01ABC", device: true, anonymous: true });
    expect((await db.doc(paths.device(STUDY, "ipad_01ABC")).get()).data()).toMatchObject({ selfRegistered: true });

    // And the same installation from a second device is still refused.
    await expect(
      authenticate(`Device ipad_01ABC.${"b".repeat(43)}`, { allowDeviceCredential: true }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("is counted by `meter` against the device limits, not the per-caller ceiling", async () => {
    await meter(ipad("01ABC"));
    const day = new Date().toISOString().slice(0, 10);
    expect((await counts(`${day}_ipad_01ABC`)).data()).toMatchObject({ calls: 1 });
    expect((await counts(day)).data()).toMatchObject({ calls: 1 });
    expect((await db.collection(`${paths.audit(STUDY)}_relay`).get()).size).toBe(0);
  });
});

describe("one iPad calling many times at once", () => {
  it("is let through exactly its own limit, and the study counts only those", async () => {
    const limits = { perDevice: 5, allDevices: 1_000 };
    const outcome = await allAtOnce(Array.from({ length: 12 }, () => meterDevice(db, STUDY, ipad(1), limits, NOW)));

    expect(outcome).toEqual({ through: 5, refused: { device: 7 } });
    expect((await counts("2026-10-06_ipad_1")).data()).toMatchObject({ calls: 5, refused: 7 });
    // Its refusals are its own: none reached the study's count.
    expect((await counts("2026-10-06")).data()).toMatchObject({ calls: 5 });
    expect((await counts("2026-10-06")).data()).not.toHaveProperty("refused");
  });
});

describe("many new iPads calling at once", () => {
  /**
   * The case a per-device limit cannot cover: a stranger's script registering a
   * fresh installation for every call. Each one is under its own limit; only the
   * study's ceiling stops them, so it must not be overshot when they arrive
   * together.
   */
  it("lets exactly the study's ceiling through, however many devices ask", async () => {
    const limits = { perDevice: 5, allDevices: 8 };
    const outcome = await allAtOnce(Array.from({ length: 20 }, (_, i) => meterDevice(db, STUDY, ipad(`new_${i}`), limits, NOW)));

    expect(outcome).toEqual({ through: 8, refused: { study: 12 } });
    expect((await counts("2026-10-06")).data()).toMatchObject({ calls: 8, refused: 12 });
    // A device refused by the ceiling was counted nowhere.
    const perDevice = (await db.collection(`${paths.audit(STUDY)}_relayDevices`).get()).docs.filter((d) => d.id !== "2026-10-06");
    expect(perDevice).toHaveLength(8);
    expect(perDevice.every((d) => d.data()["calls"] === 1)).toBe(true);
  });

  it("starts a fresh ceiling the next UTC day", async () => {
    const limits = { perDevice: 5, allDevices: 2 };
    await allAtOnce([0, 1, 2].map((i) => meterDevice(db, STUDY, ipad(i), limits, NOW)));
    const tomorrow = await allAtOnce([0, 1, 2].map((i) => meterDevice(db, STUDY, ipad(i), limits, new Date("2026-10-07T08:00:00Z"))));
    expect(tomorrow).toEqual({ through: 2, refused: { study: 1 } });
  });
});

describe("devices switched off", () => {
  it("refuses every device call and writes nothing at all", async () => {
    const outcome = await allAtOnce([1, 2, 3].map((i) => meterDevice(db, STUDY, ipad(i), { perDevice: 120, allDevices: 0 }, NOW)));
    expect(outcome).toEqual({ through: 0, refused: { off: 3 } });
    expect((await db.collection(`${paths.audit(STUDY)}_relayDevices`).get()).size).toBe(0);
  });
});

describe("whose conversation it is", () => {
  const run = (over: Partial<NarrativeRun> = {}): NarrativeRun => ({
    sessionId: "ses_mystory_1",
    protocolKey: "np.phone_wellbeing",
    protocolVersion: "0.1.0",
    records: [],
    finished: false,
    releaseHash: `sha256:${"a".repeat(64)}`,
    ...over,
  });
  const stored = async () => (await db.doc(paths.narrative(STUDY, "ses_mystory_1")).get()).data();

  it("is the first device's, and another device cannot replace it", async () => {
    await storeNarrative(db, STUDY, ipad("A"), run());
    await storeNarrative(db, STUDY, ipad("A"), run({ finished: true }));
    await expect(storeNarrative(db, STUDY, ipad("B"), run())).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toMatchObject({ uid: "ipad_A", finished: true, provenance: "study" });
  });

  it("settles on one owner when two devices store it at the same instant", async () => {
    const results = await Promise.allSettled([
      storeNarrative(db, STUDY, ipad("A"), run({ elapsedSeconds: 1 })),
      storeNarrative(db, STUDY, ipad("B"), run({ elapsedSeconds: 2 })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? "ipad_A" : "ipad_B";
    expect(await stored()).toMatchObject({ uid: winner, elapsedSeconds: winner === "ipad_A" ? 1 : 2 });
  });

  it("cannot be attached by a device to a sitting another device filed", async () => {
    const event: DeviceEvent = {
      seq: 0,
      type: "response.recorded",
      itemKey: "inst.q0",
      payload: { value: { kind: "choice", code: 1 } },
      tWall: "2026-10-06T10:00:00.000Z",
      tMono: 0,
    };
    const sitting: DeviceSession = {
      sessionId: "ses_mystory_1",
      studyCode: "NDC0042",
      releaseKey: "ybm_nd2026_standard_r8_0_0",
      releaseHash: `sha256:${"a".repeat(64)}`,
      startedAt: "2026-10-06T10:00:00.000Z",
      complete: false,
      events: [event],
    };
    await storeSitting(db, STUDY, sitting, "ipad_B", NOW, "device");

    await expect(storeNarrative(db, STUDY, ipad("A"), run())).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toBeUndefined();
    // The device that filed the sitting stores its own conversation as usual.
    await storeNarrative(db, STUDY, ipad("B"), run());
    expect(await stored()).toMatchObject({ uid: "ipad_B" });
  });

  it("must name its release when it comes from a participant's iPad", async () => {
    await expect(storeNarrative(db, STUDY, ipad("A"), run({ releaseHash: undefined }))).rejects.toMatchObject({ status: 400 });
    expect(await stored()).toBeUndefined();
  });
});
