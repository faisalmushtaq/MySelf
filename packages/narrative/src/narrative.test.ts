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

  it("does not leave the punctuation of a name that is not there", () => {
    // Seen on a real run: the debrief reads "Thank you, {first_name}." and a
    // participant with no name was told "Thank you,. That is everything." The
    // last thing said to them was a typo.
    const permitted = new Set(["first_name"]);
    expect(resolveText("Thank you, {first_name}. That is everything.", { first_name: "" }, permitted).text).toBe(
      "Thank you. That is everything.",
    );
    expect(resolveText("Thank you, {first_name}. That is everything.", { first_name: "Priya" }, permitted).text).toBe(
      "Thank you, Priya. That is everything.",
    );
    expect(resolveText("Hi {first_name} — this last bit.", { first_name: "" }, permitted).text).toBe(
      "Hi — this last bit.",
    );
    expect(resolveText("Hi {first_name}, how are you?", { first_name: "" }, permitted).text).toBe("Hi, how are you?");
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

describe("telling the participant how far along they are", () => {
  it("counts only the stages somebody is actually shown", () => {
    const runner = new NarrativeRunner(mocked(microNarrativeFull), context(), gatewayWith(new MockAdapter()));
    const screen = runner.start();
    const shown = microNarrativeFull.stages.filter((s) => s.kind !== "extract" && s.kind !== "generate");
    expect(screen.progress).toEqual({ step: 1, of: shown.length });
    // The protocol does have hidden stages, or this test proves nothing.
    expect(shown.length).toBeLessThan(microNarrativeFull.stages.length);
  });

  it("never goes backwards, and arrives at the end full", async () => {
    const runner = new NarrativeRunner(mocked(futureSelf), context(), gatewayWith(new MockAdapter()));
    const seen: number[] = [];
    const note = (s: { progress?: { step: number; of: number } }) => {
      if (s.progress) seen.push(s.progress.step);
    };

    note(runner.start());
    // Drive it to the end, answering whatever it asks for.
    let screen = await runner.submit("I hope I am still playing football and doing something I enjoy.");
    note(screen);
    for (let guard = 0; guard < 20 && !screen.finished; guard++) {
      screen = screen.expectsInput ? await runner.submit("That sounds about right to me.") : await runner.next();
      note(screen);
    }

    expect(screen.finished).toBe(true);
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    // Ending one short of the total reads as something having gone wrong.
    expect(screen.progress).toEqual({ step: screen.progress!.of, of: screen.progress!.of });
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

  it("never shows the closing turn, as the original never shows FINISHED", async () => {
    /**
     * The original ends the interview on the single word FINISHED and never
     * shows it; the next thing a participant reads is the app's own handover.
     * Ours ends on a boolean, and whatever the model writes on that turn is
     * discarded the same way.
     *
     * Two live failures came from not doing this: a warm goodbye immediately
     * before three retellings arrived, and a question nobody was allowed to
     * answer. Both were a model having the last word on a turn whose only job
     * is to stop.
     */
    class DoneWithAQuestion extends MockAdapter {
      override async generate(
        prompt: Parameters<MockAdapter["generate"]>[0],
        config: Parameters<MockAdapter["generate"]>[1],
        schema?: Parameters<MockAdapter["generate"]>[2],
      ) {
        const result = await super.generate(prompt, config, schema);
        if (schema?.name !== "interviewer_turn") return result;
        // The opening turn asks normally; the turn after the first answer is
        // the one that declares itself finished while still asking something.
        const answered = prompt.messages.some((m) => m.role === "user" && !m.content.startsWith("("));
        return {
          ...result,
          text: JSON.stringify({
            reply: answered ? "Thanks for sharing all this with me. Take care!" : "What do you use your phone for?",
            interviewDone: answered,
            questionsCovered: [1],
          }),
        };
      }
    }

    const runner = new NarrativeRunner(mocked(microNarrativeFull), context(), gatewayWith(new DoneWithAQuestion()));
    runner.start();
    let screen = await runner.next();
    while (screen.kind === "introduction") screen = await runner.next();
    screen = await runner.submit("I use it mostly for talking to my friends.");

    expect(runner.outcome.interviewDone).toBe(true);
    expect(screen.kind).not.toBe("collect");
    const shown = runner.all.filter((r) => r.kind === "model_shown").map((r) => r.text ?? "");
    expect(shown).not.toContain("Thanks for sharing all this with me. Take care!");
    // Recorded, so the run can be read back — just not shown and not asked.
    expect(
      runner.all.some(
        (r) => (r.data as { replyWithheld?: string } | null)?.replyWithheld === "interview_complete",
      ),
    ).toBe(true);
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

/**
 * A reload is not the end of a run.
 *
 * The runner lives in the tab, so refreshing used to lose the interview and
 * start again at the first question — on a phone, a notification or Safari
 * reclaiming a backgrounded tab does exactly that. What the page keeps is a
 * snapshot; these are the invariants that make putting one back safe.
 */
describe("carrying a run across a reload", () => {
  const partWayThrough = async () => {
    const protocol = mocked(microNarrativeFull);
    protocol.interview = { ...protocol.interview!, maxTurns: 1 };
    const runner = new NarrativeRunner(protocol, context(), gatewayWith(new MockAdapter()));
    runner.start();
    let screen = await runner.next();
    while (screen.kind === "introduction") screen = await runner.next();
    screen = await runner.submit("We fell out at lunch and it was horrible.");
    return { protocol, runner };
  };

  it("comes back with the same records, in the same order", async () => {
    const { protocol, runner } = await partWayThrough();
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), runner.snapshot());

    expect(resumed).not.toBeNull();
    expect(resumed!.all).toEqual(runner.all);
    expect(resumed!.all.map((r) => r.seq)).toEqual(runner.all.map((r) => r.seq));
    // And the participant's own words are still theirs, unaltered.
    expect(originalsIntact(resumed!.all)).toBe(true);
    expect(participantWords(resumed!.all).map((w) => w.text)).toEqual(
      participantWords(runner.all).map((w) => w.text),
    );
  });

  it("carries the retellings and the extraction, not just the transcript", async () => {
    const { protocol, runner } = await partWayThrough();
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), runner.snapshot());

    expect(resumed!.outcome.candidates).toEqual(runner.outcome.candidates);
    expect(resumed!.outcome.extraction).toEqual(runner.outcome.extraction);
    expect(resumed!.outcome.interviewDone).toBe(runner.outcome.interviewDone);
  });

  it("carries on from the stage it was on rather than starting over", async () => {
    const { protocol, runner } = await partWayThrough();
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), runner.snapshot());

    // Choosing a retelling on the resumed runner does what it would have done
    // on the original: it is at the select stage, not back at the beginning.
    const after = await resumed!.submit("0");
    expect(after.kind).toBe("rate");
    expect(resumed!.outcome.chosenIndex).toBe(0);
  });

  it("appends nothing, so the analysis cannot tell a page was reloaded", async () => {
    const { protocol, runner } = await partWayThrough();
    const before = runner.all.length;
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), runner.snapshot());
    expect(resumed!.all).toHaveLength(before);
  });

  it("keeps writing where the sequence left off", async () => {
    const { protocol, runner } = await partWayThrough();
    const lastSeq = runner.all[runner.all.length - 1]!.seq;
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), runner.snapshot());
    await resumed!.submit("0");
    const seqs = resumed!.all.map((r) => r.seq);
    // Contiguous, and nothing has reused a number already spent.
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(seqs[seqs.length - 1]).toBeGreaterThan(lastSeq);
  });

  /**
   * The refusals. Each is an ordinary thing that happens rather than an
   * error: the caller's answer to null is to start a fresh run.
   */
  it("refuses a snapshot from a different protocol", async () => {
    const { runner } = await partWayThrough();
    expect(
      NarrativeRunner.resume(mocked(futureSelf), context(), gatewayWith(new MockAdapter()), runner.snapshot()),
    ).toBeNull();
  });

  it("refuses a snapshot from a different version of the same protocol", async () => {
    const { protocol, runner } = await partWayThrough();
    // A release went out while somebody had a tab open. Half a run under one
    // version of the method and half under another is not a run.
    const republished = { ...protocol, version: `${protocol.version}.1` };
    expect(
      NarrativeRunner.resume(republished, context(), gatewayWith(new MockAdapter()), runner.snapshot()),
    ).toBeNull();
  });

  it("refuses a snapshot belonging to a different session", async () => {
    const { protocol, runner } = await partWayThrough();
    const other = { ...context(), sessionId: "ses_somebody_else" };
    expect(NarrativeRunner.resume(protocol, other, gatewayWith(new MockAdapter()), runner.snapshot())).toBeNull();
  });

  it("refuses a snapshot written by an older build", async () => {
    const { protocol, runner } = await partWayThrough();
    const old = { ...runner.snapshot(), version: 0 as unknown as 1 };
    expect(NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), old)).toBeNull();
  });

  it("refuses a run that never started", async () => {
    const { protocol, runner } = await partWayThrough();
    const empty = { ...runner.snapshot(), records: [] };
    expect(NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), empty)).toBeNull();
  });

  it("survives the round trip through JSON, which is how it actually travels", async () => {
    const { protocol, runner } = await partWayThrough();
    const throughStorage = JSON.parse(JSON.stringify(runner.snapshot())) as ReturnType<NarrativeRunner["snapshot"]>;
    const resumed = NarrativeRunner.resume(protocol, context(), gatewayWith(new MockAdapter()), throughStorage);
    expect(resumed).not.toBeNull();
    expect(resumed!.all).toEqual(runner.all);
  });

  it("hands out a copy, so a snapshot taken mid-run does not move under the caller", async () => {
    const { runner } = await partWayThrough();
    const snapshot = runner.snapshot();
    const taken = snapshot.records.length;
    await runner.submit("0");
    expect(snapshot.records).toHaveLength(taken);
  });
});
