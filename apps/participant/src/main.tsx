import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.js";
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
 */
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
