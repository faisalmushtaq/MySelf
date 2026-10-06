import React from "react";
import { createRoot } from "react-dom/client";
import { Workbox } from "workbox-window";
import { readParticipantLink } from "@myself/schema";
import App, { type Startup } from "./App.js";
import { BUILT_IN, type LoadedRelease } from "./lib/releases.js";
import { buildRuntime, type Runtime } from "./lib/runtime.js";
import { DEFAULT_CHOICE, serviceFor, storedChoice } from "./lib/selection.js";
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
 * survey it runs and which release is active. Local only — the study is never
 * asked before the first render — and bounded all the same, because an
 * IndexedDB that hangs must not leave a child looking at a blank page. Past it
 * the default survey's built-in release is shown, and App moves to whatever the
 * iPad was set to as soon as it can be read (`late`).
 */
const STARTUP_RELEASE_WAIT_MS = 1_500;

/**
 * The participant link in the address, read once (D-56, docs/16 §11.2). Only
 * read here: what to do with it is App's, once it knows where the iPad is.
 */
const link = readParticipantLink(window.location.search, DEFAULT_CHOICE.study);

async function fromStorage(): Promise<Startup> {
  const { choice, row } = await storedChoice();
  const release: LoadedRelease | null = await serviceFor(choice).resolveStartupRelease();
  return { choice, row, release, link, late: false };
}

function startup(): Promise<Startup> {
  const fallback: Startup = { choice: DEFAULT_CHOICE, row: undefined, release: BUILT_IN, link, late: true };
  const timeout = new Promise<Startup>((resolve) => setTimeout(() => resolve(fallback), STARTUP_RELEASE_WAIT_MS));
  return Promise.race([fromStorage(), timeout]).catch(() => fallback);
}

function runtimeOf(release: LoadedRelease | null): Runtime | null {
  if (!release) return null;
  try {
    return buildRuntime(release.manifest, release.source);
  } catch {
    return null;
  }
}

void startup().then((initial) => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App initial={initial} initialRuntime={runtimeOf(initial.release)} />
    </React.StrictMode>,
  );
});
