import { modelConfig, type ModelConfig } from "@myself/llm";
import { protocols } from "@myself/narrative";
import { z } from "zod";
import { releasesByHash } from "./releases.js";

/**
 * What the relay will accept, and what it will run it on.
 *
 * Separate from the function itself because this is the part with the rules in
 * it — and because rules that can only be exercised by deploying are rules
 * nobody exercises. Nothing here touches Firebase, a network or a key.
 */

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface Caller {
  uid: string;
  /** An enrolled iPad, as opposed to a signed-in member of the research team. */
  device: boolean;
}

/**
 * What a caller may send.
 *
 * Deliberately narrow. There is no field here for a model name, a temperature
 * or a token ceiling, because there is no version of this study in which a
 * device should be choosing those — and a shape with nowhere to put them is a
 * stronger guarantee than a check that ignores them.
 */
export const relayRequest = z.object({
  prompt: z.object({
    system: z.string().min(1).max(20_000),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
      .max(60),
  }),
  modelConfigKey: z.string().min(1),
  protocolKey: z.string().min(1),
  schema: z.object({ name: z.string().min(1), schema: z.record(z.unknown()) }).optional(),
  /** Which release this session is running, so the right parameters are used. */
  releaseHash: z.string().optional(),
});

export type RelayRequest = z.infer<typeof relayRequest>;

/**
 * Every model config any published release froze.
 *
 * A key that is not here was never published, so a call naming it is a call
 * nobody approved.
 */
export const releasedConfigs = new Map<string, ModelConfig>();
for (const release of releasesByHash.values()) {
  for (const [key, raw] of Object.entries(release.modelConfigs ?? {})) {
    const parsed = modelConfig.safeParse(raw);
    if (parsed.success) releasedConfigs.set(key, parsed.data);
  }
}

/**
 * Configs a shipped protocol declares but no release has frozen yet.
 *
 * Available to a signed-in member of the research team and to nobody else. A
 * researcher writing prompts needs to run a protocol before it is published —
 * that is what writing prompts is — and refusing until it had been through a
 * release would mean publishing protocols nobody had run.
 *
 * A DEVICE NEVER GETS THIS. An iPad is running a fielded study, and a fielded
 * study runs what was published: if the parameters were not frozen the run is
 * not reproducible, and it should not be happening in front of a child.
 */
export const draftConfigs = new Map<string, ModelConfig>();
for (const protocol of protocols) {
  for (const config of protocol.models) {
    if (!releasedConfigs.has(config.key)) draftConfigs.set(config.key, config as ModelConfig);
  }
}

export function configFor(key: string, caller: Caller): ModelConfig {
  const released = releasedConfigs.get(key);
  if (released) return released;
  if (caller.device) {
    throw new RelayError(
      400,
      "unknown",
      `'${key}' is not a model configuration any published release declares, and a device may only run published configurations`,
    );
  }
  const draft = draftConfigs.get(key);
  if (draft) return draft;
  throw new RelayError(400, "unknown", `no shipped protocol or published release declares '${key}'`);
}

/**
 * Which pages may call this.
 *
 * A list somebody wrote down, rather than the permissive default: the relay
 * spends money, and an open one is a bill with an API in front of it.
 */
export const ALLOWED_ORIGIN = /^https:\/\/[a-z0-9-]+\.github\.io$|^http:\/\/localhost:\d+$/;

/** A spending ceiling per caller per day — a blast radius, not a boundary. */
export const CALLS_PER_CALLER_PER_DAY = Number(process.env["MYSELF_RELAY_DAILY_LIMIT"] ?? 600);
