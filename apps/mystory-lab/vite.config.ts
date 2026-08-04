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
const firebaseConfigRaw = process.env["MYSELF_FIREBASE_CONFIG"] ?? "";

/**
 * Where the relay lives.
 *
 * Derived from the project when it is not given explicitly: a function
 * deployed to europe-west2 answers at
 * `https://europe-west2-<project>.cloudfunctions.net/llmRelay`, so knowing the
 * project is knowing the URL, and one fewer value to copy between a console
 * and a build is one fewer place to get it wrong. `MYSELF_RELAY_URL` overrides
 * it for anyone running the function somewhere else.
 */
function deriveRelayUrl(): string {
  const explicit = process.env["MYSELF_RELAY_URL"];
  if (explicit) return explicit;
  try {
    const projectId = (JSON.parse(firebaseConfigRaw || "null") as { projectId?: string } | null)?.projectId;
    return projectId ? `https://europe-west2-${projectId}.cloudfunctions.net/llmRelay` : "";
  } catch {
    return "";
  }
}

const relayUrl = deriveRelayUrl();

/**
 * When this page was built.
 *
 * Shown in the corner, because "is the change I just merged actually live?"
 * has no answer from a page that looks the same either way — and a stale
 * service worker or a deploy still running are indistinguishable from a bug
 * until you can read a timestamp off the thing in front of you.
 */
const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

/**
 * The Firebase web config, so the page can sign somebody in.
 *
 * None of it is secret — a web config is a set of public identifiers, and the
 * `apiKey` names a project rather than authorising anything. It is baked in at
 * build time so nobody can point this page at a different project.
 */
const firebaseConfig = firebaseConfigRaw;

export default defineConfig({
  base,
  define: {
    __RELAY_URL__: JSON.stringify(relayUrl),
    __FIREBASE_CONFIG__: JSON.stringify(firebaseConfig),
    __BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  // The Node server, when one is running, holds the API key and answers here.
  server: { proxy: { "/api": "http://localhost:4300" } },
});
