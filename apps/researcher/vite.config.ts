import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The researcher view is published beside the participant app, one level down,
// so the two never share a service-worker scope or a storage origin path.
const base = process.env["MYSELF_RESEARCHER_BASE"] ?? "/MySelf/researcher/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

export default defineConfig({
  base,
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp) },
  plugins: [react()],
  server: { fs: { allow: [".."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
