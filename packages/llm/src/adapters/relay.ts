import { ModelError, type ModelAdapter, type ModelConfig, type ResolvedPrompt } from "../types.js";

/**
 * The adapter a participant's iPad uses.
 *
 * It does not talk to a provider. It posts the resolved prompt to our own
 * endpoint — the Cloud Function — which holds the key and makes the call. A
 * provider key in a page is a provider key in a school (docs/05 §6), and a
 * study that put one there would have to rotate it every time a device was
 * handed to a child.
 *
 * The device also has no business choosing a model. The config travels so the
 * function can check it against the frozen release and refuse anything that
 * does not match; a device that asked for a different model than the release
 * declares is a device running something nobody published.
 */

export interface RelayOptions {
  /** Where the function lives. */
  url: string;
  /** Bearer token identifying this enrolled device. */
  token?: string | undefined;
}

interface RelayResponse {
  text?: string;
  modelServed?: string | null;
  usage?: { inputTokens?: number | null; outputTokens?: number | null };
  error?: { kind?: string; message?: string; retryable?: boolean };
}

const KINDS = new Set([
  "transport",
  "timeout",
  "rate_limit",
  "auth",
  "safety_block",
  "malformed_output",
  "schema_mismatch",
  "unknown",
]);

export class RelayAdapter implements ModelAdapter {
  readonly provider = "relay";

  constructor(private readonly options: RelayOptions) {
    if (!options.url) throw new Error("the relay adapter needs the endpoint it should post to");
  }

  async generate(
    prompt: ResolvedPrompt,
    config: ModelConfig,
    schema?: { name: string; schema: Record<string, unknown> },
    signal?: AbortSignal,
  ) {
    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify({
          prompt: { system: prompt.system, messages: prompt.messages },
          // The key, not the parameters: the function reads the settings from
          // the frozen release, so a tampered page cannot raise the
          // temperature or point the study at a different model.
          modelConfigKey: config.key,
          protocolKey: prompt.promptKey,
          ...(schema ? { schema } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ModelError("timeout", `no response within ${config.timeoutSeconds}s`);
      // The ordinary case in a school hall, and not an error worth a message:
      // the protocol's declared offline fallback takes it from here.
      throw new ModelError("transport", String(error));
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as RelayResponse;
      const message = detail.error?.message ?? `HTTP ${response.status}`;
      const kind = detail.error?.kind;
      if (kind && KINDS.has(kind)) {
        throw new ModelError(kind as never, message, detail.error?.retryable ?? true);
      }
      if (response.status === 401 || response.status === 403) throw new ModelError("auth", message, false);
      if (response.status === 429) throw new ModelError("rate_limit", message);
      if (response.status >= 500) throw new ModelError("transport", message);
      throw new ModelError("unknown", message, false);
    }

    const data = (await response.json()) as RelayResponse;
    if (typeof data.text !== "string" || data.text.trim() === "") {
      throw new ModelError("malformed_output", "the relay returned nothing", false);
    }
    return {
      text: data.text,
      modelServed: data.modelServed ?? null,
      usage: {
        inputTokens: data.usage?.inputTokens ?? null,
        outputTokens: data.usage?.outputTokens ?? null,
      },
      latencyMs: Date.now() - started,
    };
  }
}
