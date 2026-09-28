import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * A survey published after the app was built reaching an iPad (docs/16 §5.3).
 *
 * WHAT HAS TO HOLD, and each is a way to lose or corrupt a child's sitting:
 *
 *   - the start screen shows the release the study has published, once it has
 *     downloaded and verified it — and never waits for the network to do so;
 *   - a sitting started afterwards is stamped with the new release's hash;
 *   - a sitting started BEFORE the change is resumed under the release it began
 *     with, and stays stamped with that hash, because its saved position means a
 *     particular question only in that release;
 *   - a release that fails verification is never shown, and the built-in one
 *     carries on as if nothing had been published.
 *
 * The study is a fake: `page.route` answers the build's survey source (see
 * playwright.config.ts) with Firestore REST documents, holding r7.1.0 edited and
 * re-hashed the way a Studio publish produces a release. Service workers are
 * blocked so that every request the page makes reaches the fake; the worker is
 * not what is under test here.
 */

test.use({ serviceWorkers: "block" });

const SURVEY = "ybm_nd2026_standard";
/** Resolved from the working directory: Playwright compiles specs as CommonJS, and runs from the root. */
const R710 = resolve("releases/ybm_nd2026_standard_r7.1.0.manifest.json");

const OLD_INTRO = "Yorkshire Brain Map School Workshop";
const OLD_CONSENT = "Please tap each statement";
const NEW_LABEL = "Published from the Studio";
const NEW_INTRO = "Welcome to the new version of the survey";
const NEW_CONSENT = "New consent wording that only the new release has";

type Json = Record<string, any>; // Deliberately loose: the test edits a manifest as a publisher would.

interface Release {
  hash: string;
  /** The manifest exactly as the study stores it. */
  json: string;
}

/**
 * r7.1.0, changed where a participant would see it, and hashed again with the
 * same canonical hash the app will recompute.
 */
async function nextRelease(): Promise<Release> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(R710, "utf8")) as Json;
  body["release"]["version"] = "7.2.0";
  body["release"]["key"] = "ybm_nd2026_standard_r7_2_0";
  body["composition"]["studyLabel"] = NEW_LABEL;
  const intro = body["instruments"]["ybm_intro_consent@1.0/en-GB/self/standard"]["forms"][0]["items"] as Json[];
  intro.find((item) => item["key"] === "intro")!["stem"]["text"] = NEW_INTRO;
  intro.find((item) => item["key"] === "consent")!["stem"]["text"] = NEW_CONSENT;
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }) };
}

async function builtInHash(): Promise<string> {
  return (JSON.parse(await readFile(R710, "utf8")) as { hash: string }).hash;
}

/** The study's two public documents, as Firestore's REST API serves them. */
class FakeStudy {
  private pointer: Release | null = null;
  private stored = new Map<string, string>();
  /** Hold the pointer's reply back, to show that nothing waits for it. */
  delayMs = 0;
  /** Answer the pointer with a server error, as an unreachable study would. */
  failing = false;
  readonly requests: string[] = [];

  publish(release: Release, options: { storedJson?: string } = {}): void {
    this.pointer = release;
    this.stored.set(release.hash.slice("sha256:".length), options.storedJson ?? release.json);
  }

  async attach(page: Page): Promise<void> {
    await page.route((url) => url.pathname.startsWith("/__survey/"), (route) => this.answer(route));
  }

  private async answer(route: Route): Promise<void> {
    const path = new URL(route.request().url()).pathname;
    this.requests.push(path);
    const notFound = () =>
      route.fulfill({ status: 404, json: { error: { code: 404, message: "Document not found", status: "NOT_FOUND" } } });

    if (path === `/__survey/published/${SURVEY}`) {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      if (this.failing) return route.fulfill({ status: 503, body: "Service Unavailable" });
      if (!this.pointer) return notFound();
      const manifest = JSON.parse(this.pointer.json) as Json;
      return route.fulfill({
        json: {
          name: `projects/demo/databases/(default)/documents/studies/ybm/published/${SURVEY}`,
          fields: {
            surveyId: { stringValue: SURVEY },
            hash: { stringValue: this.pointer.hash },
            version: { stringValue: manifest["release"]["version"] },
            releaseKey: { stringValue: manifest["release"]["key"] },
            engineVersion: { stringValue: manifest["release"]["engineVersion"] },
            generation: { integerValue: "2" },
            publishedAt: { timestampValue: "2026-09-28T12:00:00.000000Z" },
          },
        },
      });
    }

    const hex = /^\/__survey\/publicReleases\/([0-9a-f]{64})$/.exec(path)?.[1];
    const json = hex ? this.stored.get(hex) : undefined;
    if (!hex || json === undefined) return notFound();
    return route.fulfill({
      json: {
        name: `projects/demo/databases/(default)/documents/studies/ybm/publicReleases/${hex}`,
        fields: { hash: { stringValue: `sha256:${hex}` }, manifest: { stringValue: json } },
      },
    });
  }
}

interface StoredSitting {
  sessionId: string;
  participantCode: string;
  releaseKey: string;
  releaseHash: string;
  state: string;
  currentIndex: number;
  eventCount: number;
}

/** The device's own session rows, read out of IndexedDB — the stamp every upload and export carries. */
async function sittings(page: Page): Promise<StoredSitting[]> {
  return page.evaluate(
    () =>
      new Promise<StoredSitting[]>((resolvePromise, reject) => {
        const open = indexedDB.open("myself");
        open.onerror = () => reject(new Error("could not open the device database"));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("sessions")) {
            resolvePromise([]);
            return;
          }
          const all = database.transaction("sessions", "readonly").objectStore("sessions").getAll();
          all.onsuccess = () => resolvePromise(all.result as StoredSitting[]);
          all.onerror = () => reject(new Error("could not read sessions"));
        };
      }),
  );
}

const buildLine = (page: Page) => page.locator("p.demo-note");
const heading = (page: Page) => page.locator(".survey h1");

async function start(page: Page, code: string): Promise<void> {
  await page.locator("input.code").fill(code);
  await page.locator("button.next.big").click();
  await expect(page.locator(".survey")).toBeVisible();
}

test.describe("a survey published after this build", () => {
  test("reaches the start screen without holding it up, and the next sitting is stamped with it", async ({ page }) => {
    const next = await nextRelease();
    const study = new FakeStudy();
    study.publish(next);
    study.delayMs = 3_000;
    await study.attach(page);

    await page.goto("./");
    // Usable at once, on the release built in, while the study has not answered.
    await expect(page.locator("h1.brand")).toHaveText("MySelf");
    await expect(buildLine(page)).toContainText("release 7.1.0 (built in)");
    await expect(page.locator("input.code")).toBeEnabled();

    // Then the published release, once it has been downloaded and verified.
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL, { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 7.2.0 (downloaded)");
    expect(study.requests).toEqual([`/__survey/published/${SURVEY}`, `/__survey/publicReleases/${next.hash.slice(7)}`]);

    await start(page, "NDC0101");
    await expect(heading(page)).toHaveText(NEW_INTRO);

    const [sitting] = await sittings(page);
    expect(sitting?.releaseHash).toBe(next.hash);
    expect(sitting?.releaseKey).toBe("ybm_nd2026_standard_r7_2_0");

    // And it is this device's release from now on, read from its own storage:
    // with the study failing to answer, the next launch still opens on it.
    study.failing = true;
    await page.reload();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL);
    await expect(buildLine(page)).toContainText("release 7.2.0 (downloaded)");
  });

  test("a sitting started before the change is resumed under the release it began with", async ({ page }) => {
    const old = await builtInHash();
    const next = await nextRelease();
    const study = new FakeStudy();
    await study.attach(page);

    // Nothing published: a sitting starts under the built-in release, and gets
    // one screen in.
    await page.goto("./");
    await expect(buildLine(page)).toContainText("release 7.1.0 (built in)");
    await start(page, "NDC0202");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    await page.locator("button.next:not(.big)").first().click();
    await expect(heading(page)).toContainText(OLD_CONSENT);
    // The position is saved with the write that presents the question; wait for it.
    await expect.poll(async () => (await sittings(page))[0]?.currentIndex).toBe(1);
    const [before] = await sittings(page);
    expect(before?.releaseHash).toBe(old);

    // The study publishes; the iPad is reloaded mid-sitting and lands on the start
    // screen, which now offers the new release.
    study.publish(next);
    await page.reload();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL, { timeout: 15_000 });

    // The same code resumes the same sitting, on the same question, in the old
    // wording — not the question at that position in the new release.
    await start(page, "NDC0202");
    await expect(heading(page)).toContainText(OLD_CONSENT);
    await expect(heading(page)).not.toContainText(NEW_CONSENT);

    const after = await sittings(page);
    expect(after).toHaveLength(1);
    expect(after[0]?.sessionId).toBe(before?.sessionId);
    expect(after[0]?.releaseHash).toBe(old);
    expect(after[0]?.eventCount).toBeGreaterThan(before!.eventCount);

    // Back at the start screen the new release is the one on offer again, and a
    // different participant's sitting is stamped with it.
    await page.reload();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL);
    await start(page, "NDC0303");
    await expect(heading(page)).toHaveText(NEW_INTRO);
    const byCode = new Map((await sittings(page)).map((s) => [s.participantCode, s.releaseHash]));
    expect(byCode.get("NDC0202")).toBe(old);
    expect(byCode.get("NDC0303")).toBe(next.hash);
  });

  test("refuses a release altered after it was published, and carries on with the built-in one", async ({ page }) => {
    const old = await builtInHash();
    const next = await nextRelease();
    const study = new FakeStudy();
    // The manifest as stored has had its words changed; its hash has not.
    study.publish(next, { storedJson: next.json.replace(NEW_LABEL, "Words nobody approved") });
    await study.attach(page);

    await page.goto("./");
    for (let i = 0; i < 5; i += 1) await buildLine(page).click();
    const note = page.locator(".handover .release-note");
    await expect(note).toContainText("was not used", { timeout: 15_000 });
    await expect(note).toContainText("changed after it was published");

    await expect(buildLine(page)).toContainText("release 7.1.0 (built in)");
    await expect(page.locator("p.study-title")).toHaveCount(0);

    await start(page, "NDC0404");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    const [sitting] = await sittings(page);
    expect(sitting?.releaseHash).toBe(old);
  });
});
