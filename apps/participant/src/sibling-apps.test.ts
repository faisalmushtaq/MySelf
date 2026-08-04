import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The survey's service worker must not swallow its neighbours.
 *
 * This has now gone wrong twice, in the same place, for two different reasons,
 * and both times it was invisible until someone opened the deployed site.
 *
 *   The first time there was no denylist at all, so `/researcher/` served the
 *   questionnaire to anybody whose browser had ever cached it.
 *
 *   The second time the denylist required a trailing slash, so
 *   `/MySelf/researcher/` worked and `/MySelf/researcher` — what a person
 *   types, and what every link without a trailing slash resolves to — did not.
 *   Without a service worker the server redirects to the canonical form; with
 *   one, `navigateFallback` answers first and the redirect never happens.
 *
 * Neither failure can be caught by a preview server, because a preview server
 * has no service worker. So this reads the regex the build actually emits into
 * `sw.js` and checks the paths against it directly. It needs `pnpm build` to
 * have run; where it has not, it says so rather than passing quietly, because
 * a test that skips itself is how this got deployed the first time.
 */

const swPath = fileURLToPath(new URL("../dist/sw.js", import.meta.url));

/** The denylist Workbox compiled into the shipped worker. */
function denylist(): RegExp[] {
  let source: string;
  try {
    source = readFileSync(swPath, "utf8");
  } catch {
    throw new Error(
      `${swPath} does not exist. Run \`pnpm --filter @myself/participant build\` first — this test checks the built service worker, which is the only place the bug can be seen.`,
    );
  }
  const match = source.match(/denylist:\[([^\]]*)\]/);
  if (!match) throw new Error("no navigateFallbackDenylist in the built service worker");
  return [...match[1]!.matchAll(/\/((?:[^/\\]|\\.)+)\/([gimsuy]*)/g)].map(
    (m) => new RegExp(m[1]!, m[2]),
  );
}

const excluded = (path: string): boolean => denylist().some((r) => r.test(path));

describe("the survey's service worker and its neighbours", () => {
  it("hands the researcher view and MyStory over, with or without a trailing slash", () => {
    for (const path of [
      "/MySelf/researcher",
      "/MySelf/researcher/",
      "/MySelf/researcher/index.html",
      "/MySelf/mystory",
      "/MySelf/mystory/",
      "/MySelf/mystory/index.html",
    ]) {
      expect(excluded(path), `${path} would be served the questionnaire`).toBe(true);
    }
  });

  it("still answers the survey's own navigations, which is what the worker is for", () => {
    // Over-broad exclusion is the opposite failure: the survey has to work in
    // a school hall with no network.
    for (const path of ["/MySelf/", "/MySelf/index.html", "/MySelf/some/deep/route"]) {
      expect(excluded(path), `${path} would stop working offline`).toBe(false);
    }
  });

  it("does not exclude a path that merely starts with a neighbour's name", () => {
    // `/researchers/` is not the researcher view, and matching it would break
    // a future route for no reason.
    expect(excluded("/MySelf/researchers")).toBe(false);
    expect(excluded("/MySelf/mystories/x")).toBe(false);
  });
});
