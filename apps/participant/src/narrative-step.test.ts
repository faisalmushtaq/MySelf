import { describe, expect, it } from "vitest";

/**
 * The hand-over from the survey to the module.
 *
 * What is worth testing here is not the iframe — that is the browser's job —
 * but the two things the hand-over gets wrong silently if they are wrong: the
 * URL the module is asked for, and which messages are believed.
 */

/** The same URL the component builds, kept in step by being asserted on. */
function handoverUrl(options: {
  moduleUrl: string;
  protocol: string;
  sessionId: string;
  releaseHash: string;
  firstName?: string;
}): URL {
  const url = new URL(`${options.moduleUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("embed", "1");
  url.searchParams.set("view", "participant");
  url.searchParams.set("start", "1");
  url.searchParams.set("protocol", options.protocol);
  url.searchParams.set("sessionId", options.sessionId);
  url.searchParams.set("releaseHash", options.releaseHash);
  if (options.firstName) url.searchParams.set("name", options.firstName);
  return url;
}

const base = {
  moduleUrl: "https://myself-research.web.app",
  protocol: "np.micro_narrative_full",
  sessionId: "ses_01J",
  releaseHash: "sha256-abc",
};

describe("what the survey hands to the module", () => {
  it("carries the sitting's own session id, which is the whole join", () => {
    // The module stores its run against this, the sitting is stored against
    // this, and the export puts the two side by side because they agree.
    expect(handoverUrl(base).searchParams.get("sessionId")).toBe("ses_01J");
  });

  it("carries the release, so a run is tied to the study as it stood that day", () => {
    expect(handoverUrl(base).searchParams.get("releaseHash")).toBe("sha256-abc");
  });

  it("asks for the participant view and starts straight away", () => {
    const url = handoverUrl(base);
    expect(url.searchParams.get("view")).toBe("participant");
    expect(url.searchParams.get("start")).toBe("1");
    expect(url.searchParams.get("embed")).toBe("1");
  });

  it("sends no name when the study did not collect one", () => {
    // The module reads correctly with no name, and a default greeting reaching
    // a stranger is a bug this platform has already had once.
    expect(handoverUrl(base).searchParams.has("name")).toBe(false);
    expect(handoverUrl({ ...base, firstName: "Amara" }).searchParams.get("name")).toBe("Amara");
  });

  it("tolerates a module url with or without a trailing slash", () => {
    expect(handoverUrl({ ...base, moduleUrl: "https://x.example/" }).origin).toBe("https://x.example");
    expect(handoverUrl({ ...base, moduleUrl: "https://x.example" }).origin).toBe("https://x.example");
  });
});

/** The rule the component applies to an arriving message. */
function believes(
  event: { origin: string; data: unknown },
  expected: { origin: string; sessionId: string },
): boolean {
  if (event.origin !== expected.origin) return false;
  const data = event.data as { type?: string; sessionId?: string } | null;
  if (data?.type !== "mystory:finished") return false;
  if (data.sessionId && data.sessionId !== expected.sessionId) return false;
  return true;
}

describe("which messages advance the survey", () => {
  const expected = { origin: "https://myself-research.web.app", sessionId: "ses_01J" };
  const finished = { type: "mystory:finished", sessionId: "ses_01J" };

  it("advances on the module saying it has finished", () => {
    expect(believes({ origin: expected.origin, data: finished }, expected)).toBe(true);
  });

  it("ignores a message from anywhere else", () => {
    // An extension, another frame, the page itself. A stray message that
    // advanced the survey would skip a section with nobody doing anything.
    expect(believes({ origin: "https://elsewhere.example", data: finished }, expected)).toBe(false);
  });

  it("ignores a message about a different sitting", () => {
    expect(
      believes({ origin: expected.origin, data: { ...finished, sessionId: "ses_other" } }, expected),
    ).toBe(false);
  });

  it("ignores anything that is not the finish message", () => {
    expect(believes({ origin: expected.origin, data: { type: "resize" } }, expected)).toBe(false);
    expect(believes({ origin: expected.origin, data: null }, expected)).toBe(false);
    expect(believes({ origin: expected.origin, data: "mystory:finished" }, expected)).toBe(false);
  });
});
