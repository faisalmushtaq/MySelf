import { describe, expect, it } from "vitest";
import { phoneWellbeing, type NarrativeProtocol } from "@myself/narrative";
import {
  READY,
  PROTOCOL_MESSAGE,
  acceptHostCredential,
  acceptHostProtocol,
  belongsHere,
  receiveHostProtocol,
  sameProtocol,
  trustedHostOrigins,
} from "./host-protocol.js";

/**
 * The module running the protocol the survey sent: which ones it
 * accepts, whom it believes, and that it refuses rather than falls back.
 */

/** As it arrives: frozen into a manifest, stored as JSON, sent in a message. */
const sent = (protocol: NarrativeProtocol): unknown => JSON.parse(JSON.stringify(protocol));

describe("a protocol sent by the survey", () => {
  it("is accepted when it is a protocol that passes its checks", () => {
    const accepted = acceptHostProtocol(sent(phoneWellbeing), "np.phone_wellbeing");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(sameProtocol(accepted.protocol, phoneWellbeing)).toBe(true);
  });

  it("is accepted when it was edited in Studio, and is then not the bundled copy", () => {
    const edited = { ...phoneWellbeing, name: "Phones and how you feel (edited)", version: "1.1.0" };
    const accepted = acceptHostProtocol(sent(edited), "np.phone_wellbeing");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.protocol.version).toBe("1.1.0");
      expect(sameProtocol(accepted.protocol, phoneWellbeing)).toBe(false);
    }
  });

  it("is refused when it does not parse", () => {
    const { stages: _stages, ...noStages } = phoneWellbeing;
    expect(acceptHostProtocol(sent(noStages as NarrativeProtocol), "np.phone_wellbeing")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/not one this module can read.*stages/),
    });
    expect(acceptHostProtocol("np.phone_wellbeing", null).ok).toBe(false);
  });

  it("is refused when it fails the protocol's own checks", () => {
    const leaky = { ...phoneWellbeing, permittedIdentifiers: ["surname"] };
    expect(acceptHostProtocol(sent(leaky), "np.phone_wellbeing")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/fails its checks.*surname/),
    });
  });

  it("is refused when it is not the protocol the survey's link named", () => {
    expect(acceptHostProtocol(sent(phoneWellbeing), "np.micro_narrative_full")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/asked for np\.micro_narrative_full and sent np\.phone_wellbeing/),
    });
  });
});

describe("waiting for it", () => {
  /** This page, framed by a survey; `other` is anything else able to post here. */
  function framed() {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const toParent: unknown[] = [];
    const parent = { postMessage: (message: unknown) => void toParent.push(message) };
    const other = {};
    const target = {
      parent,
      addEventListener: (_: string, listener: (event: MessageEvent) => void) => void listeners.push(listener),
      removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
        void listeners.splice(listeners.indexOf(listener), 1),
    } as unknown as Window;
    const deliver = (source: unknown, data: unknown, origin = "https://survey.example") =>
      [...listeners].forEach((l) => l({ source, data, origin } as unknown as MessageEvent));
    return { target, parent, other, toParent, deliver, listening: () => listeners.length };
  }

  it("says it is ready, and takes the protocol only from the page that framed it", async () => {
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: "ses_01J", expectedKey: "np.phone_wellbeing" });
    expect(page.toParent).toEqual([{ type: READY, sessionId: "ses_01J" }]);

    // Another frame, an extension, the page itself: not believed.
    page.deliver(page.other, { type: PROTOCOL_MESSAGE, protocol: sent({ ...phoneWellbeing, name: "Somebody else's" }) });
    page.deliver(page.parent, { type: "something else" });
    page.deliver(page.parent, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing) });

    const received = await result;
    expect(received.ok).toBe(true);
    if (received.ok) expect(received.protocol.name).toBe(phoneWellbeing.name);
    expect(page.listening()).toBe(0);
  });

  it("refuses, rather than falling back to its own copy, when nothing arrives", async () => {
    const page = framed();
    const received = await receiveHostProtocol(page.target, { sessionId: null, expectedKey: null, patienceMs: 20 });
    expect(received).toMatchObject({ ok: false, problem: expect.stringMatching(/did not arrive/) });
    expect(page.listening()).toBe(0);
  });

  /**
   * The iPad's credential, which the survey sends with the protocol (D-55). It
   * lets this page call the model as that iPad, so whom it is believed from
   * matters more than for the protocol: the page that framed this one, AND on
   * an origin this build trusts.
   */
  const SURVEY = "https://faisalmushtaq.github.io";
  const KEY = `ipad_01ABC.${"s".repeat(43)}`;

  it("takes the iPad's credential with the protocol from a trusted survey", async () => {
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: "ses_01J", expectedKey: "np.phone_wellbeing", trustedOrigins: [SURVEY] });
    page.deliver(page.parent, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing), deviceCredential: KEY }, SURVEY);
    expect(await result).toMatchObject({ ok: true, deviceCredential: KEY });
  });

  it("takes the protocol but not the credential from a page on any other origin", async () => {
    // Anybody can frame this page. One that could hand it a credential would have
    // a free front end to the study's model.
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: "ses_01J", expectedKey: "np.phone_wellbeing", trustedOrigins: [SURVEY] });
    page.deliver(page.parent, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing), deviceCredential: KEY }, "https://elsewhere.example");
    expect(await result).toMatchObject({ ok: true, deviceCredential: null });
  });

  it("believes nothing from anything but the page that framed it, whatever its origin", async () => {
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: null, expectedKey: null, trustedOrigins: [SURVEY], patienceMs: 20 });
    page.deliver(page.other, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing), deviceCredential: KEY }, SURVEY);
    expect(await result).toMatchObject({ ok: false });
  });

  it("trusts nobody with a credential when it was told of no trusted origin", async () => {
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: null, expectedKey: null });
    page.deliver(page.parent, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing), deviceCredential: KEY }, SURVEY);
    expect(await result).toMatchObject({ ok: true, deviceCredential: null });
  });

  it("goes without one when an older survey sends none", async () => {
    const page = framed();
    const result = receiveHostProtocol(page.target, { sessionId: null, expectedKey: null, trustedOrigins: [SURVEY] });
    page.deliver(page.parent, { type: PROTOCOL_MESSAGE, protocol: sent(phoneWellbeing) }, SURVEY);
    expect(await result).toMatchObject({ ok: true, deviceCredential: null });
  });
});

describe("the iPad's credential", () => {
  const SURVEY = "https://faisalmushtaq.github.io";
  const KEY = `ipad_01ABC.${"s".repeat(43)}`;

  it("is believed only from a trusted origin", () => {
    expect(acceptHostCredential(KEY, SURVEY, [SURVEY])).toBe(KEY);
    expect(acceptHostCredential(KEY, "https://faisalmushtaq.github.io.evil.example", [SURVEY])).toBeNull();
    expect(acceptHostCredential(KEY, "http://faisalmushtaq.github.io", [SURVEY])).toBeNull();
    expect(acceptHostCredential(KEY, SURVEY, [])).toBeNull();
  });

  it("is believed only in the shape the survey makes, and anything else is dropped", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "ipad_01ABC",
      `Device ${KEY}`,
      `ipad_01ABC.${"s".repeat(31)}`,
      `ipad/01ABC.${"s".repeat(43)}`,
      `ipad_01ABC.${"s".repeat(42)}\n`,
      `ipad_01ABC.${"s".repeat(20)} ${"s".repeat(20)}`,
    ]) {
      expect(acceptHostCredential(bad, SURVEY, [SURVEY]), String(bad)).toBeNull();
    }
  });

  it("is trusted from this page's own origin, and from any named at build time", () => {
    // On GitHub Pages the survey and the module are one site.
    expect(trustedHostOrigins(SURVEY, "")).toEqual([SURVEY]);
    expect(trustedHostOrigins("http://localhost:4174", " http://localhost:5173/ ,https://study.example ")).toEqual([
      "http://localhost:4174",
      "http://localhost:5173",
      "https://study.example",
    ]);
    expect(trustedHostOrigins(SURVEY, SURVEY)).toEqual([SURVEY]);
  });
});

describe("a run kept on a shared iPad", () => {
  /**
   * The next child must never be shown the last one's conversation. A run left
   * unfinished stays on the iPad for up to a day so a reload can bring it back;
   * inside the survey it is brought back only for the sitting it belongs to.
   */
  it("comes back only for the sitting it belongs to", () => {
    expect(belongsHere("ses_child_A", "ses_child_A")).toBe(true);
    expect(belongsHere("ses_child_A", "ses_child_B")).toBe(false);
  });

  it("comes back as before in the lab on its own, which has no sitting", () => {
    expect(belongsHere("lab_abc", null)).toBe(true);
  });
});
