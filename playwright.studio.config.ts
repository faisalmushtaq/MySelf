import { defineConfig, devices } from "@playwright/test";

/**
 * MySelf Studio, end to end, against the Firebase emulators (docs/16 §9).
 *
 * The whole loop the Studio exists for, with nothing mocked between the browser
 * and the database: a researcher signs in, edits the draft, previews it, is
 * stopped by validation, fixes it, publishes; the public survey link then loads
 * the new version, and a sitting taken on it is filed stamped with that
 * version — while a sitting recorded before any of this stays byte-for-byte as
 * it was.
 *
 * Run it with `pnpm test:e2e:studio`, which packages the functions and starts the
 * Auth, Firestore and Functions emulators around this suite. The builds point
 * the apps at those emulators: the Studio through its emulator config (which is
 * the only thing that turns its test sign-in on), the participant app through
 * the survey source and upload URLs a real build derives from the project.
 */

const PORT = 4175;
const chromiumExecutable = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
const PROJECT = "demo-myself";

const emulators = {
  auth: "http://127.0.0.1:9099",
  firestore: { host: "127.0.0.1", port: 8181 },
  functions: { host: "127.0.0.1", port: 5001 },
};

export default defineConfig({
  testDir: "./e2e-studio",
  // The screenshot run lives beside the suite but is not part of it.
  testIgnore: ["**/shots/**"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  timeout: 300_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}/MySelf/`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
  ],
  webServer: {
    command:
      "pnpm --filter @myself/participant build && pnpm --filter @myself/researcher build && node e2e-studio/support/site.mjs",
    url: `http://localhost:${PORT}/MySelf/`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      MYSELF_FIREBASE_CONFIG: JSON.stringify({ apiKey: "demo-api-key", authDomain: "localhost", projectId: PROJECT }),
      MYSELF_STUDIO_EMULATORS: JSON.stringify(emulators),
      MYSELF_SURVEY_SOURCE: `http://127.0.0.1:8181/v1/projects/${PROJECT}/databases/(default)/documents/studies/ybm`,
      MYSELF_SITTINGS_URL: `http://127.0.0.1:5001/${PROJECT}/europe-west2/saveSitting`,
      MYSELF_MYSTORY_URL: "",
      MYSELF_CHECKPOINT_SECONDS: "5",
      STUDIO_SITE_PORT: String(PORT),
    },
  },
});
