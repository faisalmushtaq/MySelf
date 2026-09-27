import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The researcher view is published beside the participant app, one level down,
// so the two never share a service-worker scope or a storage origin path.
const base = process.env["MYSELF_RESEARCHER_BASE"] ?? "/MySelf/researcher/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  base,
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
    // Public identifiers, baked in rather than typed into the page — same
    // reasoning as the participant app and the narrative module.
    __FIREBASE_CONFIG__: JSON.stringify(process.env["MYSELF_FIREBASE_CONFIG"] ?? ""),
    // One study per project keeps IAM simple, so this matches MYSELF_STUDY on
    // the functions rather than being chosen in the browser.
    __STUDY__: JSON.stringify(process.env["MYSELF_STUDY"] ?? "ybm"),
  },
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
