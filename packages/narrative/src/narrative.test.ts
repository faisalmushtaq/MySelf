import { beforeEach, describe, expect, it } from "vitest";
import { Gateway, MockAdapter, type ModelCall } from "@myself/llm";
import { checkProtocol, narrativeProtocol, type NarrativeProtocol } from "./protocol.js";
import { originalsIntact, participantWords, refuseReason } from "./records.js";
import { NarrativeRunner, resolveText } from "./runner.js";
import { futureSelf, microNarrative } from "./protocols.js";

/**
 * The test matrix docs/08 §7 asks for, plus the two invariants that make this
 * a research module rather than a chatbot: the model can never produce a
 * participant's words, and a failure never costs a participant theirs.
 */

let calls: ModelCall[] = [];

const gatewayWith = (adapter: MockAdapter) =>
  new Gateway({
    adapters: [adapter],
    onCall: (call) => {
      calls.push(call);
    },
    sleep: async () => undefined,
  });

/** The shipped protocol, switched to the mock provider. */
const mocked = (base: NarrativeProtocol = microNarrative): NarrativeProtocol => ({
  ...base,
  stages: base.stages.map((s) => (s.modelConfigKey ? { ...s, modelConfigKey: "mc.mock" } : s)),
});

const context = (overrides: Partial<{ online: boolean; first_name: string }> = {}) => ({
  sessionId: "ses_test",
  variables: { first_name: overrides.first_name ?? "Amara", topic: "how school has been this term" },
  online: overrides.online ?? true,
});

beforeEach(() => {
  calls = [];
});

describe("the shipped protocols pass their own publish gate", () => {
  it("accepts both seeds", () => {
    expect(checkProtocol(microNarrative)).toEqual([]);
    expect(checkProtocol(futureSelf)).toEqual([]);
  });

  it("refuses a prompt that uses a variable nobody permitted", () => {
    const bad = structuredClone(microNarrative) as NarrativeProtocol;
    bad.stages[2]!.prompt!.template = "Tell me about {school_name}: {participant_words}";
    expect(checkProtocol(bad).join(" ")).toMatch(/school_name.*not a permitted variable/);
  });

  it("refuses a model stage with no output schema", () => {
    const bad = structuredClone(microNarrative) as NarrativeProtocol;
    delete bad.stages[2]!.outputSchema;
    expect(checkProtocol(bad).join(" ")).toMatch(/no output schema/);
  });

  it("refuses a protocol that asks for confirmation of nothing", () => {
    const bad = narrativeProtocol.parse({
      ...microNarrative,
      stages: [
        { key: "e", kind: "elicit", text: "Say something", minChars: 1 },
        { key: "c", kind: "confirm", text: "Right?" },
      ],
    });
    expect(checkProtocol(bad).join(" ")).toMatch(/confirm something no stage produces/);
  });
});

describe("the participant's name", () => {
  /**
   * The researcher asked for the name to be usable. It is — on the screen.
   * Putting it in front of a third-party model is a different act with a DPIA
   * consequence, so it takes a second, explicit declaration.
   */
  it("greets the participant by name", () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    expect(runner.start().text).toBe("Hi Amara — this last part is a short conversation.");
  });

  it("reads properly when there is no name to use", () => {
    // A missing name must never render as "Hi {first_name}" or "Hi , ...".
    const runner = new NarrativeRunner(mocked(), context({ first_name: "" }), gatewayWith(new MockAdapter()));
    expect(runner.start().text).toBe("Hi — this last part is a short conversation.");
  });

  it("never sends it to the model in the shipped protocol", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been quite hard this term, mostly because of maths.");
    const prompts = calls.map((c) => c.promptResolved).join("\n");
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts).not.toContain("Amara");
    expect(calls.every((c) => c.containedIdentifiers === false)).toBe(true);
  });

  it("refuses at the gate a protocol that puts it in a prompt without saying so", () => {
    const bad = structuredClone(microNarrative) as NarrativeProtocol;
    bad.stages[2]!.prompt!.template = "The young person is called {first_name}. {participant_words}";
    const problems = checkProtocol(bad).join(" ");
    expect(problems).toMatch(/first_name/);
    expect(problems).toMatch(/stated decision/);
  });

  it("allows it when a study declares it deliberately, and records that it did", async () => {
    const deliberate = structuredClone(microNarrative) as NarrativeProtocol;
    deliberate.permittedIdentifiers = ["first_name"];
    deliberate.stages[2]!.prompt!.template = "The young person is called {first_name}. {participant_words}";
    expect(checkProtocol(deliberate)).toEqual([]);

    const runner = new NarrativeRunner(mocked(deliberate), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been hard this term.");
    const modelCalls = calls.filter((c) => c.status !== "started");
    expect(modelCalls.some((c) => c.promptResolved.includes("Amara"))).toBe(true);
    // Flagged in the provenance, so an audit can find every call that carried
    // an identifier without reading the prompts.
    expect(modelCalls.some((c) => c.containedIdentifiers)).toBe(true);
  });
});

describe("running a protocol", () => {
  it("keeps the participant's words and asks a follow-up", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    const screen = await runner.submit("School has been quite hard this term, mostly because of maths.");
    expect(screen.kind).toBe("follow_up");
    expect(screen.text.length).toBeGreaterThan(0);

    const words = participantWords(runner.all);
    expect(words).toHaveLength(1);
    expect(words[0]!.text).toContain("maths");
    expect(originalsIntact(runner.all)).toBe(true);
  });

  it("writes the staged records in order, with the right sources", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("It has been a hard term.");
    const kinds = runner.all.map((r) => `${r.source}:${r.kind}`);
    expect(kinds).toContain("system:request_shown");
    expect(kinds).toContain("participant:participant_original");
    expect(kinds).toContain("system:prompt_resolved");
    expect(kinds).toContain("model:model_raw");
    expect(kinds).toContain("model:model_validated");
    expect(kinds).toContain("system:model_shown");
    // Ordering is explicit, not implied by array position.
    expect(runner.all.map((r) => r.seq)).toEqual([...runner.all.map((_, i) => i)]);
  });

  it("asks again rather than storing an answer that is too short", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    const screen = await runner.submit("no");
    expect(screen.kind).toBe("elicit");
    expect(runner.all.some((r) => r.kind === "participant_original")).toBe(false);
    expect(runner.all.some((r) => r.kind === "validation_result")).toBe(true);
  });

  it("links a correction to what it corrects", async () => {
    // future_self opens straight on the elicitation, then the model's
    // follow-up, then the confirmation the correction attaches to.
    const runner = new NarrativeRunner(mocked(futureSelf), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.submit("I hope I am still playing football and doing something I enjoy.");
    await runner.next();
    await runner.submit("That is not quite right — it is more about being outdoors.");
    const correction = runner.all.find((r) => r.kind === "participant_correction");
    expect(correction).toBeTruthy();
    expect(correction!.refersTo).toBeTruthy();
    // And the original is still exactly what they first said.
    expect(originalsIntact(runner.all)).toBe(true);
  });
});

describe("when the model misbehaves", () => {
  it("keeps the words and records the fallback when the call times out", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter({ fail: { kind: "timeout" } })));
    runner.start();
    await runner.next();
    const screen = await runner.submit("It has been a difficult term for me.");

    expect(screen.fallback?.applied).toBe("continue_without_model");
    expect(runner.all.some((r) => r.kind === "fallback_applied")).toBe(true);
    // The whole point: nothing they said was lost, and no apology string was
    // written into a slot where data belongs.
    expect(participantWords(runner.all)[0]!.text).toContain("difficult term");
    expect(originalsIntact(runner.all)).toBe(true);
    expect(runner.all.some((r) => r.kind === "model_validated")).toBe(false);
  });

  it("records a failed call in the provenance, not just a successful one", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter({ fail: { kind: "rate_limit" } })));
    runner.start();
    await runner.next();
    await runner.submit("It has been a difficult term for me.");
    const failed = calls.find((c) => c.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed!.errorKind).toBe("rate_limit");
    expect(failed!.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not retry a safety block, because the answer will not change", async () => {
    const adapter = new MockAdapter({ fail: { kind: "safety_block" } });
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(adapter));
    runner.start();
    await runner.next();
    await runner.submit("It has been a difficult term for me.");
    expect(calls.find((c) => c.status === "failed")!.attempts).toBe(1);
  });

  it("retries a transient failure and succeeds", async () => {
    // The mock config allows a single attempt by design — retrying a
    // deterministic provider proves nothing — so this protocol asks for more.
    const retrying = mocked();
    retrying.models = retrying.models.map((m) => (m.key === "mc.mock" ? { ...m, maxAttempts: 3 } : m));
    const adapter = new MockAdapter({ fail: { kind: "transport", times: 1 } });
    const runner = new NarrativeRunner(retrying, context(), gatewayWith(adapter));
    runner.start();
    await runner.next();
    const screen = await runner.submit("It has been a difficult term for me.");
    expect(screen.fallback).toBeUndefined();
    expect(calls.find((c) => c.status === "succeeded")!.attempts).toBe(2);
  });

  it("treats output that does not match the schema as a failure", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter({ returnGarbage: true })));
    runner.start();
    await runner.next();
    const screen = await runner.submit("It has been a difficult term for me.");
    // An apology string is not a follow-up question, and must not be shown as
    // one or stored as one.
    expect(screen.fallback).toBeTruthy();
    expect(runner.all.some((r) => r.kind === "model_validated")).toBe(false);
    expect(originalsIntact(runner.all)).toBe(true);
  });

  it("skips the model entirely when offline, and still collects the narrative", async () => {
    const runner = new NarrativeRunner(mocked(), context({ online: false }), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    const screen = await runner.submit("It has been a difficult term for me.");
    expect(screen.fallback?.reason).toBe("no connection");
    expect(calls).toHaveLength(0);
    expect(participantWords(runner.all)).toHaveLength(1);
  });

  it("shows researcher-authored text when the protocol asks for that instead", async () => {
    const withText = { ...mocked(), offlineFallback: "predefined_fallback" as const };
    const runner = new NarrativeRunner(withText, context({ online: false }), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    const screen = await runner.submit("It has been a difficult term for me.");
    expect(screen.text).toBe("Thank you — that is really helpful.");
    expect(screen.fallback?.applied).toBe("predefined_fallback");
  });
});

describe("what the model may never do", () => {
  it("cannot produce a participant's words", () => {
    expect(refuseReason({ kind: "participant_original", source: "model", refersTo: null }, [])).toMatch(
      /may never become a participant's words/,
    );
    expect(refuseReason({ kind: "participant_original", source: "system", refersTo: null }, [])).toBeTruthy();
    expect(refuseReason({ kind: "participant_original", source: "participant", refersTo: null }, [])).toBeNull();
  });

  it("cannot write anything except its own output and a flag", () => {
    expect(refuseReason({ kind: "participant_rating", source: "model", refersTo: null }, [])).toMatch(/may only be/);
    expect(refuseReason({ kind: "model_validated", source: "model", refersTo: null }, [])).toBeNull();
  });

  it("cannot point a record at something that does not exist", () => {
    expect(refuseReason({ kind: "participant_correction", source: "participant", refersTo: "nope" }, [])).toMatch(
      /not a record in this session/,
    );
  });
});

describe("safeguarding", () => {
  it("raises a flag for review without showing the participant anything", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    const screen = await runner.submit("Some days I want to die and I do not know who to tell.");

    const flag = runner.all.find((r) => r.kind === "safeguarding_flag");
    expect(flag).toBeTruthy();
    expect(flag!.data).toMatchObject({ rule: "distress_lexicon", tier: "safeguarding_review" });
    // Nothing about the flag reaches the screen: it is a route to a human,
    // not a response to the young person.
    expect(screen.text.toLowerCase()).not.toContain("safeguard");
    expect(screen.text.toLowerCase()).not.toContain("concern");
  });

  it("works offline, because a lexicon rule needs no model", async () => {
    const runner = new NarrativeRunner(mocked(), context({ online: false }), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("Sometimes I think about self harm when it gets bad.");
    expect(runner.all.some((r) => r.kind === "safeguarding_flag")).toBe(true);
  });

  it("does not flag an ordinary answer", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been fine, maths is a bit hard but I like art.");
    expect(runner.all.some((r) => r.kind === "safeguarding_flag")).toBe(false);
  });
});

describe("text resolution", () => {
  it("leaves an unpermitted placeholder alone rather than inventing a value", () => {
    const { text, used } = resolveText("Hi {first_name}, about {secret}", { first_name: "Amara", secret: "x" }, new Set(["first_name"]));
    expect(text).toBe("Hi Amara, about {secret}");
    expect(used).toEqual(["first_name"]);
  });
});

describe("determinism", () => {
  it("gives the same conversation twice, so a demonstration is repeatable", async () => {
    const run = async () => {
      const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
      runner.start();
      await runner.next();
      const screen = await runner.submit("It has been a hard term because of maths.");
      return screen.text;
    };
    expect(await run()).toBe(await run());
  });
});

describe("the answer to the model's question", () => {
  /**
   * Found by running the lab: the model asks a follow-up, the participant
   * answers it on that screen, and the answer went nowhere — the stage was a
   * model stage, and only participant stages recorded anything. Silent loss of
   * the second half of every conversation.
   */
  it("is kept, and linked to the question that prompted it", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been hard this term because of maths.");
    await runner.submit("Mostly before a test. I cannot sleep the night before.");

    const words = participantWords(runner.all);
    expect(words).toHaveLength(2);
    expect(words[1]!.text).toContain("cannot sleep");
    expect(words[1]!.kind).toBe("participant_clarification");
    // It points at the question it answers, so a transcript can be rebuilt.
    const question = runner.all.find((r) => r.recordId === words[1]!.refersTo);
    expect(question?.kind).toBe("model_shown");
  });

  it("is safeguarded like any other thing a participant writes", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been hard this term because of maths.");
    await runner.submit("Some days I want to die about it.");
    expect(runner.all.some((r) => r.kind === "safeguarding_flag")).toBe(true);
  });

  it("does not invent a record when the participant says nothing", async () => {
    const runner = new NarrativeRunner(mocked(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    await runner.next();
    await runner.submit("School has been hard this term because of maths.");
    await runner.submit("   ");
    expect(participantWords(runner.all)).toHaveLength(1);
  });
});

describe("every stage the shipped protocols declare shows something", () => {
  it("has text, or produces it from a model", () => {
    // A stage with neither is a blank screen in front of a child.
    for (const protocol of [microNarrative, futureSelf]) {
      for (const stage of protocol.stages) {
        const producesText = stage.kind === "follow_up" || stage.kind === "interpret";
        expect(
          stage.text.trim().length > 0 || producesText,
          `${protocol.key}/${stage.key} would render an empty screen`,
        ).toBe(true);
      }
    }
  });
});
