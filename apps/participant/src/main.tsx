import React from "react";
import { createRoot } from "react-dom/client";
import { Workbox } from "workbox-window";
import App from "./App.js";
import { BUILT_IN, resolveStartupRelease, type LoadedRelease } from "./lib/releases.js";
import { buildRuntime, type Runtime } from "./lib/runtime.js";
import { updates } from "./lib/updates.js";
import "./styles.css";

/**
 * A new build is fetched as soon as it exists, so a device cannot keep serving a
 * cached one after a deploy and silently hide a fix from whoever is testing.
 *
 * WHEN IT IS APPLIED is `updates`' decision, not this file's — see the note
 * there. Reloading the moment a worker takes control looked right and put a child
 * answering question forty back on the start screen, and put the first
 * participant on every new iPad there too.
 *
 * Registered with workbox-window directly rather than the plugin's
 * `virtual:pwa-register`, whose registration reloads the page by itself when a
 * newer worker takes control (see vite.config.ts). Here the worker waits, is
 * reported to `updates`, and is told to take over only when the gate allows;
 * the one reload that follows goes through the gate as well.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const wb = new Workbox(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
  const reportWaiting = () => updates.buildWaiting(() => wb.messageSkipWaiting());
  wb.addEventListener("waiting", reportWaiting);
  wb.register({ immediate: true })
    .then((registration) => {
      if (!registration) return;
      /**
       * Looked at directly as well as through the event: workbox-window stops
       * reporting builds found by a later `update()` after the first one, and a
       * page left open across two deploys would otherwise never hear of the
       * second. Reporting the same waiting build twice is harmless.
       */
      const poll = () =>
        void registration
          .update()
          .catch(() => undefined)
          .then(() => {
            if (registration.waiting) reportWaiting();
          });
      poll();
      setInterval(poll, 60_000);
    })
    .catch(() => undefined);
}

registerServiceWorker();
navigator.serviceWorker?.addEventListener("controllerchange", () => updates.tookOver());

/**
 * How long the first screen may wait for this device's own storage to say which
 * release is active. Local only — the study is never asked before the first
 * render — and bounded all the same, because an IndexedDB that hangs must not
 * leave a child looking at a blank page. Past it the built-in release is shown,
 * and the start screen switches to the active one as soon as it can be read.
 */
const STARTUP_RELEASE_WAIT_MS = 1_500;

function startupRelease(): Promise<LoadedRelease> {
  const fallback = new Promise<LoadedRelease>((resolve) => setTimeout(() => resolve(BUILT_IN), STARTUP_RELEASE_WAIT_MS));
  return Promise.race([resolveStartupRelease(), fallback]).catch(() => BUILT_IN);
}

function runtimeOf(release: LoadedRelease): Runtime {
  try {
    return buildRuntime(release.manifest, release.source);
  } catch {
    return buildRuntime(BUILT_IN.manifest, "built-in");
  }
}

void startupRelease().then((release) => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App initialRuntime={runtimeOf(release)} />
    </React.StrictMode>,
  );
});
