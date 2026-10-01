import { expect, test, type Page } from "@playwright/test";
import type { ChunkDoc, SessionDoc } from "@myself/firebase";
import type { StudyServer } from "../e2e/support/study-server.js";
import { accepted, position } from "../e2e/support/walker.js";

/**
 * Loaded dynamically, because Playwright compiles these specs as CommonJS and every
 * workspace package here is ESM-only. A static import resolves at parse time and fails
 * with "does not provide an export named", which reads like a missing export rather
 * than a module-system mismatch.
 */
type FirebaseLayout = typeof import("@myself/firebase");
let layout: FirebaseLayout;

/**
 * A sitting, from a child's finger to a row in the database.
 *
 * THIS IS THE TEST THE OTHERS LEAD UP TO. The contract suite proves the shapes agree.
 * The integration suite proves the write path keeps two devices apart. The browser
 * suite proves the app collects and resumes and hands over as a file. Each stops at a
 * seam, and the seam a study actually depends on is the one none of them crossed: a
 * real app, in a real browser, putting a real request on a socket in front of the real
 * handler, and the sitting being in Firestore afterwards with the right answers in it.
 *
 * Everything on the server side here is the deployed code — `registerDevice`,
 * `sittingUpload`, `deviceIdFor`, `storeSitting`, the origin rule — with only the Cloud
 * Functions wrapper replaced, because that cannot run outside Google's runtime.
 */

let study: StudyServer;

test.beforeAll(async () => {
  layout = await import("@myself/firebase");
  const { startStudyServer } = await import("../e2e/support/study-server.js");
  study = await startStudyServer();
});

test.afterAll(async () => {
  await study?.close();
});

test.beforeEach(async () => {
  await study.db.recursiveDelete(study.db.collection("studies/ybm/sessions"));
  await study.db.recursiveDelete(study.db.collection("studies/ybm/devices"));
  study.requests.length = 0;
});

const CODE = "NDC0042";

/** Answer whatever the screen shows; the survey suite covers the walking itself. */
async function answer(page: Page): Promise<void> {
  const consent = page.locator(".consent-list input[type=checkbox]:visible");
  const statements = await consent.count();
  if (statements > 0) {
    for (let i = 0; i < statements; i += 1) await consent.nth(i).check();
    return;
  }
  const group = page.locator('[role="radiogroup"]:visible').first();
  if ((await group.count()) > 0) {
    const options = group.locator("button:visible");
    const total = await options.count();
    for (let i = 0; i < total; i += 1) {
      const option = options.nth(i);
      if (!(await option.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
      await option.click({ timeout: 5_000 });
      if (await accepted(page)) return;
    }
    return;
  }
  const cards = page.locator('[role="group"] button.card:visible, [role="group"] button.chip:visible');
  if ((await cards.count()) > 0) {
    for (let i = 0; i < Math.min(3, await cards.count()); i += 1) await cards.nth(i).click({ timeout: 5_000 });
    return;
  }
  for (const [selector, value] of [
    [".survey-body .ladder-svg:visible", null],
    ['.survey-body input[type="range"]:visible', "5"],
    ['.survey-body input[type="date"]:visible', "2012-05-14"],
  ] as const) {
    const element = page.locator(selector).first();
    if ((await element.count()) === 0 || !(await element.isVisible())) continue;
    if (value === null) await element.click({ timeout: 5_000 });
    else await element.fill(value);
    return;
  }
  const select = page.locator(".survey-body select.picker:visible").first();
  if ((await select.count()) > 0) {
    const values = await select
      .locator("option")
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ""));
    if (values[0] !== undefined) await select.selectOption(values[0]);
    return;
  }
  const text = page.locator(".survey-body textarea:visible, .survey-body input.text-input:visible").first();
  if ((await text.count()) > 0) {
    // A postcode for the address screen (D-52), which rejects the others.
    for (const candidate of ["1", "A", "LS2 9JT", "Something I would say about this."]) {
      await text.fill(candidate);
      if (await accepted(page)) return;
    }
  }
}

async function walk(page: Page, screens = 400): Promise<void> {
  for (let i = 0; i < screens; i += 1) {
    const at = await position(page);
    if (at === "finished") return;
    expect(at, "the survey stopped because the device could not save").not.toBe("save-failed");
    await answer(page);
    let moved = false;
    for (let waited = 0; waited < 600; waited += 100) {
      if ((await position(page)) !== at) {
        moved = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    if (moved) continue;
    // Not the shared `advance`: this list is shorter, and a miss falls through to
    // the poll below instead of throwing. Left as it was when the walker was shared
    // (as is `answerSome`'s); bring them into line on purpose, not in passing.
    for (const selector of [
      ".screen.checkin button.next.big",
      "button.next:not(.big)",
      "button.skip-go",
      "button.primary",
    ]) {
      const button = page.locator(selector).first();
      if ((await button.count()) === 0) continue;
      if (!(await button.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
      await button.click({ timeout: 5_000 });
      break;
    }
    await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(at);
  }
  throw new Error("the sitting did not finish");
}

async function start(page: Page, code = CODE): Promise<void> {
  await page.goto("./");
  await page.locator("input.code").fill(code);
  await page.locator("button.next.big").click();
  await expect(page.locator(".screen.survey, .screen.checkin")).toBeVisible();
}

/** Read the sitting back out of Firestore the way the export does. */
async function stored(sessionId: string) {
  const parent = await study.db.doc(layout.paths.session("ybm", sessionId)).get();
  if (!parent.exists) return null;
  const doc = parent.data() as SessionDoc;
  const chunks =
    doc.chunkCount > 0
      ? (await study.db.collection(layout.paths.sessionChunks("ybm", sessionId)).get()).docs.map((c) => c.data() as ChunkDoc)
      : [];
  return { doc, session: layout.joinSession(doc, chunks) };
}

async function sessionIds(): Promise<string[]> {
  const all = await study.db.collection(layout.paths.sessions("ybm")).get();
  return all.docs.map((d) => d.id);
}

/** Wait for the device to have filed something, however long its queue takes. */
async function waitForSittings(count: number): Promise<string[]> {
  await expect.poll(async () => (await sessionIds()).length, { timeout: 60_000, intervals: [500] }).toBe(count);
  return sessionIds();
}

test("a finished sitting reaches the database with its answers intact", async ({ page }) => {
  test.slow();
  await start(page);
  await walk(page);
  await expect(page.locator(".screen.finish")).toBeVisible();

  const [id] = await waitForSittings(1);
  const held = await stored(id!);
  expect(held).not.toBeNull();

  // Filed under the code the participant typed, by the device that collected it, and
  // marked as having come from a device that registered itself rather than one an
  // owner named.
  expect(held!.session.studyCode).toBe(CODE);
  expect(held!.session.complete).toBe(true);
  expect(held!.doc.deviceId).toMatch(/^ipad_/);
  expect(held!.doc.provenance).toBe("device");

  // The answers are in there, in order, with payloads — not an empty shell with the
  // right metadata.
  const answers = held!.session.events.filter((e) => e.type === "response.recorded");
  expect(answers.length).toBeGreaterThan(20);
  expect(answers.every((e) => e.payload !== undefined)).toBe(true);
  expect(held!.session.events.map((e) => e.seq)).toEqual(
    [...held!.session.events].sort((a, b) => a.seq - b.seq).map((e) => e.seq),
  );

  // And the device proved who it was rather than asserting it.
  expect(study.requests[0]!.authorization).toMatch(/^Device ipad_[A-Z0-9]+\.[A-Za-z0-9_-]{32,}$/);

  /**
   * Every wall-clock timestamp in the dataset comes from this iPad's clock, and
   * `sentAt` is the only thing that lets the study check whether that clock was right.
   * Asserted over the real request rather than in a unit test because the value has to
   * be read at the moment of sending: an implementation that stamped it when the
   * sitting was queued would pass a unit test and manufacture hours of skew on a
   * device whose upload waited behind a retry backoff.
   */
  expect(study.requests.length).toBeGreaterThan(0);
  for (const [n, request] of study.requests.entries()) {
    const sentAt = (request.body as { sentAt?: string }).sentAt;
    expect(sentAt, `request ${n} did not say what the device's clock read`).toBeDefined();
    /**
     * Every request, not just the first. A sitting's uploads are spread over the whole
     * walk and some of them follow a retry delay, which is precisely where an
     * implementation that stamped the value when the upload was QUEUED would drift —
     * and drift is the thing the field exists to measure, so it must not be
     * manufactured by the client.
     */
    expect(
      Math.abs(Date.parse(sentAt!) - request.receivedAt),
      `request ${n} claimed a clock reading far from when it arrived`,
    ).toBeLessThan(10_000);
  }
});

test("the device registers itself once and keeps the same identity across sittings", async ({ page }) => {
  test.slow();
  await start(page, "NDC0001");
  await walk(page);
  await waitForSittings(1);

  // A second participant on the same iPad.
  await page.locator("button.next.big").first().click();
  await start(page, "NDC0002");
  await walk(page);
  const ids = await waitForSittings(2);

  const both = await Promise.all(ids.map((id) => stored(id)));
  const devices = new Set(both.map((s) => s!.doc.deviceId));
  expect(devices.size).toBe(1);
  expect(new Set(both.map((s) => s!.session.studyCode))).toEqual(new Set(["NDC0001", "NDC0002"]));

  // One registration document, not one per sitting.
  const registered = await study.db.collection(layout.paths.devices("ybm")).get();
  expect(registered.size).toBe(1);
  expect(registered.docs[0]!.data()).toMatchObject({ selfRegistered: true });
});

/** Answer `count` screens, whatever they are, without finishing the sitting. */
async function answerSome(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const at = await position(page);
    if (at === "finished") return;
    await answer(page);
    let moved = false;
    for (let waited = 0; waited < 600; waited += 100) {
      if ((await position(page)) !== at) {
        moved = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    if (moved) continue;
    for (const selector of [".screen.checkin button.next.big", "button.next:not(.big)", "button.primary"]) {
      const button = page.locator(selector).first();
      if ((await button.count()) === 0) continue;
      if (!(await button.isEnabled({ timeout: 1_000 }).catch(() => false))) continue;
      await button.click({ timeout: 5_000 });
      break;
    }
    await expect.poll(() => position(page), { timeout: 10_000 }).not.toBe(at);
  }
}

test("a sitting still being answered is already in the database", async ({ page }) => {
  // The protection against a dropped iPad, a flat battery, a child who stops halfway.
  // Without it the only sittings the study ever holds are the ones that reached the
  // end, and a morning that went wrong leaves no record that it happened.
  //
  // This build checkpoints every five seconds rather than every two minutes — the
  // cadence is a build-time setting, so the real timer is exercised rather than stubbed.
  test.slow();
  await start(page);
  await answerSome(page, 12);

  const [id] = await waitForSittings(1);
  const early = await stored(id!);

  // Present, incomplete, and carrying what has been answered so far.
  expect(early!.session.complete).toBe(false);
  expect(early!.session.events.length).toBeGreaterThan(5);
  expect(early!.session.studyCode).toBe(CODE);
  expect(early!.doc.deviceId).toMatch(/^ipad_/);

  // Then more answers, and the SAME sitting grows rather than becoming a second one.
  // A checkpoint turning into a duplicate would be a participant counted twice.
  await answerSome(page, 10);
  await expect
    .poll(async () => (await stored(id!))!.session.events.length, { timeout: 60_000, intervals: [500] })
    .toBeGreaterThan(early!.session.events.length);

  expect(await sessionIds()).toHaveLength(1);
  const later = await stored(id!);
  expect(later!.session.complete).toBe(false);
  // Every event the earlier copy held is still there, in the same order.
  expect(later!.session.events.slice(0, early!.session.events.length).map((e) => e.seq)).toEqual(
    early!.session.events.map((e) => e.seq),
  );
});

test("a sitting survives the study being unreachable and lands when it returns", async ({ page }) => {
  // A saturated hall at nine in the morning: the first attempts fail, the sitting stays
  // on the device, and nothing is lost when the network comes back.
  test.slow();
  // Down for the whole sitting, not for a fixed number of requests: this build
  // checkpoints every five seconds, so a walk produces dozens of attempts and any count
  // would be spent long before the participant finished.
  study.failEverything(true);

  await start(page);
  await answerSome(page, 14);
  await walk(page);
  await expect(page.locator(".screen.finish")).toBeVisible();

  // Nothing stored while the study was refusing, and it was genuinely asked.
  expect(await sessionIds()).toEqual([]);
  expect(study.requests.length).toBeGreaterThan(3);

  study.failEverything(false);

  // The operator's Sync now, which is what a researcher reaches for.
  await page.locator("button.next.big").first().click();
  const buildLine = page.locator("p.demo-note");
  for (let i = 0; i < 5; i += 1) await buildLine.click();
  await page.locator("button", { hasText: /Sync completed sessions/ }).click();

  const [id] = await waitForSittings(1);
  const held = await stored(id!);
  expect(held!.session.studyCode).toBe(CODE);
  expect(held!.session.complete).toBe(true);
});

test("two devices with the same sitting id cannot overwrite each other, over HTTP", async ({ browser }) => {
  test.slow();
  // Two separate browser contexts are two separate devices: each has its own storage,
  // so each issues itself its own identity, exactly as two iPads do.
  const first = await browser.newContext({ baseURL: "http://localhost:4174/MySelf/" });
  const second = await browser.newContext({ baseURL: "http://localhost:4174/MySelf/" });
  try {
    const one = await first.newPage();
    await start(one, "NDC0009");
    await walk(one);
    await waitForSittings(1);
    const [id] = await sessionIds();
    const original = await stored(id!);

    // Force the collision: the second device files a sitting under the first's id.
    const two = await second.newPage();
    await two.goto("./");
    const refused = await two.evaluate(
      async ([sessionId, url]) => {
        const response = await fetch(url as string, {
          method: "POST",
          headers: {
            authorization: `Device ipad_SECOND.${"z".repeat(43)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            deviceId: "ipad_SECOND",
            sittings: [
              {
                sessionId,
                studyCode: "NDC9999",
                releaseKey: "ybm_nd2026_standard_r7_0_1",
                releaseHash: "sha256:whatever",
                startedAt: "2026-09-01T10:00:00.000Z",
                complete: true,
                events: [{ seq: 0, type: "session.started", tWall: "2026-09-01T10:00:00.000Z", tMono: 0 }],
              },
            ],
          }),
        });
        return response.json();
      },
      [id!, "http://127.0.0.1:4319/saveSitting"],
    );

    expect((refused as { outcomes: { stored: boolean; quarantined: boolean }[] }).outcomes[0]).toMatchObject({
      stored: false,
      quarantined: true,
    });

    // The first device's log is untouched, and the participant code was not replaced.
    const after = await stored(id!);
    expect(after!.session.studyCode).toBe("NDC0009");
    expect(after!.session.events.length).toBe(original!.session.events.length);
    // Flagged, because nothing can say which of the two copies is the real child.
    expect(after!.doc.quarantined).toBe(true);
  } finally {
    await first.close();
    await second.close();
  }
});
