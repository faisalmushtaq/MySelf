import { beforeEach, describe, expect, it } from "vitest";
import { Gateway, MockAdapter, type ModelCall } from "@myself/llm";
import { checkProtocol, narrativeProtocol, type NarrativeProtocol } from "./protocol.js";
import { originalsIntact, participantWords, refuseReason } from "./records.js";
import { NarrativeRunner, resolveText } from "./runner.js";
import { futureSelf, microNarrative, microNarrativeFull } from "./protocols.js";
import { aggregate, shouldStopBeforeGeneration, signalsFor } from "./quality.js";

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

describe("the full CHI 2025 journey", () => {
  /**
   * Faithfulness to the original is the point (docs/08 §8.2), so these test
   * the method rather than the plumbing: a guided interview over the
   * researcher's questions, extraction that does not invent, personas the
   * participant chooses between, a rating, and a correction in their words.
   */
  const full = () => mocked(microNarrativeFull);

  const runThrough = async (answers: string[], opts: { protocol?: NarrativeProtocol } = {}) => {
    const runner = new NarrativeRunner(opts.protocol ?? full(), context(), gatewayWith(new MockAdapter()));
    runner.start();
    // Past the consent page and the interviewer's opening, into the interview.
    // Both come from the study's own file: `[consent] intro_and_consent` and
    // `[collection] intro`.
    let screen = await runner.next();
    while (screen.kind === "introduction") screen = await runner.next();
    for (const answer of answers) {
      screen = await runner.submit(answer);
      if (!screen.expectsInput || screen.kind !== "collect") break;
    }
    return { runner, screen };
  };

  it("interviews before it writes anything", async () => {
    const { runner, screen } = await runThrough(["It happened at school last week."]);
    expect(screen.kind).toBe("collect");
    expect(screen.expectsInput).toBe(true);
    // Nothing has been generated: no retelling exists until the interview ends.
    expect(runner.outcome.candidates).toHaveLength(0);
    expect(runner.outcome.finalScenario).toBeNull();
  });

  it("closes the interview at the researcher's turn limit rather than running for ever", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 2 };
    const { runner } = await runThrough(["First answer here.", "Second answer here."], { protocol: short });
    expect(runner.outcome.interviewDone).toBe(true);
  });

  it("cannot be ended by a participant saying the wrong word", async () => {
    // The original ended on a "FINISHED" sentinel in the model's reply, which
    // a participant could speak and a model could echo. Completion is now a
    // field in the structured output.
    const { runner, screen } = await runThrough(["FINISHED"]);
    expect(runner.outcome.interviewDone).toBe(false);
    expect(screen.kind).toBe("collect");
  });

  it("extracts into the researcher's keys, and keeps a null where nothing was said", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 1 };
    const { runner } = await runThrough(["We fell out over something at lunch and it was horrible."], {
      protocol: short,
    });
    const keys = Object.keys(microNarrativeFull.extraction!.keys);
    expect(Object.keys(runner.outcome.extraction).sort()).toEqual(keys.sort());
  });

  it("offers one retelling per persona, and the participant picks", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 1 };
    const { runner, screen } = await runThrough(["We fell out at lunch and it was horrible."], { protocol: short });

    expect(screen.kind).toBe("select");
    expect(screen.choices).toHaveLength(microNarrativeFull.scenario!.personas.length);
    // Recorded by persona NAME — `plain`, `feeling`, `their_words` — because
    // which voice a young person recognised as theirs is a finding, and an
    // index stops meaning anything the moment a wave reorders the list.
    expect(runner.outcome.candidates.map((c) => c.persona)).toEqual(
      microNarrativeFull.scenario!.personas.map((p) => p.key),
    );

    const rating = await runner.submit("1");
    expect(rating.kind).toBe("rate");
    // The choice itself is recorded as data, not just used for navigation.
    const choice = runner.all.find((r) => r.data && "chosenIndex" in r.data);
    expect(choice?.data).toMatchObject({ chosenIndex: 1, offered: 3 });
    expect(runner.outcome.chosenIndex).toBe(1);
  });

  it("skips the correction step when the participant says it is exactly right", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 1 };
    const { runner } = await runThrough(["We fell out at lunch."], { protocol: short });
    await runner.submit("0"); // choose
    const after = await runner.submit("10"); // rate

    expect(after.kind).toBe("debrief");
    expect(runner.all.some((r) => r.kind === "stage_skipped" && (r.data as { reason?: string })?.reason === "rated_full_marks")).toBe(true);
  });

  it("offers the correction step when it is not right, and keeps both versions", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 1 };
    const { runner } = await runThrough(["We fell out at lunch."], { protocol: short });
    await runner.submit("0");
    const adapt = await runner.submit("6");
    expect(adapt.kind).toBe("adapt");
    const before = runner.outcome.finalScenario;

    await runner.submit("It was more that I felt left out, not that we argued.");
    // The revision is a new record beside the old, and the correction is
    // linked to what it corrected.
    expect(runner.all.filter((r) => r.kind === "model_shown").length).toBeGreaterThan(1);
    const correction = runner.all.find((r) => r.kind === "participant_correction");
    expect(correction?.refersTo).toBeTruthy();
    expect(runner.outcome.finalScenario).not.toBe(before);
    expect(originalsIntact(runner.all)).toBe(true);
  });

  it("never lets a model record become the participant's words, all journey long", async () => {
    const short = full();
    short.interview = { ...short.interview!, maxTurns: 1 };
    const { runner } = await runThrough(["We fell out at lunch."], { protocol: short });
    await runner.submit("0");
    await runner.submit("4");
    await runner.submit("It was more that I felt left out.");
    for (const record of runner.all.filter((r) => r.kind === "participant_original")) {
      expect(record.source).toBe("participant");
    }
    expect(originalsIntact(runner.all)).toBe(true);
  });
});

describe("typing-dynamics quality control", () => {
  const config = { enabled: true, maxCharsPerSecond: 15, longMessageChars: 250, flagAboveShare: 0.3, stopBeforeGeneration: true };

  it("spots a paste, implausible speed, and a long multi-line answer", () => {
    expect(signalsFor({ text: "typed at a normal pace", composeMs: 8000, pasted: false }, config).suspect).toBe(false);
    expect(signalsFor({ text: "pasted in", composeMs: 8000, pasted: true }, config).pasted).toBe(true);
    expect(signalsFor({ text: "x".repeat(300), composeMs: 8000, pasted: false }, config).longOrMultiline).toBe(true);
    expect(signalsFor({ text: "a".repeat(200), composeMs: 1000, pasted: false }, config).fastTyping).toBe(true);
  });

  it("does not compute a speed from an implausibly short compose time", () => {
    // Dividing by almost zero produces a number that means nothing; the paste
    // flag is what catches that case.
    expect(signalsFor({ text: "hi", composeMs: 20, pasted: false }, config).charsPerSecond).toBeNull();
  });

  it("flags a session only above the researcher's share, not at it", () => {
    const clean = { pasted: false, fastTyping: false, longOrMultiline: false, charsPerSecond: 3, suspect: false };
    const dirty = { ...clean, pasted: true, suspect: true };
    // Exactly 30% is not "more than 30%".
    expect(aggregate([dirty, ...Array(9).fill(clean)], config).flagged).toBe(false);
    expect(aggregate([dirty, dirty, dirty, dirty, ...Array(6).fill(clean)], config).flagged).toBe(true);
  });

  it("does nothing at all when the study has not turned it on", () => {
    const off = { ...config, enabled: false };
    const dirty = { pasted: true, fastTyping: true, longOrMultiline: true, charsPerSecond: 99, suspect: true };
    expect(aggregate([dirty, dirty], off).flagged).toBe(false);
    expect(shouldStopBeforeGeneration(aggregate([dirty, dirty], off), off)).toBe(false);
  });

  it("stops before generating, and still keeps everything collected", async () => {
    const strict = mocked(microNarrativeFull);
    strict.interview = { ...strict.interview!, maxTurns: 1 };
    strict.qualityControl = config;
    const runner = new NarrativeRunner(strict, context(), gatewayWith(new MockAdapter()));
    runner.start();
    let screen = await runner.next();
    while (screen.kind === "introduction") screen = await runner.next();
    screen = await runner.submit("x".repeat(400), { composeMs: 500, pasted: true });

    expect(screen.stopped?.reason).toMatch(/quality signals/);
    expect(runner.outcome.candidates).toHaveLength(0);
    // Nothing is discarded: what they wrote is on the record either way.
    expect(participantWords(runner.all)).toHaveLength(1);
    expect(runner.outcome.quality.flagged).toBe(true);
  });
});

describe("the participant rewriting the retelling themselves", () => {
  /**
   * §8.1: the original offers "direct text editing and/or AI-assisted
   * adaptation chat with accept/reject/reset". Only the second half was built.
   * A sentence a young person typed is evidence in a way a model's reading of
   * their instruction is not, so the two must be distinguishable afterwards.
   */
  const toAdapt = async () => {
    const protocol = mocked(microNarrativeFull);
    protocol.interview = { ...protocol.interview!, maxTurns: 1 };
    const runner = new NarrativeRunner(protocol, context(), gatewayWith(new MockAdapter()));
    runner.start();
    let screen = await runner.next();
    while (screen.kind === "introduction") screen = await runner.next();
    screen = await runner.submit("We fell out at lunch and it was horrible.");
    screen = await runner.submit("0"); // choose the first retelling
    screen = await runner.submit("6"); // rate it below full marks
    return { runner, screen };
  };

  it("offers the retelling for editing, not just for comment", async () => {
    const { screen } = await toAdapt();
    expect(screen.kind).toBe("adapt");
    expect(screen.editable).toBe(true);
    expect(screen.scenario).toBeTruthy();
  });

  it("keeps a participant's own edit as their words, not as a correction", async () => {
    const { runner } = await toAdapt();
    const before = runner.outcome.finalScenario;
    const screen = runner.editScenario("It was at lunch and I felt left out for the rest of the day.");

    expect(screen.scenario).toBe("It was at lunch and I felt left out for the rest of the day.");
    expect(runner.outcome.finalScenario).toBe("It was at lunch and I felt left out for the rest of the day.");

    const edit = runner.all.find((r) => r.kind === "participant_edit");
    expect(edit?.source).toBe("participant");
    // It says what it replaced, so every version is reconstructable in order.
    expect(edit?.data?.["replaced"]).toBe(before);
    expect(edit?.refersTo).toBeTruthy();
    // And it is not filed as a correction: a correction asks the model to
    // change something; this IS the change.
    expect(runner.all.some((r) => r.kind === "participant_correction")).toBe(false);
    expect(originalsIntact(runner.all)).toBe(true);
  });

  it("makes no model call for an edit, because there is nothing to ask", async () => {
    const { runner } = await toAdapt();
    const before = calls.length;
    runner.editScenario("My own words, thank you.");
    expect(calls).toHaveLength(before);
  });

  it("ignores an edit that changes nothing, rather than filling the log with it", async () => {
    const { runner } = await toAdapt();
    const unchanged = runner.outcome.finalScenario!;
    runner.editScenario(unchanged);
    runner.editScenario("   ");
    expect(runner.all.some((r) => r.kind === "participant_edit")).toBe(false);
  });

  it("puts back the previous version without deleting the one turned down", async () => {
    const { runner } = await toAdapt();
    const original = runner.outcome.finalScenario!;
    runner.editScenario("A version they then thought better of.");
    const screen = runner.revertScenario();

    expect(screen.scenario).toBe(original);
    expect(runner.outcome.finalScenario).toBe(original);
    // What they rejected stays on the record — turning a retelling down is a
    // finding about it, not noise to be swept up.
    expect(runner.all.some((r) => r.text === "A version they then thought better of.")).toBe(true);
    // The LAST reaction: choosing a retelling writes one of these too.
    const reactions = runner.all.filter((r) => r.kind === "participant_reaction");
    expect(reactions[reactions.length - 1]?.data?.["rejected"]).toBe("A version they then thought better of.");
  });
});
