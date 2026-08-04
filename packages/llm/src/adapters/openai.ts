import { ModelError, type ModelAdapter, type ModelConfig, type ResolvedPrompt } from "../types.js";

/**
 * OpenAI, over plain fetch.
 *
 * No SDK: the chat-completions contract is stable, the surface used here is
 * four fields wide, and a dependency that ships breaking changes on its own
 * schedule is not something a study that must still run in 2029 needs.
 *
 * The key lives wherever this adapter is constructed — a server process or a
 * Cloud Function — and never in a browser. That is an architectural rule
 * (docs/05 §6), not a preference: a key in a page is a key in a school.
 */

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Sent as the OpenAI-Organization header where a study needs it. */
  organisation?: string;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAiAdapter implements ModelAdapter {
  readonly provider = "openai";

  constructor(private readonly options: OpenAiOptions) {
    if (!options.apiKey) throw new Error("OpenAI adapter needs an API key");
  }

  async generate(
    prompt: ResolvedPrompt,
    config: ModelConfig,
    schema?: { name: string; schema: Record<string, unknown> },
    signal?: AbortSignal,
  ) {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      messages: [{ role: "system", content: prompt.system }, ...prompt.messages],
    };
    if (schema) {
      // Structured outputs: the model is constrained to the schema the
      // protocol froze, rather than asked nicely and parsed hopefully.
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: schema.name, schema: schema.schema, strict: true },
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.options.organisation ? { "openai-organization": this.options.organisation } : {}),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // An aborted request is the protocol's timeout, not a network fault, and
      // the two lead to different fallbacks.
      if (signal?.aborted) throw new ModelError("timeout", `no response within ${config.timeoutSeconds}s`);
      throw new ModelError("transport", String(error));
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as ChatResponse;
      const message = detail.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) throw new ModelError("auth", message, false);
      if (response.status === 429) throw new ModelError("rate_limit", message);
      if (response.status >= 500) throw new ModelError("transport", message);
      throw new ModelError("unknown", message, false);
    }

    const data = (await response.json()) as ChatResponse;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "content_filter") {
      // Refused by the provider's own safety layer. Recorded as such, not
      // retried, and handed to the protocol's declared fallback.
      throw new ModelError("safety_block", "the provider refused to answer this prompt", false);
    }
    const text = choice?.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
      throw new ModelError("malformed_output", "the model returned nothing", false);
    }

    return {
      text,
      modelServed: data.model ?? null,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
      },
      latencyMs: Date.now() - started,
    };
  }
}
