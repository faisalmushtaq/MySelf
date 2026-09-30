import { defineConfig, devices } from "@playwright/test";

/**
 * The whole chain: an iPad in a browser, over HTTP, into a real Firestore.
 *
 * Separate from `playwright.config.ts` because it needs two things that suite must not
 * need — the Firestore emulator, and a build of the app pointed at a local endpoint.
 * A test that only runs when a Java process is listening is a test people skip, so the
 * default suite stays offline and fast, and this runs under `pnpm test:e2e:sync`.
 *
 * SERVED ON `localhost`, NOT `127.0.0.1`, on purpose. The deployed function's origin
 * allowlist admits `http://localhost:<port>` for a researcher running the page locally,
 * and the test server applies that same rule — so CORS is exercised here rather than
 * stepped around, and a page served from an unexpected host fails the way it would in
 * the field.
 */

const PORT = 4174;
/** The MyStory module, served beside the survey as it is in the field (`releases.spec.ts`). */
const MYSTORY_PORT = 4175;
const chromiumExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];

export default defineConfig({
  testDir: "./e2e-sync",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${PORT}/MySelf/`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
  ],
  webServer: [
    {
      // Built with the study endpoint baked in, the same way a real deployment bakes in
      // the project's — the app has no way to be pointed at one at runtime, deliberately.
      command:
        "pnpm --filter @myself/participant build && pnpm --filter @myself/participant preview --port 4174 --strictPort --host localhost",
      url: `http://localhost:${PORT}/MySelf/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        MYSELF_SITTINGS_URL: "http://127.0.0.1:4319/saveSitting",
        /**
         * The live version is read from the emulator (D-54, `releases.spec.ts`):
         * the project the emulator runs as, and the emulator's own address, which
         * `emulators:exec` hands over in FIRESTORE_EMULATOR_HOST. With nothing
         * published there, as in the other specs, the app runs its bundled release.
         */
        MYSELF_FIREBASE_CONFIG: JSON.stringify({ projectId: "demo-myself" }),
        MYSELF_FIRESTORE_HOST: `http://${process.env["FIRESTORE_EMULATOR_HOST"] ?? "127.0.0.1:8181"}`,
        // The module below. No release fielded so far places MyStory, so only a
        // version published in `releases.spec.ts` ever opens it.
        MYSELF_MYSTORY_URL: `http://localhost:${MYSTORY_PORT}/`,
        // Five seconds rather than two minutes, so the real checkpoint timer is exercised
        // without a test waiting on production cadence. Not lower: at two seconds a walk
        // of several minutes produced dozens of uploads, which made the suite slow and
        // told it nothing extra.
        MYSELF_CHECKPOINT_SECONDS: "5",
      },
    },
    {
      /**
       * The MyStory module, built as for Hosting (served from the root) and given no
       * model: no relay, no local server. So it never talks to anybody, and what is
       * exercised is the exchange with the survey — which protocol it runs, and that
       * it refuses one it should not run (D-54). Its `/api` proxy logs
       * ECONNREFUSED for port 4300 when the page looks for a local server: there
       * is none, on purpose.
       */
      command: `pnpm --filter @myself/mystory-lab build && pnpm --filter @myself/mystory-lab preview --port ${MYSTORY_PORT} --strictPort --host localhost`,
      url: `http://localhost:${MYSTORY_PORT}/`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { MYSELF_MYSTORY_BASE: "/", MYSELF_FIREBASE_CONFIG: "", MYSELF_RELAY_URL: "" },
    },
  ],
});
