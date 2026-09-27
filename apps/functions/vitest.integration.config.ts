import { defineConfig } from "vitest/config";

/**
 * The integration suite, against a real Firestore.
 *
 * Separate from `vitest.config.ts` because it needs an emulator running and the
 * unit suite must not: a test that only runs when a Java process is listening is a
 * test people skip. `pnpm test` stays fast and offline; `pnpm test:integration`
 * starts the emulator around this.
 *
 * What it buys over the fake Firestore the unit tests use: real transaction
 * contention, real document-size limits, real batch semantics, and the actual
 * behaviour of `FieldValue.serverTimestamp()`. The collision rule is decided inside
 * a transaction, and a stand-in cannot prove that two devices uploading at the same
 * instant resolve to one winner — only a database can.
 */
export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    setupFiles: ["./integration/quiet.ts"],
    // A real database, one emulator, and tests that deliberately race each other.
    // Parallel files would race over the same documents and prove nothing.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
