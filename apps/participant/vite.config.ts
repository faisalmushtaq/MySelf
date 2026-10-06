import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Base path: GitHub Pages serves the app at /<repo-name>/.
const base = process.env["MYSELF_BASE"] ?? "/MySelf/";

const buildStamp = new Date().toISOString().slice(0, 16).replace("T", " ");

/**
 * The project this build files its sittings into.
 *
 * Only used to work out the endpoint below — the app carries no Firebase SDK and
 * signs in to nothing, because a device presents a credential it issued itself.
 * That keeps the whole auth library out of a bundle whose first requirement is to
 * work with no network.
 *
 * Absent, this build stores everything on the device and sends nothing anywhere,
 * which is exactly what the public preview should be.
 */
const firebaseConfig = process.env["MYSELF_FIREBASE_CONFIG"] ?? "";

/**
 * Where sittings go.
 *
 * Derived from the project rather than copied: a function deployed to
 * europe-west2 answers at
 * `https://europe-west2-<project>.cloudfunctions.net/saveSitting`, so knowing
 * the project is knowing the URL, and one fewer value to carry between a console
 * and a build is one fewer place to get it wrong. `MYSELF_SITTINGS_URL`
 * overrides it for an emulator or a function deployed elsewhere.
 */
function deriveSittingsUrl(): string {
  const explicit = process.env["MYSELF_SITTINGS_URL"];
  if (explicit) return explicit;
  try {
    const projectId = (JSON.parse(firebaseConfig || "null") as { projectId?: string } | null)?.projectId;
    return projectId ? `https://europe-west2-${projectId}.cloudfunctions.net/saveSitting` : "";
  } catch {
    return "";
  }
}

/**
 * Where the survey itself is read from (docs/16 §5.3).
 *
 * The study's public, get-only documents — the `published/{surveyId}` pointer
 * and the `publicReleases/{hash}` store — through the Firestore REST API, with
 * plain `fetch` and no SDK, for the same reasons as the sittings endpoint above.
 * Derived from the project in the same way, so a build that knows where to send
 * sittings also knows where the survey is published. `MYSELF_STUDY` names the
 * study document the collections live under; `MYSELF_SURVEY_SOURCE` overrides the
 * whole thing, for an emulator or for the e2e suite's stand-in.
 *
 * EMPTY MEANS NEVER ASK. The public preview and the e2e build have no project,
 * and run the release compiled into them exactly as every build before this did.
 */
function deriveSurveySource(): string {
  const explicit = process.env["MYSELF_SURVEY_SOURCE"];
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const projectId = (JSON.parse(firebaseConfig || "null") as { projectId?: string } | null)?.projectId;
    const study = process.env["MYSELF_STUDY"] || "ybm";
    return projectId
      ? `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/studies/${study}`
      : "";
  } catch {
    return "";
  }
}

/**
 * Where any study's public documents are read from (D-56, docs/16 §11.3): the
 * parent of `studies/{study}`, so a participant link can name a study other
 * than this build's own. Derived from the project like the source above;
 * `MYSELF_STUDIES_SOURCE` overrides it (the e2e suite's stand-in), and a
 * `MYSELF_SURVEY_SOURCE` that ends in `/studies/<the default>` gives its parent.
 *
 * Only the study id from a link is ever appended to it, after the strict
 * pattern has refused anything that could carry a `/`, so a link can choose a
 * study and never a host or a path. EMPTY MEANS THIS BUILD RUNS ONLY ITS OWN
 * SURVEY: a link to another study is refused, saying so.
 */
function deriveStudiesSource(): string {
  const explicit = process.env["MYSELF_STUDIES_SOURCE"];
  if (explicit) return explicit.replace(/\/+$/, "");
  const study = process.env["MYSELF_STUDY"] || "ybm";
  const survey = process.env["MYSELF_SURVEY_SOURCE"];
  if (survey) {
    const trimmed = survey.replace(/\/+$/, "");
    return trimmed.endsWith(`/studies/${study}`) ? trimmed.slice(0, -`/${study}`.length) : "";
  }
  try {
    const projectId = (JSON.parse(firebaseConfig || "null") as { projectId?: string } | null)?.projectId;
    return projectId ? `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/studies` : "";
  } catch {
    return "";
  }
}

export default defineConfig({
  base,
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
    /**
     * Where the narrative module is served from.
     *
     * Baked in rather than typed into the page, for the same reason the relay
     * URL is: the survey must not be a place where somebody can point a
     * child's conversation at a host of their choosing. Empty means this build
     * has no module, and a narrative position says so instead of showing an
     * empty frame.
     */
    __MYSTORY_URL__: JSON.stringify(process.env["MYSELF_MYSTORY_URL"] ?? ""),
    __SITTINGS_URL__: JSON.stringify(deriveSittingsUrl()),
    /**
     * How often a sitting still being answered is copied to the study.
     *
     * A fielding decision rather than a constant: it trades how much a dropped iPad
     * costs against how much traffic a hall of thirty devices puts on one access
     * point. Two minutes is the default because a lost two minutes of answers is
     * recoverable by asking the participant, and a lost morning is not.
     *
     * It is also the seam that makes checkpointing testable — the alternative is a
     * test that waits two real minutes to watch a timer fire.
     */
    __CHECKPOINT_SECONDS__: JSON.stringify(Number(process.env["MYSELF_CHECKPOINT_SECONDS"] ?? 120)),
    __SURVEY_SOURCE__: JSON.stringify(deriveSurveySource()),
    /**
     * The study this build files into unless an iPad has been given a link to
     * another (D-56). The same `MYSELF_STUDY` the source above is built from.
     */
    __STUDY__: JSON.stringify(process.env["MYSELF_STUDY"] || "ybm"),
    __STUDIES_SOURCE__: JSON.stringify(deriveStudiesSource()),
    /**
     * Which survey's pointer the start screen follows until an iPad is given a
     * participant link (D-56). Baked in, like the endpoints. A link can choose
     * among surveys a study has PUBLISHED, and nothing else: it is checked
     * against the study's registry and live pointer, and the release it names
     * is verified, before it is run (lib/selection.ts).
     */
    __SURVEY_ID__: JSON.stringify(process.env["MYSELF_SURVEY_ID"] || "ybm_nd2026_standard"),
  },
  plugins: [
    react(),
    VitePWA({
      /**
       * "prompt", and registered by hand in main.tsx, because "autoUpdate" reloads
       * the page itself (docs/16 R11).
       *
       * In "autoUpdate" mode the generated worker takes over the moment it
       * installs, and the plugin's registration code reloads the page when it
       * does — unconditionally, before `lib/updates.ts` is asked. So a deploy
       * landing mid-morning could put a child answering question forty back on
       * the start screen, whatever the gate said. In "prompt" mode a new worker
       * waits until it is told to take over, and main.tsx only tells it to when
       * the gate says nobody is part-way through a sitting.
       *
       * `injectRegister: false` because main.tsx registers the worker itself,
       * with workbox-window rather than the plugin's `virtual:pwa-register`: even
       * in "prompt" mode, the plugin's registration reloads the page whenever a
       * newer worker takes control — including one activated from another tab,
       * mid-sitting in this one. Registering directly leaves `updates` the only
       * thing on this page that ever reloads it.
       */
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["apple-touch-icon.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "MySelf",
        short_name: "MySelf",
        description: "MySelf research platform — participant application",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        background_color: "#faf6f0",
        theme_color: "#faf6f0",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,json,woff2}"],
        // The bundled release manifest must be available offline.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        /**
         * The other apps live under this service worker's scope, and must not
         * be swallowed by it.
         *
         * Workbox answers every navigation inside the scope with this app's
         * index.html, so it can work offline in a school hall with no network.
         * That is right for the survey and catastrophic for its neighbours:
         * without this denylist, /researcher/ and /narrative/ both served the
         * questionnaire to anyone whose browser had ever cached it. It looked
         * fine on a plain preview server, where no service worker exists —
         * which is exactly why it survived to be deployed.
         */
        navigateFallbackDenylist: [
          new RegExp(`^${base.replace(/\/$/, "")}/(researcher|mystory)(/|$)`),
        ],
      },
    }),
  ],
  server: { fs: { allow: ["..", "../.."] } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
