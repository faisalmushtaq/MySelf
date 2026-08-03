import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, getDocs } from "firebase/firestore";

/**
 * The rules are the access control, so they are tested from both sides: the
 * caller who should pass, and the caller who should not. A rules suite that
 * only checks the happy path proves nothing — the whole value of a rule is what
 * it refuses.
 *
 * These run against the real Firestore emulator, so what is exercised is the
 * rules file that will be deployed, not a description of it.
 */

let env: RulesTestEnvironment;

const STUDY = "ybm";
const sessionPath = (id: string) => `studies/${STUDY}/sessions/${id}`;

const sessionDoc = (deviceId: string, sessionId: string) => ({
  sessionId,
  deviceId,
  study: STUDY,
  studyCode: "NDC0042",
  releaseKey: "ybm_nd2026_standard",
  releaseHash: "sha256:abc",
  startedAt: "2026-09-01T09:00:00.000Z",
  complete: true,
  events: [{ seq: 0, type: "session.started", tWall: "2026-09-01T09:00:00.000Z", tMono: 0 }],
  chunkCount: 0,
  eventCount: 1,
  receivedAt: "2026-09-01T10:00:00.000Z",
});

/** An iPad: authenticated, carries a device claim, belongs to one study. */
const device = (id: string, study = STUDY) =>
  env.authenticatedContext(id, { device: true, study }).firestore();

/** A person with a role. */
const person = (uid: string, role: string) => env.authenticatedContext(uid, { role }).firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-myself",
    firestore: {
      rules: readFileSync(fileURLToPath(new URL("../firestore.rules", import.meta.url)), "utf8"),
      host: "127.0.0.1",
      port: 8181,
    },
  });
});

afterAll(async () => env?.cleanup());

beforeEach(async () => env.clearFirestore());

describe("iPads", () => {
  it("may add a sitting to their own study", async () => {
    const db = device("dev_a");
    await assertSucceeds(setDoc(doc(db, sessionPath("s1")), sessionDoc("dev_a", "s1")));
  });

  it("may not post into a study they were not enrolled for", async () => {
    const db = device("dev_a", "other_study");
    await assertFails(setDoc(doc(db, sessionPath("s1")), sessionDoc("dev_a", "s1")));
  });

  it("may not claim to be a different device", async () => {
    // The stamped deviceId must be the authenticated one, or a compromised
    // iPad could file sittings under a colleague's device and muddy the audit.
    const db = device("dev_a");
    await assertFails(setDoc(doc(db, sessionPath("s1")), sessionDoc("dev_b", "s1")));
  });

  it("may not read the study back", async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), sessionPath("s1")), sessionDoc("dev_a", "s1"));
    });
    // A stolen iPad is a device that can post, not a window into the cohort.
    const db = device("dev_a");
    await assertFails(getDoc(doc(db, sessionPath("s1"))));
    await assertFails(getDocs(collection(db, `studies/${STUDY}/sessions`)));
  });

  it("may finish a sitting it started, and no other device's", async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), sessionPath("s1")), sessionDoc("dev_a", "s1"));
    });
    await assertSucceeds(
      updateDoc(doc(device("dev_a"), sessionPath("s1")), { complete: true, eventCount: 9 }),
    );
    // This is the merge the platform must never make: refused at the rule.
    await assertFails(updateDoc(doc(device("dev_b"), sessionPath("s1")), { complete: true }));
  });

  it("may not rewrite which release a stored sitting was collected under", async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), sessionPath("s1")), sessionDoc("dev_a", "s1"));
    });
    await assertFails(
      updateDoc(doc(device("dev_a"), sessionPath("s1")), { releaseHash: "sha256:different" }),
    );
  });

  it("may file a quarantine record when its write was refused", async () => {
    const db = device("dev_b");
    await assertSucceeds(
      addDoc(collection(db, `studies/${STUDY}/quarantine`), {
        sessionId: "s1",
        deviceId: "dev_b",
        reason: "session already exists under another device",
        payload: sessionDoc("dev_b", "s1"),
      }),
    );
  });

  it("may not delete anything", async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), sessionPath("s1")), sessionDoc("dev_a", "s1"));
    });
    await assertFails(deleteDoc(doc(device("dev_a"), sessionPath("s1"))));
  });
});

describe("people", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), sessionPath("s1")), sessionDoc("dev_a", "s1"));
    });
  });

  it("read the study when they have any role", async () => {
    for (const role of ["owner", "researcher", "analyst"]) {
      await assertSucceeds(getDoc(doc(person(`u_${role}`, role), sessionPath("s1"))));
    }
  });

  it("get nothing without a role", async () => {
    // Authenticated but not authorised: an account exists and has been given
    // no role, which must not be the same as being an analyst.
    await assertFails(getDoc(doc(person("u_new", ""), sessionPath("s1"))));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), sessionPath("s1"))));
  });

  it("may flag a sitting quarantined but never edit the log", async () => {
    const db = person("u_r", "researcher");
    await assertSucceeds(updateDoc(doc(db, sessionPath("s1")), { quarantined: true }));
    // The raw record is not something a person edits, ever.
    await assertFails(updateDoc(doc(db, sessionPath("s1")), { events: [] }));
    await assertFails(updateDoc(doc(db, sessionPath("s1")), { complete: false }));
  });

  it("stops an analyst changing anything", async () => {
    const db = person("u_a", "analyst");
    await assertFails(updateDoc(doc(db, sessionPath("s1")), { quarantined: true }));
    await assertFails(
      addDoc(collection(db, `studies/${STUDY}/corrections`), {
        wrongCode: "JE101CD",
        rightCode: "JA101CD",
        reason: "same pupil",
      }),
    );
  });

  it("nobody deletes a sitting", async () => {
    for (const role of ["owner", "researcher", "analyst"]) {
      await assertFails(deleteDoc(doc(person(`u_${role}`, role), sessionPath("s1"))));
    }
  });
});

describe("corrections and twin splits", () => {
  it("a researcher may record one, and may not point a code at itself", async () => {
    const db = person("u_r", "researcher");
    const corrections = collection(db, `studies/${STUDY}/corrections`);
    await assertSucceeds(
      addDoc(corrections, { wrongCode: "JE101CD", rightCode: "JA101CD", reason: "same pupil" }),
    );
    await assertFails(
      addDoc(corrections, { wrongCode: "JA101CD", rightCode: "JA101CD", reason: "nonsense" }),
    );
  });

  it("a correction is withdrawn, never edited", async () => {
    let id = "";
    await env.withSecurityRulesDisabled(async (admin) => {
      const ref = await addDoc(collection(admin.firestore(), `studies/${STUDY}/corrections`), {
        wrongCode: "JE101CD",
        rightCode: "JA101CD",
        reason: "same pupil",
        withdrawnAt: null,
      });
      id = ref.id;
    });
    const db = person("u_r", "researcher");
    await assertSucceeds(
      updateDoc(doc(db, `studies/${STUDY}/corrections/${id}`), { withdrawnAt: "2026-09-02T00:00:00.000Z" }),
    );
    // Rewriting who a sitting belongs to, in place and without trace, is
    // exactly what must not be possible.
    await assertFails(updateDoc(doc(db, `studies/${STUDY}/corrections/${id}`), { rightCode: "ZZ999ZZ" }));
  });

  it("a twin split is a researcher action", async () => {
    await assertSucceeds(
      setDoc(doc(person("u_r", "researcher"), `studies/${STUDY}/assignments/s2`), {
        participantCode: "JA101CD-2",
        reason: "twins share a code",
      }),
    );
    await assertFails(
      setDoc(doc(person("u_a", "analyst"), `studies/${STUDY}/assignments/s3`), {
        participantCode: "JA101CD-2",
        reason: "twins share a code",
      }),
    );
  });
});

describe("devices and audit", () => {
  it("no browser can enrol a device, whatever role it holds", async () => {
    // Enrolment happens in a Cloud Function with the admin SDK. Nothing a
    // signed-in owner can do from a console creates one.
    for (const role of ["owner", "researcher"]) {
      await assertFails(
        setDoc(doc(person(`u_${role}`, role), `studies/${STUDY}/devices/dev_x`), { label: "sneaky" }),
      );
    }
  });

  it("only an owner reads the device list", async () => {
    await env.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), `studies/${STUDY}/devices/dev_a`), { label: "iPad 1" });
    });
    await assertSucceeds(getDoc(doc(person("u_o", "owner"), `studies/${STUDY}/devices/dev_a`)));
    await assertFails(getDoc(doc(person("u_r", "researcher"), `studies/${STUDY}/devices/dev_a`)));
  });

  it("audit entries are appended by anyone signed in and edited by no one", async () => {
    let id = "";
    await env.withSecurityRulesDisabled(async (admin) => {
      const ref = await addDoc(collection(admin.firestore(), `studies/${STUDY}/audit`), { action: "sync.batch" });
      id = ref.id;
    });
    await assertSucceeds(
      addDoc(collection(person("u_r", "researcher"), `studies/${STUDY}/audit`), { action: "export" }),
    );
    // Not even by the person who wrote it: an audit log somebody can tidy up
    // afterwards is not an audit log.
    await assertFails(updateDoc(doc(person("u_o", "owner"), `studies/${STUDY}/audit/${id}`), { action: "nothing" }));
    await assertFails(deleteDoc(doc(person("u_o", "owner"), `studies/${STUDY}/audit/${id}`)));
    await assertFails(getDoc(doc(person("u_r", "researcher"), `studies/${STUDY}/audit/${id}`)));
  });
});

describe("everything else", () => {
  it("is closed", async () => {
    const db = person("u_o", "owner");
    await assertFails(getDoc(doc(db, "somethingElse/x")));
    await assertFails(setDoc(doc(db, "somethingElse/x"), { a: 1 }));
    await assertFails(setDoc(doc(db, `studies/${STUDY}/notAThing/x`), { a: 1 }));
  });
});
