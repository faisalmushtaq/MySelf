import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { openStaffPanel } from "./support/staff.js";

/**
 * Participant links and study spaces on the iPad (D-56, docs/16 §11.3).
 *
 * WHAT HAS TO HOLD, each a way a sitting could land in a study nobody chose:
 *
 *   - a link to a published survey of an open study sets the iPad to it, and
 *     it keeps it — after a reload, and with the study unreachable;
 *   - a sitting started then is stamped with that study and survey;
 *   - a link to an unknown study or an unpublished survey is refused in words,
 *     and the iPad stays where it was;
 *   - a link that cannot be checked yet starts nothing, says why, and is
 *     followed by itself once the study answers;
 *   - a link is followed once, and staff can move the iPad in the handover
 *     panel, back to the default survey too;
 *   - an unfinished sitting is resumed only on the survey it started on;
 *   - and the bare address changes nothing: every iPad today stays as it is.
 *
 * The other study is a fake: `page.route` answers the build's studies source
 * (playwright.config.ts) with Firestore REST documents — its registry entry,
 * its live pointer and a release — the way a Studio publish in a study space
 * leaves them. Service workers are blocked so every request reaches it.
 */

test.use({ serviceWorkers: "block" });

const STUDY = "future";
const SURVEY = "future_main";
const LINK = `./?study=${STUDY}&survey=${SURVEY}`;
const DEFAULT_LINK = "./?study=ybm&survey=ybm_nd2026_standard";
const LABEL = "Perspectives of the future";
const BUILT_IN = resolve("releases/ybm_nd2026_standard_r8.0.0.manifest.json");
const OLD_INTRO = "Yorkshire Brain Map School Workshop";
const OLD_CONSENT = "Please tap each statement";
const WHY = "Why your answers matter";

type Json = Record<string, any>; // Deliberately loose: the test writes a release as a publisher would.

interface Release {
  hash: string;
  json: string;
}

/**
 * The first version of a survey in the study space: r8.0.0's two information
 * screens, filed as `future_main` of `future` and hashed again, so a walk is
 * short and every check the app makes — hash, engine, survey, study — is real.
 */
async function futureRelease(study = STUDY): Promise<Release> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(BUILT_IN, "utf8")) as Json;
  body["release"] = { ...body["release"], version: "1.0.0", key: `${SURVEY}_r1_0_0`, assessment: SURVEY, study, engineVersion: "0.2.0" };
  body["composition"]["key"] = SURVEY;
  body["composition"]["study"] = study;
  body["composition"]["studyLabel"] = LABEL;
  const welcome = (body["composition"]["sections"] as Json[])[0]!;
  welcome["components"] = [{ ...(welcome["components"] as Json[])[0], items: ["intro", "why_it_matters"] }];
  body["composition"]["sections"] = [welcome];
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }) };
}

/** Another study's public documents, as Firestore's REST API serves them. */
class FakeStudies {
  /** The registry entry: `open`, `closed`, absent, or failing. */
  registry: "open" | "closed" | "absent" | "failing" = "open";
  private live: Release | null = null;
  readonly requests: string[] = [];

  publish(release: Release): void {
    this.live = release;
  }

  async attach(page: Page): Promise<void> {
    await page.route((url) => url.pathname.startsWith("/__studies/"), (route) => this.answer(route));
  }

  private async answer(route: Route): Promise<void> {
    const path = new URL(route.request().url()).pathname;
    this.requests.push(path);
    const notFound = () =>
      route.fulfill({ status: 404, json: { error: { code: 404, message: "Document not found", status: "NOT_FOUND" } } });
    const base = `/__studies/${STUDY}`;
    if (path === base) {
      if (this.registry === "failing") return route.fulfill({ status: 503, body: "Service Unavailable" });
      if (this.registry === "absent") return notFound();
      return route.fulfill({
        json: {
          name: `projects/demo/databases/(default)/documents/studies/${STUDY}`,
          fields: { study: { stringValue: STUDY }, title: { stringValue: LABEL }, status: { stringValue: this.registry } },
        },
      });
    }
    if (this.registry === "failing") return route.fulfill({ status: 503, body: "Service Unavailable" });
    if (path === `${base}/published/${SURVEY}`) {
      if (!this.live) return notFound();
      return route.fulfill({
        json: {
          name: `projects/demo/databases/(default)/documents/studies/${STUDY}/published/${SURVEY}`,
          fields: {
            surveyId: { stringValue: SURVEY },
            study: { stringValue: STUDY },
            hash: { stringValue: this.live.hash },
            version: { stringValue: "1.0.0" },
            releaseKey: { stringValue: `${SURVEY}_r1_0_0` },
            engineVersion: { stringValue: "0.2.0" },
            generation: { integerValue: "1" },
          },
        },
      });
    }
    if (this.live && path === `${base}/publicReleases/${this.live.hash.slice(7)}`) {
      return route.fulfill({
        json: {
          name: `projects/demo/databases/(default)/documents/studies/${STUDY}/publicReleases/x`,
          fields: { hash: { stringValue: this.live.hash }, manifest: { stringValue: this.live.json } },
        },
      });
    }
    return notFound();
  }
}

interface StoredSitting {
  sessionId: string;
  participantCode: string;
  releaseHash: string;
  study?: string;
  surveyId?: string;
  state: string;
  currentIndex: number;
}

async function sittings(page: Page): Promise<StoredSitting[]> {
  return page.evaluate(
    () =>
      new Promise<StoredSitting[]>((resolvePromise, reject) => {
        const open = indexedDB.open("myself");
        open.onerror = () => reject(new Error("could not open the device database"));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("sessions")) return resolvePromise([]);
          const all = database.transaction("sessions", "readonly").objectStore("sessions").getAll();
          all.onsuccess = () => resolvePromise(all.result as StoredSitting[]);
          all.onerror = () => reject(new Error("could not read sessions"));
        };
      }),
  );
}

const buildLine = (page: Page) => page.locator("p.demo-note");
const notice = (page: Page) => page.locator(".survey-notice");
const heading = (page: Page) => page.locator(".survey h1");

async function start(page: Page, code: string): Promise<void> {
  await page.locator("input.code").fill(code);
  await page.locator("button.next.big").click();
  await expect(page.locator(".survey")).toBeVisible();
}

/** The handover panel: five taps on the build line and the staff PIN, as staff open it. */
async function openPanel(page: Page): Promise<void> {
  await openStaffPanel(page);
  await expect(page.getByRole("heading", { name: "Survey on this iPad" })).toBeVisible();
}

async function useSurvey(page: Page, typed: string | null): Promise<void> {
  await openPanel(page);
  if (typed === null) {
    await page.getByRole("button", { name: "Back to the default survey" }).click();
  } else {
    await page.getByLabel("Participant link, or study/survey").fill(typed);
    await page.getByRole("button", { name: "Check" }).click();
  }
  await page.getByRole("button", { name: "Use this survey on this iPad" }).click();
}

test.describe("a participant link", () => {
  test("sets the iPad to a published survey of an open study, which it keeps, and files its sittings there", async ({ page }) => {
    const release = await futureRelease();
    const studies = new FakeStudies();
    studies.publish(release);
    await studies.attach(page);

    await page.goto(LINK);
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`, { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 1.0.0 (downloaded)");
    await expect(page.locator("p.study-title")).toHaveText(LABEL);
    // The registry first, then the pointer, then the release.
    expect(studies.requests.slice(0, 3)).toEqual([`/__studies/${STUDY}`, `/__studies/${STUDY}/published/${SURVEY}`, `/__studies/${STUDY}/publicReleases/${release.hash.slice(7)}`]);

    await start(page, "NDC0901");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    const [sitting] = await sittings(page);
    expect(sitting).toMatchObject({ study: STUDY, surveyId: SURVEY, releaseHash: release.hash });

    // Kept: the bare address, with the study not answering at all, opens on it.
    studies.registry = "failing";
    await page.goto("./");
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`);
    await expect(buildLine(page)).toContainText("release 1.0.0 (downloaded)");
    await expect(page.locator("input.code")).toBeEnabled();
  });

  test("to a study that does not exist, or a survey not published, is refused in words, and the iPad stays as it was", async ({ page }) => {
    const studies = new FakeStudies();
    studies.registry = "absent";
    await studies.attach(page);

    await page.goto(LINK);
    await expect(notice(page)).toContainText("can't be used: there is no such study in this project", { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");
    await expect(buildLine(page)).not.toContainText("survey future");
    await expect(page.locator("input.code")).toBeEnabled();

    studies.registry = "open";
    await page.goto(LINK);
    await expect(notice(page)).toContainText("has no live version", { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");

    studies.registry = "closed";
    studies.publish(await futureRelease());
    await page.goto(LINK);
    await expect(notice(page)).toContainText(`the study “${LABEL}” is closed`, { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");
  });

  test("that cannot be checked yet starts nothing and says why, then is followed once the study answers", async ({ page, context }) => {
    const studies = new FakeStudies();
    studies.registry = "failing";
    studies.publish(await futureRelease());
    await studies.attach(page);

    await page.goto(LINK);
    await expect(notice(page)).toContainText("It has to be downloaded once", { timeout: 15_000 });
    await expect(notice(page)).toContainText("could not be reached");
    // No code and no Start: the iPad was given this survey, and must not run another in its place.
    await expect(page.locator("input.code")).toHaveCount(0);

    await context.setOffline(true);
    await expect(notice(page)).toContainText("this iPad is offline", { timeout: 15_000 });

    studies.registry = "open";
    await context.setOffline(false);
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`, { timeout: 15_000 });
    await expect(page.locator("input.code")).toBeEnabled();
    await expect(notice(page)).toHaveCount(0);
  });

  test("is followed once, so a change staff made since is not undone; staff move the iPad in the handover panel", async ({ page }) => {
    const studies = new FakeStudies();
    studies.publish(await futureRelease());
    await studies.attach(page);

    await page.goto(LINK);
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`, { timeout: 15_000 });

    // Staff move it back to the default survey, which needs no network.
    await useSurvey(page, null);
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");
    await expect(buildLine(page)).not.toContainText("survey future");

    // The same link again — a Home-Screen app saved from it opens on it every time — is not followed.
    await page.goto(LINK);
    await expect(notice(page)).toContainText("was set up from this link before", { timeout: 15_000 });
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");

    // Staff can still move it there from the panel, by typing study/survey.
    await useSurvey(page, `${STUDY}/${SURVEY}`);
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`);

    // And a link to the default survey moves it back, whatever it was on.
    await page.goto(DEFAULT_LINK);
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)", { timeout: 15_000 });
    await expect(buildLine(page)).not.toContainText("survey future");
  });

  test("never resumes a sitting on a survey other than the one it started on", async ({ page }) => {
    const studies = new FakeStudies();
    studies.publish(await futureRelease());
    await studies.attach(page);

    // A sitting of the default survey, one screen in, left unfinished.
    await page.goto("./");
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");
    await start(page, "NDC0902");
    await page.locator("button.next:not(.big)").first().click();
    await expect(heading(page)).toContainText(OLD_CONSENT);
    await expect.poll(async () => (await sittings(page))[0]?.currentIndex).toBe(1);

    // The iPad is moved to the study space's survey: the same code starts a new
    // sitting there rather than putting the participant back into the other one.
    await page.goto("./");
    await useSurvey(page, `${STUDY}/${SURVEY}`);
    await expect(buildLine(page)).toContainText(`survey ${STUDY}/${SURVEY}`);
    await start(page, "NDC0902");
    await expect(heading(page)).toHaveText(OLD_INTRO);
    const rows = await sittings(page);
    expect(rows.map((r) => r.study ?? "ybm").sort()).toEqual(["future", "ybm"]);

    // Moved back, the code resumes the default's sitting where it stopped.
    await page.goto("./");
    await useSurvey(page, null);
    await start(page, "NDC0902");
    await expect(heading(page)).toContainText(OLD_CONSENT);
    await expect(heading(page)).not.toHaveText(WHY);
  });
});

test.describe("the bare address", () => {
  test("changes nothing for an iPad that was never given a link", async ({ page }) => {
    const studies = new FakeStudies();
    await studies.attach(page);
    await page.goto("./");
    await expect(buildLine(page)).toContainText("release 8.0.0 (built in)");
    await expect(buildLine(page)).not.toContainText("survey");
    await expect(notice(page)).toHaveCount(0);
    // Nothing about any other study was asked.
    expect(studies.requests).toEqual([]);
    await start(page, "NDC0903");
    const [sitting] = await sittings(page);
    expect(sitting).toMatchObject({ study: "ybm", surveyId: "ybm_nd2026_standard" });
  });
});
