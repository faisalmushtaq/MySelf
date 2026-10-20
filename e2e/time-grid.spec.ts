import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { openStaffPanel } from "./support/staff.js";

/**
 * The time grid on a real screen (engine 0.5.0).
 *
 * A two-question release published to a fake study, the way `live-release.spec.ts`
 * publishes one: the apps question from the social-media battery, then the
 * "Time on each app" grid that takes its rows from it. What has to hold:
 *
 *   - the grid lists exactly the apps put in "I have these apps", in the order
 *     they were ranked, and follows a change made by going back;
 *   - each row's total is read back as it is typed;
 *   - a time that cannot be one is announced and holds the screen;
 *   - what is recorded is total minutes per app, keyed by the app's code;
 *   - it fits a phone held upright without scrolling sideways.
 *
 * Every value typed here is made up.
 */

test.use({ serviceWorkers: "block" });

const SURVEY = "ybm_nd2026_standard";
const BUILT_IN = resolve("releases/ybm_nd2026_standard_r8.0.0.manifest.json");
const LABEL = "Time on each app (test)";
const STEM = "On a typical day, how much time do you usually spend on each of the following apps?";
const PASSPHRASE = "four quiet herons counting";

type Json = Record<string, any>; // Deliberately loose: the test writes a manifest as a publisher would.

/** The library's ybm_app_time module, as the publish gate freezes it. */
const appTime: Json = {
  instrument: "ybm_app_time",
  version: "1.0",
  name: "Time on each app",
  construct: "Self-reported daily time on each social-media app used",
  citationVerified: false,
  licence: { status: "open", modifiable: "yes", verified: true },
  forms: [
    {
      language: "en-GB",
      readingLevel: "standard",
      informant: "self",
      label: "Time on each app (one grid of the apps the participant has)",
      items: [
        {
          key: "minutes_per_app",
          revision: 1,
          variable: "app_minutes",
          stem: { text: STEM },
          lede: { text: "You may refer to your phone's Screen Time or Digital Wellbeing summary." },
          required: "soft",
          allowDecline: false,
          identifying: false,
          responseType: "time_grid",
          rowsFrom: { instrument: "ybm_social_media", item: "apps_owned", revision: 1, group: "have" },
        },
      ],
      presentationFidelity: "stepped_allowed",
    },
  ],
  timeEstimates: [{ ageBand: "14-16", medianSeconds: 75, provenance: "estimated-heuristic" }],
  changelog: "1.0: new module.",
  approvalStatus: "draft",
  owner: "ybm",
  kind: "module",
  study: "ybm",
};

async function gridRelease(): Promise<{ hash: string; json: string }> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(BUILT_IN, "utf8")) as Json;
  body["release"]["version"] = "8.3.0";
  body["release"]["key"] = "ybm_nd2026_standard_r8_3_0";
  body["release"]["engineVersion"] = "0.5.0";
  body["composition"]["studyLabel"] = LABEL;
  const ref = (instrument: string) => ({ instrument, version: "1.0", language: "en-GB", informant: "self", readingLevel: "standard" });
  body["composition"]["sections"] = [
    {
      key: "social_media",
      title: "Social media",
      components: [
        { kind: "module", ref: ref("ybm_social_media"), items: ["apps_owned"] },
        { kind: "module", ref: ref("ybm_app_time") },
      ],
      randomiseComponents: false,
    },
  ];
  body["instruments"]["ybm_app_time@1.0/en-GB/self/standard"] = appTime;
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }) };
}

/** The study's two public documents, as Firestore's REST API serves them (see live-release.spec.ts). */
async function publish(page: Page, release: { hash: string; json: string }): Promise<void> {
  const manifest = JSON.parse(release.json) as Json;
  const hex = release.hash.slice("sha256:".length);
  await page.route(
    (url) => url.pathname.startsWith("/__survey/"),
    (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/__survey/published/${SURVEY}`) {
        return route.fulfill({
          json: {
            name: `projects/demo/databases/(default)/documents/studies/ybm/published/${SURVEY}`,
            fields: {
              surveyId: { stringValue: SURVEY },
              hash: { stringValue: release.hash },
              version: { stringValue: manifest["release"]["version"] },
              releaseKey: { stringValue: manifest["release"]["key"] },
              engineVersion: { stringValue: manifest["release"]["engineVersion"] },
              generation: { integerValue: "3" },
              publishedAt: { timestampValue: "2026-10-20T12:00:00.000000Z" },
            },
          },
        });
      }
      if (path === `/__survey/publicReleases/${hex}`) {
        return route.fulfill({
          json: {
            name: `projects/demo/databases/(default)/documents/studies/ybm/publicReleases/${hex}`,
            fields: { hash: { stringValue: release.hash }, manifest: { stringValue: release.json } },
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: { code: 404, message: "Document not found", status: "NOT_FOUND" } } });
    },
  );
}

async function start(page: Page, code: string): Promise<void> {
  await publish(page, await gridRelease());
  await page.goto("./");
  await expect(page.locator("p.study-title")).toHaveText(LABEL, { timeout: 15_000 });
  await page.locator("input.code").fill(code);
  await page.locator("button.next.big").click();
  await expect(page.locator(".survey h1")).toHaveText(/^Which of these apps/);
}

const chip = (page: Page, name: string) => page.locator(".rank-group button.chip", { hasText: name });
const next = (page: Page) => page.locator("footer button.next");
const grid = (page: Page) => page.getByRole("table");
const rowNames = (page: Page) => grid(page).locator("tbody th[scope=row]").allTextContents();
const box = (page: Page, app: string, unit: "hours" | "minutes") => page.getByRole("textbox", { name: `${app}, ${unit}` });
const total = (page: Page, app: string) =>
  grid(page).locator("tbody tr", { has: page.locator("th", { hasText: app }) }).locator("output");

test.describe("the time grid", () => {
  test("lists only the apps the participant has, totals and checks each row, and records minutes", async ({ page }) => {
    await start(page, "TGR0001");

    // Instagram first, then TikTok and Snapchat: the order they are ranked in.
    for (const app of ["Instagram", "TikTok", "Snapchat"]) await chip(page, app).click();
    await next(page).click();

    await expect(page.locator(".survey h1")).toHaveText(STEM);
    await expect(page.locator(".lede")).toContainText("Screen Time or Digital Wellbeing");
    expect(await rowNames(page)).toEqual(["Instagram", "TikTok", "Snapchat"]);

    // Back, and Snapchat taken out of "have": the grid follows.
    await page.locator("button.back").click();
    await chip(page, "Snapchat").click();
    await next(page).click();
    expect(await rowNames(page)).toEqual(["Instagram", "TikTok"]);

    await box(page, "Instagram", "hours").fill("1");
    await box(page, "Instagram", "minutes").fill("25");
    await expect(total(page, "Instagram")).toHaveText("1 h 25 min");

    // Seventy-five minutes is not a time on a clock face: said, and the screen holds.
    await box(page, "TikTok", "minutes").fill("75");
    await expect(page.getByRole("alert")).toHaveText("TikTok: Minutes must be between 0 and 59");
    await expect(box(page, "TikTok", "minutes")).toHaveAttribute("aria-invalid", "true");
    await expect(box(page, "TikTok", "hours")).toHaveAttribute("aria-invalid", "false");
    await expect(next(page)).toBeDisabled();
    await box(page, "TikTok", "minutes").fill("45");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(total(page, "TikTok")).toHaveText("45 min");

    // Letters never get in at all.
    await box(page, "TikTok", "hours").pressSequentially("x");
    await expect(box(page, "TikTok", "hours")).toHaveValue("");

    await expect(next(page)).toBeEnabled();
    await next(page).click();
    await expect(page.locator(".screen.finish")).toBeVisible();

    // What the device recorded, read back through the researcher's export.
    await page.getByRole("button", { name: /hand back to the researcher/i }).click();
    await expect(page.locator("h1.brand")).toBeVisible();
    await openStaffPanel(page);
    await page.locator('.handover input[type="password"]').fill(PASSPHRASE);
    const download = page.waitForEvent("download");
    await page.locator("button", { hasText: "Export completed sessions" }).click();
    const text = await readFile((await (await download).path())!, "utf8");
    const opened = (await (await import("@myself/store")).openExport(JSON.parse(text), PASSPHRASE)) as {
      sessions: { events: { type: string; itemKey?: string; payload?: { value?: unknown } }[] }[];
    };
    const recorded = opened.sessions[0]!.events.filter(
      (e) => e.type.startsWith("response.") && e.itemKey === "ybm_app_time.minutes_per_app",
    );
    // Instagram is code 3 and TikTok code 4 in scale.sm_platforms.
    expect(recorded.at(-1)?.payload?.value).toEqual({ kind: "time_grid", minutes: { 3: 85, 4: 45 } });
  });

  test("is not asked when no app is in 'I have these apps'", async ({ page }) => {
    await start(page, "TGR0002");
    // Nothing chosen: skipped, and the grid has no rows, so it is passed by.
    await next(page).click();
    const skip = page.locator(".skip-confirm button.skip-go");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await expect(page.locator(".screen.finish")).toBeVisible();
  });

  test("fits a phone held upright", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await start(page, "TGR0003");
    for (const app of ["X (Twitter)", "YouTube", "Instagram"]) await chip(page, app).click();
    await next(page).click();
    await expect(grid(page)).toBeVisible();
    await box(page, "X (Twitter)", "hours").fill("10");
    await box(page, "X (Twitter)", "minutes").fill("30");
    await expect(total(page, "X (Twitter)")).toHaveText("10 h 30 min");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Every box is a usable tap target, wholly on screen.
    for (const input of await grid(page).locator("input").all()) {
      const rect = (await input.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(375);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
  });
});
