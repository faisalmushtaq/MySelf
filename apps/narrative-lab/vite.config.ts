import { defineConfig } from "vite";

// Published beside the participant app and the researcher view.
const base = process.env["MYSELF_NARRATIVE_BASE"] ?? "/MySelf/narrative/";

export default defineConfig({
  base,
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  // The Node server, when one is running, holds the API key and answers here.
  server: { proxy: { "/api": "http://localhost:4300" } },
});
