import { protocolConfig, protocolFromConfig, type ProtocolConfig } from "./config.js";
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
 * IT IS DEFINED AS A STUDY CONFIGURATION, not as a hand-written object, and
 * that is the point. The original is one TOML file per study; this is the same
 * file, typed and checked. A researcher runs a different study by copying
 * `protocols/micro_narrative_full.toml`, changing the questions and the
 * personas, and dropping it in — and because what ships is the same shape they
 * are editing, there is no privileged version of this protocol that behaves in
 * a way their file cannot.
 *
 * What is deliberately different from the original is failure and safety, not
 * method. Completion is a field in the structured output rather than the word
 * FINISHED, which a participant could say and end their own interview. Every
 * output is validated against the schema it was asked for. A persona that
 * fails to generate is absent rather than replaced by an apology string in the
 * data slot. And typing-dynamics quality control is off by default: in a
 * school, a child who pastes from Notes is not a bot.
 */
export const microNarrativeFullConfig: ProtocolConfig = protocolConfig.parse({
  model: "gpt-4o",
  quality_control_flagging: false,

  consent: {
    intro_and_consent: "Hi {first_name} — this last part is a short conversation.",
  },

  participant: { require_participant_id: true, editable_participant_id: false, text: "" },

  collection: {
    persona:
      "You're a friendly researcher talking to a young person aged 11 to 16. You are genuinely curious and never in a hurry.",
    language_type:
      "Use short sentences and everyday words — nothing a 12-year-old would have to look up. No jargon and no therapy language.",
    intro:
      "I will ask you a few questions about {topic}, one at a time. There are no right answers and nothing here is marked. Afterwards I will show you a few short write-ups of what you told me, and you can pick the one that fits best — or tell me what is wrong with it.",
    questions: [
      "Can you tell me about a time recently when {topic} came up for you?",
      "What was happening around then — where were you, and who else was there?",
      "How did that leave you feeling at the time?",
      "Has anything changed since, or does it still feel the same?",
    ],
    topic_restriction:
      "Stay on the topic of {topic} and how this young person has experienced it. If they raise something else, acknowledge it briefly and return to the questions.",
  },

  summaries: {
    questions: {
      what_happened: "What did the participant say actually happened?",
      who_was_there: "Who else did they mention being involved or present?",
      how_it_felt: "How did they say it made them feel?",
      what_changed: "What did they say has changed since, if anything?",
    },
    personas: {
      plain: "You write plainly and briefly, telling it in the order it happened.",
      feeling: "You lead with how it felt, and keep the events light.",
      their_words: "You keep the young person's own turns of phrase wherever you can.",
    },
  },

  example: {
    conversation: [
      "Question: Can you tell me about a time recently when this came up for you?",
      'Answer: "There was a group chat and people were being off with one of my mates. I didn\'t say anything at the time."',
      "",
      "Question: How did that leave you feeling at the time?",
      'Answer: "Bad, mostly at myself. I kept thinking I should have said something."',
    ].join("\n"),
    scenario:
      "In a group chat, people were being off with one of their friends and they did not say anything at the time. Afterwards they felt bad, mostly at themselves, and kept thinking they should have said something.",
  },

  myself: {
    key: "np.micro_narrative_full",
    version: "1.0.0",
    name: "Micro-narrative (full journey)",
    research_question:
      "How does this young person describe their own experience, and which retelling of it do they recognise as theirs?",
    owner: "faisalmushtaq",
    approval_status: "draft",
    language: "en-GB",
    estimated_minutes: 12,
    age_min: 10,
    age_max: 19,

    /**
     * Botty, for the younger end.
     *
     * This protocol reaches ten-year-olds, and at that age "it is a robot" is
     * a thing somebody can hold onto for a whole conversation in a way that a
     * name is not. Looking like what it is does the disclosure's work before
     * anybody reads a word of the profile.
     */
    character: {
      name: "Botty",
      meaning: "a robot that listens",
      look: "robot",
      about: [
        "Botty is a robot — a computer program, not a real person.",
        "It asks you about your life, then writes back what it heard so you can say if it got it right or wrong.",
        "It cannot see you. It only hears you if you send it a recording.",
        "What you tell it is kept for the research, and your name is not kept with it.",
        "There are no right answers, and nothing you say here is marked.",
      ],
    },

    permitted_variables: ["first_name", "topic"],
    permitted_identifiers: [],

    provider: "openai",
    temperature: 0.7,
    max_output_tokens: 400,
    retention_note: "zero-retention endpoint requested",
    region: "eu",

    max_turns: 12,
    min_chars: 2,

    select_text: "Here are three short stories about what you told me. Which one fits best?",
    select_lede: "None of them will be perfect. Pick the closest and you can fix it next.",
    rate_text: "How well does that one describe what you told me?",
    rate_lede: "0 means it is not you at all. 10 means it is exactly right.",
    adapt_text: "What would you change about it?",
    adapt_lede: "Tell me in your own words and I will rewrite it. What you write here is kept alongside it.",
    debrief_text: "Thank you, {first_name}. That is everything.",
    debrief_lede:
      "What you wrote is stored with the rest of your answers under your secret code. If you want it taken out later, that code is how we find it.",
    fallback_text: "Thank you — that is really helpful.",

    offline_fallback: "continue_without_model",
    safeguarding_declaration: microNarrative.safeguardingDeclaration,
    consent_requirements: microNarrative.consentRequirements,
    safeguarding: microNarrative.safeguarding,
  },
});

export const microNarrativeFull: NarrativeProtocol = protocolFromConfig(microNarrativeFullConfig);

/**
 * Phones and wellbeing — a placeholder study, for putting the component in
 * front of people.
 *
 * Written to be shared with testers before any real protocol is approved, so
 * what is being judged is the journey rather than the wording of a study that
 * does not exist yet. It is a real configuration in the real format, so
 * replacing it means editing a file, not editing the platform.
 *
 * THE TOPIC IS FIXED rather than piped through {topic}. This one asks about a
 * specific thing and the questions are written for it; a topic box that did
 * nothing would be worse than no topic box.
 *
 * Three choices worth defending, because they are about young people and
 * phones rather than about software:
 *
 * The questions ask for the good and the bad in the same breath, in that
 * order. Asking only what is wrong with your phone tells a young person what
 * answer is wanted, and they will give it. The research question is genuinely
 * two-sided and the instrument has to be too.
 *
 * The persona is told not to give advice about screen time. Adults moralise
 * about phones, young people know it, and one whiff of a lecture ends the
 * honest version of this conversation.
 *
 * Safeguarding carries a second rule at the notification tier for bullying and
 * exclusion, which the distress lexicon alone would miss. A phone is where a
 * lot of that happens, so a study asking about phones should expect to hear
 * about it — and should have decided in advance what it does when it does.
 */
export const phoneWellbeingConfig: ProtocolConfig = protocolConfig.parse({
  model: "gpt-4o",
  quality_control_flagging: false,

  consent: {
    intro_and_consent: "Hi {first_name} — this last bit is a short chat about your phone.",
  },

  // Left at its defaults deliberately. `require_participant_id` only gates the
  // longitudinal `{previous_scenario}` feature, and it is DERIVED when a
  // protocol is written back out — so setting it here would make the shipped
  // config and the generated TOML look as though they disagreed.
  participant: {},

  collection: {
    persona: [
      "You're a friendly researcher talking to a young person aged 11 to 18 about their phone.",
      "You are genuinely curious and never in a hurry.",
      "You are not worried about their phone use and you are not here to change it.",
      "Never give advice about screen time, never suggest they use it more or less, and never imply that any amount is too much.",
    ].join(" "),
    language_type:
      "Use short sentences and everyday words — nothing a 12-year-old would have to look up. No jargon, no therapy language, and nothing that sounds like a parent.",
    intro: [
      "I am going to ask you a few questions about your phone and how it fits into your life, one at a time.",
      "There are no right answers and nothing here is marked.",
      "Some of it might be good and some of it might not be, and both are just as useful to me.",
      "Afterwards I will show you a few short write-ups of what you told me, and you can pick the one that fits best — or tell me what is wrong with it.",
    ].join(" "),
    questions: [
      "Tell me about your phone — what do you actually use it for most?",
      "Can you tell me about a time recently when your phone made a day better?",
      "And a time when it made a day worse?",
      "How do you usually feel after you have been on it for a long stretch?",
      "If you had to go a week without it, what would you miss most, and what would you not miss at all?",
    ],
    topic_restriction: [
      "Stay on this young person's own experience of their phone and how it affects them.",
      "If they raise something else, acknowledge it briefly and return to the questions.",
      "Do not give advice, do not suggest changes, and do not comment on how much they use it.",
    ].join(" "),
  },

  summaries: {
    questions: {
      what_they_use_it_for: "What did they say they mainly use their phone for?",
      when_it_helps: "What did they describe their phone making better?",
      when_it_gets_in_the_way: "What did they describe it making worse?",
      how_it_leaves_them_feeling: "How did they say a long stretch on it leaves them feeling?",
      what_they_would_miss: "What did they say they would miss, and not miss, without it?",
    },
    /**
     * FIRST PERSON. The retelling is offered back as "is this you?", and a
     * young person answers that question about "I mainly use my phone…" far
     * more readily than about "they mainly use their phone…", which reads as a
     * case note somebody has written about them.
     *
     * The voice is set here and in the worked example rather than in the
     * module's prompts, because it is a study decision: the CHI protocol
     * retells in the third person deliberately, and both live in the same
     * codebase without one overruling the other.
     */
    /**
     * Three retellings a participant can actually tell apart.
     *
     * The first versions of these were one-line nudges about tone — "plainly
     * and briefly", "lead with how it felt" — and they produced three
     * paragraphs that differed by a few words. That is not a choice; it is a
     * coin flip wearing three coats, and which one somebody picks is the
     * measurement this whole component exists to take.
     *
     * The fix is to make them differ in WHAT THEY INCLUDE rather than how they
     * sound. One names no feelings at all. One is almost entirely feelings.
     * One is their own phrasing kept as they said it. Given the same four
     * facts those cannot converge, because they are not selecting the same
     * material.
     *
     * All three stay in the first person, which costs the axis the CHI
     * protocol used — its personas were different NARRATORS, and a narrator is
     * the strongest way to make retellings diverge. That trade is deliberate:
     * "is this you?" is a question a young person answers about "I", and reads
     * as a case note about "they".
     */
    personas: {
      plain:
        "You write it as short and matter-of-fact as you can, in the first person as 'I': what happens, in the " +
        "order they said it, in three or four sentences. You never name a feeling and never say what anything " +
        "meant to you.",
      feeling:
        "You write mostly about how it leaves you feeling, in the first person as 'I'. Feelings come first and " +
        "get the most words; you mention what actually happened only where it is needed to explain one of them.",
      their_words:
        "You build it out of the young person's own phrases, in the first person as 'I', kept exactly as they " +
        "said them even where they are rough or unfinished. You add as few words of your own as it takes to join " +
        "them up, and you never smooth their wording into better English.",
    },
  },

  example: {
    conversation: [
      "Question: Tell me about your phone — what do you actually use it for most?",
      'Answer: "Mostly talking to my friends, and watching stuff before bed."',
      "",
      "Question: And a time when it made a day worse?",
      'Answer: "I stayed up way too late on it and then felt rubbish at school the next day."',
    ].join("\n"),
    // The example is what the model actually copies, so it carries the voice.
    scenario:
      "I mainly use my phone to talk to my friends and to watch things before bed. One night I stayed up much later than I meant to and felt rubbish at school the next day.",
  },

  myself: {
    key: "np.phone_wellbeing",
    // 0.x deliberately: this is a placeholder for testing the component, not a
    // study anybody has signed off.
    version: "0.1.0",
    name: "Phones and wellbeing (placeholder)",
    research_question:
      "How does this young person describe their relationship with their phone, and what do they say it does to how they feel?",
    owner: "faisalmushtaq",
    approval_status: "draft",
    language: "en-GB",
    estimated_minutes: 10,
    age_min: 11,
    age_max: 18,

    /**
     * Sam, for eleven to eighteen.
     *
     * A robot reads as something made for younger children and gets dismissed
     * by this age group, so the character is a name — and the name carries no
     * gender and no culture, because a study about how young people see
     * themselves has no business putting a boy, a girl, or a background on the
     * other side of the conversation.
     *
     * That it reads as a person's name is exactly why the profile says what it
     * stands for and what it is. The disclosure is not a footnote here; it is
     * the first thing the profile says, and the publish gate refuses a
     * character whose profile never says it.
     */
    character: {
      name: "Sam",
      meaning: "Stories About Me",
      look: "neutral",
      about: [
        "Sam is an AI, not a person. Nobody is sitting somewhere reading this as you type.",
        "Sam stands for Stories About Me. It asks about your life and then writes back what it heard, so you can say whether it got it right.",
        "It can only read and write. It cannot see you, and it only hears you if you send a recording.",
        "What you say is kept for the research. Your name is not stored with it.",
        "There are no right answers and nothing here is marked.",
      ],
    },

    // No {topic}: this protocol asks about one thing and says so.
    permitted_variables: ["first_name"],
    permitted_identifiers: [],

    provider: "openai",
    temperature: 0.7,
    max_output_tokens: 400,
    retention_note: "zero-retention endpoint requested",
    region: "eu",

    max_turns: 14,
    min_chars: 2,

    select_text: "Here are three short stories about what you told me. Which one fits best?",
    select_lede: "None of them will be perfect. Pick the closest and you can fix it next.",
    rate_text: "How well does that one describe what you told me?",
    rate_lede: "0 means it is not you at all. 10 means it is exactly right.",
    adapt_text: "What would you change about it?",
    adapt_lede: "Tell me in your own words and I will rewrite it. What you write here is kept alongside it.",
    debrief_text: "Thank you, {first_name}. That is everything.",
    debrief_lede:
      "What you wrote is stored with the rest of your answers under your secret code. If you want it taken out later, that code is how we find it.",
    fallback_text: "Thank you — that is really helpful.",

    offline_fallback: "continue_without_model",
    safeguarding_declaration: microNarrative.safeguardingDeclaration,
    consent_requirements: microNarrative.consentRequirements,
    safeguarding: [
      ...microNarrative.safeguarding,
      {
        key: "online_harm_lexicon",
        kind: "lexicon",
        terms: ["bullied", "bullying", "left me out", "leaving me out", "nasty messages", "sent it round", "made a fake"],
        // Notification, not safeguarding review: a young person saying they
        // were left out of a group chat needs somebody to read it, not an
        // escalation. Putting it at the higher tier would bury the rule that
        // matters under the one that fires constantly.
        tier: "team_notification",
        reviewers: ["principal_investigator"],
        disclosure:
          "What you write here is read by the research team after the session — not while you are typing. If you need to talk to someone now, the last page has the numbers.",
      },
    ],
  },
});

export const phoneWellbeing: NarrativeProtocol = protocolFromConfig(phoneWellbeingConfig);

export const protocols: NarrativeProtocol[] = [phoneWellbeing, microNarrativeFull, microNarrative, futureSelf];
