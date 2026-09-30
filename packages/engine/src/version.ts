/**
 * This engine's version, which a release names as `engineVersion`.
 *
 * A constant rather than a read of `package.json`, because the iPad has no
 * package file to read. `version.test.ts` holds the two together, so bumping
 * one without the other fails the tests. A device uses this to decide whether
 * it can run a version published from the dashboard (D-54, `engineCanRun` in
 * `@myself/schema`), so a mismatch would be a device refusing, or accepting, the
 * wrong releases.
 */
export const ENGINE_VERSION = "0.3.0";
