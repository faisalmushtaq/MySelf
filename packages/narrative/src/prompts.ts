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
    /**
     * This description was the bug.
     *
     * "One short question" is exactly what it produced: a bare interrogation,
     * question after question with no sign of having heard the answer. The
     * original app has no schema at all — the model writes free text and the
     * warmth comes for free — so the flatness was ours, introduced by the very
     * constraint that makes the output safe to parse.
     *
     * The constraint stays; the description now asks for what a person would
     * actually send.
     */
    reply: {
      type: "string",
      description:
        "What to say next, as a message in a chat. React briefly to what they just said first — a few words, warm and " +
        "specific to their answer, never a compliment on the answer itself — and then ask. If their last answer was " +
        "one or two words, do not move on: ask them to say a bit more about that same thing. Never advice, never a " +
        "diagnosis, never a summary of what they have told you so far. When interviewDone is true this field is " +
        "discarded without being shown, so nothing written there reaches anybody.",
    },
    interviewDone: {
      type: "boolean",
      description:
        "True only when every question on the list has been genuinely answered. Setting this true ends the " +
        "conversation immediately, so do not set it in the same turn as a question you want answered.",
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

/**
 * The interviewer.
 *
 * `llm_config.generate_questions_prompt_template`, line for line, with the
 * `{history}`/`{input}` tail dropped — the transcript travels as messages here
 * rather than being pasted into the system text, which is both how the API
 * expects it and one fewer place a participant can write something that reads
 * like an instruction.
 *
 * The last line is the one deliberate change. The original ends the interview
 * when the model emits the word FINISHED, which a participant can also type.
 */
export const INTERVIEWER_SYSTEM = [
  "{persona}",
  "",
  "Your goal is to gather structured answers to the following questions:",
  "",
  "{questions}",
  "Ask each question one at a time.",
  "{language_style}",
  "Ensure you get at least a basic answer to each question before moving to the next.",
  // Two lines the original does not need and this does. The original's model
  // writes free prose and is conversational by default; ours writes into a
  // JSON field, which pulls it towards terse and functional. These put back
  // what the schema takes away, and nothing about the method changes.
  "Talk like a person in a chat: react to what they just said before you ask the next thing.",
  "A one or two word answer is not a basic answer — ask them to say a bit more about that same thing before moving on.",
  "Never answer for the human. If you are unsure what the human meant, ask again.",
  "{topic_restriction}",
  /**
   * The original writes the single word "FINISHED" here and never shows it.
   *
   * We replaced that sentinel with a boolean, because a participant could type
   * FINISHED and end their own interview — but then asked the model to "close
   * warmly instead", and it did: "Thanks for sharing all this with me. Take
   * care!", immediately before three retellings arrived. That goodbye was
   * ours, not theirs.
   *
   * The reply on the closing turn is now DISCARDED by the runner, exactly as
   * the original discards FINISHED, and the handover is the app's own line —
   * a fixed sentence that cannot wander off and say goodbye.
   */
  "{collection_complete}, set interviewDone to true. Whatever you write in reply on that turn is discarded and " +
    "never shown, so do not try to close the conversation: it is closed by the app, which says what happens next.",
].join("\n");

/** "Once you have collected answers to all N questions", as the original phrases it. */
export const collectionComplete = (count: number): string =>
  count === 1
    ? "Once you have collected an answer to the question"
    : `Once you have collected answers to all ${count} questions`;

/**
 * Extraction, from `generate_extraction_prompt_template`.
 *
 * The instruction to reuse only the words the text contains is the whole point
 * of the stage (§8.2, assumption 2), so it is reproduced rather than reworded.
 */
export const EXTRACTION_SYSTEM = [
  "You are an expert extraction algorithm.",
  "Only extract relevant information from the Human answers in the text.",
  "Use only the words and phrases that the text contains.",
  "If you do not know the value of an attribute asked to extract, return null for the attribute's value.",
  "",
  "You will output a JSON with {keys_string} keys.",
  "",
  "{questions}",
  "Remember, only extract text that is in the messages above and do not change it.",
].join("\n");

/**
 * The retelling, from `generate_scenario_prompt_template`.
 *
 * The persona comes first and verbatim, because in the original the persona IS
 * the instruction — "You're an experienced secondary school teacher. Create a
 * short narrative that reflects… Use a balanced, professional and reflective
 * tone." A study's persona text has to land exactly as written or a config
 * that has been through ethics no longer produces what it produced.
 *
 * The closing constraints are added. The original relies on the persona to
 * keep the model honest; §8.3 notes it has no other guard, and a retelling
 * that invents a motive for a child is a finding about nobody.
 */
/**
 * The retelling, from `generate_scenario_prompt_template` — and only from it.
 *
 * This had grown three lines that are not in the original: an instruction to
 * add nothing the participant did not say, and a note about the confidence
 * field. They were added in good faith and they were a mistake, because the
 * original puts that constraint in the EXTRACTION step ("use only the words
 * and phrases that the text contains") and then hands the extracted fragments
 * here with nothing but the persona and a worked example. Constraining this
 * step as well pushes all three personas towards the same cautious middle,
 * which is the opposite of what the three are for.
 *
 * The task line is theirs verbatim. The closing "Create a scenario based on
 * these responses." sits after the answers, as it does in their template,
 * which is why the runner appends it rather than it living here.
 */
export const SCENARIO_SYSTEM = ["{persona}", "{one_shot}", "Your task:", "Create a scenario based on the following answers:"].join(
  "\n",
);

/** Closes the scenario prompt, after the Q&A — `generate_scenario_prompt_template`. */
export const SCENARIO_CLOSE = "Create a scenario based on these responses.";

/**
 * Adaptation, from `generate_adaptation_prompt_template`.
 *
 * The original's wording, plus a way to say no: it always returns an
 * alternative, so a request it cannot honour from the participant's own words
 * is met by inventing something. Here that returns `changed: false`.
 */
export const ADAPT_SYSTEM = [
  "You're a helpful assistant, helping a participant adapt a scenario to their liking.",
  "Suggest an alternative version of the scenario.",
  "Keep the language and content as similar as possible, while fulfilling the participant's request.",
  "You may only use what they have said, here or earlier. If their request cannot be honoured from their own",
  "words, return the scenario unchanged and set changed to false.",
].join("\n");

/**
 * The question list.
 *
 * Numbered, which the original intends and does not do: its helper is called
 * `_generate_question_list`, documented as "creates an enumerated list",
 * enumerates in the loop — and then never uses the index. Numbering them makes
 * `questionsCovered` meaningful and costs nothing.
 */
export const numberedQuestions = (questions: string[]): string =>
  questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

/** `_generate_summary_keys`: "`what`, `context`, and `outcome`". */
export function keysString(keys: string[]): string {
  const quoted = keys.map((k) => `\`${k}\``);
  if (quoted.length === 0) return "";
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

/** `_generate_summary_questions`: the numbered list the keys correspond to. */
export function keyQuestions(keys: Record<string, string>): string {
  const entries = Object.values(keys);
  const heading = `These correspond to the following question${entries.length === 1 ? "" : "s"}:`;
  return [heading, ...entries.map((q, i) => `${i + 1}: ${q}`)].join("\n");
}

/** `generate_one_shot`, rendered into the scenario prompt when configured. */
export function oneShot(protocol: NarrativeProtocol): string {
  const example = protocol.scenario?.example;
  if (!example) return "";
  return [
    "",
    "Example:",
    example.conversation.trim(),
    "",
    "The scenario based on these responses:",
    `"${example.scenario.trim()}"`,
    "",
  ].join("\n");
}
