import base from "./playwright.studio.config.js";

/**
 * The Studio screenshot run: the same built site and emulators as the Studio
 * end-to-end suite, but photographing every screen instead of testing a flow.
 * `pnpm test:studio:shots`; pictures in STUDIO_SHOTS_DIR.
 */
export default {
  ...base,
  testDir: "./e2e-studio/shots",
  testIgnore: [],
  timeout: 600_000,
};
