import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Base path: GitHub Pages serves the app at /<repo-name>/.
const base = process.env["MYSELF_BASE"] ?? "/MySelf/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

/**
 * The project this build files its sittings into.
 *
 * Only used to work out the endpoint below — the app carries no Firebase SDK and
 * signs in to nothing, because a device presents a credential it issued itself.
 * That keeps the whole auth library out of a bundle whose first requirement is to
 * work with no network.
 *
 * Absent, this build stores everything on the device and sends nothing anywhere,
 * which is exactly what the public preview should be.
 */
const firebaseConfig = process.env["MYSELF_FIREBASE_CONFIG"] ?? "";

/**
 * Where sittings go.
 *
 * Derived from the project rather than copied: a function deployed to
 * europe-west2 answers at
 * `https://europe-west2-<project>.cloudfunctions.net/saveSitting`, so knowing
 * the project is knowing the URL, and one fewer value to carry between a console
 * and a build is one fewer place to get it wrong. `MYSELF_SITTINGS_URL`
 * overrides it for an emulator or a function deployed elsewhere.
 */
function deriveSittingsUrl(): string {
  const explicit = process.env["MYSELF_SITTINGS_URL"];
  if (explicit) return explicit;
  try {
    const projectId = (JSON.parse(firebaseConfig || "null") as { projectId?: string } | null)?.projectId;
    return projectId ? `https://europe-west2-${projectId}.cloudfunctions.net/saveSitting` : "";
  } catch {
    return "";
  }
}

/**
 * Where the live version is read from (D-54).
 *
 * The project's own Firestore, derived from the same config as the upload
 * endpoint, so a build reads its questionnaire from the study it files into
 * and from nowhere else. No project, and the build runs the release bundled
 * into it and asks nobody, which is what the public preview should do.
 * `MYSELF_FIRESTORE_HOST` points a test build at the emulator.
 */
function deriveFirebaseProject(): string {
  try {
    return (JSON.parse(firebaseConfig || "null") as { projectId?: string } | null)?.projectId ?? "";
  } catch {
    return "";
  }
}

export default defineConfig({
  base,
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
    __FIREBASE_PROJECT__: JSON.stringify(deriveFirebaseProject()),
    __FIRESTORE_HOST__: JSON.stringify(process.env["MYSELF_FIRESTORE_HOST"] ?? "https://firestore.googleapis.com"),
    // One study per project, as in the functions and the researcher view.
    __STUDY__: JSON.stringify(process.env["MYSELF_STUDY"] ?? "ybm"),
    /**
     * Extra pages allowed to send this app a draft to preview, beyond the
     * dashboard's own (lib/preview.ts). For a test build that serves its own
     * stand-in dashboard; empty in every deployed build.
     */
    __PREVIEW_ORIGINS__: JSON.stringify(process.env["MYSELF_PREVIEW_ORIGINS"] ?? ""),
    /**
     * Where the narrative module is served from.
     *
     * Baked in rather than typed into the page, for the same reason the relay
     * URL is: the survey must not be a place where somebody can point a
     * child's conversation at a host of their choosing. Empty means this build
     * has no module, and a narrative position says so instead of showing an
     * empty frame.
     */
    __MYSTORY_URL__: JSON.stringify(process.env["MYSELF_MYSTORY_URL"] ?? ""),
    __SITTINGS_URL__: JSON.stringify(deriveSittingsUrl()),
    /**
     * How often a sitting still being answered is copied to the study.
     *
     * A fielding decision rather than a constant: it trades how much a dropped iPad
     * costs against how much traffic a hall of thirty devices puts on one access
     * point. Two minutes is the default because a lost two minutes of answers is
     * recoverable by asking the participant, and a lost morning is not.
     *
     * It is also the seam that makes checkpointing testable — the alternative is a
     * test that waits two real minutes to watch a timer fire.
     */
    __CHECKPOINT_SECONDS__: JSON.stringify(Number(process.env["MYSELF_CHECKPOINT_SECONDS"] ?? 120)),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "MySelf",
        short_name: "MySelf",
        description: "MySelf research platform — participant application",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        background_color: "#faf6f0",
        theme_color: "#faf6f0",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,json,woff2}"],
        // The bundled release manifest must be available offline.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        /**
         * The other apps live under this service worker's scope, and must not
         * be swallowed by it.
         *
         * Workbox answers every navigation inside the scope with this app's
         * index.html, so it can work offline in a school hall with no network.
         * That is right for the survey and catastrophic for its neighbours:
         * without this denylist, /researcher/ and /narrative/ both served the
         * questionnaire to anyone whose browser had ever cached it. It looked
         * fine on a plain preview server, where no service worker exists —
         * which is exactly why it survived to be deployed.
         */
        navigateFallbackDenylist: [
          new RegExp(`^${base.replace(/\/$/, "")}/(researcher|mystory)(/|$)`),
        ],
      },
    }),
  ],
  server: { fs: { allow: ["..", "../.."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
