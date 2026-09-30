import { ENGINE_VERSION } from "@myself/engine";
import { bundledManifest } from "./bundled.js";
import { lastActiveRelease, setLastActiveRelease, storeRelease, storedReleaseJson, takeResume } from "./db.js";
import { configuredStudy, studySource } from "./published.js";
import type { ChoiceOptions } from "./versions.js";

/**
 * How this device looks up and keeps versions (D-54): the rules in
 * `versions.ts`, wired to the study's database and to IndexedDB.
 *
 * `main.tsx` uses it at start-up, and App asks the same question again after a
 * handover to learn whether a different version has been made active.
 */
export const choiceOptions: ChoiceOptions = {
  bundled: bundledManifest,
  source: (() => {
    const study = configuredStudy();
    return study ? studySource(study) : null;
  })(),
  device: {
    get: storedReleaseJson,
    put: (manifest, json) => storeRelease(manifest.hash ?? "", manifest.release.version, manifest.release.key, json),
    lastActive: lastActiveRelease,
    setLastActive: setLastActiveRelease,
    takeResume: () => takeResume(),
  },
  engineVersion: ENGINE_VERSION,
};
