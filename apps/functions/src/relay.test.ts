import { describe, expect, it } from "vitest";
import { modelConfig } from "@myself/llm";
import { protocols } from "@myself/narrative";
import { releasesByHash } from "./releases.js";
import {
  ALLOWED_ORIGIN,
  allowedOrigins,
  configFor,
  LINK_CALL_CAP,
  LINK_DAYS,
  linkRefusal,
  mayCall,
  relayRequest,
  type Caller,
} from "./relay-policy.js";
import { narrativeSave, provenanceOf } from "./narratives.js";

/**
 * The relay's job is to be the only thing holding a key, and the only thing
 * deciding what a call may be. These test the second part — the first is
 * deployment configuration, not code.
 */

const device: Caller = { uid: "dev_1", device: true };
const researcher: Caller = { uid: "res_1", device: false };

describe("what a caller may ask for", () => {
  it("takes a model config key, and has nowhere to put model parameters", () => {
    // The shape is the guarantee. If a temperature could be sent, a tampered
    // page could raise it, and a study's published parameters would stop being
    // the parameters it ran on.
    const parsed = relayRequest.safeParse({
      prompt: { system: "you are a researcher", messages: [{ role: "user", content: "hello" }] },
      modelConfigKey: "mc.openai.gpt4o.t07",
      protocolKey: "np.micro_narrative_full",
      temperature: 2,
      model: "gpt-4o",
      maxOutputTokens: 100000,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "temperature" in parsed.data).toBe(false);
    expect(parsed.success && "model" in parsed.data).toBe(false);
  });

  it("refuses a prompt with no system message, and an unbounded transcript", () => {
    const base = { modelConfigKey: "mc.x", protocolKey: "np.x" };
    expect(relayRequest.safeParse({ ...base, prompt: { system: "", messages: [] } }).success).toBe(false);
    expect(
      relayRequest.safeParse({
        ...base,
        prompt: { system: "s", messages: Array.from({ length: 61 }, () => ({ role: "user", content: "x" })) },
      }).success,
    ).toBe(false);
  });
});

describe("which model configuration a call runs on", () => {
  it("gives a device only what a published release froze", () => {
    // A fielded study runs what was published. If the parameters were not
    // frozen the run is not reproducible, and it should not be happening in
    // front of a child.
    const draftOnly = protocols[0]!.models.find((m) => m.provider !== "mock")!.key;
    const released = [...releasesByHash.values()].some((r) => draftOnly in (r.modelConfigs ?? {}));
    if (!released) {
      expect(() => configFor(draftOnly, device)).toThrow(/only run published configurations/);
    }
    expect(() => configFor("mc.nothing.declares.this", device)).toThrow();
  });

  it("lets a signed-in researcher run a shipped protocol before it is published", () => {
    // Writing prompts means running a protocol that is not yet published.
    // Refusing until it has been through a release would mean publishing
    // protocols nobody had run.
    const key = protocols[0]!.models.find((m) => m.provider !== "mock")!.key;
    const config = configFor(key, researcher);
    expect(modelConfig.safeParse(config).success).toBe(true);
    expect(config.key).toBe(key);
  });

  it("refuses a key nobody declares, whoever is asking", () => {
    expect(() => configFor("mc.made.up", researcher)).toThrow(/no shipped protocol or published release/);
    expect(() => configFor("mc.made.up", device)).toThrow();
  });

  it("returns the declared parameters, not anything the caller wanted", () => {
    const key = protocols[0]!.models.find((m) => m.provider !== "mock")!.key;
    const config = configFor(key, researcher);
    const declared = protocols[0]!.models.find((m) => m.key === key)!;
    expect(config.temperature).toBe(declared.temperature);
    expect(config.maxOutputTokens).toBe(declared.maxOutputTokens);
    expect(config.model).toBe(declared.model);
  });
});

describe("which pages may call it", () => {
  it("allows the published site and local development, and nothing else", () => {
    expect(ALLOWED_ORIGIN.test("https://faisalmushtaq.github.io")).toBe(true);
    expect(ALLOWED_ORIGIN.test("http://localhost:4300")).toBe(true);
    expect(ALLOWED_ORIGIN.test("https://faisalmushtaq.github.io.evil.example")).toBe(false);
    expect(ALLOWED_ORIGIN.test("https://evil.example")).toBe(false);
    expect(ALLOWED_ORIGIN.test("http://faisalmushtaq.github.io")).toBe(false);
  });

  /**
   * The signed-in site is served from Firebase Hosting, and leaving those two
   * origins off the list is invisible from here: no match means no CORS
   * headers, so the browser refuses the request and the relay never sees it.
   * It reads on the page as the model being unreachable, which is what it did.
   */
  it("allows this project's Hosting, which is where signing in works", () => {
    const allowed = allowedOrigins("myself-research");
    expect(allowed.test("https://myself-research.web.app")).toBe(true);
    expect(allowed.test("https://myself-research.firebaseapp.com")).toBe(true);
    // Preview channels, so a staging page can be staged against something.
    expect(allowed.test("https://myself-research--pr-12-a1b2c3.web.app")).toBe(true);
  });

  it("does not let every Firebase project on the internet spend the budget", () => {
    const allowed = allowedOrigins("myself-research");
    expect(allowed.test("https://someone-else.web.app")).toBe(false);
    expect(allowed.test("https://myself-research.web.app.evil.example")).toBe(false);
    expect(allowed.test("https://evil-myself-research.web.app")).toBe(false);
    // The identity project is a different project and has no business here.
    expect(allowed.test("https://myself-identity.web.app")).toBe(false);
  });

  it("builds the list from whichever project it is deployed to", () => {
    const other = allowedOrigins("some-other-study");
    expect(other.test("https://some-other-study.web.app")).toBe(true);
    expect(other.test("https://myself-research.web.app")).toBe(false);
  });

  it("takes extra origins literally, so a dot is not a wildcard", () => {
    const allowed = allowedOrigins("myself-research", ["https://study.example.ac.uk"]);
    expect(allowed.test("https://study.example.ac.uk")).toBe(true);
    expect(allowed.test("https://studyXexample.ac.uk")).toBe(false);
  });
});

describe("who may spend the study's model budget", () => {
  /**
   * The failure this prevents: Google sign-in is open to the world, so anyone
   * can arrive holding a valid token for this project. If a verified token
   * were enough, the public page would be a stranger's route to the study's
   * OpenAI bill.
   */
  it("refuses a signed-in stranger with no role", () => {
    expect(mayCall({})).toBe(false);
    expect(mayCall({ role: "" })).toBe(false);
    expect(mayCall({ role: "friend-of-the-project" })).toBe(false);
    expect(mayCall({ device: false })).toBe(false);
    // A truthy-looking claim that is not the boolean true is not a device.
    expect(mayCall({ device: "true" })).toBe(false);
  });

  it("admits an enrolled device and anybody an owner gave a role", () => {
    expect(mayCall({ device: true })).toBe(true);
    for (const role of ["owner", "researcher", "analyst"]) {
      expect(mayCall({ role })).toBe(true);
    }
  });
});

describe("a tester link, which stands in for signing in", () => {
  const good = { revokedAt: null, expiresAt: Date.now() + 60_000, callCap: 10, callsUsed: 0 };

  it("lets a link that is in date and under its cap through", () => {
    expect(linkRefusal(good, Date.now())).toBeNull();
  });

  /**
   * A key in a URL will be forwarded, pasted into a chat and left in browser
   * history. It is not trusted — it is bounded, and each bound is the reason
   * a leaked link costs a known amount rather than an unknown one.
   */
  it("refuses on every bound, and says which", () => {
    expect(linkRefusal(null, Date.now())).toMatch(/not one this study issued/);
    expect(linkRefusal({ ...good, revokedAt: new Date() }, Date.now())).toMatch(/switched off/);
    expect(linkRefusal({ ...good, expiresAt: Date.now() - 1 }, Date.now())).toMatch(/expired/);
    expect(linkRefusal({ ...good, callsUsed: 10 }, Date.now())).toMatch(/as many times as it was allowed/);
  });

  it("counts the cap as a ceiling, not a target to overshoot", () => {
    // The off-by-one that matters: at the cap it must already be refused,
    // because the call being checked is the one that would exceed it.
    expect(linkRefusal({ ...good, callsUsed: 9 }, Date.now())).toBeNull();
    expect(linkRefusal({ ...good, callsUsed: 10 }, Date.now())).not.toBeNull();
    expect(linkRefusal({ ...good, callsUsed: 11 }, Date.now())).not.toBeNull();
  });

  it("expires on time rather than on the next whole day", () => {
    const at = good.expiresAt;
    expect(linkRefusal(good, at)).toBeNull();
    expect(linkRefusal(good, at + 1)).toMatch(/expired/);
  });

  it("ships bounds that are finite", () => {
    // A cap of Infinity or a life of zero days would both be worse than the
    // feature not existing.
    expect(Number.isFinite(LINK_CALL_CAP)).toBe(true);
    expect(LINK_CALL_CAP).toBeGreaterThan(0);
    expect(Number.isFinite(LINK_DAYS)).toBe(true);
    expect(LINK_DAYS).toBeGreaterThan(0);
  });
});

describe("storing a narrative run", () => {
  const base = {
    sessionId: "lab_abc",
    protocolKey: "np.phone_wellbeing",
    protocolVersion: "0.1.0",
    records: [
      {
        recordId: "nr_1",
        sessionId: "lab_abc",
        protocolKey: "np.phone_wellbeing",
        protocolVersion: "0.1.0",
        stageKey: "consent",
        seq: 0,
        source: "system" as const,
        kind: "request_shown",
        text: "Hi — this last bit is a short chat about your phone.",
        data: null,
        refersTo: null,
        modelCallId: null,
        at: new Date().toISOString(),
      },
    ],
  };

  it("accepts a run as the runner produces it", () => {
    const parsed = narrativeSave.safeParse(base);
    expect(parsed.success).toBe(true);
    // Unfinished unless it says so: most test runs are abandoned partway, and
    // treating silence as "finished" would overstate every one of them.
    expect(parsed.success && parsed.data.finished).toBe(false);
  });

  it("refuses a run with nothing identifying it", () => {
    expect(narrativeSave.safeParse({ ...base, sessionId: "" }).success).toBe(false);
    expect(narrativeSave.safeParse({ ...base, protocolKey: "" }).success).toBe(false);
  });

  it("takes a partial run, because a partial run is the interesting one", () => {
    expect(narrativeSave.safeParse({ ...base, records: [] }).success).toBe(true);
  });

  /**
   * The line between a test and a study. A tester following a link is not a
   * consented participant and must never land in the research dataset by
   * accident — so the marking comes from HOW THEY AUTHENTICATED, which no page
   * can lie about, rather than from a field in the request, which any page
   * could set.
   */
  it("marks a link-holder's run as a test, whatever the page says", () => {
    expect(provenanceOf({ uid: "link_abc123", device: true })).toBe("test");
    expect(provenanceOf({ uid: "dev_ipad_4", device: true })).toBe("study");
    expect(provenanceOf({ uid: "user_faisal", device: false })).toBe("study");
  });

  it("keeps one copy of the conversation, not two", () => {
    // The original exported chat_history AND chat_history_single_string — the
    // same content twice, and two things that can disagree.
    const parsed = narrativeSave.parse(base);
    expect(Object.keys(parsed)).not.toContain("chat_history_single_string");
    expect(parsed.records[0]!.text).toContain("short chat about your phone");
  });
});
