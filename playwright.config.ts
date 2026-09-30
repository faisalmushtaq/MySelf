import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end suite.
 *
 * Everything else in this repository is a unit test, and they stop exactly where
 * the risk starts: 1,700 lines of the screens a child actually touches, the real
 * IndexedDB, the AES round trip through it, the service worker, and resuming a
 * sitting after a reload are between them tested nowhere. An offline-first iPad
 * app whose failure mode is "a child's morning is lost" needs at least one test
 * that drives the real thing in a real browser.
 *
 * TWO ENGINES, AND WEBKIT IS THE ONE THAT MATTERS. An iPad runs WebKit, and its
 * IndexedDB, storage eviction and service-worker behaviour are where this app's
 * hard cases live — the code is full of comments about Safari specifically. CI
 * installs both. A developer machine that only has Chromium still gets the walk
 * through the survey, which is most of the value, with `--project=chromium`.
 *
 * IT RUNS AGAINST THE BUILT APP, not the dev server. The service worker only
 * exists in a build, and a preview server has none — which is how the researcher
 * view shipped broken twice, per the note in the participant app's vite config.
 * Testing the dev server would miss the entire class of bug.
 */

const PORT = 4173;

/**
 * An escape hatch for a machine whose browsers were installed by somebody else.
 *
 * Sandboxes and CI images often ship a Chromium at a fixed path and forbid
 * `playwright install`, and when its revision does not match the pinned
 * `@playwright/test` the only symptom is "Executable doesn't exist", which reads
 * like a broken checkout. Point this at the binary instead. Unset — the normal
 * case, including this repo's own CI — Playwright uses the browser it manages.
 */
const chromiumExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "./e2e",
  // A sitting is a long walk through many screens; one at a time keeps the
  // failure legible and the machine honest about timing.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}/MySelf/`,
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      // An iPad-shaped viewport with touch, because the layout and the tap
      // targets are the point of this app and a desktop window hides both.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
    {
      name: "webkit",
      use: { ...devices["iPad (gen 7)"] },
    },
  ],
  /**
   * Built here rather than assumed, so the suite cannot pass against a stale
   * `dist` from a previous change. Deliberately built with NO study configured:
   * these tests are about the survey and the device's own storage, and a build
   * that could reach a real project is not what should be driven by a robot.
   */
  webServer: {
    // `--host 127.0.0.1` so preview binds the same address the health check below
    // polls. Without it vite binds `localhost`, which on the ubuntu-24.04 CI runner
    // resolves to IPv6 `::1` while Playwright waits on IPv4 `127.0.0.1` — the two
    // never meet and the job dies with "Timed out waiting 180000ms from
    // config.webServer" before a single test runs. Locally `localhost` happens to be
    // 127.0.0.1 so it passed here and only ever failed in CI. The sync config already
    // pins its host for the same reason.
    command: "pnpm --filter @myself/participant build && pnpm --filter @myself/participant preview --port 4173 --strictPort --host 127.0.0.1",
    url: `http://127.0.0.1:${PORT}/MySelf/`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    env: {
      MYSELF_FIREBASE_CONFIG: "",
      MYSELF_SITTINGS_URL: "",
      MYSELF_MYSTORY_URL: "",
      // The stand-in dashboard `preview.spec.ts` serves, allowed to send this
      // build a draft to preview. A deployed build allows only the dashboard's own.
      MYSELF_PREVIEW_ORIGINS: `http://127.0.0.1:${PORT + 10}`,
    },
  },
});
