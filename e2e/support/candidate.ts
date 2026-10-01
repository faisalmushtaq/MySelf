import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

/**
 * The release that is cut but not yet approved (releases/candidates/), reaching
 * the app the way any published release does: downloaded from the study and
 * verified on the device.
 *
 * A candidate is never bundled, so the screens only it has (D-53) cannot be
 * walked on the built-in release. Rather than build an app that carries it, the
 * build's survey source (see playwright.config.ts) is answered with the
 * candidate as the published release — which also walks the asset pins it adds
 * (the street list) through the app's real verification.
 *
 * Requests the page makes must reach this route, so a spec using it blocks
 * service workers (`test.use({ serviceWorkers: "block" })`).
 */

const SURVEY = "ybm_nd2026_standard";
/** Resolved from the working directory: Playwright compiles specs as CommonJS, and runs from the root. */
export const CANDIDATE = resolve("releases/candidates/ybm_nd2026_standard_r9.0.0.manifest.json");

/** Answer the study's two public documents with the candidate, before the page is opened. */
export async function serveCandidate(page: Page): Promise<void> {
  const json = await readFile(CANDIDATE, "utf8");
  const manifest = JSON.parse(json) as { hash: string; release: { version: string; key: string; engineVersion: string } };
  const hex = manifest.hash.slice("sha256:".length);
  const notFound = { status: 404, json: { error: { code: 404, message: "Document not found", status: "NOT_FOUND" } } };

  await page.route(
    (url) => url.pathname.startsWith("/__survey/"),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/__survey/published/${SURVEY}`) {
        return route.fulfill({
          json: {
            name: `projects/demo/databases/(default)/documents/studies/ybm/published/${SURVEY}`,
            fields: {
              surveyId: { stringValue: SURVEY },
              hash: { stringValue: manifest.hash },
              version: { stringValue: manifest.release.version },
              releaseKey: { stringValue: manifest.release.key },
              engineVersion: { stringValue: manifest.release.engineVersion },
              generation: { integerValue: "1" },
              publishedAt: { timestampValue: "2026-09-30T12:00:00.000000Z" },
            },
          },
        });
      }
      if (path === `/__survey/publicReleases/${hex}`) {
        return route.fulfill({
          json: {
            name: `projects/demo/databases/(default)/documents/studies/ybm/publicReleases/${hex}`,
            fields: { hash: { stringValue: manifest.hash }, manifest: { stringValue: json } },
          },
        });
      }
      return route.fulfill(notFound);
    },
  );
}

/** Open the start screen and wait until the candidate is the release a new sitting gets. */
export async function openOnCandidate(page: Page): Promise<void> {
  const version = (JSON.parse(await readFile(CANDIDATE, "utf8")) as { release: { version: string } }).release.version;
  await serveCandidate(page);
  await page.goto("./");
  await expect(page.locator("p.demo-note")).toContainText(`release ${version} (downloaded)`, { timeout: 15_000 });
}
