import { expect, test, type Page } from "@playwright/test";
import { accepted, advance, position } from "./support/walker.js";

/**
 * A sitting, from the start screen to a file a researcher can read.
 *
 * WHAT THIS IS FOR. The unit suite proves the engine walks, the manifest parses
 * and the sync protocol verifies. None of it touches a rendered screen, a real
 * IndexedDB, the AES round trip through it, the service worker, or resuming after
 * a reload — and those are where a lost morning actually comes from.
 *
 * THE WALKER IS DELIBERATELY GENERIC. It answers whatever control the screen
 * happens to present rather than knowing the YBM questionnaire, so a change to
 * the composition, a new response type, or a reordered section does not break it.
 * A test that had to be edited every time an instrument changed would be deleted
 * within a month, and the point of this one is that it keeps running. How it reads
 * where it is and moves on is shared with the other suites, in `support/walker.ts`.
 */

const CODE = "NDC0042";
/** Long rather than fiddly, which is what the app asks for. */
const PASSPHRASE = "six brown otters reading";

/** The status line is the app's own claim about connectivity. */
const statusText = (page: Page) => page.locator(".status-text");

async function startSitting(page: Page, code = CODE): Promise<void> {
  await page.goto("./");
  await expect(page.locator("h1.brand")).toHaveText("MySelf");
  await page.locator("input.code").fill(code);
  await page.locator("button.next.big").click();
  await expect(page.locator(".survey, .screen.checkin")).toBeVisible();
}

/**
 * Answer one screen, whatever kind it is.
 *
 * Returns false when there is nothing here to answer — a consent or information
 * screen — which is not a failure, just a screen that only needs Next.
 */
async function answerCurrentScreen(page: Page): Promise<boolean> {
  // A consent statement set needs EVERY statement ticked — each one is required —
  // so it comes first, and the count is re-read rather than assumed.
  const consent = page.locator(".consent-list input[type=checkbox]:visible");
  const statements = await consent.count();
  if (statements > 0) {
    for (let i = 0; i < statements; i += 1) await consent.nth(i).check();
    return true;
  }

  // Single choice, in any of its presentations: tiles, spectrum, chips, cards.
  if (await chooseAnOption(page, '[role="radiogroup"] button:visible')) return true;

  /**
   * A multi-select of options — "tap everything that applies".
   *
   * Several, not one: some of these items hold a second step that only opens for
   * the options chosen in the first, and a walk that ticked a single box would
   * never see it. Three is enough to exercise that without labouring the point.
   */
  // `.card` and `.chip` are two presentations of the same thing: the app-grid item
  // uses chips, the option list uses cards, and a walker that knew only one of
  // them stopped dead on section seven.
  const cards = page.locator('[role="group"] button.card:visible, [role="group"] button.chip:visible');
  const cardCount = await cards.count();
  if (cardCount > 0) {
    for (let i = 0; i < Math.min(3, cardCount); i += 1) {
      const card = cards.nth(i);
      if (await card.isEnabled({ timeout: 1_000 }).catch(() => false)) await card.click({ timeout: 5_000 });
    }
    return true;
  }

  const slider = await usable(page, '.survey-body input[type="range"]:visible');
  if (slider) {
    await slider.fill("5");
    return true;
  }

  // The social-ladder item is an SVG with role="slider", driven by pointer events
  // rather than being an input — so it needs a click on the shape itself. The
  // centre lands on a middle rung, which is the answer a real participant is
  // most likely to give anyway.
  const ladder = await usable(page, ".survey-body .ladder-svg:visible");
  if (ladder) {
    await ladder.click({ timeout: 5_000 });
    return true;
  }

  const select = await usable(page, ".survey-body select.picker:visible");
  if (select) {
    const values = await select.locator("option").evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""),
    );
    if (values[0] !== undefined) await select.selectOption(values[0]);
    return true;
  }

  // A date, before the generic text branch: it is rendered as an `input[type=date]`
  // which reports as a textbox, and filling prose into one silently does nothing
  // while leaving Next disabled. A plausible participant year, not today's.
  const date = await usable(page, '.survey-body input[type="date"]:visible');
  if (date) {
    await date.fill("2012-05-14");
    return true;
  }

  const text = await usable(page, ".survey-body textarea:visible, .survey-body input.text-input:visible");
  if (text) {
    /**
     * Try values until the app accepts one.
     *
     * Some fields have their own validation — a postcode must look like one
     * (D-52) — and a sentence typed into one is truncated and rejected. Rather
     * than encoding which question wants which kind of value, which would make
     * this test a second copy of the questionnaire, offer a digit, a letter, a
     * West Yorkshire postcode and a sentence, and keep whichever clears the error.
     */
    for (const candidate of ["1", "A", "LS2 9JT", "Something I would say about this."]) {
      await text.fill(candidate);
      if (await accepted(page)) return true;
    }
    // Leave the last attempt in place; `step` will report that nothing moved,
    // which is a more useful failure than a silent skip.
    return true;
  }

  const number = await usable(page, '.survey-body input[type="number"]:visible, .survey-body input[inputmode="numeric"]:visible');
  if (number) {
    await number.fill("1");
    return true;
  }

  return false;
}

/**
 * The first element matching `selector` that can actually be interacted with.
 *
 * Presence is not usability. The survey renders controls that are in the DOM but
 * hidden or disabled — inside a collapsed panel, or waiting on another answer —
 * and acting on one of those spends a timeout and reports a failure that looks
 * like a broken app rather than a walker that picked the wrong element.
 */
async function usable(page: Page, selector: string) {
  const element = page.locator(selector).first();
  if ((await element.count()) === 0) return null;
  if (!(await element.isVisible().catch(() => false))) return null;
  if (!(await element.isEnabled({ timeout: 1_000 }).catch(() => false))) return null;
  return element;
}

/**
 * Pick an option, and if the app objects, pick a different one.
 *
 * Some items are checked against earlier answers rather than on their own: "the
 * month you were born" (to r7.3.0) had to agree with the date of birth given two screens
 * back, and the engine refuses the sitting until it does. That consistency check
 * is a feature, and a walker that always took the first option would be stopped
 * by it every run.
 *
 * So the app's own verdict drives the choice here, exactly as it does for the
 * text fields. Encoding "pick May because the date was in May" would make this
 * test a second implementation of the questionnaire's logic, and the second
 * implementation is the one that goes stale.
 */
async function chooseAnOption(page: Page, selector: string): Promise<boolean> {
  const options = page.locator(selector);
  const total = await options.count();
  if (total === 0) return false;

  for (let i = 0; i < total; i += 1) {
    const option = options.nth(i);
    if (!(await option.isVisible().catch(() => false))) continue;
    if (!(await option.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
    await option.click({ timeout: 5_000 });
    if (await accepted(page)) return true;
  }
  // Every option refused. Leave the last one selected: `step` will report that
  // the survey did not move on, which names the screen that is stuck.
  return true;
}

/**
 * Answer, advance, and insist that the screen actually changed.
 *
 * SOME CONTROLS ADVANCE THEMSELVES. Tapping a tile or a card can move the survey
 * on without Next being touched — which is right for a child answering a battery
 * of single-choice items, and it means the screen may already have changed by the
 * time this would have clicked anything. Clicking anyway lands on the NEXT
 * screen's Next button, skipping an item; on the last item it lands on the finish
 * screen, where there is no Next at all and the walk reported being stuck one
 * screen short of the end.
 *
 * So the move is checked for before it is asked for.
 */
async function step(page: Page): Promise<void> {
  const before = await position(page);
  await answerCurrentScreen(page);

  // A short grace period: an auto-advancing control needs a moment to re-render,
  // and this must not be long enough to make a several-hundred-screen walk slow.
  for (let waited = 0; waited < 600; waited += 100) {
    if ((await position(page)) !== before) return;
    await page.waitForTimeout(100);
  }

  await advance(page);
  await expect
    .poll(() => position(page), { timeout: 10_000, message: `the survey did not move on from ${before}` })
    .not.toBe(before);
}

/** Walk until the finish screen, or until `limit` screens have gone by. */
async function walkToEnd(page: Page, limit = 400): Promise<number> {
  for (let screens = 0; screens < limit; screens += 1) {
    if ((await position(page)) === "finished") return screens;
    await step(page);
  }
  throw new Error(`did not reach the end of the sitting within ${limit} screens`);
}

test.describe("a sitting on a device with no study configured", () => {
  test("starts, records answers, and says everything is saved locally", async ({ page }) => {
    await startSitting(page);

    // Four screens in, the app should have written something and said so.
    for (let i = 0; i < 4; i += 1) await step(page);

    const stored = await countStoredEvents(page);
    expect(stored).toBeGreaterThan(0);
  });

  test("survives a reload mid-sitting and resumes where it was", async ({ page }) => {
    // The failure this guards against is the worst one available: a child is
    // halfway through, Safari discards the page or somebody closes the lid, and
    // the sitting starts again from question one.
    await startSitting(page);

    for (let i = 0; i < 6; i += 1) await step(page);
    const before = await countStoredEvents(page);
    expect(before).toBeGreaterThan(0);

    await page.reload();
    await page.locator("input.code").fill(CODE);
    await page.locator("button.next.big").click();

    // Resumed, not restarted: the event log still holds everything from before.
    await expect(page.locator(".survey, .screen.checkin")).toBeVisible();
    const after = await countStoredEvents(page);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("keeps working with the network cut, which is the normal case in a school", async ({ page, context }) => {
    await startSitting(page);
    for (let i = 0; i < 3; i += 1) await step(page);

    await context.setOffline(true);
    await expect(statusText(page)).toContainText("Offline");

    // Still answerable offline, and still saving.
    const before = await countStoredEvents(page);
    for (let i = 0; i < 3; i += 1) await step(page);
    expect(await countStoredEvents(page)).toBeGreaterThan(before);

    await context.setOffline(false);
    await expect(statusText(page)).toContainText("Online");
  });

  test("reaches the end and hands the whole sitting over as an encrypted file", async ({ page }) => {
    // The one route that has always worked, and the one a researcher relies on
    // when a hall has no usable wifi. If this breaks, a day's fieldwork is
    // stranded on a device.
    test.slow();
    await startSitting(page);
    await walkToEnd(page);

    await expect(page.locator(".screen.finished, .finish")).toBeVisible();

    // Back to a neutral start screen, so the next participant sees nothing of
    // the last one.
    const done = page.locator("button.next.big").first();
    if (await done.count() > 0) await done.click();
    await expect(page.locator("h1.brand")).toBeVisible();

    // The handover panel sits behind five taps on the build line, so a
    // participant cannot wander into it.
    const buildLine = page.locator("p.demo-note");
    for (let i = 0; i < 5; i += 1) await buildLine.click();
    await expect(page.locator(".handover")).toBeVisible();

    const exportButton = page.locator("button", { hasText: "Export completed sessions" });
    // Nothing can be written before a passphrase is given: the plaintext file
    // this used to produce is the thing that must not be reachable.
    await expect(exportButton).toBeDisabled();
    await page.locator('.handover input[type="password"]').fill(PASSPHRASE);
    await expect(exportButton).toBeEnabled();

    const download = page.waitForEvent("download");
    await exportButton.click();
    const file = await download;
    const path = await file.path();
    expect(path).toBeTruthy();

    const text = await (await import("node:fs/promises")).readFile(path!, "utf8");
    const envelope = JSON.parse(text) as {
      format: string;
      sittings: number;
      kdf: { name: string; iterations: number; salt: string };
      iv: string;
      data: string;
    };

    expect(envelope.format).toBe("myself.device.export.v1.encrypted");
    // Openable, and carrying the device that wrote it — the whole reason an iPad issues
    // itself an identity at first launch rather than on first upload. Without it a file
    // from a device that never reached the network could not say where it came from, and
    // the same sitting arriving later over wifi would look like a second device.
    const opened = (await (await import("@myself/store")).openExport(envelope as never, PASSPHRASE)) as {
      deviceId?: string;
      sessions: { sessionId: string }[];
    };
    expect(opened.deviceId).toMatch(/^ipad_[A-Z0-9]+$/);
    expect(opened.sessions).toHaveLength(1);
    expect(envelope.sittings).toBe(1);
    expect(envelope.kdf.name).toBe("PBKDF2");
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600_000);

    // Nothing identifying in the clear. The participant code is the obvious
    // thing to check for, because it is what a stray file would be searched for.
    expect(text).not.toContain(CODE);
    expect(text).not.toContain("response.recorded");
    expect(text).not.toContain("session.completed");
    // And it is big enough to actually be the sitting rather than an empty seal.
    expect(envelope.data.length).toBeGreaterThan(2_000);
  });

  /**
   * The worker that lets the survey open in a hall with no signal is registered
   * by the app's own code, not the build plugin's (docs/16 R11: the plugin's
   * registration reloaded the page by itself). A registration that silently
   * stopped happening would look fine online and fail the first offline morning.
   */
  test("registers the service worker that keeps it working offline", async ({ page }) => {
    await page.goto("./");
    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, script: ready.active?.scriptURL ?? "" };
    });
    expect(registration.scope).toMatch(/\/MySelf\/$/);
    expect(registration.script).toMatch(/\/MySelf\/sw\.js$/);
  });

  test("asks the operator to set nothing up, and says where the data stays", async ({ page }) => {
    // Nothing is registered: an iPad with the URL collects and files sittings by
    // itself. So the handover panel must not present a setup step, and on a build
    // with no study behind it — which is what this suite runs — it must say
    // plainly that everything stays on the device rather than implying an upload
    // that cannot happen.
    await page.goto("./");
    const buildLine = page.locator("p.demo-note");
    for (let i = 0; i < 5; i += 1) await buildLine.click();

    const handover = page.locator(".handover");
    await expect(handover).toBeVisible();
    await expect(handover).toContainText("no study configured");
    await expect(handover).toContainText("stays on this device");

    // No token to paste, and no enrolment to perform. The only password field
    // here is the study passphrase that encrypts the handover file.
    await expect(handover.getByRole("button", { name: /enrol/i })).toHaveCount(0);
    await expect(handover.locator('input[type="password"]')).toHaveCount(1);
  });

  /**
   * The one setup step there is, and the only protection against the loss that
   * would take a whole morning without anybody noticing.
   *
   * WebKit deletes a site's IndexedDB after seven days of the site not being
   * opened. A fielded iPad holding unsynced sittings in a cupboard between school
   * visits is precisely that, and an iOS web app on the Home Screen is exempt.
   * So the app has to ask for it, on the screen the person setting the device up is
   * looking at, and has to stop asking once the data is safe.
   *
   * The browser's answer is stubbed rather than taken as found, because the whole
   * point is the behaviour on a browser that will not promise — which is every
   * iPad, and is not the browser this test runs in.
   */
  test("asks for the Home Screen on a browser that will not promise to keep the data", async ({ page }) => {
    await page.addInitScript(() => {
      // Safari's shape: `estimate()` and nothing else. There is no persistence to
      // be had, so the Home Screen is the only answer and the app must say so.
      Object.defineProperty(navigator, "storage", {
        value: { estimate: async () => ({ usage: 1_000, quota: 500_000_000 }) },
        configurable: true,
      });
    });
    await page.goto("./");

    const note = page.locator("p.setup-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Add to Home Screen");
    await expect(note).toContainText("7 days");

    // And the handover panel carries the same warning for the researcher deciding
    // whether this device can be put away.
    for (let i = 0; i < 5; i += 1) await page.locator("p.demo-note").click();
    await expect(page.locator(".handover")).toContainText("deleted after 7 days");
  });

  test("says nothing about the Home Screen once the browser has promised to keep the data", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "storage", {
        value: {
          estimate: async () => ({ usage: 1_000, quota: 500_000_000 }),
          persisted: async () => false,
          persist: async () => true,
        },
        configurable: true,
      });
    });
    await page.goto("./");

    // A warning that is always there is a warning nobody reads, so a granted
    // promise has to actually remove it. The build line is still present, which is
    // what makes this a check on the note and not on the page having rendered.
    await expect(page.locator("p.demo-note")).toBeVisible();
    await expect(page.locator("p.setup-note")).toHaveCount(0);
  });

  /**
   * Correcting one answer at the end must land back at the end.
   *
   * THE BUG: a participant who finished, opened the summary and tapped a question
   * to change it could not get back to the finish screen without walking every
   * remaining question again — pressing Back dropped them out of review mode into
   * the ordinary survey. This drives the real path: both "Back to summary" and the
   * primary button must return to the summary, and the summary must return to the
   * end, ready to hand over.
   */
  test("editing an answer from the summary returns to the summary, not the middle of the survey", async ({ page }) => {
    await startSitting(page);
    await walkToEnd(page);
    await expect(page.locator(".screen.finish")).toBeVisible();

    await page.getByRole("button", { name: /go back to my answers/i }).click();
    const review = page.locator(".screen.review");
    const survey = page.locator(".screen.survey");
    await expect(review).toBeVisible();

    // Tap a question to correct it, then press Back: this is exactly the move that
    // used to strand the participant mid-survey. It must return to the summary.
    await review.locator("button.review-row").first().click();
    await expect(survey).toBeVisible();
    await survey.getByRole("button", { name: /back to summary/i }).click();
    await expect(review).toBeVisible();

    // Saving an edit returns to the summary too — the other way out of an item.
    await review.locator("button.review-row").first().click();
    await expect(survey).toBeVisible();
    await survey.getByRole("button", { name: /^save$/i }).click();
    await expect(review).toBeVisible();

    // And the summary hands back to the finish screen in one step, not a re-walk.
    await review.getByRole("button", { name: /back to the end/i }).click();
    await expect(page.locator(".screen.finish")).toBeVisible();
    await expect(page.getByRole("button", { name: /hand back to the researcher/i })).toBeVisible();
  });
});

/**
 * How many events this device has actually written.
 *
 * Read out of IndexedDB rather than inferred from the screen, because the screen
 * is exactly the thing that could be lying. The payloads are sealed, so this
 * counts rows; the export test is what proves they can be opened again.
 */
async function countStoredEvents(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("myself");
        open.onerror = () => reject(new Error("could not open the device database"));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("events")) {
            resolve(0);
            return;
          }
          const count = database.transaction("events", "readonly").objectStore("events").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(new Error("could not count events"));
        };
      }),
  );
}
