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
    /**
     * The SAME origin this build is served from, not the .firebaseapp.com one.
     *
     * This is the point of the whole file and it was half done. Sign-in
     * completes by handing off to `/__/auth/handler` on the authDomain and
     * handing back; with the app on `myself-research.web.app` and the handler
     * on `myself-research.firebaseapp.com`, those are two origins, and Safari
     * partitions storage between them. The handler cannot read the state it
     * just wrote — "Unable to process request due to missing initial state" —
     * and on the Home Screen, where sign-in has to go by redirect, that is the
     * difference between it working and it silently forgetting you.
     *
     * Firebase Hosting serves the auth handler on every site of the project,
     * and a project's own `.web.app` domain is authorised by default, so this
     * needs nothing switched on in the console. A deployment on a custom
     * domain must set `MYSELF_FIREBASE_CONFIG` with that domain here, and add
     * it under Authentication → Settings → Authorised domains.
     */
    authDomain: "myself-research.web.app",
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
