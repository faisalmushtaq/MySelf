import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDoc } from "@myself/firebase";
import type { StudyServer } from "../e2e/support/study-server.js";

/**
 * Versions published from the dashboard (D-54), from the database to the iPad.
 *
 * The documents are written to the Firestore emulator exactly as the
 * dashboard's functions write them — `studies/ybm/releases/{hash}` and
 * `studies/ybm/config/activeRelease`, with the Admin SDK — and the app, built
 * pointing at the emulator (playwright.sync.config.ts), reads them over REST
 * the way a device reads the real project. Then:
 *
 *   - it runs the active version, and says so on the start screen;
 *   - it keeps running it when the study cannot be reached;
 *   - it never runs one whose manifest does not match its hash;
 *   - a version ending with MyStory is walked to MyStory, then the finish
 *     screen, then the handover, and the sitting reaches the study filed under
 *     that version. The MyStory module is the real one, served beside the
 *     survey (playwright.sync.config.ts): it is sent the protocol the version
 *     froze and runs that, and it refuses one that fails its checks;
 *   - a new version made active while the device is open is picked up after
 *     the next handover, and not before;
 *   - a sitting started under one version is finished under it after another
 *     has gone live.
 */

type Schema = typeof import("@myself/schema");
let schema: Schema;
let study: StudyServer;
/** A real protocol, as the dashboard's editor would freeze into a version. */
let protocol: Record<string, unknown> & { key: string; version: string; name: string };

const CODE = "NDC0042";
const r9 = JSON.parse(readFileSync(resolve("releases/ybm_nd2026_standard_r9.0.0.manifest.json"), "utf8")) as Record<
  string,
  unknown
> & {
  hash: string;
  release: Record<string, unknown>;
  composition: { sections: { key: string }[]; studyLabel?: string };
  narrativeProtocols: Record<string, unknown>;
};

test.beforeAll(async () => {
  schema = await import("@myself/schema");
  // Not a dependency of the test suite, so reached through its build.
  const narrative = (await import("../packages/narrative/dist/index.js")) as {
    phoneWellbeing: Record<string, unknown> & { key: string; version: string; name: string };
  };
  protocol = JSON.parse(JSON.stringify(narrative.phoneWellbeing)) as typeof protocol;
  const { startStudyServer } = await import("../e2e/support/study-server.js");
  study = await startStudyServer();
});

test.afterAll(async () => {
  await study?.close();
});

async function clear(): Promise<void> {
  await study.db.recursiveDelete(study.db.collection("studies/ybm/releases"));
  await study.db.recursiveDelete(study.db.collection("studies/ybm/config"));
  await study.db.recursiveDelete(study.db.collection("studies/ybm/sessions"));
  await study.db.recursiveDelete(study.db.collection("studies/ybm/devices"));
}

test.beforeEach(clear);
// The other sync specs expect the bundled release, so nothing is left active.
test.afterEach(clear);

/**
 * Publish r9.0.0 again as `version`, as the dashboard's editor would: with a
 * study label a participant can see, optionally cut to its sleep questions,
 * optionally ended with MyStory, hashed, stored, and (unless told not to) made
 * active. `mystory: "failing"` freezes a protocol that fails its own checks.
 */
async function publish(
  version: string,
  options: { short?: boolean; mystory?: "sound" | "failing"; tamper?: boolean; activate?: boolean } = {},
): Promise<string> {
  const body = structuredClone(r9) as Omit<typeof r9, "hash"> & { hash?: string };
  delete body.hash;
  body.release["version"] = version;
  body.release["key"] = `ybm_nd2026_standard_r${version.replaceAll(".", "_")}`;
  body.composition.studyLabel = `Test site · version ${version}`;
  if (options.short) body.composition.sections = [body.composition.sections.find((s) => s.key === "sleep")!];
  if (options.mystory) {
    const frozen = options.mystory === "sound" ? protocol : { ...protocol, permittedIdentifiers: ["surname"] };
    body.composition.sections.push({
      key: "mystory",
      title: "MyStory",
      components: [{ kind: "narrative", protocol: protocol.key, protocolVersion: protocol.version }],
    } as never);
    body.narrativeProtocols = { [`${protocol.key}@${protocol.version}`]: frozen };
  }
  const hash = await schema.manifestContentHash(body);
  let manifestJson = JSON.stringify({ ...body, hash });
  if (options.tamper) manifestJson = manifestJson.replace("brainpop@leeds.ac.uk", "someone@example.com");
  await study.db.doc(schema.publishedPaths.release("ybm", hash)).set({
    hash,
    version,
    key: body.release["key"],
    study: "ybm",
    publishedAt: new Date().toISOString(),
    publishedBy: "owner@example.ac.uk",
    engineVersion: "0.3.0",
    manifestJson,
    source: "editor",
  });
  if (options.activate !== false) await activate(hash, version);
  return hash;
}

async function activate(hash: string, version: string): Promise<void> {
  await study.db.doc(schema.publishedPaths.activeRelease("ybm")).set({
    hash,
    version,
    key: `ybm_nd2026_standard_r${version.replaceAll(".", "_")}`,
    activatedAt: new Date().toISOString(),
    activatedBy: "owner@example.ac.uk",
  });
}

const buildLine = (page: Page) => page.locator("p.demo-note");

/**
 * The one sitting the study holds, once its finished copy has arrived. A copy
 * checkpointed while it was being answered can land first, and says less.
 */
async function finishedSitting(): Promise<SessionDoc> {
  const read = async () =>
    (await study.db.collection("studies/ybm/sessions").get()).docs.map((d) => d.data() as SessionDoc);
  await expect.poll(async () => (await read()).map((s) => s.complete), { timeout: 60_000 }).toEqual([true]);
  return (await read())[0]!;
}

async function begin(page: Page): Promise<void> {
  await page.locator("input.code").fill(CODE);
  await page.locator("button.next.big").click();
}

/** The two sleep questions of a short version, answered. */
async function answerSleep(page: Page): Promise<void> {
  await page.getByRole("radio", { name: "7, Good" }).click();
  await expect(page.locator(".survey-body h1")).toHaveText("How sleepy are you feeling right now?");
  await page.locator('[role="radiogroup"] button').first().click();
}

test("a device runs the version the study made active, and keeps it when the study cannot be reached", async ({ page }) => {
  await publish("10.0.0");
  await page.goto("./");
  await expect(page.locator(".study-title")).toHaveText("Test site · version 10.0.0");
  await expect(buildLine(page)).toContainText("release 10.0.0 (live)");

  // The study out of reach: the device opens the version it stored.
  await page.route("**/documents:batchGet", (route) => route.abort());
  await page.reload();
  await expect(page.locator(".study-title")).toHaveText("Test site · version 10.0.0");
  await expect(buildLine(page)).toContainText("release 10.0.0 (live when last checked)");
  await expect(buildLine(page)).toContainText("the study could not be asked");
});

test("a version whose manifest does not match its hash is never run", async ({ page }) => {
  await publish("11.0.0", { tamper: true });
  await page.goto("./");
  // The release built in, whichever that is, and never the one refused.
  await expect(buildLine(page)).toContainText("(built in)");
  await expect(buildLine(page)).not.toContainText("release 11.0.0");
  await expect(buildLine(page)).toContainText("was refused: its content hashes to");
  await expect(page.locator(".study-title")).toHaveCount(0);
});

test("a version ending with MyStory goes survey, MyStory, finish, handover, and is filed under that version", async ({
  page,
}) => {
  test.slow();
  const hash = await publish("10.0.0", { short: true, mystory: "sound" });
  await page.goto("./");
  await expect(buildLine(page)).toContainText("release 10.0.0 (live)");
  await begin(page);
  await answerSleep(page);

  // MyStory is last, and the module runs the protocol this version froze,
  // sent by the survey: it says so beside the protocol's name.
  await expect(page.locator(".narrative-frame iframe")).toBeVisible();
  const module = page.frameLocator(".narrative-frame iframe");
  await expect(module.locator("#protocol option:checked")).toHaveText(
    `${protocol.name} (${protocol.key}@${protocol.version}, sent by the survey)`,
  );

  // This module has no model to talk to, so it cannot begin. The survey's way
  // past it, when it is the last position, is the end of the survey.
  const way = page.locator(".narrative-after").getByRole("button", { name: "Finish without it" });
  await expect(way).toBeVisible({ timeout: 30_000 });
  await way.click();
  await expect(page.locator(".screen.finish")).toBeVisible();
  await page.getByRole("button", { name: "Hand back to the researcher" }).click();
  await expect(page.locator(".screen.start")).toBeVisible();

  // And the study has the sitting, filed under the version it was collected under.
  const sitting = await finishedSitting();
  expect(sitting.releaseHash).toBe(hash);
  expect(sitting.releaseKey).toBe("ybm_nd2026_standard_r10_0_0");
});

test("the module refuses a protocol that fails its checks, and the survey moves on at once", async ({ page }) => {
  await publish("10.0.0", { short: true, mystory: "failing" });
  await page.goto("./");
  await begin(page);
  await answerSleep(page);

  // Refused rather than run on the module's own copy, and said on both sides.
  const module = page.frameLocator(".narrative-frame iframe");
  await expect(module.locator("#bootNote")).toContainText("This conversation cannot start: the protocol it sent fails its checks");
  const note = page.locator(".narrative-after");
  await expect(note).toContainText("The conversation cannot start on this device. You can finish without it");
  await note.getByRole("button", { name: "Finish without it" }).click();
  await expect(page.locator(".screen.finish")).toBeVisible();

  // The sitting's own log says what happened at this position.
  const types = (await finishedSitting()).events.map((e) => e.type);
  expect(types).toContain("narrative_refused");
  expect(types.indexOf("narrative_refused")).toBeLessThan(types.indexOf("session.completed"));
});

test("a version made active while the device is open is taken up after the next handover, not before", async ({ page }) => {
  await publish("10.0.0", { short: true });
  await page.goto("./");
  await begin(page);
  await page.getByRole("radio", { name: "7, Good" }).click();
  await expect(page.locator(".survey-body h1")).toHaveText("How sleepy are you feeling right now?");

  // Published and made live in the middle of a sitting: nothing changes here.
  await publish("11.0.0", { short: true });
  await page.locator('[role="radiogroup"] button').first().click();
  await expect(page.locator(".screen.finish")).toBeVisible();

  // Back at the start screen, the device asks, stores it, and reloads onto it.
  await page.getByRole("button", { name: "Hand back to the researcher" }).click();
  await expect(buildLine(page)).toContainText("release 11.0.0 (live)", { timeout: 20_000 });
  await expect(page.locator(".study-title")).toHaveText("Test site · version 11.0.0");
});

test("a sitting started under one version is finished under it after another goes live", async ({ page }) => {
  const v10 = await publish("10.0.0", { short: true });
  await page.goto("./");
  await begin(page);
  await page.getByRole("radio", { name: "7, Good" }).click();
  await expect(page.locator(".survey-body h1")).toHaveText("How sleepy are you feeling right now?");

  // A new version goes live, and the iPad is reloaded mid-sitting.
  await publish("11.0.0", { short: true });
  await page.reload();
  await expect(buildLine(page)).toContainText("release 11.0.0 (live)");

  // The same code: the device reopens under 10.0.0 and carries on where it was.
  await begin(page);
  await expect(page.locator(".survey-body h1")).toHaveText("How sleepy are you feeling right now?", { timeout: 20_000 });
  await page.locator('[role="radiogroup"] button').first().click();
  await expect(page.locator(".screen.finish")).toBeVisible();

  // One sitting, under the version it began with.
  expect((await finishedSitting()).releaseHash).toBe(v10);

  // Then, handed back, the device returns to the live version.
  await page.getByRole("button", { name: "Hand back to the researcher" }).click();
  await expect(buildLine(page)).toContainText("release 11.0.0 (live)", { timeout: 20_000 });
});
