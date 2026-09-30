import { describe, expect, it } from "vitest";
import r9 from "../../../releases/ybm_nd2026_standard_r9.0.0.manifest.json";
import {
  PREVIEW_MANIFEST,
  PREVIEW_READY,
  listenForDrafts,
  previewOriginAllowed,
  previewRequested,
  previewSittings,
  readDraft,
  type Draft,
} from "./lib/preview.js";

/**
 * Preview mode (D-54): the dashboard shows a draft in the real survey. Who may
 * send one, what counts as one, and that nothing is kept.
 */

const production = { development: false };
const development = { development: true };

describe("who may send a draft", () => {
  it("is the dashboard's Hosting site and its preview channels", () => {
    expect(previewOriginAllowed("https://myself-research-dashboard.web.app", production)).toBe(true);
    expect(previewOriginAllowed("https://myself-research-dashboard.firebaseapp.com", production)).toBe(true);
    expect(previewOriginAllowed("https://myself-research-dashboard--editor-a1b2c3.web.app", production)).toBe(true);
  });

  it("is a dashboard on this machine only in a development build", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:4173", "http://localhost"]) {
      expect(previewOriginAllowed(origin, development)).toBe(true);
      expect(previewOriginAllowed(origin, production)).toBe(false);
    }
  });

  it("is nobody else, however close the name", () => {
    for (const origin of [
      "https://myself-research-dashboard.web.app.evil.example",
      "https://evil-myself-research-dashboard.web.app",
      "http://myself-research-dashboard.web.app",
      "https://myself-research.web.app",
      "https://myself-research-dashboard--x.web.app.example",
      "https://faisalmushtaq.github.io",
      "https://localhost:5173",
      "http://localhost.example:5173",
      "null",
    ]) {
      expect(previewOriginAllowed(origin, development), origin).toBe(false);
    }
  });

  it("includes a test build's own stand-in, named exactly", () => {
    const extra = ["http://localhost:4173"];
    expect(previewOriginAllowed("http://localhost:4173", { development: false, extra })).toBe(true);
    expect(previewOriginAllowed("http://localhost:4174", { development: false, extra })).toBe(false);
  });
});

describe("what counts as a draft", () => {
  it("is a manifest the schema accepts, with or without a hash that matches", () => {
    const { hash: _hash, ...unhashed } = r9;
    expect(readDraft(unhashed, "0.3.0").ok).toBe(true);
    expect(readDraft({ ...r9, hash: `sha256:${"0".repeat(64)}` }, "0.3.0").ok).toBe(true);
  });

  it("is refused, with the reason, when it is not one", () => {
    expect(readDraft({ ...r9, composition: undefined }, "0.3.0")).toMatchObject({ ok: false, problem: /composition/ });
    expect(readDraft("a manifest", "0.3.0").ok).toBe(false);
    expect(readDraft({ ...r9, release: { ...r9.release, engineVersion: "1.0.0" } }, "0.3.0")).toMatchObject({
      ok: false,
      problem: /needs engine 1\.0\.0/,
    });
  });

  it("is asked for with ?preview=1 and nothing else", () => {
    expect(previewRequested("?preview=1")).toBe(true);
    expect(previewRequested("?preview=0")).toBe(false);
    expect(previewRequested("")).toBe(false);
  });
});

describe("the exchange with the dashboard", () => {
  /** A window in an iframe, with the parent's side recorded. */
  function framed() {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const toParent: unknown[] = [];
    const parent = { postMessage: (message: unknown) => void toParent.push(message) };
    const target = {
      parent,
      addEventListener: (_: string, listener: (event: MessageEvent) => void) => void listeners.push(listener),
      removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
        void listeners.splice(listeners.indexOf(listener), 1),
    } as unknown as Window;
    const deliver = (origin: string, data: unknown) => listeners.forEach((l) => l({ origin, data } as MessageEvent));
    return { target, toParent, deliver, listening: () => listeners.length };
  }

  it("says it is ready, then takes a draft from the dashboard and nothing from anywhere else", () => {
    const page = framed();
    const drafts: Draft[] = [];
    const stop = listenForDrafts(page.target, {
      allowed: (origin) => origin === "https://myself-research-dashboard.web.app",
      engineVersion: "0.3.0",
      onDraft: (draft) => drafts.push(draft),
    });
    expect(page.toParent).toEqual([{ type: PREVIEW_READY }]);

    page.deliver("https://elsewhere.example", { type: PREVIEW_MANIFEST, manifest: r9 });
    page.deliver("https://myself-research-dashboard.web.app", { type: "something else", manifest: r9 });
    page.deliver("https://myself-research-dashboard.web.app", null);
    expect(drafts).toEqual([]);

    page.deliver("https://myself-research-dashboard.web.app", { type: PREVIEW_MANIFEST, manifest: r9 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.ok).toBe(true);

    stop();
    expect(page.listening()).toBe(0);
  });
});

describe("a preview's sitting", () => {
  it("lives in memory, is never resumable, and has no answers to load", async () => {
    const session = await previewSittings.createSession("NDC0042", "ybm_r9", "sha256:x");
    expect(session.sessionId).toMatch(/^preview_/);
    await previewSittings.appendEvent(session, "session.started", undefined, {}, 3, 0);
    expect(session.eventCount).toBe(1);
    expect(session.currentIndex).toBe(3);
    await previewSittings.completeSession(session);
    expect(session.state).toBe("awaiting_sync");
    expect(await previewSittings.findResumableSession("NDC0042", "sha256:x")).toBeUndefined();
    expect((await previewSittings.loadAnswers(session.sessionId)).size).toBe(0);
  });
});
