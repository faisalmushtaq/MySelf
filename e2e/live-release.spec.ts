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
 * playwright.config.ts) with Firestore REST documents, holding r7.3.0 edited and
 * re-hashed the way a Studio publish produces a release. Service workers are
 * blocked so that every request the page makes reaches the fake; the worker is
 * not what is under test here.
 */

test.use({ serviceWorkers: "block" });

const SURVEY = "ybm_nd2026_standard";
/** Resolved from the working directory: Playwright compiles specs as CommonJS, and runs from the root. */
const BUILT_IN = resolve("releases/ybm_nd2026_standard_r7.3.0.manifest.json");

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
 * r7.3.0 (the built-in release), changed where a participant would see it, and hashed again with the
 * same canonical hash the app will recompute.
 */
async function nextRelease(): Promise<Release> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(BUILT_IN, "utf8")) as Json;
  body["release"]["version"] = "7.4.0";
  body["release"]["key"] = "ybm_nd2026_standard_r7_4_0";
  body["composition"]["studyLabel"] = NEW_LABEL;
  const intro = body["instruments"]["ybm_intro_consent@1.0/en-GB/self/standard"]["forms"][0]["items"] as Json[];
  intro.find((item) => item["key"] === "intro")!["stem"]["text"] = NEW_INTRO;
  intro.find((item) => item["key"] === "consent")!["stem"]["text"] = NEW_CONSENT;
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }) };
}

const SHORT_LABEL = "A two-screen survey";
const WHY = "Why your answers matter";

/**
 * A second published release, short enough to finish in an e2e run: r7.3.0's
 * welcome section showing only its two information screens (a placement subset,
 * engine 0.2.0). Position 1 is "Why your answers matter" here and the consent
 * question in r7.3.0 and `nextRelease`, so a resume drawn with the wrong release
 * shows the wrong screen.
 */
async function shortRelease(): Promise<Release> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(BUILT_IN, "utf8")) as Json;
  body["release"]["version"] = "7.5.0";
  body["release"]["key"] = "ybm_nd2026_standard_r7_5_0";
  body["release"]["engineVersion"] = "0.2.0";
  body["composition"]["studyLabel"] = SHORT_LABEL;
  const welcome = (body["composition"]["sections"] as Json[])[0]!;
  welcome["components"] = [{ ...(welcome["components"] as Json[])[0], items: ["intro", "why_it_matters"] }];
  body["composition"]["sections"] = [welcome];
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }) };
}

async function builtInHash(): Promise<string> {
  return (JSON.parse(await readFile(BUILT_IN, "utf8")) as { hash: string }).hash;
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

/** The hashes of the releases this device has downloaded and kept. */
async function cachedHashes(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolvePromise, reject) => {
        const open = indexedDB.open("myself");
        open.onerror = () => reject(new Error("could not open the device database"));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("releases")) {
            resolvePromise([]);
            return;
          }
          const keys = database.transaction("releases", "readonly").objectStore("releases").getAllKeys();
          keys.onsuccess = () => resolvePromise(keys.result.map(String));
          keys.onerror = () => reject(new Error("could not read releases"));
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
    await expect(buildLine(page)).toContainText("release 7.3.0 (built in)");
    await expect(page.locator("input.code")).toBeEnabled();

    // Then the published release, once it has been downloaded and verified.
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL, { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 7.4.0 (downloaded)");
    expect(study.requests).toEqual([`/__survey/published/${SURVEY}`, `/__survey/publicReleases/${next.hash.slice(7)}`]);

    await start(page, "NDC0101");
    await expect(heading(page)).toHaveText(NEW_INTRO);

    const [sitting] = await sittings(page);
    expect(sitting?.releaseHash).toBe(next.hash);
    expect(sitting?.releaseKey).toBe("ybm_nd2026_standard_r7_4_0");

    // And it is this device's release from now on, read from its own storage:
    // with the study failing to answer, the next launch still opens on it.
    study.failing = true;
    await page.reload();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL);
    await expect(buildLine(page)).toContainText("release 7.4.0 (downloaded)");
  });

  test("a sitting started before the change is resumed under the release it began with", async ({ page }) => {
    const old = await builtInHash();
    const next = await nextRelease();
    const study = new FakeStudy();
    await study.attach(page);

    // Nothing published: a sitting starts under the built-in release, and gets
    // one screen in.
    await page.goto("./");
    await expect(buildLine(page)).toContainText("release 7.3.0 (built in)");
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

  test("a sitting under an earlier DOWNLOADED release is kept, finished under it, and the next participant gets the live one", async ({
    page,
  }) => {
    // The case above pins a sitting to the built-in release, which is always
    // there. This one pins it to a release that exists only in this device's
    // cache: it must survive the pruning that follows the next publish, be read
    // back and verified from storage, be finished under, and give way to the live
    // release when the iPad is handed back — with no reload in between.
    const short = await shortRelease();
    const next = await nextRelease();
    const study = new FakeStudy();
    study.publish(short);
    await study.attach(page);

    await page.goto("./");
    await expect(page.locator("p.study-title")).toHaveText(SHORT_LABEL, { timeout: 15_000 });
    await start(page, "NDC0505");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    await page.locator("button.next:not(.big)").first().click();
    await expect(heading(page)).toHaveText(WHY);
    await expect.poll(async () => (await sittings(page))[0]?.currentIndex).toBe(1);

    // A newer version goes live while that sitting is unfinished.
    study.publish(next);
    await page.reload();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL, { timeout: 15_000 });
    // Taking it prunes the cache, and the short release is kept: a sitting needs it.
    await expect.poll(() => cachedHashes(page)).toEqual(expect.arrayContaining([short.hash, next.hash]));

    // The same code resumes under the short release, on its own second screen —
    // in the live release that position is the consent question.
    await start(page, "NDC0505");
    await expect(heading(page)).toHaveText(WHY);
    await page.locator("button.next:not(.big)").first().click();
    await expect(page.locator(".screen.finish")).toBeVisible();
    const finished = (await sittings(page)).find((s) => s.participantCode === "NDC0505");
    expect(finished?.releaseHash).toBe(short.hash);
    expect(finished?.state).toBe("awaiting_sync");

    // Handed back: the start screen is the live release again, straight away.
    await page.getByRole("button", { name: /hand back to the researcher/i }).click();
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL);
    await expect(buildLine(page)).toContainText("release 7.4.0 (downloaded)");
    await start(page, "NDC0606");
    await expect(heading(page)).toHaveText(NEW_INTRO);
    const byCode = new Map((await sittings(page)).map((s) => [s.participantCode, s.releaseHash]));
    expect(byCode.get("NDC0505")).toBe(short.hash);
    expect(byCode.get("NDC0606")).toBe(next.hash);
  });

  test("an iPad upgraded from the previous build keeps its unfinished sitting through the database upgrade", async ({
    page,
  }) => {
    // Rollout day. The device ran the build before this one, whose database is
    // Dexie version 4 (IndexedDB version 40), and holds a child's unfinished
    // r7.3.0 sitting. This build opens it as version 5, which only ADDS tables
    // (lib/db.ts): if that upgrade failed, the app would not open on a device
    // holding sittings. And with a new release already published, the sitting
    // must still resume under r7.3.0, where it began.
    const old = await builtInHash();
    const next = await nextRelease();
    const study = new FakeStudy();
    study.publish(next);
    await study.attach(page);

    // Any page of the origin that is not the app, so the old database can be laid
    // down before the app first opens it.
    await page.goto("./icon-192.png");
    await page.evaluate(
      (releaseHash) =>
        new Promise<void>((resolvePromise, reject) => {
          const open = indexedDB.open("myself", 40);
          open.onupgradeneeded = () => {
            const database = open.result;
            const store = (name: string, keyPath: string, indexes: (string | string[])[] = []) => {
              const created = database.createObjectStore(name, { keyPath });
              for (const index of indexes) {
                created.createIndex(Array.isArray(index) ? `[${index.join("+")}]` : index, index);
              }
              return created;
            };
            // Version 4 of lib/db.ts, exactly.
            const sessions = store("sessions", "sessionId", ["participantCode", "state", "updatedAt"]);
            store("events", "eventId", ["sessionId", ["sessionId", "seq"]]);
            store("device", "id");
            store("install", "id");
            store("sync_state", "sessionId", ["nextAttemptAt", "syncedAt", "quarantinedAt"]);
            store("receipts", "sessionId", ["verifiedAt"]);
            store("checkpoints", "sessionId", ["at"]);
            store("accessibility", "id", ["updatedAt"]);
            // Written in the upgrade transaction itself; no other may run during it.
            sessions.put({
              sessionId: "ses_before_the_upgrade",
              participantCode: "NDC0707",
              releaseKey: "ybm_nd2026_standard_r7_3_0",
              releaseHash,
              state: "in_progress",
              currentIndex: 1,
              startedAt: "2026-09-28T09:00:00.000Z",
              updatedAt: "2026-09-28T09:05:00.000Z",
              eventCount: 3,
            });
          };
          open.onsuccess = () => {
            open.result.close();
            resolvePromise();
          };
          open.onerror = () => reject(new Error("could not lay down the version 4 database"));
        }),
      old,
    );

    await page.goto("./");
    await expect(page.locator("p.study-title")).toHaveText(NEW_LABEL, { timeout: 15_000 });
    await start(page, "NDC0707");
    // Position 1 of r7.3.0 is the consent question; in the new release it is the new wording.
    await expect(heading(page)).toContainText(OLD_CONSENT);
    await expect(heading(page)).not.toContainText(NEW_CONSENT);

    const rows = await sittings(page);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe("ses_before_the_upgrade");
    expect(rows[0]?.releaseHash).toBe(old);
    expect(await cachedHashes(page)).toEqual([next.hash]);
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

    await expect(buildLine(page)).toContainText("release 7.3.0 (built in)");
    await expect(page.locator("p.study-title")).toHaveCount(0);

    await start(page, "NDC0404");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    const [sitting] = await sittings(page);
    expect(sitting?.releaseHash).toBe(old);
  });
});
