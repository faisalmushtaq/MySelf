import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Package the functions for deployment.
 *
 * Firebase uploads the functions directory and runs `npm install` inside
 * Google's build environment. Our five `workspace:*` dependencies mean nothing
 * there, so a deploy straight from `apps/functions` fails — and it fails at
 * the end of a long upload, with a message about a missing package rather than
 * about the workspace.
 *
 * So the whole thing is bundled into one file with the workspace packages
 * inlined, and deployed from a directory whose package.json names only what
 * npm can actually fetch. `firebase-admin` and `firebase-functions` stay
 * external because the runtime provides them and bundling them fights the
 * emulator's instrumentation.
 *
 * The release manifests are imported as JSON and get inlined too, which is
 * what keeps a function that runs at two in the morning from depending on
 * anything being reachable.
 */

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here("./deploy");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const runtimeDeps = { "firebase-admin": "^13.0.0", "firebase-functions": "^6.1.0" };

await build({
  entryPoints: [here("./src/index.ts")],
  outfile: `${out}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: Object.keys(runtimeDeps),
  loader: { ".json": "json" },
  // Named so a stack trace from production points at a real line.
  sourcemap: true,
  logLevel: "info",
});

writeFileSync(
  `${out}/package.json`,
  `${JSON.stringify(
    {
      name: "myself-functions",
      private: true,
      type: "module",
      main: "index.js",
      engines: { node: "22" },
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
);

console.log(`packaged into ${out}`);
