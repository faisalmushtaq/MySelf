/**
 * The Studio data layer's public surface.
 *
 * The screens import from here and nowhere else in data/: the signatures are
 * the contract they were written against (types.ts), and the Firebase-backed
 * implementations live in the sibling files re-exported below.
 *
 * - session.tsx       who is signed in and their role (studioSession)
 * - hooks.ts          live reads: surveys, versions, audit, presence, members…
 * - releases.ts       published releases by hash, verified before use
 * - draft-editor.ts   the working draft and its save engine (save-machine.ts)
 * - callables.ts      the trusted operations (`studio.*`)
 * - errors.ts         Firebase errors in plain English
 * - model-adapter.ts  TEMPORARY seam to @myself/studio's diff/history modules
 */

export * from "./types.js";
export { useMemoryDraftEditor } from "./memory.js";
export { StudioCallError } from "./errors.js";
export { StudioDataProvider, useStudioSession } from "./session.js";
export {
  loadAudit,
  useAccessConfig,
  useAudit,
  useMembers,
  useOnline,
  usePresence,
  usePublishedContext,
  usePublishedManifest,
  useResponseStats,
  useSurvey,
  useSurveys,
  useVersions,
} from "./hooks.js";
export { useDraftEditor } from "./draft-editor.js";
export { studio } from "./callables.js";
