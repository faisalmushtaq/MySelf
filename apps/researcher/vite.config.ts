import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { auditPreviewBundle, type ChunkLike } from "./src/studio/preview/bundle-guard.js";

// The researcher view is published beside the participant app, one level down,
// so the two never share a service-worker scope or a storage origin path.
const base = process.env["MYSELF_RESEARCHER_BASE"] ?? "/MySelf/researcher/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The Studio's preview frame must never be able to store or send an answer
 * (docs/16 risk R7). This fails the build if the frame's bundle reaches any
 * of the participant's storage or upload code — see bundle-guard.ts.
 */
function previewIsolation(): Plugin {
  return {
    name: "myself-preview-isolation",
    apply: "build",
    generateBundle(_options, bundle) {
      const problems = auditPreviewBundle(bundle as unknown as Record<string, ChunkLike | { type: "asset" }>);
      if (problems.length > 0) {
        this.error(`The Studio preview frame could reach production storage:\n${problems.join("\n")}`);
      }
    },
  };
}

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
    // MySelf Studio. Emulators only for local runs and the end-to-end tests:
    // left empty, the build contains no emulator or test sign-in code at all.
    __STUDIO_EMULATORS__: JSON.stringify(process.env["MYSELF_STUDIO_EMULATORS"] ?? ""),
    __SURVEY_ID__: JSON.stringify(process.env["MYSELF_SURVEY_ID"] ?? "ybm_nd2026_standard"),
  },
  resolve: {
    // The Studio's preview renders the participant's own screens from their
    // source, so what a researcher previews cannot drift from what a
    // participant sees. One copy of React between the two, or hooks break.
    alias: [{ find: /^@participant\//, replacement: `${here("../participant/src")}/` }],
    dedupe: ["react", "react-dom"],
  },
  build: {
    rollupOptions: {
      // Two pages: the researcher view, and the preview frame the Studio
      // embeds — a separate document so the participant's stylesheet applies
      // there and nowhere else.
      input: { main: here("index.html"), preview: here("preview.html") },
    },
  },
  plugins: [react(), previewIsolation()],
  // The repository root too, as the participant app allows: pnpm keeps the
  // participant stylesheet's fonts under the root node_modules, and the dev
  // server otherwise refuses them to the preview frame.
  server: { fs: { allow: ["..", "../.."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
