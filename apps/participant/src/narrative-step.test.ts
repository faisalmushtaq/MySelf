import { describe, expect, it } from "vitest";
import {
  answerReady,
  handoverUrl as buildHandoverUrl,
  moduleCredential,
  protocolMessage,
  readModuleMessage,
  type ModuleFrame,
} from "./lib/narrative.js";

/**
 * The hand-over from the survey to the module.
 *
 * What is worth testing here is not the iframe — that is the browser's job —
 * but the things the hand-over gets wrong silently if they are wrong: the URL
 * the module is asked for, which messages are believed, and the protocol the
 * survey sends.
 *
 * These used to test copies of the component's logic, kept in step by hand.
 * The logic now lives in `lib/narrative.ts`, so they test the real thing.
 */

function handoverUrl(options: {
  moduleUrl: string;
  protocol: string;
  sessionId: string;
  releaseHash: string;
  firstName?: string;
}): URL {
  return buildHandoverUrl({ ...options, sendsProtocol: true });
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

  it("carries the sitting's study when there is one, so the module acts in it (D-56)", () => {
    expect(buildHandoverUrl({ ...base, study: "future", sendsProtocol: true }).searchParams.get("study")).toBe("future");
    // The default's sittings send none, and the address is what it always was.
    expect(handoverUrl(base).searchParams.has("study")).toBe(false);
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

  it("tells the module a protocol is coming, so it waits for it rather than using its own list", () => {
    expect(handoverUrl(base).searchParams.get("protocolFromHost")).toBe("1");
    expect(buildHandoverUrl({ ...base, sendsProtocol: false }).searchParams.has("protocolFromHost")).toBe(false);
  });
});

/** Whether a message would advance the survey. */
function believes(
  event: { origin: string; data: unknown },
  expected: { origin: string; sessionId: string },
): boolean {
  return readModuleMessage(event, expected)?.kind === "finished";
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

describe("the rest of the conversation with the module", () => {
  const expected = { origin: "https://myself-research.web.app", sessionId: "ses_01J" };

  it("hears that the module is ready, which is when the protocol is sent", () => {
    expect(readModuleMessage({ origin: expected.origin, data: { type: "mystory:ready", sessionId: "ses_01J" } }, expected)).toEqual({
      kind: "ready",
    });
    // From anywhere else, nothing is sent: the protocol goes only to the module.
    expect(readModuleMessage({ origin: "https://elsewhere.example", data: { type: "mystory:ready" } }, expected)).toBeNull();
  });

  it("hears that the module refused what it was sent, and why", () => {
    const refused = { type: "mystory:refused", sessionId: "ses_01J", problem: "stage 'open' has no text" };
    expect(readModuleMessage({ origin: expected.origin, data: refused }, expected)).toEqual({
      kind: "refused",
      problem: "stage 'open' has no text",
    });
    expect(readModuleMessage({ origin: expected.origin, data: { type: "mystory:refused" } }, expected)).toEqual({
      kind: "refused",
      problem: "no reason given",
    });
  });

  it("keeps the reason the module gave for finishing", () => {
    expect(
      readModuleMessage({ origin: expected.origin, data: { type: "mystory:finished", reason: "stopped" } }, expected),
    ).toEqual({ kind: "finished", reason: "stopped" });
  });
});

describe("handing the module this iPad's credential (D-55)", () => {
  /**
   * The module needs something the relay accepts, and a child has no account.
   * The survey has the credential it files sittings with, so it hands that over
   * — by message, to the module's origin, and only to its own frame. These are
   * the things the hand-over gets wrong silently: a secret in a URL, a secret
   * posted to whatever asked, or a protocol withheld because the secret could
   * not be read.
   */
  const SECRET = "s".repeat(43);
  const target = { url: "https://example.test/saveSitting", credential: `Device ipad_01ABC.${SECRET}`, installId: "ipad_01ABC" };
  const MODULE = "https://faisalmushtaq.github.io";
  const definition = { key: "np.phone_wellbeing", version: "0.1.0" };

  /** A frame that records what it was sent, and where. */
  function frameRecording(): ModuleFrame & { sent: { message: unknown; origin: string }[] } {
    const sent: { message: unknown; origin: string }[] = [];
    return { sent, postMessage: (message, origin) => void sent.push({ message, origin }) };
  }

  it("is the secret the survey files sittings with, without the scheme the module adds itself", () => {
    expect(moduleCredential(target)).toBe(`ipad_01ABC.${SECRET}`);
    // A build that files nowhere has none, and the module asks for sign-in as before.
    expect(moduleCredential(null)).toBeNull();
    expect(moduleCredential({ credential: "Bearer something" })).toBeNull();
    expect(moduleCredential({ credential: "Device " })).toBeNull();
  });

  it("travels with the protocol, and is left out when there is none", () => {
    expect(protocolMessage(definition, "ipad_01ABC.x")).toEqual({
      type: "myself:narrative-protocol",
      protocol: definition,
      deviceCredential: "ipad_01ABC.x",
    });
    expect(protocolMessage(definition, null)).toEqual({ type: "myself:narrative-protocol", protocol: definition });
    expect(protocolMessage(undefined, "ipad_01ABC.x")).toBeNull();
  });

  it("is sent to the module's origin, in answer to its own frame saying it is ready", async () => {
    const frame = frameRecording();
    const sent = await answerReady({
      asker: frame,
      frame: () => frame,
      moduleOrigin: MODULE,
      definition,
      credential: Promise.resolve(moduleCredential(target)),
    });
    expect(sent).toBe(true);
    expect(frame.sent).toEqual([
      {
        message: { type: "myself:narrative-protocol", protocol: definition, deviceCredential: `ipad_01ABC.${SECRET}` },
        origin: MODULE,
      },
    ]);
  });

  it("is not sent to anything else that says it is ready", async () => {
    // On GitHub Pages the survey and the module share an origin, so the origin
    // check alone would let any other page of the site ask for it.
    const frame = frameRecording();
    const stranger = frameRecording();
    const sent = await answerReady({
      asker: stranger,
      frame: () => frame,
      moduleOrigin: MODULE,
      definition,
      credential: Promise.resolve("ipad_01ABC.x"),
    });
    expect(sent).toBe(false);
    expect(frame.sent).toEqual([]);
    expect(stranger.sent).toEqual([]);
  });

  it("is not sent to a frame that was replaced while the credential was being read", async () => {
    const first = frameRecording();
    const second = frameRecording();
    let current: ModuleFrame = first;
    let release: (value: string | null) => void = () => undefined;
    const pending = answerReady({
      asker: first,
      frame: () => current,
      moduleOrigin: MODULE,
      definition,
      credential: new Promise((resolve) => (release = resolve)),
    });
    current = second;
    release("ipad_01ABC.x");
    expect(await pending).toBe(false);
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([]);
  });

  it("still sends the protocol when the credential cannot be read", async () => {
    const frame = frameRecording();
    await answerReady({
      asker: frame,
      frame: () => frame,
      moduleOrigin: MODULE,
      definition,
      credential: Promise.reject(new Error("storage unavailable")),
    });
    expect(frame.sent).toEqual([{ message: { type: "myself:narrative-protocol", protocol: definition }, origin: MODULE }]);
  });

  it("is never in the address the module is opened at", () => {
    // Pinned as the whole list, so a parameter added later is a decision somebody
    // makes here rather than a secret that drifts into history and logs.
    const url = buildHandoverUrl({ ...base, firstName: "Amara", sendsProtocol: true });
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["embed", "name", "protocol", "protocolFromHost", "releaseHash", "sessionId", "start", "view"].sort(),
    );
    expect(url.toString()).not.toContain(SECRET);
  });
});
