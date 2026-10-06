import { modelConfig, type ModelConfig } from "@myself/llm";
import { protocols } from "@myself/narrative";
import type { ReleaseManifest } from "@myself/schema";
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
    /**
     * Which of a participant's device limits refused this, when one did (D-55).
     *
     * Sent with the refusal so the module can tell "this is over for today" from
     * a model that is merely busy — the first ends MyStory for the day and the
     * survey should offer the way past at once, the second is worth a retry.
     */
    readonly limit?: DeviceLimit,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

/**
 * Roles that may spend the study's model budget.
 *
 * A verified token is not a permission. Google sign-in is open to the world by
 * design, so anyone at all can arrive holding a valid token for this project —
 * and if that were enough, a page on the open web would be a stranger's route
 * to the study's OpenAI bill. Signing in says who you are; a role is how the
 * study says it knows you.
 */
export const ROLES: ReadonlySet<string> = new Set(["owner", "researcher", "analyst"]);

export function mayCall(claims: { device?: unknown; role?: unknown }): boolean {
  return claims.device === true || (typeof claims.role === "string" && ROLES.has(claims.role));
}

export interface Caller {
  uid: string;
  /** An iPad, as opposed to a signed-in member of the research team. */
  device: boolean;
  /**
   * Whether this device just signed itself in rather than being enrolled by an
   * owner.
   *
   * A participant opens the URL and takes part; nobody registers the iPad first.
   * So most devices arrive this way, and the flag is not a suspicion — it is
   * recorded on the sitting so an analysis can tell an open-URL sitting from one
   * collected on a named device, which is the distinction a dataset needs and
   * which "everybody is anonymous" would lose.
   */
  anonymous: boolean;
}

/**
 * A participant's iPad on the credential it issued itself — the caller D-55's
 * limits govern.
 *
 * Both flags, because each alone means something else: `device` alone is also an
 * iPad an owner enrolled, which keeps its old rules, and `anonymous` is only ever
 * set on a device. The model-spending endpoints admit an anonymous device only
 * through the `Device` scheme (`authenticate`), never on an anonymous sign-in
 * token, so this is exactly "an installation anybody with the URL could have
 * made" — the one caller a per-caller limit cannot bound, because a new one is
 * free.
 */
export function isParticipantDevice(caller: Caller): boolean {
  return caller.device && caller.anonymous;
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
  /**
   * Which release this sitting is running, so the parameters used are exactly
   * the ones it froze (`configForCall`). Sent by MyStory when a survey opened
   * it; absent when the lab is used on its own.
   */
  releaseHash: z.string().min(1).max(200).optional(),
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

/** Finds a release by its hash, the way every reader does (`resolveRelease`), or null when there is none. */
export type ReleaseLookup = (hash: string) => Promise<ReleaseManifest | null>;

/**
 * The config a call runs on, given the release its sitting is running.
 *
 * A version published from the Studio is in no bundle: it exists only in the
 * release store, and its MyStory protocol may have been edited there, so its
 * model settings can differ from any shipped protocol's under the same key (a
 * key names the provider, model and temperature, not the token ceiling). So a
 * call that names its release runs exactly the config THAT release froze —
 * found the way every reader finds a release, bundled first, then the store
 * with the hash re-verified — and nothing else, whoever is calling. A release
 * the study never published, or a key it did not freeze, is refused.
 *
 * A call that names no release is decided as before (`configFor`) — EXCEPT from
 * a participant's iPad (D-55), which must name one. Its credential reaches the
 * module only through the survey, which always knows the release its sitting is
 * running, so a device call without a hash is not a survey's call. Refusing it
 * means an installation anybody could have made runs a configuration a release
 * froze for the sitting in front of it, and can never pick one of the shipped
 * configs `configFor` would otherwise look through.
 */
export async function configForCall(
  key: string,
  caller: Caller,
  releaseHash: string | undefined,
  lookup: ReleaseLookup,
): Promise<ModelConfig> {
  if (releaseHash === undefined) {
    if (isParticipantDevice(caller)) {
      throw new RelayError(
        400,
        "unknown",
        "a participant's device runs only what its survey version froze, and this call did not say which version that is",
      );
    }
    return configFor(key, caller);
  }
  let release: ReleaseManifest | null;
  try {
    release = await lookup(releaseHash);
  } catch {
    // The store could not be read. Not the caller's fault, and worth a retry;
    // never a reason to fall back on some other release's settings.
    throw new RelayError(503, "transport", "the study's published versions could not be read just now", true);
  }
  if (!release) {
    throw new RelayError(400, "unknown", "this sitting names a version of the survey that this study has not published");
  }
  const configs = release.modelConfigs ?? {};
  const raw = Object.prototype.hasOwnProperty.call(configs, key) ? configs[key] : undefined;
  if (raw === undefined) {
    throw new RelayError(400, "unknown", `'${key}' is not a model configuration the version this sitting is running declares`);
  }
  const parsed = modelConfig.safeParse(raw);
  if (!parsed.success) {
    throw new RelayError(400, "unknown", `the version this sitting is running declares '${key}' in a form this relay cannot use`);
  }
  return parsed.data;
}

/**
 * Which pages may call this.
 *
 * A list somebody wrote down, rather than the permissive default: the relay
 * spends money, and an open one is a bill with an API in front of it.
 *
 * The list is built from the project rather than typed out, because the two
 * Hosting origins Firebase gives a project are a function of its name, and the
 * failure when one is missing is silent from the relay's side: no matching
 * origin means no CORS headers, which means the browser refuses the request
 * before it is ever sent. The relay logs nothing, because nothing arrived. On
 * the page it looks exactly like the model being unreachable — which is how
 * the Hosting site could sign somebody in perfectly and then fail every call.
 *
 * Preview channels are included: they are `<project>--<channel>.web.app`, they
 * are this project's, and a staging page that cannot call the relay cannot
 * stage anything worth looking at.
 */
export function allowedOrigins(project: string, extra: readonly string[] = []): RegExp {
  const quoted = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    [
      // This project's Hosting, live and preview channels.
      `^https://${quoted}\\.web\\.app$`,
      `^https://${quoted}\\.firebaseapp\\.com$`,
      `^https://${quoted}--[a-z0-9-]+\\.web\\.app$`,
      // The public preview on GitHub Pages. Narrowed to the study's own site:
      // the previous form admitted every github.io page on the internet, and
      // while a caller still needs a role to spend anything, an allowlist that
      // admits everybody is not one.
      `^https://faisalmushtaq\\.github\\.io$`,
      // A researcher running the page locally while writing prompts.
      `^http://localhost:\\d+$`,
      ...extra.map((o) => `^${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    ].join("|"),
  );
}

/**
 * GCLOUD_PROJECT is set by the runtime; the fallback is for tests and for a
 * local run, where nothing is being spent either way.
 */
export const ALLOWED_ORIGIN = allowedOrigins(
  process.env["GCLOUD_PROJECT"] ?? "myself-research",
  (process.env["MYSELF_EXTRA_ORIGINS"] ?? "").split(",").filter(Boolean),
);

/** A spending ceiling per caller per day — a blast radius, not a boundary. */
export const CALLS_PER_CALLER_PER_DAY = Number(process.env["MYSELF_RELAY_DAILY_LIMIT"] ?? 600);

/**
 * A participant's iPad's limits (D-55, docs/09 §5).
 *
 * The research team decided any participant's iPad may use the model for
 * MyStory, with a daily cap. The per-caller ceiling above is no cap on that:
 * anybody with the survey URL can register a new installation, the first writer
 * of an installation id wins, and a new one is free — so a limit per device
 * alone bounds a stranger by nothing. Two numbers, then, counted together:
 *
 *   PER DEVICE, so one iPad left looping on a windowsill — or one stranger with
 *   one credential — cannot use up the day for every school in the study.
 *
 *   ACROSS ALL DEVICES, which is the one that actually bounds the day's spend.
 *   When a stranger reaches it, MyStory is unavailable for the rest of the day
 *   and the survey goes on without it. That is the trade: availability is given
 *   up to keep the bill bounded, and never the other way round.
 *
 * A TRANSCRIPTION COUNTS AS ONE CALL against both. It spends OpenAI money like a
 * model call, and the per-caller counter already treats the two alike — a loop
 * that records instead of prompting is the same bill.
 *
 * Neither applies to researchers, to iPads an owner enrolled, or to tester
 * links, which keep the ceiling above and their own caps.
 */
export interface DeviceLimits {
  /** Model calls one participant's device may make in a UTC day. */
  perDevice: number;
  /** Model calls all participants' devices together may make in a UTC day. */
  allDevices: number;
}

/**
 * One limit from the environment, failing CLOSED.
 *
 * Absent or blank is the default: an unset repository variable reaches the
 * function as an empty string, and that must mean "not chosen", not zero.
 * Anything else that is not a whole number of zero or more — "2,000", "-1",
 * "lots" — reads as 0, which switches devices off. `Number("lots")` is NaN, and
 * every comparison with NaN is false, so a limit read naively from a typo would
 * never refuse anything; a spending limit that a typo removes is worse than one
 * that a typo trips, because the second is noticed the same morning.
 */
export function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * The defaults, and how they were sized.
 *
 * One conversation of the full protocols (np.phone_wellbeing,
 * np.micro_narrative_full) makes one interviewer call to open and one per answer
 * until the interview is done or reaches its turn limit (14 and 12) — usually
 * five to eight — then one extraction, three retellings at once, and one per
 * revision the participant asks for. Typed, that is usually 10–13 calls, and
 * about 20 at the turn limit with two revisions. Speaking adds a transcription
 * per recorded answer, up to about 14 more, and a retried call counts again. So
 * the heaviest conversation is about 40 calls and a typical one 12–15.
 *
 * 120 is three of the heaviest, or eight to ten typical ones, per device per day.
 * 2,000 is about 150 typical conversations a day across the study — more than a
 * day of fielding at this study's size, and a few pounds at 1–3p a journey.
 */
export const DEVICE_LIMITS: DeviceLimits = {
  perDevice: readLimit(process.env["MYSELF_RELAY_DEVICE_DAILY_LIMIT"], 120),
  allDevices: readLimit(process.env["MYSELF_RELAY_DEVICES_DAILY_LIMIT"], 2_000),
};

/** Which limit refused a device's call: its own, the study's, or devices switched off. */
export type DeviceLimit = "device" | "study" | "off";

/**
 * Whether one more call fits, given what was already let through today.
 *
 * Null when it does. Either limit at 0 is the off switch — no code change, one
 * setting — and is reported as such rather than as a limit reached, because
 * "try again tomorrow" would be untrue. The device's own limit is checked before
 * the study's, so a device that has used its own day is told about its own day
 * and never counted against everybody else's.
 *
 * The counts are of calls LET THROUGH, not of attempts: a device refused for its
 * own limit keeps asking, and if those attempts counted towards the study's
 * ceiling one stuck iPad could close MyStory for every school.
 */
export function deviceLimitReached(limits: DeviceLimits, usedByDevice: number, usedByAll: number): DeviceLimit | null {
  if (limits.perDevice <= 0 || limits.allDevices <= 0) return "off";
  if (usedByDevice >= limits.perDevice) return "device";
  if (usedByAll >= limits.allDevices) return "study";
  return null;
}

/**
 * What a participant reads when a limit refuses the call.
 *
 * The module shows it in the conversation, so it is written for whoever is
 * holding the iPad — the same rules as a tester link's refusals: no "relay", no
 * "credential", and a way forward. That way forward is always the same and
 * always true: the survey can be finished without MyStory, and nothing already
 * answered is lost.
 */
export function deviceLimitMessage(limit: DeviceLimit): string {
  const forward = "You can carry on without it, and nothing you have already answered is lost.";
  switch (limit) {
    case "device":
      return `This device has used MyStory as much as it can for today. ${forward} It will be available again tomorrow.`;
    case "study":
      return `MyStory has had as many conversations as it can for today. ${forward} It will be available again tomorrow.`;
    case "off":
      return `MyStory is switched off at the moment. ${forward}`;
  }
}

/**
 * The refusal itself: 429, a rate limit, and NOT retryable now.
 *
 * `retryable: false` is what keeps the gateway from asking again at once — a
 * retry a second later meets the same count — while the message and the
 * `Retry-After` the endpoints add say when it is worth asking: tomorrow.
 */
export function deviceLimitError(limit: DeviceLimit): RelayError {
  return new RelayError(429, "rate_limit", deviceLimitMessage(limit), false, limit);
}

/**
 * Seconds until the counts start again: the next UTC midnight.
 *
 * At least one, because `Retry-After: 0` reads as "now", which is exactly what
 * it is not.
 */
export function secondsUntilTomorrow(now: Date): number {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((tomorrow - now.getTime()) / 1000));
}

/**
 * A tester link: access carried by the URL, with no account behind it.
 *
 * Somebody trying the module out is not a member of the study, and making them
 * create an account to answer five questions about their phone loses most of
 * them before the first screen. So the link itself is the credential.
 *
 * That is a real key in a URL, and URLs get forwarded, pasted into chats and
 * kept in browser history — so it is bounded on three axes rather than
 * trusted. It expires, it has a hard cap on how many model calls it can ever
 * buy, and it can be switched off at once. A leaked link costs the study a
 * known, small, already-budgeted amount and nothing else: it cannot read
 * anybody's answers, cannot administer anything, and cannot choose a model.
 *
 * Only the SHA-256 of the key is stored, the same discipline as device
 * tokens — a dump of the database does not hand anybody a working link.
 */
export interface LinkRecord {
  revokedAt: unknown | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  callCap: number;
  callsUsed: number;
}

/** Why this link may not be used, or null if it may. Said, not just refused. */
export function linkRefusal(link: LinkRecord | null, now: number): string | null {
  /**
   * Written to be read by whoever is holding the link, which on a pilot is a
   * person who was sent it and has done nothing wrong. Each one says what
   * happened and what to do about it, and none of them says "relay",
   * "credential" or "caller" — a refusal a participant cannot act on is just
   * a closed door with jargon on it.
   */
  if (!link) return "This link is not one this study gave out. Do check you have the whole of it.";
  if (link.revokedAt) return "This link has been switched off. Ask whoever sent it to you for a new one.";
  if (now > link.expiresAt) return "This link has run out. Ask whoever sent it to you for a new one.";
  if (link.callsUsed >= link.callCap) {
    return "This link has been used as many times as it was set up for. Ask whoever sent it to you for a new one.";
  }
  return null;
}

/** How long a tester link lives, and how much it may ever spend. */
export const LINK_DAYS = Number(process.env["MYSELF_LINK_DAYS"] ?? 14);
export const LINK_CALL_CAP = Number(process.env["MYSELF_LINK_CALL_CAP"] ?? 400);
