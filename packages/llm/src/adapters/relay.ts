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
  /** Bearer token identifying this enrolled device or signed-in person. */
  token?: string | undefined;
  /**
   * A tester link key, used instead of a token.
   *
   * Sent as `Authorization: Link <key>` so the relay can tell the two apart
   * without guessing at the shape of the string. Somebody testing the module
   * has no account and should not need one; the link is the credential, and
   * the relay bounds what it can cost.
   */
  linkKey?: string | undefined;
  /**
   * A participant's iPad's own credential, `<installId>.<secret>` (D-55).
   *
   * Sent as `Authorization: Device <credential>`, the scheme `saveSitting`
   * already reads. MyStory only holds one when the survey that embedded it
   * handed it over, and then the page is acting as that iPad — under that
   * iPad's daily limits, and running only what its release froze.
   */
  deviceCredential?: string | undefined;
  /**
   * Told when the relay refuses because a participant's device limit has been
   * reached, or devices are switched off (D-55) — with the relay's message,
   * which is written for the participant.
   *
   * The call still fails, as any refused call does, and the protocol's fallback
   * still applies. This is so the page can say the plain thing — MyStory is done
   * for today — and let the survey offer the way past at once, instead of
   * reporting a model that cannot be reached and leaving the participant to wait
   * for something that will not change until tomorrow.
   */
  onLimit?: ((message: string) => void) | undefined;
  /**
   * The provider this relay stands in for. Defaults to OpenAI.
   *
   * A relay is a transport, not a provider: the study's config says `openai`
   * because that is what will answer, and this is only how the prompt gets
   * there. The gateway routes by provider name, so a relay that called itself
   * "relay" was never selected for an OpenAI config — the lookup found
   * nothing, threw before a call was made, and the failure surfaced as a
   * transport error with no provenance row to explain it.
   */
  serves?: "openai" | "anthropic" | undefined;
  /**
   * The release the sitting is running, when a survey opened the module.
   *
   * Sent with every call so the relay runs the model config THAT release froze
   * — a version published from the Studio is in no bundle, and its protocol's
   * settings may have been edited there. A device cannot choose parameters by
   * naming a release: the relay finds it the way every reader does and refuses
   * one the study never published.
   */
  releaseHash?: string | undefined;
}

interface RelayResponse {
  text?: string;
  modelServed?: string | null;
  usage?: { inputTokens?: number | null; outputTokens?: number | null };
  /** `limit` names which of a device's daily limits refused the call, when one did. */
  error?: { kind?: string; message?: string; retryable?: boolean; limit?: string };
}

/**
 * The `Authorization` header for whoever this page is acting as.
 *
 * A link key wins when there is more than one: a page opened from a tester link
 * is acting as that link, not as whoever happens to be signed in to Google in
 * the same browser. A device credential comes next, for the same reason — the
 * page is inside a participant's survey, acting as that iPad. A signed-in
 * person's token is the last resort, and nothing at all is sent rather than an
 * empty credential.
 */
function authorization(options: RelayOptions): Record<string, string> {
  if (options.linkKey) return { authorization: `Link ${options.linkKey}` };
  if (options.deviceCredential) return { authorization: `Device ${options.deviceCredential}` };
  if (options.token) return { authorization: `Bearer ${options.token}` };
  return {};
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
  readonly provider: string;

  constructor(private readonly options: RelayOptions) {
    if (!options.url) throw new Error("the relay adapter needs the endpoint it should post to");
    this.provider = options.serves ?? "openai";
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
        headers: { "content-type": "application/json", ...authorization(this.options) },
        body: JSON.stringify({
          prompt: { system: prompt.system, messages: prompt.messages },
          // The key, not the parameters: the function reads the settings from
          // the frozen release, so a tampered page cannot raise the
          // temperature or point the study at a different model.
          modelConfigKey: config.key,
          protocolKey: prompt.promptKey,
          ...(schema ? { schema } : {}),
          ...(this.options.releaseHash ? { releaseHash: this.options.releaseHash } : {}),
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
      if (typeof detail.error?.limit === "string") {
        // Over for today, or switched off: never worth asking again at once,
        // whatever the body said, because the next attempt meets the same count.
        this.options.onLimit?.(message);
        throw new ModelError("rate_limit", message, false);
      }
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
