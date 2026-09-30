import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { ENGINE_VERSION } from "@myself/engine";
import { bundledManifest } from "./lib/bundled.js";
import { choiceOptions } from "./lib/choice.js";
import { allowedHere, listenForDrafts, previewRequested } from "./lib/preview.js";
import { setRunningRelease } from "./lib/running.js";
import { updates } from "./lib/updates.js";
import { chooseRelease, type ChosenRelease } from "./lib/versions.js";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const preview = previewRequested(location.search);

/**
 * A new build is fetched as soon as it exists, so a device cannot keep serving a
 * cached one after a deploy and silently hide a fix from whoever is testing.
 *
 * WHEN IT IS APPLIED is `updates`' decision, not this file's — see the note
 * there. Reloading the moment a worker takes control looked right and put a child
 * answering question forty back on the start screen, and put the first
 * participant on every new iPad there too.
 *
 * Not in a preview, which keeps nothing on the device, the app's own files
 * included.
 */
if (!preview) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      void updateSW(true);
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      void registration.update();
      setInterval(() => void registration.update(), 60_000);
    },
  });

  navigator.serviceWorker?.addEventListener("controllerchange", () => updates.tookOver());
}

/**
 * The version is settled before the app is loaded, because the app builds its
 * screens from the manifest as it loads (`lib/running.ts`). Until then the page
 * shows the "Getting ready" line in index.html, never nothing.
 */
async function start(release: ChosenRelease): Promise<void> {
  setRunningRelease(release);
  const { default: App } = await import("./App.js");
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

function say(message: string): void {
  root.render(<p className="booting">{message}</p>);
}

if (preview) {
  /**
   * The first good draft starts the app. After that, a different draft, or one
   * that no longer works, reloads the page: it says it is ready again, and the
   * dashboard answers with its current draft. The app's screens are built once,
   * at load, so starting again is how a changed draft is shown.
   */
  let running: string | null = null;
  say("Waiting for the draft from the survey editor…");
  listenForDrafts(window, {
    allowed: allowedHere,
    engineVersion: ENGINE_VERSION,
    onDraft: (draft) => {
      if (running === null) {
        if (!draft.ok) {
          say(`This draft cannot be previewed: ${draft.problem}`);
          return;
        }
        running = JSON.stringify(draft.manifest);
        void start({ manifest: draft.manifest, origin: "preview" });
        return;
      }
      if (!draft.ok || JSON.stringify(draft.manifest) !== running) location.reload();
    },
  });
} else {
  void chooseRelease(choiceOptions)
    // Nothing in there is meant to throw. If something does, the built-in
    // release is always to hand, and a survey beats a blank screen.
    .catch((): ChosenRelease => ({ manifest: bundledManifest, origin: "bundled" }))
    .then((release) => {
      if (release.note) console.info(`MySelf: ${release.note}`);
      return start(release);
    });
}
