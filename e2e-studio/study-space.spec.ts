import { expect, test, type Page } from "@playwright/test";
import { paths } from "@myself/firebase";
import { grantOwner, openStudy, sittingsIn, stored, type Study } from "./support/study.js";

/**
 * A study space, end to end (D-56, docs/16 §11):
 *
 *   an owner creates a study space → creates a survey in it → publishes it →
 *   copies its participant link → an iPad opens the link → it runs that survey
 *   and its sitting is filed in that study, not in ybm → the owner closes the
 *   study → the iPad starts no new sitting in it.
 *
 * Nothing is mocked between the browser and the database: the Studio calls
 * the real callables on the Functions emulator, the iPad reads the registry,
 * the pointer and the release over the Firestore REST API and uploads through
 * the real `saveSitting`.
 */

const OWNER = "study.owner@leeds.test";
const STUDY = "future";
const SURVEY = "future_main";
const TITLE = "Perspectives of the future";
const CODE = "FUT0001";

let study: Study;

test.beforeAll(() => {
  study = openStudy();
});

test.afterAll(async () => {
  await study?.close();
});

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("researcher/#/surveys");
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
  await page.waitForFunction(() => typeof (window as unknown as { __studioTestSignIn?: unknown }).__studioTestSignIn === "function");
  await page.evaluate((e) => (window as unknown as { __studioTestSignIn: (e: string) => Promise<void> }).__studioTestSignIn(e), email);
}

test("an owner creates a study space, publishes a survey in it, and its participant link files sittings there", async ({ page, browser, baseURL }) => {
  // ── An owner, signed in ───────────────────────────────────────────────────
  // On no Studio list: signed in, nothing to open yet.
  await signIn(page, OWNER);
  await expect(page.getByRole("heading", { name: "You don’t have access yet" })).toBeVisible({ timeout: 30_000 });
  // The owner claim, as grant-role.mjs gives it; a fresh sign-in carries it.
  await grantOwner(OWNER);
  // The Studio keeps its session for the tab only: cleared and reloaded, it is signed out.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await signIn(page, OWNER);
  await expect(page.getByRole("heading", { name: "Surveys" })).toBeVisible({ timeout: 30_000 });

  // ── A new study space ─────────────────────────────────────────────────────
  await page.getByRole("button", { name: /^Study space:/ }).click();
  await page.getByRole("menuitem", { name: /New study space/ }).click();
  const create = page.getByRole("dialog", { name: "New study space" });
  await create.getByLabel("Title").fill(TITLE);
  await create.getByLabel("Study ID").fill(STUDY);
  await create.getByRole("button", { name: "Create study space" }).click();
  await expect(page).toHaveURL(new RegExp(`#/study/${STUDY}/surveys$`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "No surveys in this study space yet" })).toBeVisible({ timeout: 30_000 });
  expect(await stored(study.db, paths.study(STUDY))).toMatchObject({ study: STUDY, title: TITLE, status: "open" });
  expect(await stored(study.db, paths.studioMember(STUDY, OWNER))).toMatchObject({ role: "admin" });

  // ── A survey in it, published ─────────────────────────────────────────────
  await page.getByRole("button", { name: "New survey" }).click();
  const newSurvey = page.getByRole("dialog", { name: "New survey" });
  await newSurvey.getByLabel("Title").fill("The future");
  await newSurvey.getByLabel("Survey ID").fill(SURVEY);
  await newSurvey.getByRole("button", { name: "Create survey" }).click();
  await expect(page).toHaveURL(new RegExp(`#/study/${STUDY}/surveys/${SURVEY}/edit`), { timeout: 30_000 });
  await expect(page.getByPlaceholder("Search questions by text or ID")).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const publish = page.getByRole("dialog", { name: /Publish a new version/ });
  await expect(publish).toBeVisible();
  const reviewed = publish.getByLabel("I’ve reviewed these warnings");
  if (await reviewed.count()) {
    await reviewed.check();
    await publish.getByRole("button", { name: "Continue" }).click();
  }
  await publish.getByRole("button", { name: "Continue" }).click();
  await expect(publish.getByText("1.0.0").first()).toBeVisible();
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByLabel(/Release note for/).fill("The first version of the study space's survey.");
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByRole("button", { name: /^Publish r?1\.0\.0/ }).click();
  await expect(page.getByRole("dialog", { name: "Published" }).getByText(/1\.0\.0 is live/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("dialog", { name: "Published" }).getByRole("button", { name: "Done" }).click();

  const pointer = (await stored(study.db, paths.publishedPointer(STUDY, SURVEY))) as { hash: string; version: string } | null;
  expect(pointer).toMatchObject({ version: "1.0.0" });
  // Filed in the study space, and nowhere in ybm.
  expect(await stored(study.db, paths.publishedPointer("ybm", SURVEY))).toBeNull();

  // ── Its participant link, and the QR code ─────────────────────────────────
  await page.goto(`researcher/#/study/${STUDY}/surveys/${SURVEY}/versions`);
  await page.getByRole("button", { name: "Participant link" }).click();
  const dialog = page.getByRole("dialog", { name: "Participant link" });
  const link = await dialog.getByLabel("Link").inputValue();
  expect(link).toBe(`${baseURL}?study=${STUDY}&survey=${SURVEY}`);
  await expect(dialog.getByRole("img", { name: `QR code for ${link}` })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  // ── An iPad opens it ──────────────────────────────────────────────────────
  const ipad = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const participant = await ipad.newPage();
  await participant.goto(link);
  await expect(participant.locator("p.demo-note")).toContainText(`survey ${STUDY}/${SURVEY}`, { timeout: 30_000 });
  await expect(participant.locator("p.demo-note")).toContainText("release 1.0.0 (downloaded)");

  await participant.locator("input.code").fill(CODE);
  await participant.locator("button.next.big").click();
  await expect(participant.locator(".survey")).toBeVisible();
  await expect(participant.locator(".survey h1")).toContainText("Welcome, and thank you for taking part.");

  // Filed in the study space by the real saveSitting (a checkpoint every 5 s in this build).
  await expect
    .poll(async () => (await sittingsIn(study.db, STUDY, CODE)).map((s) => s.releaseHash), { timeout: 60_000, intervals: [2_000] })
    .toEqual([pointer!.hash]);
  const [filed] = await sittingsIn(study.db, STUDY, CODE);
  expect(filed?.study).toBe(STUDY);
  expect(await stored(study.db, paths.device(STUDY, filed!.deviceId))).toMatchObject({ selfRegistered: true });
  expect(await sittingsIn(study.db, "ybm", CODE)).toEqual([]);

  // ── The owner closes the study space; the iPad starts nothing new in it ──
  await page.goto(`researcher/#/study/${STUDY}/surveys`);
  await page.getByRole("button", { name: /^Study space:/ }).click();
  await page.getByRole("menuitem", { name: /settings/ }).click();
  const settings = page.getByRole("dialog", { name: "Study space settings" });
  await settings.getByLabel(/^Closed/).check();
  await settings.getByRole("button", { name: "Close the study space" }).click();
  await expect(page.getByText("This study space is closed.").first()).toBeVisible({ timeout: 30_000 });
  expect(await stored(study.db, paths.study(STUDY))).toMatchObject({ status: "closed" });

  await participant.goto("./");
  await expect(participant.locator(".survey-notice")).toContainText("This study is closed", { timeout: 30_000 });
  await participant.locator("input.code").fill("FUT0002");
  await participant.locator("button.next.big").click();
  await expect(participant.getByRole("alert")).toContainText("This study is closed");
  await expect(participant.locator(".survey")).toHaveCount(0);

  await ipad.close();
});
