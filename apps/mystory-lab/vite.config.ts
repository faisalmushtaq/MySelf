import { defineConfig } from "vite";

// MyStory, published beside MyThoughts and the researcher view.
const base = process.env["MYSELF_MYSTORY_BASE"] ?? "/MySelf/mystory/";

export default defineConfig({
  base,
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  // The Node server, when one is running, holds the API key and answers here.
  server: { proxy: { "/api": "http://localhost:4300" } },
});
