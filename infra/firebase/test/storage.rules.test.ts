import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { getMetadata, ref, uploadString } from "firebase/storage";

/**
 * The Storage rules, from both sides, against the Storage emulator: who reads
 * the nightly export, and that a recording of a child's voice is read by
 * nobody through a browser at all.
 */

let env: RulesTestEnvironment;

const EXPORT = "exports/2026-10-17/participants.tsv";
const STUDY_EXPORT = "exports/studies/future/2026-10-17/participants.tsv";
const VOICE = "studies/ybm/voice/ses_1/clip.mp4";

const person = (uid: string, role: string) => env.authenticatedContext(uid, { role }).storage();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-myself",
    storage: {
      rules: readFileSync(fileURLToPath(new URL("../storage.rules", import.meta.url)), "utf8"),
      host: "127.0.0.1",
      port: 9199,
    },
  });
  await env.withSecurityRulesDisabled(async (admin) => {
    for (const path of [EXPORT, STUDY_EXPORT, VOICE]) await uploadString(ref(admin.storage(), path), "x");
  });
});

afterAll(async () => env?.cleanup());

describe("the export", () => {
  it("is read by an owner, and by nobody else", async () => {
    // Pseudonymised, but it carries every narrative log and free-text answer,
    // and there is no separate de-identified export to give anyone else.
    for (const path of [EXPORT, STUDY_EXPORT]) {
      await assertSucceeds(getMetadata(ref(person("u_owner", "owner"), path)));
      for (const role of ["researcher", "analyst", ""]) await assertFails(getMetadata(ref(person(`u_${role}`, role), path)));
      await assertFails(getMetadata(ref(env.authenticatedContext("dev_a", { device: true, role: "owner" }).storage(), path)));
      await assertFails(getMetadata(ref(env.unauthenticatedContext().storage(), path)));
    }
  });

  it("is written by no browser, an owner included", async () => {
    await assertFails(uploadString(ref(person("u_owner", "owner"), "exports/forged.tsv"), "x"));
  });
});

describe("spoken answers", () => {
  it("are read and written by nobody through a browser", async () => {
    for (const role of ["owner", "researcher", "analyst"]) {
      await assertFails(getMetadata(ref(person(`u_${role}`, role), VOICE)));
      await assertFails(uploadString(ref(person(`u_${role}`, role), VOICE), "y"));
    }
  });
});
