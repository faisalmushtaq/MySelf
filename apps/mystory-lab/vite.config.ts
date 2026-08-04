import { defineConfig } from "vite";

// MyStory, published beside MyThoughts and the researcher view.
const base = process.env["MYSELF_MYSTORY_BASE"] ?? "/MySelf/mystory/";

/**
 * The relay, when this build is meant to reach one.
 *
 * Baked in at build time rather than typed in the page: the page must not be a
 * place where somebody can point the study at an endpoint of their choosing.
 * Absent, the built page runs the mock, which is what the public preview is.
 */
const relayUrl = process.env["MYSELF_RELAY_URL"] ?? "";

export default defineConfig({
  base,
  define: { __RELAY_URL__: JSON.stringify(relayUrl) },
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  // The Node server, when one is running, holds the API key and answers here.
  server: { proxy: { "/api": "http://localhost:4300" } },
});
