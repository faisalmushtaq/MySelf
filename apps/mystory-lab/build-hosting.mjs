import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Build the lab for Firebase Hosting, and put it where the CLI will find it.
 *
 * Two things differ from the GitHub Pages build, and both are the reason this
 * exists at all.
 *
 * IT IS SERVED AT THE ROOT, not under /MySelf/mystory/, so the base changes.
 *
 * AND IT SHARES AN ORIGIN WITH THE AUTH HANDLER. Firebase sign-in completes by
 * redirecting through <project>.firebaseapp.com and handing back; on GitHub
 * Pages those are different origins, and iOS Safari partitions storage between
 * them, so the handler cannot read the state it just wrote — "Unable to
 * process request due to missing initial state". Served from the project's own
 * hosting, there is one origin and nothing to partition.
 *
 * The Pages build stays exactly as it is: the public, mock-only preview needs
 * no sign-in, works on every device, and is the link that gets shared.
 */

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../infra/firebase/public");

/**
 * The project this build signs into.
 *
 * Defaulted rather than required, because a hosting build without it would be
 * mock-only — which is the one thing this build exists NOT to be — and because
 * a Firebase web config is a set of public identifiers that ships inside the
 * JavaScript anyway. `MYSELF_FIREBASE_CONFIG` overrides it for another project.
 */
const firebaseConfig =
  process.env.MYSELF_FIREBASE_CONFIG ??
  JSON.stringify({
    apiKey: "AIzaSyCqcaFWJMobljhX63s--l4NEPZV6IXWJvM",
    authDomain: "myself-research.firebaseapp.com",
    projectId: "myself-research",
  });

execFileSync("pnpm", ["exec", "vite", "build"], {
  cwd: here("."),
  stdio: "inherit",
  env: { ...process.env, MYSELF_MYSTORY_BASE: "/", MYSELF_FIREBASE_CONFIG: firebaseConfig },
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(here("./dist"), out, { recursive: true });

console.log(`packaged for hosting into ${out}`);
