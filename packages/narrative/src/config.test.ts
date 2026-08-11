import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  configFromProtocol,
  NO_SAFEGUARDING_STATED,
  parseProtocolFile,
  parseToml,
  protocolFromConfig,
  protocolToToml,
  stringifyToml,
  TomlError,
} from "./index.js";
import { checkProtocol, type NarrativeProtocol } from "./protocol.js";
import { futureSelf, microNarrativeFull, microNarrativeFullConfig, phoneWellbeing } from "./protocols.js";

/**
 * The fixtures are the real thing.
 *
 * They are copied unedited from `Lynn-linboliu/micro-narratives-overdiagnosis`,
 * which is the app the researcher actually runs. "Our format resembles theirs"
 * is not a claim worth making; "their six study files load" is, and it is only
 * worth anything if the files are theirs.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const configFiles = readdirSync(fixtures).filter((f) => f.endsWith(".toml"));
const read = (name: string) => readFileSync(`${fixtures}${name}`, "utf8");

describe("the TOML subset", () => {
  it("reads every study config the original app ships", () => {
    // The point of the subset is that it covers what these files use. If one
    // of them stops parsing, the subset is wrong, not the file.
    expect(configFiles.length).toBeGreaterThanOrEqual(6);
    for (const file of configFiles) {
      const parsed = parseToml(read(file)) as Record<string, Record<string, unknown>>;
      expect(Object.keys(parsed.summaries!["personas"] as object).length).toBeGreaterThanOrEqual(2);
      expect(parsed.collection!["questions"]).toBeInstanceOf(Array);
    }
  });

  it("keeps a line-continuation backslash from becoming a newline", () => {
    // Used throughout the real topic_restriction blocks.
    const parsed = parseToml(`text = """\nthe questions are asked \\\n  one at a time"""`);
    expect(parsed["text"]).toBe("the questions are asked one at a time");
  });

  it("refuses what it does not understand rather than guessing", () => {
    // The failure mode that matters: a config that half-parses runs a study
    // asking the wrong questions, and nobody finds out until the data arrives.
    expect(() => parseToml("when = 1979-05-27")).toThrow(TomlError);
    expect(() => parseToml("model = { name = 'gpt-4o' }")).toThrow(/inline tables/);
    expect(() => parseToml('key = "a"\nkey = "b"')).toThrow(/set twice/);
    expect(() => parseToml("[a]\nx = 1\n[a]\ny = 2")).toThrow(/defined twice/);
    expect(() => parseToml('key = "unterminated')).toThrow(/unterminated/);
    expect(() => parseToml('key = "a" rubbish')).toThrow(/unexpected text/);
    expect(() => parseToml("key =")).toThrow(/no value/);
  });

  it("names the line a problem is on", () => {
    try {
      parseToml("a = 1\nb = 2\nc = @\n");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as TomlError).line).toBe(3);
    }
  });

  it("round-trips everything it can write", () => {
    const table = {
      protocol: { key: "np.demo", version: "1.0.0", minutes: 12, rate: 0.35, on: true },
      text: { intro: "Hi {first_name} —\nthis is a conversation.", quote: 'she said "no"' },
      interview: { questions: ["one", "two", "three"] },
      empty: { list: [] },
      rules: [{ key: "a", terms: ["x"] }, { key: "b", terms: [] }],
    };
    expect(parseToml(stringifyToml(table))).toEqual(table);
  });
});

describe("study configuration files from the original app", () => {
  it("loads all six, untouched, into runnable protocols", () => {
    for (const file of configFiles) {
      const protocol = parseProtocolFile(read(file), file);
      expect(protocol.interview!.questions.length).toBeGreaterThan(0);
      expect(Object.keys(protocol.extraction!.keys).length).toBeGreaterThan(0);
      expect(protocol.scenario!.personas.length).toBeGreaterThanOrEqual(2);
      expect(protocol.scenario!.example).toBeDefined();
    }
  });

  it("takes the study's own words as written", () => {
    const protocol = parseProtocolFile(read("overdiagnosis1.toml"), "overdiagnosis1.toml");
    expect(protocol.interview!.persona).toBe(
      "You're a researcher collecting people's views about the perceived over-diagnosis of mental health and neurodevelopmental conditions, particularly ADHD and autism.",
    );
    expect(protocol.interview!.questions).toHaveLength(8);
    expect(protocol.extraction!.keys["what"]).toBe("What are their views about over-diagnosis?");
    expect(protocol.scenario!.personas.map((p) => p.key)).toEqual(["formal", "sibling", "goth"]);
    expect(protocol.scenario!.personas[0]!.text).toContain("experienced secondary school teacher");
    expect(protocol.qualityControl.enabled).toBe(true); // quality_control_flagging = true
    expect(protocol.models[0]!.model).toBe("gpt-4o");
  });

  it("keeps the persona's name, because which voice was chosen is a finding", () => {
    // The original stores `formal`/`sibling`/`goth` alongside the scenario.
    // An index would stop meaning anything the first time a wave reorders them.
    const protocol = parseProtocolFile(read("example_social.toml"), "example_social.toml");
    for (const persona of protocol.scenario!.personas) expect(persona.key).toMatch(/^[a-z_]+$/);
  });

  it("names a protocol after its file when the file does not name one", () => {
    const protocol = parseProtocolFile(read("brain_health.toml"), "brain_health.toml");
    expect(protocol.key).toBe("np.brain_health");
    expect(protocol.version).toBe("1.0.0");
  });

  it("carries the longitudinal pipe through, and refuses it without an id to look up", () => {
    // §8.2 assumption 4: a later wave re-presents what this participant last
    // said. The original raises rather than run it with nothing to key on.
    const protocol = parseProtocolFile(read("example_social_follow_up.toml"), "example_social_follow_up.toml");
    expect(protocol.permittedVariables).toContain("previous_scenario");

    const config = parseToml(read("example_social_follow_up.toml")) as Record<string, Record<string, unknown>>;
    config["participant"]!["require_participant_id"] = false;
    expect(() => protocolFromConfig(config)).toThrow(/nothing to look the previous scenario up by/);
  });

  it("loads without a safeguarding declaration, and refuses to pretend there is one", () => {
    // Trying a file out costs nothing. Putting it in front of a child requires
    // somebody to have written down what happens if that child says something
    // frightening — so an untouched file gets a declaration that says so, and
    // the release gate stops there.
    const protocol = parseProtocolFile(read("example_social.toml"), "example_social.toml");
    expect(protocol.safeguardingDeclaration).toBe(NO_SAFEGUARDING_STATED);
    expect(protocol.approvalStatus).toBe("draft");
    // It still runs: the gate is about fielding, not about trying.
    expect(checkProtocol(protocol)).toEqual([]);
  });
});

describe("writing a configuration file back out", () => {
  it("expresses a shipped protocol and rebuilds it unchanged", () => {
    expect(protocolFromConfig(configFromProtocol(microNarrativeFull))).toEqual(microNarrativeFull);
  });

  it("survives the trip through TOML", () => {
    const rebuilt = parseProtocolFile(protocolToToml(microNarrativeFull), "micro_narrative_full.toml");
    expect(rebuilt).toEqual(microNarrativeFull);
  });

  /**
   * The files in `protocols/` are what a researcher copies and edits, and
   * nothing generates them at build time — so they can quietly drift from the
   * protocol that actually ships. Somebody would then edit a file believing it
   * to be the thing they had just run, and be debugging a difference that
   * exists only on disk.
   *
   * Checked by parsing the committed file rather than by comparing text, so
   * reformatting is allowed and a change in meaning is not.
   */
  it("keeps the committed protocol files in step with what ships", () => {
    const shipped: [string, NarrativeProtocol][] = [
      ["micro_narrative_full.toml", microNarrativeFull],
      ["phone_wellbeing.toml", phoneWellbeing],
    ];
    for (const [file, protocol] of shipped) {
      const onDisk = readFileSync(new URL(`../../../protocols/${file}`, import.meta.url), "utf8");
      expect(parseProtocolFile(onDisk, file), `${file} has drifted from the shipped protocol`).toEqual(protocol);
    }
  });

  it("round-trips a real study file, so an edited one can go back to the original app", () => {
    const protocol = parseProtocolFile(read("overdiagnosis1.toml"), "overdiagnosis1.toml");
    const rewritten = parseProtocolFile(protocolToToml(protocol), "overdiagnosis1.toml");
    expect(rewritten).toEqual(protocol);

    // ...and the file it writes has the sections the original app reads.
    const table = parseToml(protocolToToml(protocol)) as Record<string, unknown>;
    expect(Object.keys(table).sort()).toEqual(
      ["collection", "consent", "example", "model", "myself", "participant", "quality_control_flagging", "summaries"].sort(),
    );
  });

  it("does not write out a declaration that only says there isn't one", () => {
    const protocol = parseProtocolFile(read("example_social.toml"), "example_social.toml");
    expect(protocolToToml(protocol)).not.toContain("NOT STATED");
  });

  it("will not write a file for a protocol whose stages it cannot express", () => {
    expect(() => configFromProtocol(futureSelf)).toThrow(/cannot express/);
  });

  it("only reads a file whose extension says what it is", () => {
    expect(() => parseProtocolFile("{}", "study.yaml")).toThrow(/\.toml or \.json/);
    expect(parseProtocolFile(JSON.stringify(microNarrativeFullConfig), "study.json").key).toBe(microNarrativeFull.key);
  });
});

describe("the publish gate over a configuration", () => {
  const config = microNarrativeFullConfig;

  it("passes what ships", () => {
    expect(checkProtocol(microNarrativeFull)).toEqual([]);
  });

  it("builds the CHI 2025 journey, in order, whatever the study says", () => {
    const rebuilt = protocolFromConfig({
      ...config,
      collection: { ...config.collection, questions: ["Tell me about school."] },
    });
    expect(rebuilt.stages.map((s) => s.kind)).toEqual([
      "introduction",
      "introduction",
      "collect",
      "extract",
      "generate",
      "select",
      "rate",
      "adapt",
      "debrief",
    ]);
    expect(rebuilt.interview?.questions).toEqual(["Tell me about school."]);
  });

  it("catches a mistyped placeholder in a question, which no screen would show", () => {
    // A question is not fixed text: a study writes "when {topic} came up for
    // you" and sets the topic once. Mistype it and the model is asked to
    // enquire about the seven characters "{topik}".
    const broken = protocolFromConfig({
      ...config,
      collection: { ...config.collection, questions: ["When did {topik} come up?"] },
    });
    expect(checkProtocol(broken).join(" ")).toMatch(/interview question 1 uses \{topik\}/);

    const persona = protocolFromConfig({
      ...config,
      summaries: { ...config.summaries, personas: { plain: "a {voice}", feeling: "b" } },
    });
    expect(checkProtocol(persona).join(" ")).toMatch(/persona 'plain' uses \{voice\}/);

    const key = protocolFromConfig({
      ...config,
      summaries: { ...config.summaries, questions: { what: "What did they say about {topik}?" } },
    });
    expect(checkProtocol(key).join(" ")).toMatch(/extraction key 'what' uses \{topik\}/);
  });

  it("refuses a name smuggled into a prompt through the question list", () => {
    // The identifier rule protects prompt templates. A question is a prompt
    // template too — it is pasted into the interviewer's system message.
    const named = protocolFromConfig({
      ...config,
      collection: { ...config.collection, questions: ["Hi {first_name}, what happened?"] },
    });
    expect(checkProtocol(named).join(" ")).toMatch(/not listed in permittedIdentifiers/);

    const released = protocolFromConfig({
      ...config,
      collection: { ...config.collection, questions: ["Hi {first_name}, what happened?"] },
      myself: { ...config.myself, permitted_identifiers: ["first_name"] },
    });
    expect(checkProtocol(released)).toEqual([]);
  });

  it("declares the mock, so the same file can be run without a key or a bill", () => {
    expect(microNarrativeFull.models.map((m) => m.key)).toContain("mc.mock");
    // ...and no stage uses it: a study runs on the model it declared.
    expect(microNarrativeFull.stages.every((s) => s.modelConfigKey !== "mc.mock")).toBe(true);
  });
});

describe("who the participant is talking to", () => {
  /**
   * The character is per-study because the cohort decides it, and the one
   * thing it may never do is let somebody believe there is a person on the
   * other end. A name and a face are precisely what create that belief, so
   * the disclosure is enforced rather than trusted to whoever writes the
   * next protocol.
   */
  it("gives the younger protocol a robot and the older one a neutral name", () => {
    expect(microNarrativeFull.character.name).toBe("Botty");
    expect(microNarrativeFull.character.look).toBe("robot");
    expect(phoneWellbeing.character.name).toBe("Sam");
    expect(phoneWellbeing.character.look).toBe("neutral");
    expect(phoneWellbeing.character.meaning).toBe("Stories About Me");
  });

  it("refuses a character whose profile never says it is an AI", () => {
    const pretending = {
      ...phoneWellbeing,
      character: { ...phoneWellbeing.character, about: ["I like hearing about your day.", "Tell me anything."] },
    };
    expect(checkProtocol(pretending).join(" ")).toMatch(/never says it is an AI/);
    expect(checkProtocol(phoneWellbeing)).not.toContain(expect.stringMatching(/never says it is an AI/));
  });

  it("carries the character through a file and back", () => {
    const rewritten = parseProtocolFile(protocolToToml(microNarrativeFull), "micro_narrative_full.toml");
    expect(rewritten.character).toEqual(microNarrativeFull.character);
  });

  it("defaults a study that names no character to one that names itself", () => {
    const bare = parseProtocolFile(read("overdiagnosis1.toml"), "overdiagnosis1.toml");
    expect(bare.character.name).toBe("Sam");
    expect(checkProtocol(bare).join(" ")).not.toMatch(/never says it is an AI/);
  });
});
