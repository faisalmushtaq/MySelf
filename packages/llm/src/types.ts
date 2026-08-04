import { z } from "zod";

/**
 * The provider-independent model interface.
 *
 * Every model call in the platform goes through this, for three reasons that
 * are all about the research rather than the engineering:
 *
 *   1. A published release freezes the provider, model and sampling
 *      parameters. An analysis two years later has to be able to say exactly
 *      what generated a given piece of text, and "GPT-4o, probably" is not an
 *      answer.
 *   2. Every call writes a provenance row before and after it runs. A call
 *      that failed, timed out or was refused is part of the record.
 *   3. A deterministic mock implements the same interface, so the whole
 *      narrative module is testable without a network, a key, or a bill.
 */

export const modelConfig = z.object({
  /** Stable key frozen into the release, e.g. "mc.openai.gpt4o.t07". */
  key: z.string().min(1),
  provider: z.enum(["openai", "anthropic", "mock"]),
  /** The model as requested. The snapshot actually served is recorded separately. */
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxOutputTokens: z.number().int().positive().default(1024),
  /** Seconds before a call is abandoned and the protocol's fallback applies. */
  timeoutSeconds: z.number().int().positive().default(30),
  /** How many times a transport failure is retried before giving up. */
  maxAttempts: z.number().int().min(1).max(5).default(3),
  /**
   * What the provider has been asked to do with the data, recorded per config
   * so a DPIA can be written from the release rather than from memory.
   */
  dataHandling: z
    .object({
      trainingUseOptOut: z.boolean().default(true),
      retentionNote: z.string().optional(),
      region: z.string().optional(),
    })
    .default({ trainingUseOptOut: true }),
});

export type ModelConfig = z.infer<typeof modelConfig>;

/** A prompt after every variable has been resolved: exactly what will be sent. */
export interface ResolvedPrompt {
  /** Stable key + version of the template this came from. */
  promptKey: string;
  promptVersion: string;
  system: string;
  /** Conversation so far, oldest first. */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** The variables that were substituted, for the provenance row. */
  variables: Record<string, string>;
}

/** Normalised failure kinds. Adapters map provider errors onto these. */
export type ModelErrorKind =
  | "timeout"
  | "rate_limit"
  | "safety_block"
  | "malformed_output"
  | "auth"
  | "transport"
  | "unknown";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly retryable = kind === "timeout" || kind === "rate_limit" || kind === "transport",
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelResult<T = unknown> {
  /** Parsed and schema-validated output. */
  output: T;
  /** Exactly what the model returned, before parsing. Stored immutably. */
  raw: string;
  /** The snapshot the provider actually served, where it reports one. */
  modelServed: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  attempts: number;
}

/**
 * One row per model call, written before the call and completed after it.
 *
 * `promptResolved` holds the exact text sent. That is deliberate and it has a
 * consequence: if a protocol is configured to put a participant's name into a
 * prompt, this row contains that name, and these rows then have to be handled
 * as identifiable data. The gateway records which permitted variables were
 * substituted so that is visible rather than buried in a string.
 */
export interface ModelCall {
  callId: string;
  sessionId: string;
  protocolKey: string;
  stage: string;
  modelConfigKey: string;
  provider: string;
  modelRequested: string;
  modelServed: string | null;
  promptKey: string;
  promptVersion: string;
  /** SHA-256 of the resolved prompt, so identical calls are recognisable. */
  promptHash: string;
  promptResolved: string;
  /** Names of the variables substituted — not their values. */
  variablesUsed: string[];
  /** True when any substituted variable was declared as identifying. */
  containedIdentifiers: boolean;
  startedAt: string;
  completedAt: string | null;
  status: "started" | "succeeded" | "failed";
  errorKind: ModelErrorKind | null;
  errorMessage: string | null;
  raw: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
  attempts: number;
}

/** What an adapter hands back: the text, and what the provider said about it. */
export interface AdapterResult {
  text: string;
  modelServed: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
}

/**
 * What every provider adapter implements.
 *
 * Deliberately narrow: an adapter turns a resolved prompt into text and
 * normalises the provider's errors. Retries, validation, provenance and
 * fallbacks are the gateway's job, so adding a provider cannot accidentally
 * change how failures are handled.
 */
export interface ModelAdapter {
  readonly provider: string;
  generate(
    prompt: ResolvedPrompt,
    config: ModelConfig,
    /** JSON schema the output must satisfy, where the protocol declares one. */
    schema?: { name: string; schema: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<AdapterResult>;
}
