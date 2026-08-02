import React from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.js";
import "./styles.css";

/**
 * Service-worker updates are applied as soon as they exist, and the page
 * reloads onto the new build. Without this a device can keep serving a cached
 * build after a deploy — which silently hides fixes from anyone testing.
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

let reloading = false;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (reloading) return;
  reloading = true;
  location.reload();
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
