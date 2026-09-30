import type { ChosenRelease } from "./versions.js";

/**
 * The version this page is running, chosen once before the app is loaded.
 *
 * `App.tsx` derives its screens from the manifest at module level, so the
 * manifest has to be settled before that module is evaluated. `main.tsx`
 * chooses it (or receives a preview draft), puts it here, and only then imports
 * the app. A different version later means a reload, at the start screen, which
 * is the only moment switching costs nobody anything.
 */

let chosen: ChosenRelease | null = null;

export function setRunningRelease(release: ChosenRelease): void {
  chosen = release;
}

export function runningRelease(): ChosenRelease {
  if (!chosen) throw new Error("the version to run is chosen in main.tsx before the app is loaded");
  return chosen;
}
