import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Base path: GitHub Pages serves the app at /<repo-name>/.
const base = process.env["MYSELF_BASE"] ?? "/MySelf/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  base,
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp) },
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
      },
    }),
  ],
  server: { fs: { allow: [".."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
