import type { NarrativeProtocol } from "./protocol.js";

/**
 * The four prompt templates, carried over from the original app.
 *
 * `llm_config.py` assembles four: interviewer, extraction, scenario and
 * adaptation. Their content is what the method is — the instruction to reuse
 * only the participant's own words, the persona voice, the one-shot example
 * that sets the register — so it is reproduced faithfully rather than
 * improved upon.
 *
 * Two changes, both from the audit:
 *
 *   The "FINISHED" sentinel is gone. A participant who typed FINISHED, or a
 *   model that echoed it back, ended the interview. Completion is now a
 *   boolean in the structured output, which cannot be spoken into existence.
 *
 *   Every output is schema-constrained and validated on the way back, rather
 *   than parsed with an ad-hoc key check.
 */

export const INTERVIEWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "interviewDone", "questionsCovered"],
  properties: {
    reply: { type: "string", description: "What to say next: one short question, or a brief close." },
    interviewDone: {
      type: "boolean",
      description: "True only when every question on the list has been genuinely answered.",
    },
    questionsCovered: {
      type: "array",
      items: { type: "integer" },
      description: "Indices of the questions answered so far, from the numbered list.",
    },
  },
} as const;

export const ADAPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["newScenario", "changed"],
  properties: {
    newScenario: { type: "string", description: "The retelling, revised as the participant asked." },
    changed: { type: "boolean", description: "False if the request could not be honoured from their words alone." },
  },
} as const;

export const SCENARIO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenario", "confidence"],
  properties: {
    scenario: { type: "string", description: "The retelling, in this persona's voice." },
    confidence: {
      type: "string",
      enum: ["clear", "partly_clear", "unclear"],
      description: "How clearly the participant's account supported this retelling.",
    },
  },
} as const;

/** Extraction returns the researcher's keys, so its schema is built per protocol. */
export function extractionSchema(keys: Record<string, string>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    // Every key required, and nullable: "did not say" is an answer, and the
    // schema is what stops the model quietly filling a gap to satisfy it.
    required: Object.keys(keys),
    properties: Object.fromEntries(
      Object.entries(keys).map(([key, question]) => [
        key,
        { type: ["string", "null"], description: question },
      ]),
    ),
  };
}

export const INTERVIEWER_SYSTEM = [
  "You are {persona}.",
  "You are interviewing one young person for a research study. Work through the numbered questions below,",
  "in order, ONE at a time, conversationally — acknowledge what they just said in a few words, then ask the",
  "next question. Never ask two questions at once and never number them out loud.",
  "Language: {language_style}",
  "Stay on this topic: {topic_restriction}. If they raise something else, gently return to the topic.",
  "Use only what they have told you. Never invent details, never offer advice, a diagnosis or reassurance",
  "about their situation, and never claim to be a person, a friend or a professional.",
  "Set interviewDone to true only once every question has genuinely been answered.",
  "",
  "The questions:",
  "{questions}",
].join("\n");

export const EXTRACTION_SYSTEM = [
  "You are an expert extraction algorithm.",
  "Extract the requested values from the conversation below.",
  "Use ONLY words that appear in what the participant said. Do not paraphrase into your own vocabulary,",
  "do not smooth their grammar, and do not add anything they did not say.",
  "If the conversation does not answer a key, return null for it. A null is a correct answer and is more",
  "useful to this study than a plausible guess.",
].join("\n");

export const SCENARIO_SYSTEM = [
  "You are {persona}.",
  "You write a short account of one person's experience, in your own voice, using only what they said.",
  "Write in the third person. Keep their emphasis and, wherever you can, their own words.",
  "Add nothing they did not say: no motives, no diagnosis, no resolution they did not describe.",
  "If their account is thin, write a short retelling and say so in the confidence field rather than",
  "inventing enough material to fill a paragraph.",
].join("\n");

export const ADAPT_SYSTEM = [
  "You revise a short account of one person's experience, at that person's request.",
  "Make exactly the change they asked for and nothing else. Keep everything they did not ask you to change.",
  "You may only use what they have said, here or earlier. If their request cannot be honoured from their own",
  "words, return the account unchanged and set changed to false.",
].join("\n");

/** The numbered question list, as the interviewer prompt expects it. */
export const numberedQuestions = (questions: string[]): string =>
  questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

/** The one-shot example, rendered into the scenario prompt when configured. */
export function oneShot(protocol: NarrativeProtocol): string {
  const example = protocol.scenario?.example;
  if (!example) return "";
  return [
    "",
    "Here is an example of the register expected.",
    "",
    "Conversation:",
    example.conversation,
    "",
    "Account:",
    example.scenario,
  ].join("\n");
}
