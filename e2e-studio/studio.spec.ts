import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  addMember,
  auditActions,
  livePointer,
  openStudy,
  R800_HASH,
  seedHistoricalSitting,
  sittingJson,
  sittingsFor,
  storedRelease,
  type Study,
} from "./support/study.js";

/**
 * The Studio's reason for existing, end to end (docs/16 §9):
 *
 *   sign in → edit the draft → preview → validation catches a mistake → fix it
 *   → publish → the public survey link loads the new version → a sitting taken
 *   on it is filed stamped with that version → a sitting recorded before any of
 *   this is exactly as it was.
 *
 * Nothing between the browser and the database is mocked. The Studio signs in
 * on the Auth emulator, saves its draft through the Firestore rules, publishes
 * through the real `studioPublish` running in the Functions emulator; the
 * participant app reads the published pointer and release over the Firestore
 * REST API exactly as a school iPad does, and uploads through the real
 * `saveSitting`.
 */

const ADMIN = "research.lead@brainpop.test";
const STUDY_LABEL = "Studio E2E · 2026";
const NEW_WORDING = "Do you have a smartphone of your very own?";
const CODE = "NDC0777";

let study: Study;
let historical: { id: string; before: string };

test.beforeAll(async () => {
  study = openStudy();
  await addMember(study.db, ADMIN, "admin");
  historical = await seedHistoricalSitting(study.db);
});

test.afterAll(async () => {
  await study?.close();
});

async function signIn(page: Page): Promise<void> {
  await page.goto("researcher/#/surveys");
  // Signed out, the Studio asks for Google. The emulator build also exposes a
  // test sign-in that stands in for the Google popup — and only that build does.
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.waitForFunction(() => typeof (window as unknown as { __studioTestSignIn?: unknown }).__studioTestSignIn === "function");
  await page.evaluate((email) => (window as unknown as { __studioTestSignIn: (e: string) => Promise<void> }).__studioTestSignIn(email), ADMIN);
}

async function findQuestion(page: Page, text: string): Promise<void> {
  const search = page.getByPlaceholder("Search questions by text or ID");
  await search.fill(text);
  await page.getByRole("treeitem", { name: new RegExp(text.slice(0, 20), "i") }).first().click();
  await search.fill("");
}

test("a researcher publishes a change and the public survey runs it, with history untouched", async ({ page, browser }) => {
  // ── Sign in and set up from the live survey ────────────────────────────────
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Set up from the live survey" })).toBeVisible();
  await page.getByRole("button", { name: "Set up from the live survey" }).click();
  await expect(page.getByText(/r8\.0\.0/).first()).toBeVisible({ timeout: 60_000 });
  expect((await livePointer(study.db))?.hash).toBe(R800_HASH);

  // Into the editor for the survey.
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit");
  await expect(page.getByPlaceholder("Search questions by text or ID")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("In sync with live")).toBeVisible();

  // ── An edit that validation must catch ─────────────────────────────────────
  await findQuestion(page, "Do you have your own smartphone");
  const stem = page.locator('[data-field="stem"]').first();
  await expect(stem).toHaveValue("Do you have your own smartphone?");
  await stem.fill("");
  await expect(page.getByRole("button", { name: /1 error/ })).toBeVisible({ timeout: 15_000 });

  // Publishing is refused while the error stands, and says what to fix.
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const dialog = page.getByRole("dialog", { name: /Publish a new version/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/text/i).first()).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Publish r/ })).toHaveCount(0);
  await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();

  // ── Fix it, and change what participants see first ─────────────────────────
  await stem.fill(NEW_WORDING);
  await expect(page.getByRole("button", { name: /error/ })).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole("treeitem", { name: /Start screen/ }).first().click();
  const label = page.getByLabel("Study label");
  await label.fill(STUDY_LABEL);

  // Saved to the draft through the rules (revision checked), not just held in the tab.
  await expect(page.getByText(/Saved/).first()).toBeVisible({ timeout: 30_000 });

  // ── Preview the draft, in the participant's own screens, nothing saved ─────
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/preview");
  await expect(page.getByText(/never saved or sent/i).first()).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator("iframe");
  await expect(frame.getByText(STUDY_LABEL).first()).toBeVisible({ timeout: 30_000 });

  // ── Publish ────────────────────────────────────────────────────────────────
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit");
  await expect(page.getByPlaceholder("Search questions by text or ID")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const publish = page.getByRole("dialog", { name: /Publish a new version/ });
  await expect(publish).toBeVisible();
  // The live survey carries warnings the team already knows about; they must be acknowledged, not hidden.
  const reviewed = publish.getByLabel("I’ve reviewed these warnings");
  if (await reviewed.count()) {
    await reviewed.check();
    await publish.getByRole("button", { name: "Continue" }).click();
  }
  // What changes: the reworded question and the new label, needing a MAJOR version.
  await expect(publish.getByText(new RegExp(NEW_WORDING.slice(0, 20))).first()).toBeVisible();
  await publish.getByRole("button", { name: "Continue" }).click();
  await expect(publish.getByText("9.0.0").first()).toBeVisible();
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByLabel(/Release note for/).fill("Reword the smartphone question and label the study for the end-to-end test.");
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByRole("button", { name: /^Publish r?9\.0\.0/ }).click();
  // Reported live only once the public pointer names the new release.
  // (The dialog is retitled "Published" at that point.)
  await expect(page.getByRole("dialog", { name: "Published" }).getByText(/9\.0\.0 is live/)).toBeVisible({ timeout: 60_000 });

  const pointer = await livePointer(study.db);
  expect(pointer?.version).toBe("9.0.0");
  expect(pointer?.hash).not.toBe(R800_HASH);
  const newHash = pointer!.hash;

  // ── The public survey link loads the new version ───────────────────────────
  const participantContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const participant = await participantContext.newPage();
  await participant.goto("./");
  await expect(participant.locator("p.study-title")).toHaveText(STUDY_LABEL, { timeout: 30_000 });
  await expect(participant.locator("p.demo-note")).toContainText("release 9.0.0 (downloaded)");

  // A sitting started now is stamped with it, on the device and in the study.
  await participant.locator("input.code").fill(CODE);
  await participant.locator("button.next.big").click();
  await expect(participant.locator(".survey")).toBeVisible();
  await participant.locator("button.next:not(.big)").first().click();

  await expect
    .poll(async () => (await sittingsFor(study.db, CODE)).map((s) => s.releaseHash), { timeout: 60_000, intervals: [2_000] })
    .toEqual([newHash]);
  const [filed] = await sittingsFor(study.db, CODE);
  expect(filed?.releaseKey).toBe("ybm_nd2026_standard_r9_0_0");

  // ── History is untouched ───────────────────────────────────────────────────
  expect(await sittingJson(study.db, historical.id)).toBe(historical.before);

  // And the audit trail says who did what.
  const actions = await auditActions(study.db);
  expect(actions).toEqual(expect.arrayContaining(["survey.imported", "draft.edited", "version.published"]));

  await participantContext.close();
});

/**
 * MyStory, switched on in the Studio and published (docs/16 §10). Runs after
 * the test above, on the survey it left live at 9.0.0.
 */
test("a researcher switches MyStory on, edits its protocol, publishes it, and downloads the provenance", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit");
  await expect(page.getByPlaceholder("Search questions by text or ID")).toBeVisible({ timeout: 60_000 });

  // ── Switch it on, approve the built-in protocol as a new version, use it ───
  await page.getByRole("treeitem", { name: "MyStory (off)" }).click();
  await page.locator("label", { hasText: "End the survey with MyStory" }).click();
  // On, with the built-in protocol as it ships: still a draft, so publishing is held back.
  await expect(page.getByText("The protocol isn't approved yet").first()).toBeVisible({ timeout: 15_000 });
  const file = page.getByLabel("Protocol file (TOML)");
  await file.fill((await file.inputValue()).replace('approval_status = "draft"', 'approval_status = "approved"'));
  await expect(page.getByText(/is a built-in protocol, and this differs from it/)).toBeVisible();
  await page.getByRole("button", { name: "Use version 0.1.1" }).click();
  await expect(page.getByText("np.phone_wellbeing@0.1.1 reads as a protocol and passes its checks.")).toBeVisible();
  await page.getByRole("button", { name: "Use this protocol" }).click();
  await expect(page.getByRole("button", { name: /error/ })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/Saved/).first()).toBeVisible({ timeout: 30_000 });

  // ── Publish: a MAJOR version whose summary says MyStory was added ─────────
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const publish = page.getByRole("dialog", { name: /Publish a new version/ });
  await expect(publish).toBeVisible();
  const reviewed = publish.getByLabel("I’ve reviewed these warnings");
  if (await reviewed.count()) {
    await reviewed.check();
    await publish.getByRole("button", { name: "Continue" }).click();
  }
  await expect(publish.getByText("MyStory added (np.phone_wellbeing@0.1.1).")).toBeVisible();
  await publish.getByRole("button", { name: "Continue" }).click();
  await expect(publish.getByText("10.0.0").first()).toBeVisible();
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByLabel(/Release note for/).fill("End the survey with MyStory, on the approved phones-and-wellbeing protocol.");
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByRole("button", { name: /^Publish r?10\.0\.0/ }).click();
  await expect(page.getByRole("dialog", { name: "Published" }).getByText(/10\.0\.0 is live/)).toBeVisible({ timeout: 60_000 });

  // Frozen last, with its protocol, on the engine that sends it to MyStory.
  const pointer = await livePointer(study.db);
  expect(pointer?.version).toBe("10.0.0");
  const release = (await storedRelease(study.db, pointer!.hash)) as {
    release: { engineVersion: string };
    composition: { sections: { key: string; components: { kind: string }[] }[] };
    narrativeProtocols: Record<string, { approvalStatus: string }>;
  };
  expect(release.release.engineVersion).toBe("0.4.0");
  expect(release.composition.sections.at(-1)).toMatchObject({ key: "mystory", components: [{ kind: "narrative" }] });
  expect(release.narrativeProtocols["np.phone_wellbeing@0.1.1"]?.approvalStatus).toBe("approved");

  // ── A participant build that sends MyStory its protocol takes the version ──
  const participantContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const participant = await participantContext.newPage();
  await participant.goto("./");
  await expect(participant.locator("p.demo-note")).toContainText("release 10.0.0 (downloaded)", { timeout: 30_000 });
  await participantContext.close();

  // ── The provenance, from the Versions screen ──────────────────────────────
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/versions");
  await expect(page.getByRole("table", { name: /Published versions/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Download provenance" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "As a spreadsheet (CSV)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^ybm_nd2026_standard-provenance-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  expect(lines[0]).toMatch(/^version,release_key,hash,engine_version,status,source,authors,publisher,published_at,based_on,restored_from,/);
  const ten = lines.find((l) => l.startsWith("10.0.0,"))!;
  expect(ten).toContain(",live,studio,");
  expect(ten).toContain(",on,np.phone_wellbeing@0.1.1,");
  expect(ten).toContain("MyStory added (np.phone_wellbeing@0.1.1).");
  // The live periods, then copied_from (D-57), empty: nothing in it was copied from the library.
  expect(ten).toMatch(/to now \(published\),$/);
  const nine = lines.find((l) => l.startsWith("9.0.0,"))!;
  expect(nine).toContain(",previous,studio,");
  expect(nine).toContain(",off,,");
  // r8.0.0 was live from the set-up until 9.0.0 was published.
  expect(lines.find((l) => l.startsWith("8.0.0,"))).toMatch(/ to \d{4}-[^ ]+ \(set up from the live survey\),$/);
});
