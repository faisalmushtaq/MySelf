import { narrativeProtocol, type NarrativeProtocol } from "./protocol.js";

/**
 * The seed protocols.
 *
 * `np.micro_narrative` is the CHI 2025 method generalised: guided elicitation,
 * a model-generated reflection, and a participant confirm/correct step. The
 * science is unchanged; what changes is that every stage is declared rather
 * than hard-coded, model output is schema-constrained rather than parsed
 * hopefully, and a failure is recorded as a failure rather than written into
 * the slot where a scenario should be.
 *
 * ON THE PARTICIPANT'S NAME. Both protocols greet the young person by name.
 * The name is piped into PARTICIPANT-FACING TEXT ONLY, resolved on the device,
 * and is not in `permittedIdentifiers` — so the publish gate refuses any
 * prompt that tries to send it to a provider. The warmth costs nothing and the
 * name never leaves.
 *
 * If a study genuinely needs the model to use the name, add "first_name" to
 * `permittedIdentifiers` on a copy of the protocol. That is a deliberate,
 * frozen, auditable act with a DPIA consequence, which is exactly the weight
 * it should carry — and it will need the consent wording to match, since the
 * current wording promises names are not linked to research materials.
 */

const REFLECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["question", "theme", "confidence"],
  properties: {
    question: {
      type: "string",
      description: "One open follow-up question in the participant's own register. Never advice, never a diagnosis.",
    },
    theme: { type: "string", description: "A short neutral description of what the participant described." },
    confidence: {
      type: "string",
      enum: ["clear", "partly_clear", "unclear"],
      description: "How clearly the participant's meaning came across. 'unclear' is a valid and useful answer.",
    },
  },
} as const;

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "confidence"],
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences describing what this person said, in the third person, using their own emphasis.",
    },
    confidence: { type: "string", enum: ["clear", "partly_clear", "unclear"] },
  },
} as const;

const SYSTEM = [
  "You are helping a research study collect a young person's own account of their experience.",
  "You never give advice, never offer a diagnosis or treatment, and never suggest how they should feel.",
  "You never claim to be a person, a friend, a counsellor or a professional.",
  "You ask one short, open question at a time, in plain language a 12-year-old reads comfortably.",
  "You use only what the participant has actually said. You never invent details, and if their meaning is",
  "unclear you say so in the confidence field rather than guessing.",
  "If a participant says something that suggests they are in danger, you do not respond to it clinically;",
  "you acknowledge it briefly and continue, because a human reviews these conversations afterwards.",
].join(" ");

export const microNarrative: NarrativeProtocol = narrativeProtocol.parse({
  key: "np.micro_narrative",
  version: "1.0.0",
  name: "Micro-narrative elicitation",
  researchQuestion:
    "How do young people describe their own lived experience, in their own words, of the topic under study?",
  owner: "faisalmushtaq",
  approvalStatus: "draft",
  language: "en-GB",
  ageRange: { min: 10, max: 19 },

  // Available to participant-facing text. `first_name` is NOT a permitted
  // identifier, so the gate refuses any prompt that tries to send it.
  permittedVariables: ["first_name", "topic"],
  permittedIdentifiers: [],

  offlineFallback: "continue_without_model",
  estimatedMinutes: 6,

  models: [
    {
      key: "mc.openai.gpt4o.t07",
      provider: "openai",
      model: "gpt-4o",
      temperature: 0.7,
      maxOutputTokens: 400,
      timeoutSeconds: 30,
      maxAttempts: 3,
      dataHandling: { trainingUseOptOut: true, retentionNote: "zero-retention endpoint requested", region: "eu" },
    },
    {
      key: "mc.mock",
      provider: "mock",
      model: "deterministic",
      temperature: 0,
      maxOutputTokens: 400,
      timeoutSeconds: 5,
      maxAttempts: 1,
    },
  ],

  safeguardingDeclaration:
    "No automated safeguarding decisions. Lexicon rules raise a flag for researcher review only; nobody is contacted automatically and nothing is shown to the participant. Participants are told their answers are read by the research team later, and are not monitored as they type.",
  consentRequirements: ["consent.narrative_ai_assistance", "consent.free_text_storage"],

  safeguarding: [
    {
      key: "distress_lexicon",
      kind: "lexicon",
      terms: ["kill myself", "end my life", "self harm", "self-harm", "hurt myself", "want to die", "suicide"],
      tier: "safeguarding_review",
      reviewers: ["principal_investigator"],
      disclosure:
        "What you write here is read by the research team after the session — not while you are typing. If you need to talk to someone now, the last page has the numbers.",
    },
  ],

  stages: [
    {
      key: "intro",
      kind: "introduction",
      text: "Hi {first_name} — this last part is a short conversation.",
      lede:
        "There are no right answers, and nothing you say here is marked. You can write as much or as little as you like, and you can stop at any point. The research team reads these afterwards.",
      optional: false,
    },
    {
      key: "elicit",
      kind: "elicit",
      text: "Tell me about {topic}, in your own words.",
      lede: "Whatever comes to mind — something that happened, or just how it seems to you.",
      minChars: 15,
      maxChars: 2000,
      maxTurns: 4,
    },
    {
      key: "follow_up",
      kind: "follow_up",
      modelConfigKey: "mc.openai.gpt4o.t07",
      outputSchema: REFLECTION_SCHEMA,
      fallbackText: "Thank you — that is really helpful.",
      prompt: {
        key: "pt.micro_narrative.follow_up",
        version: "1.0.0",
        system: SYSTEM,
        template:
          "A young person was asked to describe {topic} in their own words. This is what they wrote:\n\n{participant_words}\n\nAsk them ONE short open question that invites them to say more about what they have already raised. Do not introduce a new topic. Do not reassure, advise or interpret.",
      },
    },
    {
      key: "interpret",
      kind: "interpret",
      modelConfigKey: "mc.openai.gpt4o.t07",
      outputSchema: SUMMARY_SCHEMA,
      fallbackText: "",
      prompt: {
        key: "pt.micro_narrative.summarise",
        version: "1.0.0",
        system: SYSTEM,
        template:
          "Here is everything a young person said about {topic}:\n\n{participant_words}\n\nWrite two or three sentences describing what THEY said, in the third person, keeping their emphasis and their words where you can. Add nothing they did not say. If their meaning is unclear, say so in the confidence field rather than smoothing it over.",
      },
    },
    {
      key: "confirm",
      kind: "confirm",
      text: "Here is what I understood. Have I got it right?",
      lede: "If anything is wrong or missing, tell me — what you write here is kept alongside it.",
      minChars: 0,
      maxChars: 1000,
      optional: true,
    },
    {
      key: "debrief",
      kind: "debrief",
      text: "Thank you, {first_name}. That is everything.",
      lede:
        "What you wrote is stored with the rest of your answers under your secret code. If you want it taken out later, that code is how we find it.",
    },
  ],
});

/**
 * The simpler protocol, tied to the YBM Future Self item.
 *
 * One elicitation, one reflective follow-up, one confirmation. Deliberately
 * small: it is the vertical slice that proves the module works inside a
 * questionnaire without asking a school for another twenty minutes.
 */
export const futureSelf: NarrativeProtocol = narrativeProtocol.parse({
  ...microNarrative,
  key: "np.future_self",
  version: "1.0.0",
  name: "Future self",
  researchQuestion: "What does this young person imagine for themselves in ten years, in their own words?",
  estimatedMinutes: 3,
  stages: [
    {
      key: "elicit",
      kind: "elicit",
      text: "Imagine yourself ten years from now, {first_name}. What would you say to that version of you?",
      lede: "One or two sentences is plenty.",
      minChars: 10,
      maxChars: 1000,
      maxTurns: 1,
    },
    microNarrative.stages.find((s) => s.key === "follow_up")!,
    { ...microNarrative.stages.find((s) => s.key === "confirm")!, optional: true },
    microNarrative.stages.find((s) => s.key === "debrief")!,
  ],
});

/**
 * `np.micro_narrative_full` — the CHI 2025 journey, end to end.
 *
 * Faithful to the original's structure (docs/08 §8.1): a guided interview over
 * a researcher-authored question list, extraction into the researcher's keys
 * using only the participant's words, three persona-voiced retellings, the
 * participant choosing one, rating it, and correcting it if it is not right.
 *
 * The configuration is the original's TOML, typed: collector persona,
 * questions, language style, topic restriction, extraction keys, three
 * summariser personas, a one-shot example. A researcher changes the study by
 * changing this object, not by changing code.
 *
 * What is deliberately different is failure and safety, not method. Completion
 * is a field in the structured output rather than the word FINISHED, which a
 * participant could say and end their own interview. Every output is validated
 * against the schema it was asked for. A persona that fails to generate is
 * absent rather than replaced by an apology string in the data slot. And
 * typing-dynamics quality control is off by default: in a school, a child who
 * pastes from Notes is not a bot.
 */
export const microNarrativeFull: NarrativeProtocol = narrativeProtocol.parse({
  ...microNarrative,
  key: "np.micro_narrative_full",
  version: "1.0.0",
  name: "Micro-narrative (full journey)",
  researchQuestion:
    "How does this young person describe their own experience, and which retelling of it do they recognise as theirs?",
  estimatedMinutes: 12,

  interview: {
    persona:
      "a friendly researcher talking to a young person aged 11 to 16, who is genuinely curious and never in a hurry",
    questions: [
      "Can you tell me about a time recently when {topic} came up for you?",
      "What was happening around then — where were you, and who else was there?",
      "How did that leave you feeling at the time?",
      "Has anything changed since, or does it still feel the same?",
    ],
    languageStyle:
      "Short sentences, everyday words, nothing a 12-year-old would have to look up. No jargon and no therapy language.",
    topicRestriction: "{topic}, and how this young person has experienced it",
    maxTurns: 12,
  },

  extraction: {
    keys: {
      what_happened: "What did the participant say actually happened?",
      who_was_there: "Who else did they mention being involved or present?",
      how_it_felt: "How did they say it made them feel?",
      what_changed: "What did they say has changed since, if anything?",
    },
  },

  scenario: {
    personas: [
      "a writer who tells it plainly and briefly, in the order it happened",
      "a writer who leads with how it felt, and keeps the events light",
      "a writer who keeps the young person's own turns of phrase wherever possible",
    ],
    adaptBelowRating: 10,
    maxRating: 10,
  },

  // Off for school samples. A study running on a crowdsourced adult panel
  // turns it on, and the thresholds are the original's.
  qualityControl: { enabled: false, maxCharsPerSecond: 15, longMessageChars: 250, flagAboveShare: 0.3 },

  stages: [
    {
      key: "intro",
      kind: "introduction",
      text: "Hi {first_name} — this last part is a short conversation.",
      lede:
        "I will ask you a few questions about {topic}, one at a time. There are no right answers and nothing here is marked. Afterwards I will show you a few short write-ups of what you told me, and you can pick the one that fits best — or tell me what is wrong with it.",
    },
    {
      key: "interview",
      kind: "collect",
      modelConfigKey: "mc.openai.gpt4o.t07",
      minChars: 2,
      maxChars: 2000,
      maxTurns: 12,
      fallbackText: "Thank you — that is really helpful.",
    },
    { key: "extract", kind: "extract", modelConfigKey: "mc.openai.gpt4o.t07", text: "" },
    { key: "write", kind: "generate", modelConfigKey: "mc.openai.gpt4o.t07", text: "" },
    {
      key: "choose",
      kind: "select",
      text: "Here are a few short write-ups of what you told me. Which one fits best?",
      lede: "None of them will be perfect. Pick the closest and you can fix it next.",
    },
    {
      key: "rate",
      kind: "rate",
      text: "How well does that one describe what you told me?",
      lede: "0 means it is not you at all. 10 means it is exactly right.",
    },
    {
      key: "revise",
      kind: "adapt",
      modelConfigKey: "mc.openai.gpt4o.t07",
      text: "What would you change about it?",
      lede: "Tell me in your own words and I will rewrite it. What you write here is kept alongside it.",
      optional: true,
    },
    {
      key: "debrief",
      kind: "debrief",
      text: "Thank you, {first_name}. That is everything.",
      lede:
        "What you wrote is stored with the rest of your answers under your secret code. If you want it taken out later, that code is how we find it.",
    },
  ],
});

export const protocols: NarrativeProtocol[] = [microNarrativeFull, microNarrative, futureSelf];
