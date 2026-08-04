import { defineConfig } from "vitest/config";

// The gateway's behaviour is exercised end-to-end through @myself/narrative,
// which drives it with the deterministic mock across every failure mode.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], passWithNoTests: true },
});
