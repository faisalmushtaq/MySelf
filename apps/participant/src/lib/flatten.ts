/**
 * The manifest's walk now lives in the engine, so ingest reads a sitting
 * through exactly the units the device walked (see @myself/engine flatten.ts).
 */
export { flattenManifest, reminderOf, type FlattenedRelease } from "@myself/engine";
