import { ModelError, type Gateway, type ModelConfig, type ResolvedPrompt } from "@myself/llm";
import { isIdentifying, placeholdersIn, type NarrativeProtocol, type NarrativeStage } from "./protocol.js";
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
  async submit(input: string): Promise<Screen> {
    const stage = this.stage;
    if (!stage) return this.finishedScreen();

    if (stage.kind === "elicit" || stage.kind === "confirm" || stage.kind === "rate" || stage.kind === "follow_up") {
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
      } else {
        this.append(stage.key, "participant", "participant_rating", { data: { rating: trimmed } });
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

    if (next.kind === "follow_up" || next.kind === "interpret") {
      return this.runModelStage(next);
    }

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
