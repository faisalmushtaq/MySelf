import { defineConfig } from "vitest/config";

// `passWithNoTests`: the functions themselves are thin wiring over
// @myself/store and @myself/firebase, which carry the logic and its tests.
// What is left here — IAM boundaries, triggers, schedules — is exercised
// against the emulator by the rules suite and by deployment, not by unit tests.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], passWithNoTests: true },
});
