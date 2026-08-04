import { ModelError, type ModelAdapter, type ModelConfig, type ResolvedPrompt } from "../types.js";

/**
 * The deterministic mock — the test workhorse, and the way this module can be
 * demonstrated without a key, a network or a bill.
 *
 * Seeded from the prompt, so the same conversation always produces the same
 * reply: a test that asserts on generated text stays true, and a demonstration
 * to an ethics committee shows the same thing twice.
 *
 * Schema-aware: given the JSON schema the protocol froze, it fabricates a
 * response that satisfies it. That is what makes it useful for testing the
 * validation path — including, deliberately, its ability to produce output
 * that FAILS validation on demand, because the interesting tests are the ones
 * where the model misbehaves.
 */

export interface MockOptions {
  /** Force a particular failure, for the fault-injection tests. */
  fail?: { kind: "timeout" | "rate_limit" | "safety_block" | "malformed_output" | "transport"; times?: number };
  /** Fixed latency to report, so timing assertions are stable. */
  latencyMs?: number;
  /** Return text that will not satisfy the schema. */
  returnGarbage?: boolean;
}

/** A tiny deterministic hash, used to pick between plausible phrasings. */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const FOLLOW_UPS = [
  "You mentioned that felt important — could you say a bit more about what was going on at the time?",
  "Thank you for that. What was the hardest part of it for you?",
  "That is helpful. Was there anyone else involved in what you described?",
  "Could you tell me a little more about how that left you feeling afterwards?",
];

export class MockAdapter implements ModelAdapter {
  readonly provider = "mock";
  private failuresLeft: number;

  constructor(private readonly options: MockOptions = {}) {
    this.failuresLeft = options.fail?.times ?? (options.fail ? Number.POSITIVE_INFINITY : 0);
  }

  async generate(prompt: ResolvedPrompt, config: ModelConfig, schema?: { name: string; schema: Record<string, unknown> }) {
    if (this.options.fail && this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new ModelError(this.options.fail.kind, `mock failure: ${this.options.fail.kind}`);
    }

    const conversation = prompt.messages.map((m) => m.content).join("\n");
    const seed = seedOf(`${prompt.promptKey}:${conversation}`);
    const text = this.options.returnGarbage
      ? "I am terribly sorry, I cannot help with that."
      : schema
        ? JSON.stringify(this.fabricate(schema.schema, seed, prompt))
        : FOLLOW_UPS[seed % FOLLOW_UPS.length]!;

    return {
      text,
      modelServed: `mock-${config.model}`,
      usage: { inputTokens: conversation.length >> 2, outputTokens: text.length >> 2 },
      latencyMs: this.options.latencyMs ?? 12,
    };
  }

  /** Build the smallest value that satisfies a JSON schema. */
  private fabricate(schema: Record<string, unknown>, seed: number, prompt: ResolvedPrompt, key?: string): unknown {
    const type = schema["type"] as string | undefined;
    if (schema["enum"]) {
      const options = schema["enum"] as unknown[];
      return options[seed % options.length];
    }
    switch (type) {
      case "object": {
        const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
        const required = (schema["required"] as string[] | undefined) ?? Object.keys(properties);
        const out: Record<string, unknown> = {};
        for (const key of required) {
          const child = properties[key];
          if (child) out[key] = this.fabricate(child, seed + key.length, prompt, key);
        }
        return out;
      }
      case "array": {
        const items = (schema["items"] ?? { type: "string" }) as Record<string, unknown>;
        const min = (schema["minItems"] as number | undefined) ?? 1;
        return Array.from({ length: Math.max(min, 1) }, (_, i) => this.fabricate(items, seed + i, prompt));
      }
      case "integer":
      case "number": {
        const min = (schema["minimum"] as number | undefined) ?? 0;
        const max = (schema["maximum"] as number | undefined) ?? min + 10;
        return min + (seed % Math.max(1, max - min + 1));
      }
      case "boolean":
        // Some booleans steer the run rather than describing it, and a coin
        // flip there makes a mocked interview end after one question. Where
        // the field decides whether an interview is over, answer it from the
        // conversation — which is what a real model would be doing.
        if (key === "interviewDone") {
          return prompt.messages.filter((m) => m.role === "user").length >= 4;
        }
        if (key === "changed") return true;
        return seed % 2 === 0;
      default: {
        // Echo a little of what the participant said, so a mocked run reads
        // like a conversation rather than lorem ipsum. Their words, not the
        // instruction wrapped around them: the resolved template is mostly
        // researcher prose, and echoing that made demonstrations read as
        // nonsense.
        const said = prompt.variables["participant_words"] ?? "";
        const last = said || ([...prompt.messages].reverse().find((m) => m.role === "user")?.content ?? "");
        const gist = last.split(/[.!?]/).filter((x) => x.trim().length > 0).pop()?.trim().slice(0, 90) ?? "";
        return gist.length > 0
          ? `The participant described ${gist.charAt(0).toLowerCase()}${gist.slice(1)}.`
          : FOLLOW_UPS[seed % FOLLOW_UPS.length]!;
      }
    }
  }
}
