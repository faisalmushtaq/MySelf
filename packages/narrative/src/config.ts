import { z } from "zod";
import { narrativeProtocol, type NarrativeProtocol } from "./protocol.js";
import { parseToml, stringifyToml, TomlError, type TomlValue } from "./toml.js";

/**
 * A study configuration file — the micro-narratives app's own format.
 *
 * Not a format of our own invention that resembles it. The real thing: the
 * sections and key names in `Lynn-linboliu/micro-narratives-overdiagnosis`,
 * read the way `llm_config.py` reads them, so a `.toml` written for that app
 * drops in here and runs. Six configs ship with it — social media, a follow-up
 * wave, alexithymia, parent-child connection, brain health, overdiagnosis —
 * and all six load without being touched.
 *
 * That is the whole point of configuration-over-code: a researcher who has
 * already been through ethics with a file should not have to re-key it, and a
 * file that has been re-keyed is a file whose questions might have changed.
 *
 *   model                        top level, defaults to gpt-4o
 *   quality_control_flagging     top level, defaults to false
 *   [consent]                    intro_and_consent
 *   [participant]                require_participant_id, editable_participant_id, text
 *   [collection]                 persona, language_type, intro, questions, topic_restriction
 *   [summaries.questions]        key -> the question that key answers
 *   [summaries.personas]         name -> the voice that writes the retelling
 *   [example]                    conversation, scenario
 *
 * Everything MySelf needs and the original has no field for lives under an
 * optional `[myself]` table: the safeguarding declaration, which variables may
 * reach a prompt, what happens with no network, and the words a participant
 * reads at the stages the original hard-codes in `app.py` (§8.3 lists that as
 * debt — the phrasing a child sees is a study decision).
 *
 * A file with no `[myself]` table loads and runs. It cannot be FIELDED: with
 * no safeguarding declaration it fails the release gate, which is the correct
 * boundary. Trying it out costs nothing; putting it in front of a child in a
 * school requires somebody to have written down what happens if that child
 * says something frightening.
 */

const nonEmpty = z.string().min(1);

/** MySelf's additions. Every field optional; the defaults are the cautious ones. */
const myselfSection = z
  .object({
    key: z.string().regex(/^np\.[a-z0-9_]+$/, "protocol keys look like np.my_study").optional(),
    version: z.string().optional(),
    name: z.string().optional(),
    research_question: z.string().optional(),
    owner: z.string().optional(),
    approval_status: z.enum(["draft", "in_review", "approved"]).default("draft"),
    language: z.string().default("en-GB"),
    estimated_minutes: z.number().positive().default(12),
    age_min: z.number().int().optional(),
    age_max: z.number().int().optional(),

    /**
     * Who the participant thinks they are talking to.
     *
     * Set per study because the cohort decides it: a ten-year-old holds onto
     * "this is a robot called Botty" far better than a name, and a
     * sixteen-year-old dismisses a robot as something made for children. The
     * name carries no gender and no culture on purpose.
     */
    character: z
      .object({
        name: z.string().min(1).max(40).optional(),
        meaning: z.string().max(120).optional(),
        look: z.enum(["robot", "neutral", "logo"]).optional(),
        about: z.array(z.string().min(1).max(300)).optional(),
      })
      .default({}),

    /** Substitutable in what the participant reads and in the prompts. */
    permitted_variables: z.array(z.string()).default([]),
    /** Of those, the ones allowed to reach a provider. Sending a name is a decision. */
    permitted_identifiers: z.array(z.string()).default([]),

    provider: z.enum(["openai", "anthropic", "mock"]).default("openai"),
    temperature: z.number().min(0).max(2).default(0.7),
    max_output_tokens: z.number().int().positive().default(600),
    timeout_seconds: z.number().int().positive().default(30),
    max_attempts: z.number().int().min(1).max(5).default(3),
    training_use_opt_out: z.boolean().default(true),
    retention_note: z.string().optional(),
    region: z.string().optional(),

    /**
     * The participant-facing words the original keeps in `app.py`. Defaults
     * reproduce what that app says, so a dropped-in file reads the same.
     */
    outro: z.string().default("Great, I think I got all I need -- but let me double check!"),
    select_text: z.string().default("Here are three short write-ups of what you told me. Which one fits best?"),
    select_lede: z.string().default("None of them will be perfect. Pick the closest and you can fix it next."),
    rate_text: z.string().default("How well does that one describe what you told us?"),
    rate_lede: z.string().default("0 means it is not right at all. 10 means it is exactly right."),
    adapt_text: z.string().default("What would you change about it?"),
    adapt_lede: z.string().default("Tell me in your own words and I will rewrite it."),
    debrief_text: z.string().default("Thank you. That is everything."),
    debrief_lede: z.string().default(""),
    fallback_text: z.string().default(""),

    max_turns: z.number().int().min(1).max(40).default(20),
    min_chars: z.number().int().min(0).default(1),
    max_chars: z.number().int().positive().default(2000),

    /** Thresholds for the typing-dynamics signals, when they are switched on. */
    max_chars_per_second: z.number().positive().default(15),
    long_message_chars: z.number().int().positive().default(250),
    flag_above_share: z.number().min(0).max(1).default(0.3),
    stop_before_generation: z.boolean().default(true),

    offline_fallback: z
      .enum(["queue_authorised", "continue_without_model", "predefined_fallback", "pause_module"])
      .default("continue_without_model"),
    safeguarding_declaration: z.string().optional(),
    consent_requirements: z.array(z.string()).default([]),
    safeguarding: z
      .array(
        z.object({
          key: nonEmpty,
          kind: z.enum(["lexicon", "model_classifier"]).default("lexicon"),
          terms: z.array(z.string()).default([]),
          tier: z.enum(["data_quality", "team_notification", "safeguarding_review"]),
          reviewers: z.array(z.string()).default([]),
          disclosure: nonEmpty,
        }),
      )
      .default([]),
  })
  .default({});

export const protocolConfig = z.object({
  model: z.string().default("gpt-4o"),
  quality_control_flagging: z.boolean().default(false),

  consent: z.object({ intro_and_consent: nonEmpty }),

  participant: z
    .object({
      require_participant_id: z.boolean().default(false),
      editable_participant_id: z.boolean().default(true),
      text: z.string().default(""),
    })
    .default({}),

  collection: z.object({
    persona: nonEmpty,
    language_type: nonEmpty,
    intro: nonEmpty,
    questions: z.array(nonEmpty).min(1),
    topic_restriction: nonEmpty,
  }),

  summaries: z.object({
    questions: z.record(nonEmpty),
    /**
     * The original documents exactly three and ignores any beyond that. Here
     * the number is the researcher's — two is a coin toss and eight is a
     * chore, but nothing about the method requires precisely three, and
     * silently dropping a fourth persona a researcher wrote is worse than
     * running it.
     */
    personas: z.record(nonEmpty),
  }),

  example: z.object({ conversation: nonEmpty, scenario: nonEmpty }),

  myself: myselfSection,
});

export type ProtocolConfig = z.infer<typeof protocolConfig>;

/**
 * The stated declaration, or the fact that there is not one.
 *
 * A protocol must carry a safeguarding declaration; the schema will not let it
 * be blank. A config that says nothing gets this, which is honest, and which
 * the release gate then refuses — an untouched file can be tried out, and
 * cannot reach a school.
 */
export const NO_SAFEGUARDING_STATED =
  "NOT STATED. This configuration was loaded without a [myself] safeguarding_declaration, so no safeguarding arrangement has been recorded for it. It cannot be fielded until one is.";

/** Variables the original pipes, and MySelf therefore has to know about. */
export const PREVIOUS_SCENARIO = "previous_scenario";

export function modelKeyFor(myself: ProtocolConfig["myself"], model: string): string {
  const name = model.toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
  return `mc.${myself.provider}.${name}.t${String(myself.temperature).replace(".", "")}`;
}

/**
 * The deterministic mock, declared on every protocol.
 *
 * No stage names it, so no study runs on it. It is there so the same file can
 * be exercised without a key or a bill — the lab, the tests, and anyone
 * clicking through the module for an ethics committee swap the stages onto it,
 * and a protocol that had not declared it would fail its own gate the moment
 * they tried.
 */
const MOCK_MODEL = {
  key: "mc.mock",
  provider: "mock" as const,
  model: "deterministic",
  temperature: 0,
  maxOutputTokens: 800,
  timeoutSeconds: 5,
  maxAttempts: 1,
};

const slugOf = (filename: string): string =>
  filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "untitled";

export interface ExpandOptions {
  /** Used for the protocol key and name when `[myself]` does not give them. */
  filename?: string;
}

/** Expand a study configuration into the full protocol the runner executes. */
export function protocolFromConfig(input: unknown, options: ExpandOptions = {}): NarrativeProtocol {
  const config = protocolConfig.parse(input);
  const { myself } = config;
  const stem = slugOf(options.filename ?? "untitled");
  const modelKey = modelKeyFor(myself, config.model);

  const personas = Object.entries(config.summaries.personas).map(([key, text]) => ({ key, text: text.trim() }));

  /**
   * The original's longitudinal pipe. `{previous_scenario}` in the collection
   * intro means "insert what this participant last said", and the app refuses
   * to run it without a participant ID because there would be nothing to look
   * it up by. Same rule here, checked at load rather than at the first
   * session.
   */
  const usesPrevious = config.collection.intro.includes(`{${PREVIOUS_SCENARIO}}`);
  if (usesPrevious && !config.participant.require_participant_id) {
    throw new Error(
      "the collection intro pipes in {previous_scenario}, but require_participant_id is false — there would be nothing to look the previous scenario up by",
    );
  }

  const permitted = new Set(myself.permitted_variables);
  if (usesPrevious) permitted.add(PREVIOUS_SCENARIO);

  return narrativeProtocol.parse({
    key: myself.key ?? `np.${stem}`,
    version: myself.version ?? "1.0.0",
    name: myself.name ?? stem.replaceAll("_", " "),
    // The research question defaults to the study's own first question, which
    // is a truthful placeholder rather than an invented one.
    researchQuestion: myself.research_question ?? config.collection.questions[0]!,
    owner: myself.owner ?? "unattributed",
    approvalStatus: myself.approval_status,
    language: myself.language,
    estimatedMinutes: myself.estimated_minutes,
    ...(myself.age_min !== undefined && myself.age_max !== undefined
      ? { ageRange: { min: myself.age_min, max: myself.age_max } }
      : {}),

    // Only the keys the file actually set; the rest come from the schema's
    // defaults, so a study that says nothing still gets a character that
    // names itself as an AI.
    character: {
      ...(myself.character.name !== undefined ? { name: myself.character.name } : {}),
      ...(myself.character.meaning !== undefined ? { meaning: myself.character.meaning } : {}),
      ...(myself.character.look !== undefined ? { look: myself.character.look } : {}),
      ...(myself.character.about !== undefined ? { about: myself.character.about } : {}),
    },

    permittedVariables: [...permitted],
    permittedIdentifiers: myself.permitted_identifiers,

    models: [
      {
        key: modelKey,
        provider: myself.provider,
        model: config.model,
        temperature: myself.temperature,
        maxOutputTokens: myself.max_output_tokens,
        timeoutSeconds: myself.timeout_seconds,
        maxAttempts: myself.max_attempts,
        dataHandling: {
          trainingUseOptOut: myself.training_use_opt_out,
          ...(myself.retention_note ? { retentionNote: myself.retention_note } : {}),
          ...(myself.region ? { region: myself.region } : {}),
        },
      },
      MOCK_MODEL,
    ],

    interview: {
      persona: config.collection.persona.trim(),
      questions: config.collection.questions,
      languageStyle: config.collection.language_type.trim(),
      topicRestriction: config.collection.topic_restriction.trim(),
      maxTurns: myself.max_turns,
    },
    extraction: { keys: config.summaries.questions },
    scenario: {
      personas,
      maxRating: 10,
      adaptBelowRating: 10,
      example: { conversation: config.example.conversation, scenario: config.example.scenario },
    },
    qualityControl: {
      // One switch in the original; the thresholds it uses are the defaults.
      enabled: config.quality_control_flagging,
      maxCharsPerSecond: myself.max_chars_per_second,
      longMessageChars: myself.long_message_chars,
      flagAboveShare: myself.flag_above_share,
      stopBeforeGeneration: myself.stop_before_generation,
    },

    offlineFallback: myself.offline_fallback,
    safeguardingDeclaration: myself.safeguarding_declaration ?? NO_SAFEGUARDING_STATED,
    consentRequirements: myself.consent_requirements,
    safeguarding: myself.safeguarding,

    // The journey, which a config does not get to reorder. These stages and
    // their order are the CHI 2025 method; what varies between studies is what
    // they say and what they ask, which is everything above.
    stages: [
      { key: "consent", kind: "introduction", text: config.consent.intro_and_consent.trim() },
      { key: "intro", kind: "introduction", text: config.collection.intro.trim() },
      {
        key: "interview",
        kind: "collect",
        modelConfigKey: modelKey,
        minChars: myself.min_chars,
        maxChars: myself.max_chars,
        maxTurns: myself.max_turns,
        text: "",
        ...(myself.fallback_text ? { fallbackText: myself.fallback_text } : {}),
      },
      { key: "extract", kind: "extract", modelConfigKey: modelKey, text: "" },
      { key: "write", kind: "generate", modelConfigKey: modelKey, text: "" },
      { key: "choose", kind: "select", text: myself.select_text, lede: myself.select_lede },
      { key: "rate", kind: "rate", text: myself.rate_text, lede: myself.rate_lede },
      {
        key: "revise",
        kind: "adapt",
        modelConfigKey: modelKey,
        text: myself.adapt_text,
        lede: myself.adapt_lede,
        optional: true,
      },
      { key: "debrief", kind: "debrief", text: myself.debrief_text, lede: myself.debrief_lede },
    ],
  });
}

const stageText = (protocol: NarrativeProtocol, key: string, field: "text" | "lede"): string => {
  const stage = protocol.stages.find((s) => s.key === key);
  return (field === "text" ? stage?.text : stage?.lede) ?? "";
};

/**
 * A protocol back to a configuration file.
 *
 * The other direction, so the researcher view can load what is running, be
 * edited, and hand back a file to commit — and so a file written here is one
 * the original app could also run. It only works for protocols of the full
 * journey shape; the shorter ones have stages this format has no field for,
 * and writing one anyway would produce a file that silently ran a different
 * study.
 */
export function configFromProtocol(protocol: NarrativeProtocol): ProtocolConfig {
  if (!protocol.interview || !protocol.extraction || !protocol.scenario?.example) {
    throw new Error(
      `'${protocol.key}' is not a full-journey protocol — a configuration file cannot express its stages, so writing one would quietly lose them`,
    );
  }

  const model = protocol.models.find((m) => m.provider !== "mock") ?? protocol.models[0]!;
  const interview = protocol.stages.find((s) => s.kind === "collect");
  const declaration = protocol.safeguardingDeclaration;

  return protocolConfig.parse({
    model: model.model,
    quality_control_flagging: protocol.qualityControl.enabled,
    consent: { intro_and_consent: stageText(protocol, "consent", "text") },
    participant: {
      require_participant_id: protocol.permittedVariables.includes(PREVIOUS_SCENARIO),
      editable_participant_id: true,
      text: "",
    },
    collection: {
      persona: protocol.interview.persona,
      language_type: protocol.interview.languageStyle,
      intro: stageText(protocol, "intro", "text"),
      questions: protocol.interview.questions,
      topic_restriction: protocol.interview.topicRestriction,
    },
    summaries: {
      questions: protocol.extraction.keys,
      personas: Object.fromEntries(protocol.scenario.personas.map((p) => [p.key, p.text])),
    },
    example: protocol.scenario.example,
    myself: {
      key: protocol.key,
      version: protocol.version,
      name: protocol.name,
      research_question: protocol.researchQuestion,
      owner: protocol.owner,
      approval_status: protocol.approvalStatus,
      language: protocol.language,
      estimated_minutes: protocol.estimatedMinutes,
      ...(protocol.ageRange ? { age_min: protocol.ageRange.min, age_max: protocol.ageRange.max } : {}),
      // Written out in full on the way back, so a researcher editing the file
      // can see what the character currently is rather than an empty section.
      character: {
        name: protocol.character.name,
        meaning: protocol.character.meaning,
        look: protocol.character.look,
        about: protocol.character.about,
      },
      permitted_variables: protocol.permittedVariables,
      permitted_identifiers: protocol.permittedIdentifiers,
      provider: model.provider,
      temperature: model.temperature,
      max_output_tokens: model.maxOutputTokens,
      timeout_seconds: model.timeoutSeconds,
      max_attempts: model.maxAttempts,
      training_use_opt_out: model.dataHandling.trainingUseOptOut,
      ...(model.dataHandling.retentionNote ? { retention_note: model.dataHandling.retentionNote } : {}),
      ...(model.dataHandling.region ? { region: model.dataHandling.region } : {}),
      select_text: stageText(protocol, "choose", "text"),
      select_lede: stageText(protocol, "choose", "lede"),
      rate_text: stageText(protocol, "rate", "text"),
      rate_lede: stageText(protocol, "rate", "lede"),
      adapt_text: stageText(protocol, "revise", "text"),
      adapt_lede: stageText(protocol, "revise", "lede"),
      debrief_text: stageText(protocol, "debrief", "text"),
      debrief_lede: stageText(protocol, "debrief", "lede"),
      fallback_text: interview?.fallbackText ?? "",
      max_turns: protocol.interview.maxTurns,
      min_chars: interview?.minChars ?? 1,
      max_chars: interview?.maxChars ?? 2000,
      max_chars_per_second: protocol.qualityControl.maxCharsPerSecond,
      long_message_chars: protocol.qualityControl.longMessageChars,
      flag_above_share: protocol.qualityControl.flagAboveShare,
      stop_before_generation: protocol.qualityControl.stopBeforeGeneration,
      offline_fallback: protocol.offlineFallback,
      // A declaration that only says there isn't one is not written back out:
      // a file claiming it in so many words looks like a decision, and it is
      // the absence of one.
      ...(declaration === NO_SAFEGUARDING_STATED ? {} : { safeguarding_declaration: declaration }),
      consent_requirements: protocol.consentRequirements,
      safeguarding: protocol.safeguarding,
    },
  });
}

/** Read a configuration file. The extension decides; nothing is sniffed. */
export function parseProtocolFile(source: string, filename: string): NarrativeProtocol {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".toml")) return protocolFromConfig(parseToml(source), { filename });
  if (lower.endsWith(".json")) return protocolFromConfig(JSON.parse(source), { filename });
  throw new Error(`'${filename}': a protocol file is .toml or .json`);
}

/** Write a configuration file, in the shape the original app also reads. */
export function protocolToToml(protocol: NarrativeProtocol): string {
  return stringifyToml(configFromProtocol(protocol) as unknown as Record<string, TomlValue>);
}

export { parseToml, stringifyToml, TomlError };
