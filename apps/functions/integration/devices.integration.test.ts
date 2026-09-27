import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import { registerDevice } from "../src/relay.js";
import { RelayError } from "../src/relay-policy.js";

/**
 * A device registering itself, against a real Firestore.
 *
 * This is the identity the whole no-overwrite rule rests on, so the property that
 * matters is not "the right credential works" but "the wrong one cannot take over".
 * First writer wins permanently, and proving that needs real transaction contention
 * rather than a stand-in agreeing with itself.
 */

const STUDY = "ybm";

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" }, `devices-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection(`studies/${STUDY}/devices`));
});

/** What an iPad generates for itself on first launch. */
const credential = (installId: string, secret = "a".repeat(43)) => `${installId}.${secret}`;

const refused = async (promise: Promise<unknown>): Promise<RelayError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RelayError) return error;
    throw error;
  }
  throw new Error("that was accepted, and it should not have been");
};

describe("an iPad registering itself", () => {
  it("is accepted on first sight and files under its own installation id", async () => {
    const caller = await registerDevice(db, STUDY, credential("ipad_01ABC"));
    expect(caller).toMatchObject({ uid: "ipad_01ABC", device: true });

    const stored = (await db.doc(paths.device(STUDY, "ipad_01ABC")).get()).data();
    expect(stored).toMatchObject({ deviceId: "ipad_01ABC", study: STUDY, selfRegistered: true, revokedAt: null });
    // The secret itself is never stored, only its digest.
    expect(JSON.stringify(stored)).not.toContain("a".repeat(43));
  });

  it("is accepted again and again with the same secret, which is every upload after the first", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await registerDevice(db, STUDY, credential("ipad_01ABC"))).toMatchObject({ uid: "ipad_01ABC" });
    }
  });

  it("refuses a different secret for an installation that already exists", async () => {
    // The whole point. Without this, "the same device" is something any caller can
    // claim, and the collision rule that keeps two children's logs apart means
    // nothing.
    await registerDevice(db, STUDY, credential("ipad_01ABC"));
    const error = await refused(registerDevice(db, STUDY, credential("ipad_01ABC", "b".repeat(43))));

    expect(error.status).toBe(403);
    expect(error.message).toMatch(/another device is already registered/);
    // And it says what to do about it, because the sittings are not lost.
    expect(error.message).toMatch(/hand them over as a file/);
  });

  it("lets a different installation register freely, because taking part is open", async () => {
    await registerDevice(db, STUDY, credential("ipad_01ABC"));
    expect(await registerDevice(db, STUDY, credential("ipad_02DEF"))).toMatchObject({ uid: "ipad_02DEF" });
  });

  it("refuses a device that has been withdrawn from the study", async () => {
    await registerDevice(db, STUDY, credential("ipad_01ABC"));
    await db.doc(paths.device(STUDY, "ipad_01ABC")).set({ revokedAt: FieldValue.serverTimestamp() }, { merge: true });

    const error = await refused(registerDevice(db, STUDY, credential("ipad_01ABC")));
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/withdrawn from the study/);
  });

  it("can be withdrawn before it has ever registered", async () => {
    // Revoking is a `set` with a merge rather than an `update` for exactly this: an
    // owner who wants a device stopped before it has filed anything would otherwise
    // hit "no document to update" at the moment they most need it to work.
    await db
      .doc(paths.device(STUDY, "ipad_never_seen"))
      .set({ deviceId: "ipad_never_seen", study: STUDY, revokedAt: FieldValue.serverTimestamp() }, { merge: true });

    const error = await refused(registerDevice(db, STUDY, credential("ipad_never_seen")));
    expect(error.message).toMatch(/withdrawn/);
  });
});

describe("credentials that are not credentials", () => {
  it("refuses a malformed one rather than inventing an installation", async () => {
    for (const bad of ["", ".", "ipad_only", "ipad_a.", ".secret", "ipad_a.tooshort"]) {
      const error = await refused(registerDevice(db, STUDY, bad));
      expect(error.status).toBe(401);
    }
    // And nothing was created by the attempts.
    expect((await db.collection(paths.devices(STUDY)).get()).size).toBe(0);
  });

  it("refuses an installation id with characters a ULID never contains", async () => {
    // A path-shaped id would otherwise be able to address a document somewhere else.
    for (const bad of ["../../admin", "ipad/a", "ipad a", "ipad_\u0000a"]) {
      const error = await refused(registerDevice(db, STUDY, credential(bad)));
      expect(error.status).toBe(401);
    }
  });

  it("accepts a secret at the shortest length it allows and no shorter", async () => {
    await expect(registerDevice(db, STUDY, credential("ipad_edge", "x".repeat(32)))).resolves.toMatchObject({
      uid: "ipad_edge",
    });
    const error = await refused(registerDevice(db, STUDY, credential("ipad_edge_2", "x".repeat(31))));
    expect(error.status).toBe(401);
  });
});

describe("two devices claiming one installation at the same instant", () => {
  /**
   * The race that decides whether the identity means anything.
   *
   * Both callers find no registration, both would create one, and without the
   * transaction both would be told they are that device — after which two iPads
   * file sittings under one id and the collision rule cannot tell them apart.
   */
  it("registers exactly one of them", async () => {
    const results = await Promise.allSettled([
      registerDevice(db, STUDY, credential("ipad_race", "1".repeat(43))),
      registerDevice(db, STUDY, credential("ipad_race", "2".repeat(43))),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // And the winner keeps working afterwards, while the loser stays locked out.
    const stored = (await db.doc(paths.device(STUDY, "ipad_race")).get()).data() as { secretHash: string };
    expect(stored.secretHash).toHaveLength(64);
  });

  it("settles on one winner even with six claimants", async () => {
    const results = await Promise.allSettled(
      ["1", "2", "3", "4", "5", "6"].map((n) => registerDevice(db, STUDY, credential("ipad_six", n.repeat(43)))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
  });
});
