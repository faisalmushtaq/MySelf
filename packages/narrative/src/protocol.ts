import { modelConfig } from "@myself/llm";
import { z } from "zod";

/**
 * A narrative protocol: a first-class library object, like an instrument.
 *
 * Everything a run does is declared here and frozen into the release — the
 * stages, the prompts, the model, the output schema, the fallbacks and the
 * safeguarding configuration. A researcher changes a protocol by publishing a
 * new version, not by editing code, and an analysis years later can say
 * exactly what a participant was asked and what generated any text they saw.
 *
 * Two rules the shape enforces rather than merely states:
 *
 *   NO IDENTIFIER REACHES A PROMPT BY ACCIDENT. A prompt template may only
 *   substitute variables the protocol lists in `permittedVariables`, and any
 *   variable that identifies a person has to be listed again, separately, in
 *   `permittedIdentifiers`. Nothing is implicit: putting a participant's name
 *   in front of a third-party model is a decision with a DPIA consequence, so
 *   it is made once, visibly, and frozen.
 *
 *   MODEL OUTPUT NEVER POPULATES A RESPONSE. Stages write narrative records.
 *   There is no path from here to a response variable, which is what makes
 *   "the model cannot fabricate an answer" structural rather than aspirational.
 */

/**
 * The stages a protocol can be built from.
 *
 * The first five reproduce the CHI 2025 journey faithfully — guided
 * elicitation, extraction, persona-voiced retellings, participant choice,
 * rating and adaptation. Those are not interface steps: docs/08 §8.2 records
 * that the choice, the rating and the adaptation history are data, and the
 * whole method rests on the participant being the one who decides whether a
 * retelling of their experience is right.
 */
export const narrativeStageKind = z.enum([
  /** Researcher-authored text shown before anything is asked. */
  "introduction",
  /**
   * A single open question in the participant's own words — the simple case,
   * used by the shorter protocols that sit inside a questionnaire.
   */
  "elicit",
  /**
   * The guided interview: a researcher-authored question list administered
   * conversationally, one at a time, by the model. Multi-turn, and it ends
   * when the model says every question is covered — see `interviewDone` in the
   * output schema, which replaces the original's "FINISHED" sentinel. The
   * sentinel could be spoken by a participant and end their own interview.
   */
  "collect",
  /**
   * Extraction: the participant's answers reduced to the researcher's keys,
   * using only words the participant used, null where they did not say.
   * Never shown; it is the substrate the retellings are built from.
   */
  "extract",
  /** Persona-voiced candidate retellings, generated from the extraction. */
  "generate",
  /** The participant picks the one that fits. Their choice is data. */
  "select",
  /** A rating of the chosen retelling. A perfect score skips adaptation. */
  "rate",
  /** The participant says what is wrong; the model revises; they accept or not. */
  "adapt",
  /** A single model-generated follow-up question, for the simpler protocols. */
  "follow_up",
  /** A model-generated interpretation the participant then confirms or corrects. */
  "interpret",
  /** The participant confirms, corrects or rejects what the model produced. */
  "confirm",
  /** Researcher-authored closing text. */
  "debrief",
]);

export type NarrativeStageKind = z.infer<typeof narrativeStageKind>;

/** What happens when the model is unreachable, slow, or refuses. */
export const offlineFallback = z.enum([
  /** Save the participant's words; run the model stage after sync, if consent allows. */
  "queue_authorised",
  /** Save the participant's words; skip the model stage entirely. */
  "continue_without_model",
  /** Show researcher-authored text in place of the model's. */
  "predefined_fallback",
  /** Stop the module here and continue the rest of the assessment. */
  "pause_module",
]);

export const promptTemplate = z.object({
  key: z.string().min(1),
  version: z.string().min(1),
  system: z.string().min(1),
  /** `{variable}` placeholders, resolved only from `permittedVariables`. */
  template: z.string().min(1),
});

export const narrativeStage = z.object({
  key: z.string().min(1),
  kind: narrativeStageKind,
  /** What the participant reads. May pipe permitted variables. */
  text: z.string().default(""),
  /** Shown under the text in body size, for framing that would crowd a stem. */
  lede: z.string().optional(),
  /** Model stages only. */
  prompt: promptTemplate.optional(),
  modelConfigKey: z.string().optional(),
  /**
   * JSON schema the model output must satisfy. Structured output is requested
   * from the provider and validated again on the way back.
   */
  outputSchema: z.record(z.unknown()).optional(),
  /** Participant input constraints for `elicit` stages. */
  minChars: z.number().int().min(0).default(0),
  maxChars: z.number().int().positive().default(2000),
  /** How many exchanges an elicitation may run to before it must close. */
  maxTurns: z.number().int().min(1).max(20).default(6),
  /** Text used when `predefined_fallback` applies at this stage. */
  fallbackText: z.string().optional(),
  /** A stage the participant may decline without ending the protocol. */
  optional: z.boolean().default(false),
});

export const safeguardingRule = z.object({
  key: z.string().min(1),
  /** What is looked for. Lexicon rules are deterministic and run offline. */
  kind: z.enum(["lexicon", "model_classifier"]),
  terms: z.array(z.string()).default([]),
  /** Escalation tier — never a clinical judgement, always a human route. */
  tier: z.enum(["data_quality", "team_notification", "safeguarding_review"]),
  reviewers: z.array(z.string()).default([]),
  /** What participants are told, which must not imply live monitoring. */
  disclosure: z.string().min(1),
});

/**
 * The guided interview, as the original configures it in TOML.
 *
 * A fixed researcher-authored question list, asked conversationally one at a
 * time, in a stated voice, restricted to a stated topic. Faithful to §8.2's
 * first assumption: guided elicitation, not free composition — the questions
 * are the researcher's and the words are the participant's.
 */
export const interviewConfig = z.object({
  /** The voice the model interviews in. */
  persona: z.string().min(1),
  /** Asked one at a time, in order, conversationally. */
  questions: z.array(z.string().min(1)).min(1),
  /** How to speak: reading level, register, sentence length. */
  languageStyle: z.string().min(1),
  /** What the model must decline to discuss. Prompt-level, as in the original. */
  topicRestriction: z.string().min(1),
  /** How many exchanges before the interview is closed regardless. */
  maxTurns: z.number().int().min(1).max(40).default(20),
});

/**
 * Extraction: the researcher's keys, and the question each one answers.
 *
 * The instruction that matters is "use only words the text contains, and leave
 * a key null if they did not say" — §8.2's second assumption. A summariser
 * that fills gaps plausibly is producing data the participant never gave.
 */
export const extractionConfig = z.object({
  keys: z.record(z.string().min(1)),
});

/**
 * Retelling: the personas, and the worked example that sets the register.
 *
 * Three personas in the original, and three is a sensible default, but the
 * number is the researcher's to set. Each writes the same extraction in its
 * own voice; the participant chooses between them.
 */
export const scenarioConfig = z.object({
  personas: z.array(z.string().min(1)).min(2),
  /** One-shot example: a conversation and the retelling it should produce. */
  example: z.object({ conversation: z.string().min(1), scenario: z.string().min(1) }).optional(),
  /** Below this, the participant is offered the chance to correct it. */
  adaptBelowRating: z.number().int().min(0).max(10).default(10),
  maxRating: z.number().int().min(1).max(10).default(10),
});

/**
 * Typing-dynamics quality signals (§8.2, assumption 5).
 *
 * Aimed at crowdsourced adult samples, where a share of responses are pasted
 * or generated. Kept because it is genuinely novel and load-bearing there —
 * and off by default for school samples, where a child typing slowly on a
 * borrowed iPad must never be treated as a bot.
 */
export const qualityControlConfig = z.object({
  enabled: z.boolean().default(false),
  /** Characters per second above which typing is implausibly fast. */
  maxCharsPerSecond: z.number().positive().default(15),
  /** A message longer than this, or with newlines, looks pasted. */
  longMessageChars: z.number().int().positive().default(250),
  /** Share of messages tripping any signal before the session is flagged. */
  flagAboveShare: z.number().min(0).max(1).default(0.3),
  /**
   * Stop before generating anything and save what there is.
   *
   * The original stops the run. That is right where the alternative is paying
   * for scenarios built on pasted text — and wrong if it ever silently
   * discards a real participant, so what is collected is always saved.
   */
  stopBeforeGeneration: z.boolean().default(true),
});

export const narrativeProtocol = z.object({
  key: z.string().regex(/^np\.[a-z0-9_]+$/, "protocol keys look like np.micro_narrative"),
  version: z.string().min(1),
  name: z.string().min(1),
  researchQuestion: z.string().min(1),
  owner: z.string().min(1),
  approvalStatus: z.enum(["draft", "in_review", "approved"]),
  language: z.string().default("en-GB"),
  ageRange: z.object({ min: z.number().int(), max: z.number().int() }).optional(),

  stages: z.array(narrativeStage).min(1),
  models: z.array(modelConfig).min(1),

  /**
   * Variables a prompt template may substitute. A template referring to
   * anything else fails the publish gate rather than silently rendering
   * "{first_name}" to a participant or to a model.
   */
  permittedVariables: z.array(z.string()).default([]),
  /**
   * Of those, the ones that identify a person. Listing a variable here is what
   * allows it into a PROMPT; a variable in `permittedVariables` alone may only
   * be piped into participant-facing text, which is rendered on the device and
   * never sent anywhere.
   */
  permittedIdentifiers: z.array(z.string()).default([]),

  /** Present when the protocol runs the full guided-interview journey. */
  interview: interviewConfig.optional(),
  extraction: extractionConfig.optional(),
  scenario: scenarioConfig.optional(),
  qualityControl: qualityControlConfig.default({}),

  offlineFallback,
  safeguarding: z.array(safeguardingRule).default([]),
  /**
   * Required, and "no automated rules; researcher review only" is a valid,
   * deliberate answer. What is not valid is leaving it unsaid.
   */
  safeguardingDeclaration: z.string().min(1),
  consentRequirements: z.array(z.string()).default([]),
  estimatedMinutes: z.number().positive().default(5),
});

export type NarrativeProtocol = z.infer<typeof narrativeProtocol>;
export type NarrativeStage = z.infer<typeof narrativeStage>;
export type InterviewConfig = z.infer<typeof interviewConfig>;
export type ExtractionConfig = z.infer<typeof extractionConfig>;
export type ScenarioConfig = z.infer<typeof scenarioConfig>;
export type QualityControlConfig = z.infer<typeof qualityControlConfig>;
export type PromptTemplate = z.infer<typeof promptTemplate>;
export type SafeguardingRule = z.infer<typeof safeguardingRule>;
export type OfflineFallback = z.infer<typeof offlineFallback>;

/**
 * Variables the runner supplies, which no protocol declares.
 *
 * `participant_words` is the narrative itself — the thing the whole module
 * exists to send to the model — so requiring every protocol to declare it
 * would be ceremony that teaches researchers to add names to the list without
 * reading it. It is never identifying: it is what the participant chose to
 * write, not who they are.
 */
export const BUILT_IN_VARIABLES = new Set(["participant_words"]);

const PLACEHOLDER = /\{([a-z0-9_]+)\}/g;

export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/**
 * The publish gate for a protocol.
 *
 * Refuses anything that would fail in front of a participant, or that would
 * send something to a model that nobody decided to send. Returns problems
 * rather than throwing on the first one, so a researcher fixing a protocol
 * sees the whole list.
 */
export function checkProtocol(protocol: NarrativeProtocol): string[] {
  const problems: string[] = [];
  const permitted = new Set(protocol.permittedVariables);
  const identifiers = new Set(protocol.permittedIdentifiers);
  const models = new Set(protocol.models.map((m) => m.key));

  for (const id of identifiers) {
    if (!permitted.has(id)) {
      problems.push(`'${id}' is listed as a permitted identifier but not as a permitted variable`);
    }
  }

  for (const stage of protocol.stages) {
    for (const variable of placeholdersIn(stage.text) .concat(placeholdersIn(stage.lede ?? ""))) {
      if (!permitted.has(variable)) {
        problems.push(`stage '${stage.key}' shows {${variable}}, which is not a permitted variable`);
      }
    }

    if (stage.kind === "collect" && !protocol.interview) {
      problems.push(`stage '${stage.key}' runs a guided interview but the protocol configures no questions`);
    }
    if (stage.kind === "extract" && !protocol.extraction) {
      problems.push(`stage '${stage.key}' extracts, but the protocol declares no keys to extract into`);
    }
    if ((stage.kind === "generate" || stage.kind === "select") && !protocol.scenario) {
      problems.push(`stage '${stage.key}' needs personas, and the protocol declares none`);
    }
    if (stage.kind === "select" && !protocol.stages.some((s) => s.kind === "generate")) {
      problems.push(`stage '${stage.key}' asks the participant to choose between retellings nothing generates`);
    }
    if (stage.kind === "adapt" && !protocol.stages.some((s) => s.kind === "select" || s.kind === "generate")) {
      problems.push(`stage '${stage.key}' revises a retelling no stage produced`);
    }

    /**
     * Two kinds of model stage.
     *
     * The guided-journey stages — interview, extraction, retelling, revision —
     * use the module's own prompt templates and output schemas, because those
     * templates ARE the method (docs/08 §8.2) and a study that rewrote them
     * would no longer be running it. What a researcher configures is the
     * questions, the keys and the personas, checked above.
     *
     * The open stages — a one-off follow-up or interpretation — carry their
     * own prompt and schema, because there is no fixed method to preserve.
     */
    const journeyStage = ["collect", "extract", "generate", "adapt"].includes(stage.kind);
    const openModelStage = stage.kind === "follow_up" || stage.kind === "interpret";

    if (journeyStage || openModelStage) {
      if (!stage.modelConfigKey) problems.push(`stage '${stage.key}' names no model config`);
      else if (!models.has(stage.modelConfigKey)) {
        problems.push(`stage '${stage.key}' names model config '${stage.modelConfigKey}', which is not defined`);
      }
    }

    if (openModelStage) {
      if (!stage.prompt) problems.push(`stage '${stage.key}' is a model stage with no prompt`);
      if (!stage.outputSchema) {
        problems.push(`stage '${stage.key}' has no output schema — model output must be schema-constrained`);
      }
    }

    if (stage.prompt) {
      for (const variable of placeholdersIn(stage.prompt.template).concat(placeholdersIn(stage.prompt.system))) {
        if (BUILT_IN_VARIABLES.has(variable)) continue;
        if (!permitted.has(variable)) {
          problems.push(`prompt '${stage.prompt.key}' uses {${variable}}, which is not a permitted variable`);
        } else if (isIdentifying(variable) && !identifiers.has(variable)) {
          // The heart of it: a name can reach a prompt, but only because
          // somebody wrote it down as a decision.
          problems.push(
            `prompt '${stage.prompt.key}' puts {${variable}} in front of the model, but it is not listed in permittedIdentifiers — sending an identifier to a provider has to be a stated decision`,
          );
        }
      }
    }

    if (stage.kind === "confirm" && !protocol.stages.some((s) => s.kind === "interpret" || s.kind === "follow_up")) {
      problems.push(`stage '${stage.key}' asks the participant to confirm something no stage produces`);
    }
  }

  if (protocol.offlineFallback === "predefined_fallback") {
    for (const stage of protocol.stages.filter((s) => s.kind === "follow_up" || s.kind === "interpret" || s.kind === "collect")) {
      if (!stage.fallbackText) {
        problems.push(`stage '${stage.key}' has no fallbackText, but the protocol falls back to predefined text`);
      }
    }
  }

  if (!protocol.stages.some((s) => s.kind === "elicit" || s.kind === "collect")) {
    problems.push("a narrative protocol with no elicitation stage collects no narrative");
  }

  return problems;
}

/**
 * Variables treated as identifying wherever they appear.
 *
 * Deliberately a fixed list rather than a heuristic: this decides whether a
 * child's name may be sent to a third party, and a rule nobody can enumerate
 * is a rule nobody can check.
 */
const IDENTIFYING = new Set([
  "first_name",
  "last_name",
  "full_name",
  "dob",
  "date_of_birth",
  "upn",
  "nhs_number",
  "postcode",
  "address",
  "email",
  "phone",
]);

export const isIdentifying = (variable: string): boolean => IDENTIFYING.has(variable);
