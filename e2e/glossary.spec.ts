import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Word explanations (D-79): a word the survey explains can be tapped wherever it
 * appears, and its meaning shows under the question. The words themselves are
 * not changed — that is the point, for licensed questionnaires.
 *
 * The built-in release with a glossary added, published the way any release
 * is: a pointer and a stored manifest the app downloads and verifies.
 */
test.use({ serviceWorkers: "block" });

const BUILT_IN = resolve("releases/ybm_nd2026_standard_r8.0.0.manifest.json");
type Json = Record<string, any>; // Deliberately loose: the test edits a manifest as a publisher would.

async function glossaryRelease(): Promise<{ hash: string; json: string; version: string }> {
  const { contentHashAsync } = await import("@myself/schema");
  const { hash: _previous, ...body } = JSON.parse(await readFile(BUILT_IN, "utf8")) as Json;
  body["release"]["version"] = "8.3.0";
  body["release"]["key"] = "ybm_nd2026_standard_r8_3_0";
  // Two screens: the welcome and "Why your answers matter".
  const welcome = (body["composition"]["sections"] as Json[])[0]!;
  welcome["components"] = [{ ...(welcome["components"] as Json[])[0], items: ["intro", "why_it_matters"] }];
  body["composition"]["sections"] = [welcome];
  body["composition"]["glossary"] = [{ term: "right or wrong", explanation: "Whatever you answer is fine — it is about you." }];
  const hash = await contentHashAsync(body);
  return { hash, json: JSON.stringify({ ...body, hash }), version: body["release"]["version"] };
}

test("an explained word can be tapped for its meaning, and the text is unchanged (D-79)", async ({ page }) => {
  const release = await glossaryRelease();
  const hex = release.hash.slice("sha256:".length);
  await page.route(
    (url) => url.pathname.startsWith("/__survey/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const doc = (fields: Json) => route.fulfill({ json: { name: `projects/demo/databases/(default)/documents${path.slice("/__survey".length)}`, fields } });
      if (path === "/__survey/published/ybm_nd2026_standard") {
        return doc({
          surveyId: { stringValue: "ybm_nd2026_standard" },
          hash: { stringValue: release.hash },
          version: { stringValue: release.version },
          releaseKey: { stringValue: "ybm_nd2026_standard_r8_3_0" },
          engineVersion: { stringValue: "0.2.0" },
          generation: { integerValue: "1" },
          publishedAt: { timestampValue: "2026-11-04T12:00:00.000000Z" },
        });
      }
      if (path === `/__survey/publicReleases/${hex}`) return doc({ hash: { stringValue: release.hash }, manifest: { stringValue: release.json } });
      return route.fulfill({ status: 404, json: { error: { code: 404, message: "Document not found", status: "NOT_FOUND" } } });
    },
  );
  await page.goto("./");
  await expect(page.locator("p.demo-note")).toContainText(`release ${release.version} (downloaded)`, { timeout: 15_000 });
  await page.locator("input.code").fill("NDC0042");
  await page.locator("button.next.big").click();
  await page.locator("button.next:not(.big)").click();

  const lede = page.locator(".survey-body .lede");
  await expect(lede).toContainText("There are no right or wrong answers here — only true ones.");
  const word = lede.getByRole("button", { name: "right or wrong" });
  await expect(word).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".gloss-note")).toHaveCount(0);

  await word.click();
  await expect(page.locator(".gloss-note")).toContainText("right or wrong — Whatever you answer is fine — it is about you.");
  await expect(word).toHaveAttribute("aria-expanded", "true");
  await page.locator(".gloss-note").getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".gloss-note")).toHaveCount(0);
});
