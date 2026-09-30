import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { expect, test, type Frame, type Page } from "@playwright/test";

/**
 * Preview mode (D-54): the dashboard's survey editor shows a draft in the real
 * participant app, framed on its own page.
 *
 * A stand-in dashboard is served from its own port, which is another origin,
 * and frames the survey exactly as the editor does: it waits for
 * `myself:preview-ready` and answers with `myself:preview-manifest`. This build
 * allows that origin (the survey's port plus ten) through
 * `MYSELF_PREVIEW_ORIGINS` in playwright.config.ts; a deployed build allows
 * only the dashboard's own. It is a real server rather than an intercepted
 * URL because Chromium will not let a page it cannot place on this machine
 * frame one that is (Private Network Access).
 *
 * The draft is r9.0.0 cut down to its sleep questions and ended with MyStory,
 * with no hash, as a draft has none. That also walks the order a version
 * ending with MyStory must keep: the questions, then MyStory, then the finish
 * screen, then the handover.
 */

/** The survey, the stand-in dashboard this build trusts, and a page it does not. */
const ports = (baseURL: string | undefined) => {
  const survey = new URL(baseURL!);
  return { survey: survey.origin, dashboard: Number(survey.port) + 10, elsewhere: Number(survey.port) + 11 };
};

let server: Server | null = null;
test.afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = null;
});

const r9 = JSON.parse(readFileSync(resolve("releases/ybm_nd2026_standard_r9.0.0.manifest.json"), "utf8")) as {
  hash?: string;
  composition: { sections: { key: string }[] };
  narrativeProtocols: Record<string, unknown>;
};

function draft(): unknown {
  const d = structuredClone(r9);
  delete d.hash;
  d.composition.sections = [
    d.composition.sections.find((s) => s.key === "sleep")!,
    {
      key: "mystory",
      title: "MyStory",
      components: [{ kind: "narrative", protocol: "np.phone_wellbeing", protocolVersion: "1.0.0" }],
    } as never,
  ];
  d.narrativeProtocols = { "np.phone_wellbeing@1.0.0": { key: "np.phone_wellbeing", version: "1.0.0" } };
  return d;
}

/** A page on `port` that frames the survey in preview mode and answers every ready with `manifest`. */
async function dashboard(page: Page, survey: string, port: number, manifest: unknown): Promise<Frame> {
  const payload = JSON.stringify(manifest).replace(/</g, "\\u003c");
  const body = `<!doctype html><html><body style="margin:0">
        <iframe id="survey" src="${survey}/MySelf/?preview=1" style="width:820px;height:1150px;border:0"></iframe>
        <script>
          window.readies = 0;
          const manifest = ${payload};
          addEventListener("message", (event) => {
            if (event.origin !== "${survey}" || !event.data || event.data.type !== "myself:preview-ready") return;
            window.readies += 1;
            document.getElementById("survey").contentWindow.postMessage(
              { type: "myself:preview-manifest", manifest }, "${survey}");
          });
        </script></body></html>`;
  server = createServer((_, response) => response.writeHead(200, { "content-type": "text/html" }).end(body));
  await new Promise<void>((listening) => server!.listen(port, "127.0.0.1", listening));
  await page.goto(`http://127.0.0.1:${port}/editor.html`);
  await expect.poll(() => page.frames().some((f) => f.url().includes("preview=1"))).toBe(true);
  return page.frames().find((f) => f.url().includes("preview=1"))!;
}

test("the editor's draft runs in the real survey, ends with MyStory, and nothing is kept", async ({ page, baseURL }) => {
  const at = ports(baseURL);
  const survey = await dashboard(page, at.survey, at.dashboard, draft());

  // Said on every screen.
  const banner = survey.locator(".preview-banner");
  await expect(banner).toHaveText("Preview — nothing is saved");
  await expect(survey.locator(".demo-note")).toContainText("(draft)");

  // Nothing staff-only is reachable from a preview.
  for (let i = 0; i < 5; i += 1) await survey.locator(".demo-note").click();
  await expect(survey.locator(".handover")).toHaveCount(0);

  await survey.locator("input.code").fill("NDC0042");
  await survey.locator("button.next.big").click();

  // The draft's questions, and only those.
  await expect(survey.locator(".survey-body h1")).toContainText("sleep quality");
  await expect(banner).toBeVisible();
  await survey.getByRole("radio", { name: "7, Good" }).click();
  await expect(survey.locator(".survey-body h1")).toHaveText("How sleepy are you feeling right now?");
  await survey.locator('[role="radiogroup"] button').first().click();

  // Then MyStory, last: shown, not run, and its button finishes the survey.
  const place = survey.locator(".narrative-after");
  await expect(place).toContainText("MyStory would start here (np.phone_wellbeing@1.0.0)");
  await expect(survey.locator("iframe")).toHaveCount(0);
  await place.getByRole("button", { name: "Finish" }).click();

  // Then the finish screen, then the handover back to the start.
  await expect(survey.locator(".screen.finish")).toBeVisible();
  await survey.getByRole("button", { name: "Hand back to the researcher" }).click();
  await expect(survey.locator(".screen.start")).toBeVisible();
  await expect(banner).toBeVisible();

  // Nothing was stored on the device, nothing was installed, and no
  // identity was issued: the survey's database was never so much as opened.
  const kept = await survey.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((d) => d.name),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  expect(kept.databases).not.toContain("myself");
  expect(kept.workers).toBe(0);
});

test("a draft from any other page is ignored", async ({ page, baseURL }) => {
  const at = ports(baseURL);
  const survey = await dashboard(page, at.survey, at.elsewhere, draft());
  await expect.poll(() => page.evaluate(() => (window as unknown as { readies: number }).readies)).toBeGreaterThan(0);
  // It asked, it was answered, and it is still waiting: the answer was not the dashboard's.
  await page.waitForTimeout(500);
  await expect(survey.locator(".booting")).toHaveText("Waiting for the draft from the survey editor…");
  await expect(survey.locator(".screen.start")).toHaveCount(0);
});

test("a draft that is not a release is refused, with the reason", async ({ page, baseURL }) => {
  const broken = draft() as { composition: Record<string, unknown> };
  delete broken.composition["sections"];
  const at = ports(baseURL);
  const survey = await dashboard(page, at.survey, at.dashboard, broken);
  await expect(survey.locator(".booting")).toContainText("This draft cannot be previewed: composition.sections");
  await expect(survey.locator(".screen.start")).toHaveCount(0);
});
