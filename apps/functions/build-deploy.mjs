import { execFileSync } from "node:child_process";
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

/**
 * Which source this bundle was built from.
 *
 * A functions deploy bundles the working tree, not a branch — so "I merged the
 * fix" and "the fix is deployed" are different claims, and the gap between
 * them is invisible from the outside. This has already cost a round: a fix was
 * merged, deployed minutes later from a checkout that predated it, and then
 * debugged as though it were live.
 *
 * The commit and whether the tree was dirty are enough to settle it. Neither
 * is sensitive: the repository is the same one the deploy came from.
 */
function sourceStamp() {
  const git = (...args) => execFileSync("git", args, { cwd: here("."), encoding: "utf8" }).trim();
  let commit = "unknown";
  let dirty = false;
  try {
    commit = git("rev-parse", "--short", "HEAD");
    dirty = git("status", "--porcelain").length > 0;
  } catch {
    // A tarball rather than a checkout. Say so instead of inventing a commit.
  }
  return { built: new Date().toISOString().replace(/\.\d+Z$/, "Z"), commit, dirty };
}

const stamp = sourceStamp();

/**
 * Inside the Firebase project directory, not beside the source.
 *
 * The CLI refuses a `source` outside the directory holding firebase.json —
 * "is outside of project directory" — so a bundle written next to the
 * TypeScript cannot be deployed however correct it is. It goes where the CLI
 * will look, and is gitignored: it is build output, not source.
 */
const out = here("../../infra/firebase/functions");

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
  define: { __RELAY_BUILD__: JSON.stringify(stamp) },
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

/**
 * The settings the functions read, carried into their environment.
 *
 * The Firebase CLI deploys a `.env` it finds in the functions directory as the
 * functions' environment, and this directory is rebuilt from nothing on every
 * deploy — so without this, a limit could only ever be its default, and the way
 * to switch participants' devices off (D-55, docs/15 §10) would be a code change.
 *
 * So the spending limits are read from THIS process's environment and written
 * there: a repository variable in the deploy workflow, or a variable set in the
 * shell of whoever deploys by hand. Only the names listed, so nothing else in a
 * deploy machine's environment — a token, a path — can end up in a function.
 * An empty value is left out rather than written, because an unset repository
 * variable arrives as an empty string and must mean "the default", not "0".
 */
const SETTINGS = ["MYSELF_RELAY_DAILY_LIMIT", "MYSELF_RELAY_DEVICE_DAILY_LIMIT", "MYSELF_RELAY_DEVICES_DAILY_LIMIT"];
const settings = SETTINGS.filter((name) => (process.env[name] ?? "").trim() !== "").map(
  (name) => `${name}=${process.env[name].trim()}`,
);
if (settings.length > 0) {
  writeFileSync(`${out}/.env`, `${settings.join("\n")}\n`);
  console.log(`functions environment: ${settings.join(", ")}`);
}

/**
 * Install the two runtime dependencies, here, before deploying.
 *
 * Not for the cloud — Google installs them again from the package.json above.
 * For the CLI: it loads the bundle in this directory and reads which functions
 * it exports, to decide what to create, update and leave alone. Without
 * node_modules it cannot, and says "Couldn't find firebase-functions package
 * in your source code" followed by an unexplained failure.
 *
 * npm rather than pnpm, because pnpm's symlinked layout is not what the
 * uploaded tarball should contain.
 */
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
  cwd: out,
  stdio: "inherit",
});

console.log(`packaged into ${out}`);
