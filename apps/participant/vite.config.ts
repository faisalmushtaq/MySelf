import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Base path: GitHub Pages serves the app at /<repo-name>/.
const base = process.env["MYSELF_BASE"] ?? "/MySelf/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  base,
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
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
