import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { paths } from "@myself/firebase";
import { fileIdentity, type SittingIdentity } from "../src/identity.js";

/**
 * Filing a sitting's identity, against a real Firestore.
 *
 * The unit suite covers what the registry should hold. What only a database can
 * show is how the write lands: that an address is replaced whole rather than
 * folded into the old one key by key (the difference between `mergeFields` and
 * `merge`), that fields another path wrote are left alone, and that two
 * sittings filed at the same instant settle on the more recent address.
 */

const STUDY = "ybm";
const CODE = "P0000000001";

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env["FIRESTORE_EMULATOR_HOST"]) {
    throw new Error("this suite must run under `pnpm test:integration`, which starts the emulator");
  }
  app = initializeApp({ projectId: "demo-myself" }, `identity-${Date.now()}`);
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection(paths.participants(STUDY)));
});

const sitting = (over: Partial<SittingIdentity> = {}): SittingIdentity => ({
  code: CODE,
  study: STUDY,
  givenName: "Test",
  familyName: "Person",
  dateOfBirth: "2011-07-04",
  homeAddress: { postcode: "XX1 1XX", house: "1", street: "Example Street" },
  startedAt: "2026-09-29T10:00:00.000Z",
  ...over,
});

const entry = async () => (await db.doc(paths.participant(STUDY, CODE)).get()).data() ?? {};

describe("fileIdentity", () => {
  it("replaces the address whole, so no part of the old one survives under the new", async () => {
    await fileIdentity(db, "ses_a", sitting());
    await fileIdentity(db, "ses_b", sitting({ homeAddress: { postcode: "XX2 2XX" }, startedAt: "2027-03-01T10:00:00.000Z" }));
    expect((await entry())["homeAddress"]).toEqual({ postcode: "XX2 2XX" });
    // Each claim still says what was given at that sitting.
    const claim = (await db.doc(paths.claim(STUDY, "ses_a")).get()).data();
    expect(claim?.["homeAddress"]).toEqual({ postcode: "XX1 1XX", house: "1", street: "Example Street" });
  });

  it("leaves fields it does not own, such as where a UPN came from", async () => {
    await fileIdentity(db, "ses_a", sitting());
    await db.doc(paths.participant(STUDY, CODE)).set({ upn: "A123456789012", upnSource: "school register" }, { merge: true });
    await fileIdentity(db, "ses_b", sitting({ startedAt: "2027-03-01T10:00:00.000Z" }));
    expect(await entry()).toMatchObject({ upn: "A123456789012", upnSource: "school register", givenName: "Test" });
  });

  it("settles on the more recent address when two sittings are filed together", async () => {
    await Promise.all([
      fileIdentity(db, "ses_old", sitting({ homeAddress: { postcode: "XX1 1XX" }, startedAt: "2026-09-01T10:00:00.000Z" })),
      fileIdentity(db, "ses_new", sitting({ homeAddress: { postcode: "XX2 2XX" }, startedAt: "2027-03-01T10:00:00.000Z" })),
    ]);
    expect(await entry()).toMatchObject({
      homeAddress: { postcode: "XX2 2XX" },
      homeAddressRecordedAt: "2027-03-01T10:00:00.000Z",
    });
  });
});
