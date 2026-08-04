import { ModelError, type Gateway, type ModelConfig, type ResolvedPrompt } from "@myself/llm";
import { isIdentifying, type NarrativeProtocol, type NarrativeStage } from "./protocol.js";
import {
  ADAPT_SCHEMA,
  ADAPT_SYSTEM,
  EXTRACTION_SYSTEM,
  INTERVIEWER_SCHEMA,
  INTERVIEWER_SYSTEM,
  SCENARIO_SCHEMA,
  SCENARIO_SYSTEM,
  collectionComplete,
  extractionSchema,
  keyQuestions,
  keysString,
  numberedQuestions,
  oneShot,
} from "./prompts.js";
import { aggregate, shouldStopBeforeGeneration, signalsFor, type MessageSignals, type MessageTrace } from "./quality.js";
import { refuseReason, type NarrativeRecord, type RecordKind, type RecordSource } from "./records.js";

/**
 * Running a protocol.
 *
 * A small state machine over staged records: it knows which stage is current,
 * what to show, what to do with what the participant types, and what to do
 * when the model is unavailable. It holds no opinions of its own — every
 * decision comes from the protocol, which is frozen in the release.
 *
 * The failure behaviour is the part worth reading. When a model stage fails,
 * the protocol's declared fallback applies and a `fallback_applied` record is
 * written. Nothing the participant said is touched, and no apology string is
 * ever written into a slot where data belongs. A run that lost its network
 * halfway is a complete run with a documented gap, not a corrupted one.
 */

export interface RunnerContext {
  sessionId: string;
  /**
   * Values available to the protocol. Participant-facing text may pipe any
   * permitted variable; prompts may only pipe those also declared as
   * permitted identifiers.
   */
  variables: Record<string, string>;
  online: boolean;
}

export interface Screen {
  stageKey: string;
  kind: NarrativeStage["kind"];
  /** What to show, with participant-facing variables already resolved. */
  text: string;
  lede?: string;
  /** Whether this screen expects the participant to type something. */
  expectsInput: boolean;
  /** How long an answer this stage will take, as the protocol declared it. */
  maxTurns: number;
  optional: boolean;
  /** Set when the model could not be reached and a fallback was applied. */
  fallback?: { reason: string; applied: NarrativeProtocol["offlineFallback"] };
  /** Candidate retellings, for the stage where the participant chooses. */
  choices?: { index: number; persona: string; text: string }[];
  /** The retelling under discussion, at the rate and adapt stages. */
  scenario?: string;
  /**
   * Whether the participant may rewrite `scenario` themselves, rather than
   * only ask the model to. The original offers both (§8.1) and they are
   * different data: their own sentence, or a model's reading of a request.
   */
  editable?: boolean;
  /** The model reported it could not honour the request from their own words. */
  unchanged?: boolean;
  /** They pressed "ask for a rewrite" without saying what to change. */
  needsRequest?: boolean;
  /** Rating bounds, at the rate stage. */
  rating?: { max: number };
  /** Set when quality signals stopped the run before anything was generated. */
  stopped?: { reason: string };
  finished: boolean;
}

let counter = 0;
const nextId = () => `nr_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Substitute `{variable}` placeholders, refusing anything not permitted. */
export function resolveText(
  template: string,
  variables: Record<string, string>,
  permitted: Set<string>,
): { text: string; used: string[] } {
  const used: string[] = [];
  const text = template.replace(/\{([a-z0-9_]+)\}/g, (whole, name: string) => {
    if (!permitted.has(name)) return whole;
    const value = variables[name];
    if (value === undefined || value.trim() === "") {
      // A missing name must never render as "Hi {first_name}" or "Hi ,".
      // Falling back to nothing and tidying the spacing is the only kind
      // outcome; the alternative is a participant reading a bug.
      return "";
    }
    used.push(name);
    return value;
  });
  return { text: text.replace(/\s+([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim(), used };
}

export class NarrativeRunner {
  private records: NarrativeRecord[] = [];
  private stageIndex = 0;
  private seq = 0;
  /** The guided interview's transcript, oldest first. */
  private transcript: { role: "assistant" | "user"; content: string }[] = [];
  private interviewTurns = 0;
  private interviewDone = false;
  private extraction: Record<string, string | null> = {};
  private candidates: { index: number; persona: string; text: string }[] = [];
  private chosen: { index: number; persona: string; text: string } | null = null;
  private finalScenario: string | null = null;
  private signals: MessageSignals[] = [];

  constructor(
    private readonly protocol: NarrativeProtocol,
    private readonly context: RunnerContext,
    private readonly gateway: Gateway,
  ) {}

  get all(): NarrativeRecord[] {
    return [...this.records];
  }

  private get stage(): NarrativeStage | undefined {
    return this.protocol.stages[this.stageIndex];
  }

  private append(
    stageKey: string,
    source: RecordSource,
    kind: RecordKind,
    fields: { text?: string | null; data?: Record<string, unknown> | null; refersTo?: string | null; modelCallId?: string | null } = {},
  ): NarrativeRecord {
    const proposed = { kind, source, refersTo: fields.refersTo ?? null };
    const refusal = refuseReason(proposed, this.records);
    if (refusal) throw new Error(`refused to append a record: ${refusal}`);

    const record: NarrativeRecord = {
      recordId: nextId(),
      sessionId: this.context.sessionId,
      protocolKey: this.protocol.key,
      protocolVersion: this.protocol.version,
      stageKey,
      seq: this.seq++,
      source,
      kind,
      text: fields.text ?? null,
      data: fields.data ?? null,
      refersTo: fields.refersTo ?? null,
      modelCallId: fields.modelCallId ?? null,
      at: new Date().toISOString(),
    };
    this.records.push(record);
    return record;
  }

  /** Everything the participant may see, resolved. */
  private permittedForDisplay(): Set<string> {
    return new Set(this.protocol.permittedVariables);
  }

  /** Only what the protocol has explicitly allowed to leave the device. */
  private permittedForPrompt(): Set<string> {
    const identifiers = new Set(this.protocol.permittedIdentifiers);
    return new Set(this.protocol.permittedVariables.filter((v) => !isIdentifying(v) || identifiers.has(v)));
  }

  /**
   * Resolve a piece of researcher-authored configuration on its way into a
   * prompt — an interview question, the topic restriction, a persona.
   *
   * These read like fixed text but they are not: a study sets its topic once
   * and writes "when {topic} came up for you" in the question, exactly as the
   * original pipes its topic in. Without this the model is asked to enquire
   * about the literal string "{topic}".
   *
   * It resolves against the PROMPT set, not the display set, so an identifier
   * the protocol has not explicitly released is left unsubstituted rather than
   * carried to a provider by a placeholder somebody typed into a question.
   */
  private configText(template: string): string {
    return resolveText(template, this.context.variables, this.permittedForPrompt()).text;
  }

  /** Start, or re-show the current screen. */
  start(): Screen {
    const stage = this.stage;
    if (!stage) return this.finishedScreen();
    const { text } = resolveText(stage.text, this.context.variables, this.permittedForDisplay());
    this.append(stage.key, "system", "request_shown", { text });
    return this.screenFor(stage, text);
  }

  /**
   * Take what the participant typed and advance.
   *
   * The participant's words are recorded first, before any model is called,
   * so a failure after this point cannot cost them what they said.
   */
  async submit(input: string, trace?: Omit<MessageTrace, "text">): Promise<Screen> {
    const stage = this.stage;
    if (!stage) return this.finishedScreen();

    // Quality signals are computed from how the message was composed, not from
    // what it says. Recorded for every participant message, acted on only if
    // the protocol turns them on.
    if (trace && input.trim().length > 0) {
      this.signals.push(signalsFor({ text: input, ...trace }, this.protocol.qualityControl));
    }

    if (stage.kind === "collect") return this.continueInterview(stage, input);
    if (stage.kind === "select") return this.chooseCandidate(stage, input);
    if (stage.kind === "rate") return this.recordRating(stage, input);
    if (stage.kind === "adapt") return this.reviseScenario(stage, input);

    // `rate` is handled above by the guided journey; what remains here are the
    // simpler stages the shorter protocols are built from.
    if (stage.kind === "elicit" || stage.kind === "confirm" || stage.kind === "follow_up") {
      const trimmed = input.trim();
      if (stage.kind === "follow_up") {
        // The model asked a question and the participant answered it on the
        // same screen. That answer is their words and must be kept — an
        // earlier version dropped it on the floor, because the stage was a
        // model stage and only participant stages recorded anything.
        if (trimmed.length > 0) {
          const question = [...this.records].reverse().find((r) => r.kind === "model_shown");
          this.append(stage.key, "participant", "participant_clarification", {
            text: trimmed.slice(0, stage.maxChars),
            refersTo: question?.recordId ?? null,
          });
          this.flagSafeguarding(stage.key, trimmed);
        }
      } else if (stage.kind === "elicit") {
        if (trimmed.length < stage.minChars) {
          const asked = this.append(stage.key, "system", "validation_result", {
            data: { ok: false, reason: "too_short", minChars: stage.minChars },
          });
          void asked;
          return this.screenFor(stage, "Could you say a little more?");
        }
        this.append(stage.key, "participant", "participant_original", { text: trimmed.slice(0, stage.maxChars) });
        this.flagSafeguarding(stage.key, trimmed);
      } else if (stage.kind === "confirm") {
        const target = [...this.records].reverse().find((r) => r.kind === "model_shown");
        this.append(stage.key, "participant", trimmed === "" ? "participant_reaction" : "participant_correction", {
          text: trimmed,
          refersTo: target?.recordId ?? null,
        });
      }
    }

    return this.advance();
  }

  /**
   * The participant read a screen that asked nothing of them and continued.
   *
   * Introductions and debriefs are stages like any other — they are shown,
   * and moving past them is an act worth being explicit about rather than
   * something submitting empty text happens to do.
   */
  next(): Promise<Screen> {
    return this.advance();
  }

  /** Skip an optional stage without ending the protocol. */
  skip(): Promise<Screen> {
    const stage = this.stage;
    if (stage) this.append(stage.key, "participant", "stage_skipped", {});
    return this.advance();
  }

  private async advance(): Promise<Screen> {
    // One stage, one screen. A conversation that goes back and forth is
    // expressed by declaring more stages, not by a hidden loop counter here —
    // which keeps what a participant will experience readable from the
    // protocol rather than inferable from this file.
    this.stageIndex += 1;
    const next = this.stage;
    if (!next) return this.finishedScreen();

    if (next.kind === "collect") return this.openInterview(next);
    if (next.kind === "extract") return this.runExtraction(next);
    if (next.kind === "generate") return this.runGeneration(next);
    if (next.kind === "follow_up" || next.kind === "interpret") return this.runModelStage(next);
    if (next.kind === "select") return this.offerChoices(next);
    if (next.kind === "rate") return this.offerRating(next);
    if (next.kind === "adapt") return this.offerAdaptation(next);

    const { text } = resolveText(next.text, this.context.variables, this.permittedForDisplay());
    this.append(next.key, "system", "request_shown", { text });
    return this.screenFor(next, text);
  }

  private async runModelStage(stage: NarrativeStage): Promise<Screen> {
    const config = this.protocol.models.find((m) => m.key === stage.modelConfigKey);
    if (!stage.prompt || !config) {
      return this.applyFallback(stage, "the stage is not configured for a model call");
    }
    if (!this.context.online && this.protocol.offlineFallback !== "queue_authorised") {
      return this.applyFallback(stage, "no connection");
    }

    const permitted = this.permittedForPrompt();
    const said = this.records
      .filter((r) => r.source === "participant" && typeof r.text === "string" && r.text.length > 0)
      .map((r) => r.text!)
      .join("\n\n");
    const variables: Record<string, string> = { ...this.context.variables, participant_words: said };
    const resolvedTemplate = resolveText(stage.prompt.template, variables, new Set([...permitted, "participant_words"]));
    const resolvedSystem = resolveText(stage.prompt.system, variables, new Set([...permitted, "participant_words"]));

    const prompt: ResolvedPrompt = {
      promptKey: stage.prompt.key,
      promptVersion: stage.prompt.version,
      system: resolvedSystem.text,
      messages: [{ role: "user", content: resolvedTemplate.text }],
      variables: Object.fromEntries(
        [...new Set([...resolvedTemplate.used, ...resolvedSystem.used])].map((k) => [k, variables[k] ?? ""]),
      ),
    };
    this.append(stage.key, "system", "prompt_resolved", {
      text: `${prompt.system}\n---\n${resolvedTemplate.text}`,
      data: { promptKey: prompt.promptKey, promptVersion: prompt.promptVersion, variables: Object.keys(prompt.variables) },
    });

    try {
      const result = await this.gateway.call<Record<string, unknown>>({
        sessionId: this.context.sessionId,
        protocolKey: this.protocol.key,
        stage: stage.key,
        prompt,
        config: config as ModelConfig,
        ...(stage.outputSchema
          ? { jsonSchema: { name: `${stage.key}_output`, schema: stage.outputSchema as Record<string, unknown> } }
          : {}),
        identifyingVariables: this.protocol.permittedIdentifiers,
      });

      this.append(stage.key, "model", "model_raw", { text: result.raw });
      const validated = this.append(stage.key, "model", "model_validated", {
        data: typeof result.output === "object" && result.output !== null ? (result.output as Record<string, unknown>) : { text: result.raw },
      });
      const shown = this.renderModelOutput(result.output, result.raw);
      this.append(stage.key, "system", "model_shown", { text: shown, refersTo: validated.recordId });
      return { ...this.screenFor(stage, shown), expectsInput: stage.kind === "follow_up" };
    } catch (error) {
      const kind = error instanceof ModelError ? error.kind : "unknown";
      return this.applyFallback(stage, `model call failed (${kind})`);
    }
  }

  /**
   * What the participant sees when a model stage cannot run.
   *
   * Never an apology string written into a data slot. The fallback is its own
   * record, the participant's words are untouched, and the run continues or
   * pauses exactly as the protocol declared.
   */
  private applyFallback(stage: NarrativeStage, reason: string): Screen {
    this.append(stage.key, "system", "fallback_applied", {
      data: { reason, fallback: this.protocol.offlineFallback },
    });

    switch (this.protocol.offlineFallback) {
      case "predefined_fallback": {
        const text = stage.fallbackText ?? "Thank you — let us move on.";
        this.append(stage.key, "system", "model_shown", { text });
        return { ...this.screenFor(stage, text), expectsInput: false, fallback: { reason, applied: "predefined_fallback" } };
      }
      case "pause_module":
        return { ...this.finishedScreen(), fallback: { reason, applied: "pause_module" } };
      case "queue_authorised":
      case "continue_without_model":
      default: {
        // Skip this stage and carry on. The words are saved either way; with
        // `queue_authorised` the stage is run again after sync, if the frozen
        // consent configuration permits it.
        this.stageIndex += 1;
        const next = this.stage;
        if (!next) return { ...this.finishedScreen(), fallback: { reason, applied: this.protocol.offlineFallback } };
        const { text } = resolveText(next.text, this.context.variables, this.permittedForDisplay());
        this.append(next.key, "system", "request_shown", { text });
        return { ...this.screenFor(next, text), fallback: { reason, applied: this.protocol.offlineFallback } };
      }
    }
  }

  /** Deterministic lexicon rules, which run with or without a network. */
  private flagSafeguarding(stageKey: string, text: string): void {
    const lower = text.toLowerCase();
    for (const rule of this.protocol.safeguarding) {
      if (rule.kind !== "lexicon") continue;
      const hit = rule.terms.find((term) => lower.includes(term.toLowerCase()));
      if (!hit) continue;
      // A flag is a route to a human, never a judgement and never anything the
      // participant is shown.
      this.append(stageKey, "system", "safeguarding_flag", {
        data: { rule: rule.key, tier: rule.tier, matched: hit, reviewers: rule.reviewers },
      });
    }
  }

  // ── The guided journey ──────────────────────────────────────────────────

  /** Ask the model for its next interview turn, given the transcript so far. */
  private async interviewerTurn(stage: NarrativeStage): Promise<{ reply: string; done: boolean } | null> {
    const interview = this.protocol.interview;
    const config = this.modelFor(stage);
    if (!interview || !config) return null;

    const system = INTERVIEWER_SYSTEM.replace("{persona}", this.configText(interview.persona))
      .replace("{language_style}", this.configText(interview.languageStyle))
      .replace("{topic_restriction}", this.configText(interview.topicRestriction))
      .replace("{questions}", numberedQuestions(interview.questions.map((q) => this.configText(q))))
      .replace("{collection_complete}", collectionComplete(interview.questions.length));

    const prompt: ResolvedPrompt = {
      promptKey: "pt.interviewer",
      promptVersion: this.protocol.version,
      system,
      messages: this.transcript.length > 0 ? [...this.transcript] : [{ role: "user", content: "(the participant is ready)" }],
      variables: {},
    };
    this.append(stage.key, "system", "prompt_resolved", {
      text: system,
      data: { promptKey: prompt.promptKey, turns: this.transcript.length },
    });

    try {
      const result = await this.gateway.call<{ reply: string; interviewDone: boolean }>({
        sessionId: this.context.sessionId,
        protocolKey: this.protocol.key,
        stage: stage.key,
        prompt,
        config,
        jsonSchema: { name: "interviewer_turn", schema: INTERVIEWER_SCHEMA as unknown as Record<string, unknown> },
        identifyingVariables: this.protocol.permittedIdentifiers,
      });
      this.append(stage.key, "model", "model_raw", { text: result.raw });
      const validated = this.append(stage.key, "model", "model_validated", {
        data: result.output as unknown as Record<string, unknown>,
      });
      this.append(stage.key, "system", "model_shown", { text: result.output.reply, refersTo: validated.recordId });
      this.transcript.push({ role: "assistant", content: result.output.reply });
      return { reply: result.output.reply, done: result.output.interviewDone === true };
    } catch {
      return null;
    }
  }

  private async openInterview(stage: NarrativeStage): Promise<Screen> {
    if (!this.context.online && this.protocol.offlineFallback !== "queue_authorised") {
      return this.applyFallback(stage, "no connection");
    }
    const turn = await this.interviewerTurn(stage);
    if (!turn) return this.applyFallback(stage, "the interviewer could not be reached");
    return { ...this.screenFor(stage, turn.reply), expectsInput: true };
  }

  /**
   * One exchange of the guided interview.
   *
   * The participant's answer is recorded before the model is asked anything,
   * so a failure here cannot cost them what they just wrote. The interview
   * ends when the model says every question is covered, or when the
   * researcher's turn limit is reached — never because a word appeared in the
   * transcript.
   */
  private async continueInterview(stage: NarrativeStage, input: string): Promise<Screen> {
    const interview = this.protocol.interview;
    const said = input.trim();
    if (said.length < stage.minChars) {
      this.append(stage.key, "system", "validation_result", {
        data: { ok: false, reason: "too_short", minChars: stage.minChars },
      });
      return this.screenFor(stage, "Could you say a little more?");
    }

    this.append(stage.key, "participant", "participant_original", { text: said.slice(0, stage.maxChars) });
    this.flagSafeguarding(stage.key, said);
    this.transcript.push({ role: "user", content: said });
    this.interviewTurns += 1;

    const limit = interview?.maxTurns ?? stage.maxTurns;
    if (this.interviewTurns >= limit) {
      this.interviewDone = true;
      this.append(stage.key, "system", "validation_result", { data: { interviewClosed: "turn_limit", limit } });
      return this.advance();
    }

    const turn = await this.interviewerTurn(stage);
    if (!turn) return this.applyFallback(stage, "the interviewer could not be reached");
    if (turn.done) {
      this.interviewDone = true;
      return this.advance();
    }
    return { ...this.screenFor(stage, turn.reply), expectsInput: true };
  }

  /** The participant's answers, reduced to the researcher's keys. */
  private async runExtraction(stage: NarrativeStage): Promise<Screen> {
    const declared = this.protocol.extraction?.keys;
    const config = this.modelFor(stage);
    if (!declared || !config) return this.applyFallback(stage, "the stage is not configured for extraction");
    // The key's question becomes a schema description, so it is prompt text.
    const keys = Object.fromEntries(
      Object.entries(declared).map(([key, question]) => [key, this.configText(question)]),
    );

    const quality = aggregate(this.signals, this.protocol.qualityControl);
    if (shouldStopBeforeGeneration(quality, this.protocol.qualityControl)) {
      // Everything collected is already recorded. What stops is the spending
      // of model calls on it, and the showing of a retelling built on it.
      this.append(stage.key, "system", "fallback_applied", {
        data: { reason: "quality_signals", quality },
      });
      return {
        ...this.finishedScreen(),
        stopped: { reason: "quality signals crossed the threshold set for this study" },
      };
    }

    // "Human:" / "AI:", as the original labels the transcript it extracts from.
    const conversation = this.transcript.map((m) => `${m.role === "user" ? "Human" : "AI"}: ${m.content}`).join("\n");
    const system = EXTRACTION_SYSTEM.replace("{keys_string}", keysString(Object.keys(keys))).replace(
      "{questions}",
      keyQuestions(keys),
    );
    const prompt: ResolvedPrompt = {
      promptKey: "pt.extraction",
      promptVersion: this.protocol.version,
      system,
      messages: [{ role: "user", content: `Message to date:\n${conversation}` }],
      variables: {},
    };
    this.append(stage.key, "system", "prompt_resolved", { text: system, data: { keys: Object.keys(keys) } });

    try {
      const result = await this.gateway.call<Record<string, string | null>>({
        sessionId: this.context.sessionId,
        protocolKey: this.protocol.key,
        stage: stage.key,
        prompt,
        // Extraction is the one stage that must not improvise, so it runs at
        // the low temperature the original used.
        config: { ...config, temperature: Math.min(config.temperature, 0.1) },
        jsonSchema: { name: "extraction", schema: extractionSchema(keys) },
      });
      this.append(stage.key, "model", "model_raw", { text: result.raw });
      this.append(stage.key, "model", "model_validated", { data: result.output as Record<string, unknown> });
      this.extraction = result.output;
      return this.advance();
    } catch {
      return this.applyFallback(stage, "extraction failed");
    }
  }

  /** One retelling per persona, from the extraction. */
  private async runGeneration(stage: NarrativeStage): Promise<Screen> {
    const scenario = this.protocol.scenario;
    const config = this.modelFor(stage);
    if (!scenario || !config) return this.applyFallback(stage, "the stage is not configured for generation");

    // "Question: … / Answer: …", as `_generate_q_and_a` lays it out. A key the
    // extraction left null is shown as such rather than omitted, so the writer
    // is told what was not said instead of being left to fill the gap.
    const answers = Object.entries(this.extraction)
      .map(([key, value]) => {
        const question = this.protocol.extraction?.keys[key];
        return `Question: ${question ? this.configText(question) : key}\nAnswer: ${value ?? "(they did not say)"}`;
      })
      .join("\n");

    /**
     * The personas write at the same time, as the original's do.
     *
     * Not an optimisation — it is the difference between a usable stage and an
     * abandoned one. Each retelling is an independent call on the same
     * extraction, and run one after another that is three round trips of a
     * young person looking at a screen that does nothing. §8.1 records the
     * original as generating its three candidates in parallel; running them in
     * sequence was a plain infidelity.
     *
     * The prompt records are written first, in persona order, so the log reads
     * the same way regardless of which call happens to return first.
     */
    const attempts = scenario.personas.map((persona, index) => {
      const system =
        SCENARIO_SYSTEM.replace("{persona}", this.configText(persona.text)).replace("{one_shot}", oneShot(this.protocol));
      this.append(stage.key, "system", "prompt_resolved", { text: system, data: { persona: persona.key, index } });
      return { persona, index, system };
    });

    const settled = await Promise.all(
      attempts.map(async ({ persona, index, system }) => {
        const prompt: ResolvedPrompt = {
          promptKey: `pt.scenario.${persona.key}`,
          promptVersion: this.protocol.version,
          system,
          messages: [{ role: "user", content: answers }],
          variables: {},
        };
        try {
          const result = await this.gateway.call<{ scenario: string; confidence: string }>({
            sessionId: this.context.sessionId,
            protocolKey: this.protocol.key,
            stage: stage.key,
            prompt,
            config,
            jsonSchema: { name: "scenario", schema: SCENARIO_SCHEMA as unknown as Record<string, unknown> },
          });
          return { persona, index, result };
        } catch {
          return { persona, index, result: null };
        }
      }),
    );

    // Recorded in persona order once every call has come back, so the staged
    // records are deterministic even though the calls were not.
    const produced: { index: number; persona: string; text: string }[] = [];
    for (const { persona, index, result } of settled) {
      if (!result) {
        // One persona failing is not the run failing. The original stored an
        // apology string in the scenario slot; here the candidate is simply
        // absent, which is visible rather than disguised as a retelling.
        this.append(stage.key, "system", "fallback_applied", {
          data: { persona: persona.key, index, reason: "generation failed" },
        });
        continue;
      }
      this.append(stage.key, "model", "model_raw", { text: result.raw });
      this.append(stage.key, "model", "model_validated", {
        data: { ...(result.output as unknown as Record<string, unknown>), persona: persona.key, index },
      });
      produced.push({ index, persona: persona.key, text: result.output.scenario });
    }

    if (produced.length === 0) return this.applyFallback(stage, "no retelling could be generated");
    this.candidates = produced;
    return this.advance();
  }

  private offerChoices(stage: NarrativeStage): Screen {
    const { text } = resolveText(stage.text, this.context.variables, this.permittedForDisplay());
    this.append(stage.key, "system", "request_shown", {
      text,
      data: { candidates: this.candidates.map((c) => ({ index: c.index, persona: c.persona })) },
    });
    for (const candidate of this.candidates) {
      this.append(stage.key, "system", "model_shown", { text: candidate.text, data: { index: candidate.index } });
    }
    return { ...this.screenFor(stage, text), expectsInput: true, choices: this.candidates };
  }

  private async chooseCandidate(stage: NarrativeStage, input: string): Promise<Screen> {
    const index = Number.parseInt(input.trim(), 10);
    const picked = this.candidates.find((c) => c.index === index) ?? this.candidates[0];
    if (!picked) return this.advance();
    this.chosen = picked;
    this.finalScenario = picked.text;
    // The choice is data, not navigation (§8.2, assumption 3).
    this.append(stage.key, "participant", "participant_reaction", {
      text: picked.text,
      data: { chosenIndex: picked.index, persona: picked.persona, offered: this.candidates.length },
    });
    return this.advance();
  }

  private offerRating(stage: NarrativeStage): Screen {
    const { text } = resolveText(stage.text, this.context.variables, this.permittedForDisplay());
    this.append(stage.key, "system", "request_shown", { text });
    return {
      ...this.screenFor(stage, text),
      expectsInput: true,
      ...(this.finalScenario ? { scenario: this.finalScenario } : {}),
      rating: { max: this.protocol.scenario?.maxRating ?? 10 },
    };
  }

  private async recordRating(stage: NarrativeStage, input: string): Promise<Screen> {
    const max = this.protocol.scenario?.maxRating ?? 10;
    const rating = Math.max(0, Math.min(max, Number.parseInt(input.trim(), 10) || 0));
    this.append(stage.key, "participant", "participant_rating", {
      data: { rating, max, scenarioIndex: this.chosen?.index ?? null },
    });

    // A perfect score short-circuits adaptation, as in the original: there is
    // nothing to correct, and asking anyway invites a change nobody wanted.
    const threshold = this.protocol.scenario?.adaptBelowRating ?? max;
    if (rating >= threshold) {
      const adaptIndex = this.protocol.stages.findIndex((s) => s.kind === "adapt");
      if (adaptIndex > this.stageIndex) {
        this.append(stage.key, "system", "stage_skipped", { data: { reason: "rated_full_marks", rating } });
        this.stageIndex = adaptIndex;
      }
    }
    return this.advance();
  }

  private offerAdaptation(stage: NarrativeStage): Screen {
    const { text } = resolveText(stage.text, this.context.variables, this.permittedForDisplay());
    this.append(stage.key, "system", "request_shown", { text });
    return {
      ...this.screenFor(stage, text),
      expectsInput: true,
      // The retelling itself, offered for editing. The original lets a
      // participant rewrite it directly as well as ask the model to (§8.1),
      // and a sentence a young person typed is evidence in a way a model's
      // reading of their instruction is not.
      editable: true,
      ...(this.finalScenario ? { scenario: this.finalScenario } : {}),
    };
  }

  /**
   * The participant rewrites the retelling themselves.
   *
   * No model call: this text IS the change. It is recorded as
   * `participant_edit`, pointing at the version it replaced, so the analysis
   * can tell a rewrite in a young person's own words from a paraphrase the
   * model produced on their instruction — and can reconstruct every version
   * in order, because nothing is overwritten.
   */
  editScenario(text: string): Screen {
    const stage = this.stage;
    const edited = text.trim();
    if (!stage || edited.length === 0) return this.current();
    if (edited === this.finalScenario) return this.current();

    const shown = [...this.records].reverse().find((r) => r.kind === "model_shown" || r.kind === "participant_edit");
    this.append(stage.key, "participant", "participant_edit", {
      text: edited,
      refersTo: shown?.recordId ?? null,
      data: { replaced: this.finalScenario },
    });
    this.flagSafeguarding(stage.key, edited);
    this.finalScenario = edited;
    return { ...this.current(), scenario: edited };
  }

  /**
   * Keep this version and move on.
   *
   * The finishing move for the adapt stage, and the only one: saving the
   * participant's own text and advancing are the same act, so they are the
   * same button. Passing text that has not changed is fine — it records
   * nothing and still advances.
   */
  async keepScenario(text: string): Promise<Screen> {
    this.editScenario(text);
    return this.advance();
  }

  /**
   * Reject the last change and go back to what it replaced.
   *
   * The original offers accept/reject/reset on an AI adaptation. Rejecting
   * does not delete anything: the rejected version stays in the record, and a
   * new record says it was put back. What a participant turned down is a
   * finding about the retelling, not noise to be swept up.
   */
  revertScenario(): Screen {
    const stage = this.stage;
    if (!stage) return this.current();
    const previous = [...this.records]
      .reverse()
      .find((r) => r.kind === "participant_edit" && typeof r.data?.["replaced"] === "string");
    const replaced =
      (previous?.data?.["replaced"] as string | undefined) ??
      this.candidates.find((c) => c.index === this.chosen?.index)?.text;
    if (!replaced || replaced === this.finalScenario) return this.current();

    this.append(stage.key, "participant", "participant_reaction", {
      text: "put the previous version back",
      data: { rejected: this.finalScenario, restored: replaced },
    });
    this.finalScenario = replaced;
    return { ...this.current(), scenario: replaced };
  }

  /** Re-show the current screen without advancing or calling anything. */
  private current(): Screen {
    const stage = this.stage;
    if (!stage) return this.finishedScreen();
    const { text } = resolveText(stage.text, this.context.variables, this.permittedForDisplay());
    return {
      ...this.screenFor(stage, text),
      expectsInput: true,
      ...(stage.kind === "adapt" ? { editable: true } : {}),
      ...(this.finalScenario ? { scenario: this.finalScenario } : {}),
    };
  }

  /** The participant says what is wrong; the model revises exactly that. */
  private async reviseScenario(stage: NarrativeStage, input: string): Promise<Screen> {
    const request = input.trim();
    const config = this.modelFor(stage);

    /**
     * An empty request is not "I am finished".
     *
     * It used to advance, because when this stage had one button an empty box
     * plausibly meant "no changes thanks". With a rewrite button it means the
     * participant pressed it without saying what to change — and ending their
     * session there, before showing them anything, is the worst reading of it.
     * Finishing is now `keepScenario`, which is a button that says so.
     */
    if (request.length === 0) return { ...this.current(), needsRequest: true };
    if (!config || !this.finalScenario) return this.applyFallback(stage, "there is nothing to revise");

    const target = [...this.records].reverse().find((r) => r.kind === "model_shown");
    this.append(stage.key, "participant", "participant_correction", {
      text: request,
      refersTo: target?.recordId ?? null,
    });
    this.flagSafeguarding(stage.key, request);

    const prompt: ResolvedPrompt = {
      promptKey: "pt.adaptation",
      promptVersion: this.protocol.version,
      system: ADAPT_SYSTEM,
      messages: [
        { role: "user", content: `The account:\n${this.finalScenario}\n\nWhat they want changed:\n${request}` },
      ],
      variables: {},
    };
    this.append(stage.key, "system", "prompt_resolved", { text: ADAPT_SYSTEM });

    try {
      const result = await this.gateway.call<{ newScenario: string; changed: boolean }>({
        sessionId: this.context.sessionId,
        protocolKey: this.protocol.key,
        stage: stage.key,
        prompt,
        config,
        jsonSchema: { name: "adaptation", schema: ADAPT_SCHEMA as unknown as Record<string, unknown> },
      });
      this.append(stage.key, "model", "model_raw", { text: result.raw });
      const validated = this.append(stage.key, "model", "model_validated", {
        data: result.output as unknown as Record<string, unknown>,
      });
      // The revision is a new record beside the old one. Nothing is
      // overwritten, so the sequence of what was shown and what was asked for
      // survives for the analysis.
      this.finalScenario = result.output.newScenario;
      this.append(stage.key, "system", "model_shown", { text: result.output.newScenario, refersTo: validated.recordId });
      return {
        ...this.screenFor(stage, result.output.newScenario),
        expectsInput: true,
        editable: true,
        // The model may report that it could not honour the request from the
        // participant's own words. Saying so is better than a revision that
        // quietly invented the difference.
        ...(result.output.changed === false ? { unchanged: true } : {}),
        scenario: this.finalScenario,
      };
    } catch {
      return this.applyFallback(stage, "the revision could not be made");
    }
  }

  private modelFor(stage: NarrativeStage): ModelConfig | undefined {
    return this.protocol.models.find((m) => m.key === stage.modelConfigKey) as ModelConfig | undefined;
  }

  /** What the run produced, for storage alongside the records. */
  get outcome(): {
    extraction: Record<string, string | null>;
    candidates: { index: number; persona: string; text: string }[];
    chosenIndex: number | null;
    finalScenario: string | null;
    quality: ReturnType<typeof aggregate>;
    interviewDone: boolean;
  } {
    return {
      extraction: this.extraction,
      candidates: this.candidates,
      chosenIndex: this.chosen?.index ?? null,
      finalScenario: this.finalScenario,
      quality: aggregate(this.signals, this.protocol.qualityControl),
      interviewDone: this.interviewDone,
    };
  }

  private renderModelOutput(output: unknown, raw: string): string {
    if (typeof output === "string") return output;
    if (output && typeof output === "object") {
      const record = output as Record<string, unknown>;
      for (const key of ["question", "summary", "text", "scenario", "reflection"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim() !== "") return value;
      }
    }
    return raw;
  }

  private screenFor(stage: NarrativeStage, text: string): Screen {
    const lede = stage.lede
      ? resolveText(stage.lede, this.context.variables, this.permittedForDisplay()).text
      : undefined;
    return {
      stageKey: stage.key,
      kind: stage.kind,
      text,
      ...(lede ? { lede } : {}),
      expectsInput: stage.kind === "elicit" || stage.kind === "confirm" || stage.kind === "rate",
      maxTurns: stage.maxTurns,
      optional: stage.optional,
      finished: false,
    };
  }

  private finishedScreen(): Screen {
    return {
      stageKey: "__end__",
      kind: "debrief",
      text: "",
      expectsInput: false,
      maxTurns: 0,
      optional: false,
      finished: true,
    };
  }
}
