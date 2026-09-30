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
const admitted = new Set<string>();

/**
 * Add the model configs these releases froze to the ones a device may run.
 *
 * The bundled releases are admitted as this module loads. A version published
 * from the dashboard (D-54) is admitted when the relay has read it from the
 * database (`knownReleases`), which has already checked it against its hash:
 * a MyStory run under it then gets exactly the parameters it published.
 */
export function admitReleasedConfigs(releases: Iterable<ReleaseManifest>): void {
  for (const release of releases) {
    const hash = release.hash ?? "";
    if (admitted.has(hash)) continue;
    admitted.add(hash);
    for (const [key, raw] of Object.entries(release.modelConfigs ?? {})) {
      const parsed = modelConfig.safeParse(raw);
      if (parsed.success) releasedConfigs.set(key, parsed.data);
    }
  }
}
admitReleasedConfigs(releasesByHash.values());

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

/**
 * `configFor`, after admitting the versions published from the dashboard.
 *
 * `load` returns every known release, read within `maxAgeMs` (the relay passes
 * `knownReleases`; this file stays free of Firebase). A key no release has
 * frozen sends it back once, sooner, for a version published in the last
 * minute, before a device is refused.
 */
export async function configForPublished(
  key: string,
  caller: Caller,
  load: (maxAgeMs?: number) => Promise<Iterable<ReleaseManifest>>,
  missRetryMs = 5_000,
): Promise<ModelConfig> {
  admitReleasedConfigs(await load());
  if (!releasedConfigs.has(key)) admitReleasedConfigs(await load(missRetryMs));
  return configFor(key, caller);
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
