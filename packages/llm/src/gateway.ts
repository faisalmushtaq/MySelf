import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  ModelError,
  type ModelAdapter,
  type ModelCall,
  type ModelConfig,
  type ModelResult,
  type ResolvedPrompt,
} from "./types.js";

/**
 * The gateway every model call goes through.
 *
 * It does four things the adapters deliberately do not:
 *
 *   - writes the provenance row, before the call and after it, so a call that
 *     timed out is as much a part of the record as one that worked
 *   - validates the output against the schema the protocol froze, and treats a
 *     failure as a failure rather than passing half-parsed text onward
 *   - retries transport failures with backoff, and refuses to retry the ones
 *     where retrying is wrong (a safety block is not a flaky network)
 *   - never lets a model result overwrite anything a participant said; it
 *     returns a value, and what the caller may do with it is decided by the
 *     staged-record rules, not here
 */

export interface GatewayOptions {
  adapters: ModelAdapter[];
  /** Where provenance rows go. Kept as a sink so tests can hold them in memory. */
  onCall: (call: ModelCall) => void | Promise<void>;
  now?: () => Date;
  /** Injectable so tests do not actually wait between retries. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallRequest<T> {
  sessionId: string;
  protocolKey: string;
  stage: string;
  prompt: ResolvedPrompt;
  config: ModelConfig;
  /** Zod schema the output must satisfy. */
  outputSchema?: z.ZodType<T>;
  /** JSON schema handed to the provider for structured output, where supported. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Variables that are identifying, so the provenance row can say so. */
  identifyingVariables?: string[];
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const flatten = (prompt: ResolvedPrompt): string =>
  [`system: ${prompt.system}`, ...prompt.messages.map((m) => `${m.role}: ${m.content}`)].join("\n");

export class Gateway {
  private readonly adapters: Map<string, ModelAdapter>;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GatewayOptions) {
    this.adapters = new Map(options.adapters.map((a) => [a.provider, a]));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T = string>(request: CallRequest<T>): Promise<ModelResult<T>> {
    const adapter = this.adapters.get(request.config.provider);
    if (!adapter) {
      throw new ModelError("transport", `no adapter for provider '${request.config.provider}'`, false);
    }

    const resolved = flatten(request.prompt);
    const identifying = (request.identifyingVariables ?? []).filter((v) => v in request.prompt.variables);
    const call: ModelCall = {
      callId: `mc_${randomUUID()}`,
      sessionId: request.sessionId,
      protocolKey: request.protocolKey,
      stage: request.stage,
      modelConfigKey: request.config.key,
      provider: request.config.provider,
      modelRequested: request.config.model,
      modelServed: null,
      promptKey: request.prompt.promptKey,
      promptVersion: request.prompt.promptVersion,
      promptHash: hash(resolved),
      promptResolved: resolved,
      variablesUsed: Object.keys(request.prompt.variables).sort(),
      containedIdentifiers: identifying.length > 0,
      startedAt: this.now().toISOString(),
      completedAt: null,
      status: "started",
      errorKind: null,
      errorMessage: null,
      raw: null,
      usage: null,
      latencyMs: null,
      attempts: 0,
    };
    // Written before the call: a process that dies mid-request still leaves
    // evidence that the request was made.
    await this.options.onCall({ ...call });

    let lastError: ModelError = new ModelError("unknown", "no attempt was made");
    for (let attempt = 1; attempt <= request.config.maxAttempts; attempt += 1) {
      call.attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.config.timeoutSeconds * 1000);
      try {
        const result = await adapter.generate(request.prompt, request.config, request.jsonSchema, controller.signal);
        clearTimeout(timer);

        const output = this.validate(result.text, request.outputSchema, request.jsonSchema);
        const done: ModelCall = {
          ...call,
          modelServed: result.modelServed,
          completedAt: this.now().toISOString(),
          status: "succeeded",
          raw: result.text,
          usage: result.usage,
          latencyMs: result.latencyMs,
        };
        await this.options.onCall(done);
        return {
          output,
          raw: result.text,
          modelServed: result.modelServed,
          usage: result.usage,
          latencyMs: result.latencyMs,
          attempts: attempt,
        };
      } catch (error) {
        clearTimeout(timer);
        lastError = error instanceof ModelError ? error : new ModelError("unknown", String(error));
        // A safety block or a malformed output is not a flaky network, and
        // hammering the provider with the same prompt will produce the same
        // answer. Only genuinely transient failures are retried.
        if (!lastError.retryable || attempt === request.config.maxAttempts) break;
        await this.sleep(Math.min(2 ** (attempt - 1) * 500, 4000));
      }
    }

    await this.options.onCall({
      ...call,
      completedAt: this.now().toISOString(),
      status: "failed",
      errorKind: lastError.kind,
      errorMessage: lastError.message,
    });
    throw lastError;
  }

  private validate<T>(text: string, schema?: z.ZodType<T>, jsonSchema?: { schema: Record<string, unknown> }): T {
    if (!schema && !jsonSchema) return text as unknown as T;

    if (!schema && jsonSchema) {
      // Asking a provider for structured output is a request, not a
      // guarantee — and a provider that returns an apology instead of JSON is
      // exactly the failure the original implementation let through into a
      // data slot. What comes back is checked against the same schema that
      // was sent.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ModelError("malformed_output", "the model did not return JSON", false);
      }
      const problem = checkJsonSchema(parsed, jsonSchema.schema, "");
      if (problem) throw new ModelError("malformed_output", `output did not match the schema: ${problem}`, false);
      return parsed as T;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ModelError("malformed_output", "the model did not return JSON", false);
    }
    const result = schema!.safeParse(parsed);
    if (!result.success) {
      // The protocol declared what a usable answer looks like. Something that
      // does not match it is not "close enough" — it goes to the declared
      // fallback, which never overwrites a data slot.
      throw new ModelError(
        "malformed_output",
        `output did not match the schema: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        false,
      );
    }
    return result.data;
  }
}

/**
 * Check a value against the subset of JSON Schema protocols actually use.
 *
 * Deliberately small — objects, strings, numbers, booleans, arrays, enums and
 * required keys — and deliberately not a general validator. It exists so the
 * schema a protocol froze is enforced on the way back as well as requested on
 * the way out, and a validator nobody can read is not a control.
 *
 * Returns the first problem, or null.
 */
function checkJsonSchema(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  const where = path === "" ? "output" : path;
  const enumValues = schema["enum"] as unknown[] | undefined;
  if (enumValues) {
    return enumValues.includes(value) ? null : `${where} must be one of ${enumValues.join(", ")}`;
  }

  switch (schema["type"] as string | undefined) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where} must be an object`;
      const record = value as Record<string, unknown>;
      const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
      for (const key of (schema["required"] as string[] | undefined) ?? []) {
        if (!(key in record)) return `${where} is missing '${key}'`;
      }
      if (schema["additionalProperties"] === false) {
        const extra = Object.keys(record).find((k) => !(k in properties));
        if (extra) return `${where} has an unexpected '${extra}'`;
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!(key in record)) continue;
        const problem = checkJsonSchema(record[key], child, path === "" ? key : `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${where} must be an array`;
      const items = schema["items"] as Record<string, unknown> | undefined;
      if (!items) return null;
      for (const [i, item] of value.entries()) {
        const problem = checkJsonSchema(item, items, `${path}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${where} must be a string`;
    case "integer":
      return Number.isInteger(value) ? null : `${where} must be a whole number`;
    case "number":
      return typeof value === "number" ? null : `${where} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${where} must be true or false`;
    default:
      return null;
  }
}
