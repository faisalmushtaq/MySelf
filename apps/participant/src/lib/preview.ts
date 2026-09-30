import { engineCanRun, releaseManifest, type ReleaseManifest } from "@myself/schema";
import type { appendEvent as AppendEvent, RecordedAnswer, SessionRow } from "./db.js";
import { ulid } from "./ulid.js";
import { runnable } from "./versions.js";

/**
 * Preview mode: the dashboard's editor shows a draft in the real survey (D-54).
 *
 * The dashboard opens this app in an iframe with `?preview=1`. The app says it
 * is ready (`myself:preview-ready`), the dashboard answers with the draft
 * (`myself:preview-manifest`), and the app runs it exactly as a device would
 * run a published version, so what the team previews is what a child will see.
 *
 * A DRAFT, SO NOT HASHED. It has no hash yet, or one that need not match, and
 * it is not published anywhere. It is still parsed with the release schema and
 * checked as runnable, and refused with the reason when it is not.
 *
 * NOTHING IS KEPT. No sitting, answer or event is stored on the device or sent
 * anywhere, the device issues itself no identity, the service worker is not
 * registered, and the narrative module is not started. The page says so on a
 * banner the whole time.
 *
 * ONLY THE DASHBOARD MAY SEND ONE. Anything else that can post a message to
 * this page, such as another site framing it or an extension, would otherwise
 * be able to put its own questions in front of whoever is looking.
 */

export const PREVIEW_READY = "myself:preview-ready";
export const PREVIEW_MANIFEST = "myself:preview-manifest";

declare const __PREVIEW_ORIGINS__: string;

/** Whether this page was opened as a preview. */
export function previewRequested(search: string): boolean {
  return new URLSearchParams(search).get("preview") === "1";
}

/**
 * The pages allowed to send a draft: the dashboard's Hosting site, its preview
 * channels, and, in a development build only, a dashboard running locally.
 *
 * `extra` is for a test build that serves its own stand-in dashboard; it is
 * baked in at build time (`MYSELF_PREVIEW_ORIGINS`) and empty in every
 * deployed build.
 */
export function previewOriginAllowed(
  origin: string,
  options: { development: boolean; extra?: readonly string[] },
): boolean {
  if (origin === "https://myself-research-dashboard.web.app") return true;
  if (origin === "https://myself-research-dashboard.firebaseapp.com") return true;
  if (/^https:\/\/myself-research-dashboard--[a-z0-9-]+\.web\.app$/.test(origin)) return true;
  if (options.development && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  return options.extra?.includes(origin) ?? false;
}

/** The rule this build applies. */
export function allowedHere(origin: string): boolean {
  return previewOriginAllowed(origin, {
    development: import.meta.env.DEV,
    extra: __PREVIEW_ORIGINS__.split(",").map((o) => o.trim()).filter(Boolean),
  });
}

export type Draft = { ok: true; manifest: ReleaseManifest } | { ok: false; problem: string };

/** Check a draft the way a device checks a published version, less the hash. */
export function readDraft(value: unknown, engineVersion: string): Draft {
  const parsed = releaseManifest.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: issue ? `${issue.path.join(".") || "the draft"}: ${issue.message}` : "it is not a release manifest" };
  }
  const required = parsed.data.release.engineVersion;
  if (!engineCanRun(engineVersion, required)) {
    return { ok: false, problem: `it needs engine ${required}, and this survey has ${engineVersion}` };
  }
  const problem = runnable(parsed.data);
  if (problem) return { ok: false, problem };
  return { ok: true, manifest: parsed.data };
}

/**
 * Listen for drafts from the dashboard, then say the page is ready for one.
 *
 * Every draft from an allowed origin is passed to `onDraft`, checked. Messages
 * from anywhere else, and messages of any other kind, are ignored without a
 * word. Returns a function that stops listening.
 */
export function listenForDrafts(
  target: Window,
  options: { allowed: (origin: string) => boolean; engineVersion: string; onDraft: (draft: Draft) => void },
): () => void {
  const onMessage = (event: MessageEvent) => {
    if (!options.allowed(event.origin)) return;
    const data = event.data as { type?: unknown; manifest?: unknown } | null;
    if (data === null || typeof data !== "object" || data.type !== PREVIEW_MANIFEST) return;
    options.onDraft(readDraft(data.manifest, options.engineVersion));
  };
  target.addEventListener("message", onMessage);
  // Said to whoever framed the page. It carries nothing, so it may go to any
  // origin: the reply is what is checked.
  if (target.parent && target.parent !== target) target.parent.postMessage({ type: PREVIEW_READY }, "*");
  return () => target.removeEventListener("message", onMessage);
}

/**
 * Sittings that live only as long as the page: the storage a preview uses in
 * place of the device's (db.ts), with the same shape, so the app runs the
 * same code either way.
 */
export const previewSittings = {
  async createSession(participantCode: string, releaseKey: string, releaseHash: string): Promise<SessionRow> {
    const now = new Date().toISOString();
    return {
      sessionId: `preview_${ulid()}`,
      participantCode,
      releaseKey,
      releaseHash,
      state: "in_progress",
      currentIndex: 0,
      startedAt: now,
      updatedAt: now,
      eventCount: 0,
    };
  },
  async appendEvent(...[session, , , , currentIndex]: Parameters<typeof AppendEvent>): Promise<void> {
    session.eventCount += 1;
    session.currentIndex = currentIndex;
    session.updatedAt = new Date().toISOString();
  },
  async completeSession(session: SessionRow): Promise<void> {
    session.state = "awaiting_sync";
    session.completedAt = new Date().toISOString();
  },
  /** Nothing was kept, so there is nothing to resume. */
  async findResumableSession(_code: string, _hash: string): Promise<SessionRow | undefined> {
    return undefined;
  },
  async loadAnswers(_sessionId: string): Promise<Map<string, RecordedAnswer>> {
    return new Map();
  },
};
