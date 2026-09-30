/**
 * The platform's one seam onto @myself/studio's diff and history modules.
 *
 * It began as a temporary stand-in while the model was built in parallel; the
 * model is merged now, so these are the real functions — the same ones the
 * publish function uses to decide a version bump and which IDs are reserved.
 * Screens import them from here so that stays true in one place.
 */
export { diffDrafts, manifestIndex, publishedScaleCodes, reservedFrom } from "@myself/studio";
