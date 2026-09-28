import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addMember, openStudy, type Study } from "../support/study.js";

/**
 * Every Studio screen, photographed — the visual record a redesign is checked
 * against (not a test of behaviour; `studio.spec.ts` is that).
 *
 * Run with `pnpm test:studio:shots`. Pictures land in STUDIO_SHOTS_DIR
 * (default test-results/studio-shots), named in the order a researcher meets
 * the screens, at desktop width and, for a few, phone width.
 */

const ADMIN = "research.lead@brainpop.test";
const STRANGER = "someone.else@example.org";
const OUT = resolve(process.env["STUDIO_SHOTS_DIR"] ?? "test-results/studio-shots");
mkdirSync(OUT, { recursive: true });

let study: Study;
test.beforeAll(async () => {
  study = openStudy();
  await addMember(study.db, ADMIN, "admin");
});
test.afterAll(async () => study?.close());

/** Dismiss every toast still showing (they last 6 s, and the Studio's own navigation keeps them). */
async function clearToasts(page: Page): Promise<void> {
  for (const button of await page.locator(".st-toasts").getByRole("button", { name: "Dismiss" }).all()) {
    await button.click().catch(() => undefined);
  }
}

/**
 * One picture. Toasts left over from an earlier step are dismissed (unless the
 * picture is of one) — but never while a dialog is open, where a click outside
 * it is not ours to make — and the pointer is parked in the corner, so no row
 * or button shows the hover state of the last click.
 */
async function shot(page: Page, name: string, { keepToasts = false }: { keepToasts?: boolean } = {}): Promise<void> {
  if (!keepToasts && (await page.locator(".st-overlay").count()) === 0) await clearToasts(page);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400); // let transitions settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

async function signInAs(page: Page, email: string): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { __studioTestSignIn?: unknown }).__studioTestSignIn === "function");
  await page.evaluate((e) => (window as unknown as { __studioTestSignIn: (x: string) => Promise<void> }).__studioTestSignIn(e), email);
}

test("photograph every Studio screen", async ({ page, browser }) => {
  // Signed out, then not on the list.
  await page.goto("researcher/#/surveys");
  await expect(page.getByRole("button", { name: /Sign in with Google/ })).toBeVisible();
  await shot(page, "01-sign-in");

  const strangerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const stranger = await strangerContext.newPage();
  await stranger.goto("researcher/#/surveys");
  await signInAs(stranger, STRANGER);
  await expect(stranger.getByText(STRANGER).first()).toBeVisible();
  await shot(stranger, "02-not-authorised");
  await strangerContext.close();

  // An admin, before and after setting up.
  await signInAs(page, ADMIN);
  await expect(page.getByRole("button", { name: /Set up from the live survey/ })).toBeVisible();
  await shot(page, "03-surveys-empty");
  await page.getByRole("button", { name: /Set up from the live survey/ }).click();
  // Setting up opens the new draft in the editor; the list is one step back.
  const search = page.getByPlaceholder(/Search/);
  await expect(search).toBeVisible({ timeout: 60_000 });
  await page.goto("researcher/#/surveys");
  await expect(page.getByRole("table", { name: "Surveys" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/r7\.1\.0/).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "04-surveys");

  // The editor, once the live version it started from is known.
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit");
  await expect(search).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^r7\.1\.0 · /).first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "05-editor-overview");

  await search.fill("smartphone");
  await page.getByRole("treeitem", { name: /Do you have your own smartphone/i }).first().click();
  await search.fill("");
  await search.blur();
  await shot(page, "06-editor-choice-question");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=ybm_gaming.top_games");
  await page.waitForTimeout(800);
  await shot(page, "07-editor-text-question");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=sdq25_s.q1");
  await page.waitForTimeout(800);
  await shot(page, "08-editor-licensed-question");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=ybm_smartphone.age_smartphone");
  await page.waitForTimeout(800);
  await shot(page, "09-editor-conditional-question");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=welcome");
  await page.waitForTimeout(800);
  await shot(page, "10-editor-start-screen");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=completion");
  await page.waitForTimeout(800);
  await shot(page, "11-editor-completion");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=section:sleep");
  await page.waitForTimeout(800);
  await shot(page, "12-editor-section");

  // A mistake, and the checks panel.
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=ybm_smartphone.own");
  const stem = page.locator('[data-field="stem"]').first();
  await expect(stem).toBeVisible();
  await stem.fill("");
  await expect(page.getByRole("button", { name: /1 error/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, "13-editor-with-error");
  await page.getByRole("button", { name: /1 error/ }).click();
  // The toolbar settles on whether the draft differs from live, not "Comparing…".
  await expect(page.getByText(/In sync with live|Draft differs from live/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "14-checks-panel");
  await page.keyboard.press("Escape");
  await stem.fill("Do you have a smartphone of your very own?");
  await expect(page.getByRole("button", { name: /error/ })).toHaveCount(0, { timeout: 15_000 });

  // Adding a question.
  await page.getByRole("button", { name: /^Add question/ }).first().click();
  await page.waitForTimeout(400);
  await shot(page, "15-type-picker");
  await page.keyboard.press("Escape");

  // Publishing.
  await expect(page.getByText(/Saved/).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  const publish = page.getByRole("dialog");
  await expect(publish).toBeVisible();
  await shot(page, "16-publish-checks");
  const reviewed = publish.getByLabel(/reviewed these warnings/);
  if (await reviewed.count()) {
    await reviewed.check();
    await publish.getByRole("button", { name: "Continue" }).click();
  }
  await shot(page, "17-publish-changes");
  await publish.getByRole("button", { name: "Continue" }).click();
  await shot(page, "18-publish-version");
  await publish.getByRole("button", { name: "Continue" }).click();
  await publish.getByLabel(/Release note/).fill("Reword the smartphone question.");
  await shot(page, "19-publish-note");
  await publish.getByRole("button", { name: "Continue" }).click();
  await shot(page, "20-publish-confirm");
  await publish.getByRole("button", { name: /^Publish r?8/ }).click();
  await expect(page.getByText(/8\.0\.0 is live/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/In sync with live|Draft differs from live/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "21-published", { keepToasts: true });
  await page.keyboard.press("Escape");

  // Preview, versions, settings, access.
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/preview");
  await page.waitForTimeout(3000);
  await shot(page, "22-preview");

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/versions");
  await expect(page.getByText(/8\.0\.0/).first()).toBeVisible({ timeout: 30_000 });
  // The sittings column fills in once the count comes back (a cold function, the first time).
  await expect(page.getByRole("status", { name: "Counting sittings" })).toHaveCount(0, { timeout: 60_000 });
  await shot(page, "23-versions");
  // r7.1.0 against the draft: the draft is r8.0.0 now, so comparing that would show nothing.
  const compare = page.getByRole("button", { name: /^Compare .* with the draft$/ }).nth(1);
  if (await compare.count()) {
    await compare.click();
    await page.waitForTimeout(800);
    await shot(page, "24-versions-compare");
  }

  await page.goto("researcher/#/surveys/ybm_nd2026_standard/settings");
  await page.waitForTimeout(1500);
  await shot(page, "25-settings");

  await page.goto("researcher/#/access");
  await page.waitForTimeout(1500);
  await shot(page, "26-access");

  // Phone width, for the two screens most likely to be opened on one.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("researcher/#/surveys");
  await page.waitForTimeout(1000);
  await shot(page, "27-phone-surveys");
  await page.goto("researcher/#/surveys/ybm_nd2026_standard/edit?q=ybm_smartphone.own");
  await page.waitForTimeout(1500);
  await shot(page, "28-phone-editor");
});
