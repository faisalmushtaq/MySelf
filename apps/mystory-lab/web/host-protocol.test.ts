import { describe, expect, it } from "vitest";
import { phoneWellbeing, type NarrativeProtocol } from "@myself/narrative";
import { READY, PROTOCOL_MESSAGE, acceptHostProtocol, receiveHostProtocol, sameProtocol } from "./host-protocol.js";

/**
 * The module running the protocol the survey sent (D-54): which ones it
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

  it("is accepted when it was edited in the dashboard, and is then not the bundled copy", () => {
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
    const deliver = (source: unknown, data: unknown) =>
      [...listeners].forEach((l) => l({ source, data, origin: "https://survey.example" } as unknown as MessageEvent));
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
});
