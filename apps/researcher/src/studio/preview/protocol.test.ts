import { describe, expect, it } from "vitest";
import { releaseManifest } from "@myself/schema";
import rawR730 from "../../../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json";
import {
  fingerprint,
  fromExpected,
  isReady,
  MSG_GOTO,
  MSG_LOAD,
  MSG_READY,
  MSG_STATE,
  newNonce,
  parseGoto,
  parseLoad,
  parseState,
} from "./protocol.js";

const manifest = releaseManifest.parse(rawR730);
const nonce = "abcdef0123456789";

describe("who the preview listens to", () => {
  const frame = { name: "the iframe's window" };
  const origin = "https://faisalmushtaq.github.io";

  it("accepts only its own origin and the one window it expects", () => {
    expect(fromExpected({ origin, source: frame }, { origin, source: frame })).toBe(true);
    // Another site, even one that got hold of the window.
    expect(fromExpected({ origin: "https://evil.example", source: frame }, { origin, source: frame })).toBe(false);
    // Another window on this origin: a second tab, another frame, a popup.
    expect(fromExpected({ origin, source: { name: "another window" } }, { origin, source: frame })).toBe(false);
    // A Studio whose frame has gone accepts nothing, rather than everything.
    expect(fromExpected({ origin, source: null }, { origin, source: null })).toBe(false);
  });
});

describe("messages to the frame", () => {
  it("accepts a well-formed load and parses its manifest", () => {
    const load = parseLoad({ type: MSG_LOAD, nonce, manifest, startAt: "kss.q1" });
    expect(load?.startAt).toBe("kss.q1");
    expect(load?.manifest.release.key).toBe(manifest.release.key);
    expect(parseLoad({ type: MSG_LOAD, nonce, manifest, startAt: null })?.startAt).toBeNull();
  });

  it("refuses a load that is not quite one", () => {
    const good = { type: MSG_LOAD, nonce, manifest, startAt: null };
    expect(parseLoad({ ...good, type: "studio-preview:lode" })).toBeNull();
    expect(parseLoad({ ...good, nonce: "short" })).toBeNull();
    expect(parseLoad({ ...good, nonce: "has spaces in it!" })).toBeNull();
    expect(parseLoad({ ...good, startAt: 42 })).toBeNull();
    expect(parseLoad({ ...good, startAt: "" })).toBeNull();
    expect(parseLoad({ ...good, startAt: "x".repeat(201) })).toBeNull();
    // A manifest the participant app would refuse is refused here too.
    expect(parseLoad({ ...good, manifest: { ...manifest, composition: { ...manifest.composition, sections: [] } } })).toBeNull();
    expect(parseLoad({ ...good, manifest: "not a manifest" })).toBeNull();
    expect(parseLoad(null)).toBeNull();
    expect(parseLoad("studio-preview:load")).toBeNull();
    expect(parseLoad([good])).toBeNull();
  });

  it("accepts a jump, and refuses a malformed one", () => {
    expect(parseGoto({ type: MSG_GOTO, nonce, target: "finish" })).toEqual({ type: MSG_GOTO, nonce, target: "finish" });
    expect(parseGoto({ type: MSG_GOTO, nonce, target: "" })).toBeNull();
    expect(parseGoto({ type: MSG_GOTO, nonce, target: ["kss.q1"] })).toBeNull();
    expect(parseGoto({ type: MSG_LOAD, nonce, target: "kss.q1" })).toBeNull();
  });
});

describe("messages from the frame", () => {
  const good = {
    type: MSG_STATE,
    nonce,
    phase: "running",
    index: 3,
    itemKey: "kss.q1",
    answers: { "ybm_identity.first_name": "Sam" },
    visibility: { "kss.q1": "shown", "kss.q2": "not_reached", "doomscroll4.q1": "hidden" },
  };

  it("accepts a well-formed report", () => {
    expect(parseState(good)).toEqual(good);
    expect(parseState({ ...good, phase: "error", index: null, itemKey: null, error: "sections: Required" })).toMatchObject({
      phase: "error",
      error: "sections: Required",
    });
  });

  it("refuses a report that is not quite one", () => {
    expect(parseState({ ...good, phase: "sleeping" })).toBeNull();
    expect(parseState({ ...good, index: -1 })).toBeNull();
    expect(parseState({ ...good, index: 1.5 })).toBeNull();
    expect(parseState({ ...good, itemKey: 7 })).toBeNull();
    expect(parseState({ ...good, answers: { "kss.q1": 3 } })).toBeNull();
    expect(parseState({ ...good, answers: ["Sam"] })).toBeNull();
    expect(parseState({ ...good, answers: { "kss.q1": "x".repeat(401) } })).toBeNull();
    expect(parseState({ ...good, visibility: { "kss.q1": "visible" } })).toBeNull();
    expect(parseState({ ...good, error: { message: "no" } })).toBeNull();
    expect(parseState({ ...good, nonce: undefined })).toBeNull();
  });

  it("recognises the frame saying it is ready", () => {
    expect(isReady({ type: MSG_READY })).toBe(true);
    expect(isReady({ type: MSG_STATE })).toBe(false);
    expect(isReady(MSG_READY)).toBe(false);
  });
});

describe("telling a changed survey from a re-saved one", () => {
  it("gives the same release the same fingerprint, and a changed one another", () => {
    const copy = releaseManifest.parse(JSON.parse(JSON.stringify(rawR730)));
    expect(fingerprint(copy)).toBe(fingerprint(manifest));

    const reworded = structuredClone(manifest);
    reworded.composition.title = `${reworded.composition.title}.`;
    expect(fingerprint(reworded)).not.toBe(fingerprint(manifest));
  });

  it("makes nonces the frame will accept, different every time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(parseGoto({ type: MSG_GOTO, nonce: a, target: "finish" })).not.toBeNull();
  });
});
