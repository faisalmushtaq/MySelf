import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { Gateway, OpenAiAdapter, type ModelCall } from "@myself/llm";
import { paths } from "@myself/firebase";
import { STUDY, auth, research } from "./apps.js";
import {
  ALLOWED_ORIGIN,
  CALLS_PER_CALLER_PER_DAY,
  linkRefusal,
  type LinkRecord,
  RelayError,
  configFor,
  mayCall,
  relayRequest,
  type Caller,
} from "./relay-policy.js";

/**
 * The model relay.
 *
 * An iPad in a school and a page on the open web both need model calls made,
 * and neither may hold the key to make them. So they send the prompt here and
 * this makes the call: the key lives in Secret Manager, is read into this
 * process, and never leaves it.
 *
 * That is not the only thing being held server-side. THE CALLER SENDS A MODEL
 * CONFIG KEY, NOT MODEL PARAMETERS. The provider, the model, the temperature
 * and the token ceiling are read from the frozen release manifest, which is
 * bundled into this function. A tampered page cannot raise the temperature,
 * point the study at a different model, or ask for ten thousand tokens — and a
 * study's published parameters remain the parameters it actually ran on, which
 * is the whole reason for freezing them.
 *
 * Everything here is metered. A relay that will make any number of calls to
 * anyone who asks is a bill with an API in front of it.
 */

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

/**
 * Stamped in by the packaging step. Guarded with `typeof` rather than assumed,
 * because the tests import this module without going through esbuild, and a
 * diagnostic that crashes the thing it is diagnosing is worse than none.
 */
declare const __RELAY_BUILD__: { built: string; commit: string; dirty: boolean } | undefined;
const BUILD =
  typeof __RELAY_BUILD__ === "object" && __RELAY_BUILD__
    ? __RELAY_BUILD__
    : { built: "unpackaged", commit: "unknown", dirty: false };

/**
 * The origin allowlist and the preflight, shared by every endpoint a page
 * calls.
 *
 * Set explicitly rather than with the built-in `cors` option, so the pages
 * that may call these are a list somebody wrote down. Returns true when the
 * request is already answered — a preflight — and the caller should stop.
 *
 * Shared rather than copied, because a second endpoint with its own slightly
 * different copy is how one of them ends up permissive.
 */
export function cors(
  req: { method?: string; headers: { origin?: string | undefined } },
  res: {
    set(key: string, value: string): unknown;
    status(code: number): { end(): unknown };
  },
): boolean {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "authorization, content-type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

/**
 * A tester link, presented as `Authorization: Link <key>`.
 *
 * Checked and spent in one transaction. Two people opening the same link at
 * the same moment must not both be told there is one call left and both take
 * it; the cap is the only thing standing between a forwarded URL and an
 * unbounded bill, so it has to hold under concurrency rather than usually.
 */
async function spendLink(key: string): Promise<Caller> {
  const hash = createHash("sha256").update(key).digest("hex");
  const ref = research().doc(`${paths.audit(STUDY)}_testerLinks/${hash}`);

  const uid = await research().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const link = snap.exists ? (snap.data() as LinkRecord) : null;
    const refusal = linkRefusal(link, Date.now());
    if (refusal) throw new RelayError(403, "auth", refusal);
    tx.update(ref, { callsUsed: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() });
    return `link_${hash.slice(0, 12)}`;
  });

  /**
   * NOT a device.
   *
   * The first version said `device: true`, reasoning that a stranger should be
   * held to what a release froze. That reasoning is right for an iPad and
   * exactly backwards here: a tester link exists to pilot a protocol BEFORE it
   * is published, and a protocol being piloted is `draft` precisely so it
   * cannot be released. With no release yet declaring any model config, every
   * call on a tester link was refused before it reached the provider, and the
   * page reported the interviewer as unreachable.
   *
   * The device rule protects reproducibility in a fielded study: what a child
   * in a school runs must be what was published. A pilot is not that, and its
   * runs are stored as `provenance: "test"` and kept out of the dataset for
   * the same reason.
   *
   * Nothing is loosened by this. The caller still sends only a config KEY, and
   * it is still resolved against the protocols bundled into this function — so
   * a link can run what a shipped protocol declares and cannot invent a model,
   * a temperature or a token ceiling.
   */
  return { uid, device: false, anonymous: false };
}

/**
 * A device presenting the credential it issued itself.
 *
 * `Authorization: Device <installId>.<secret>`
 *
 * FIRST WRITER WINS, PERMANENTLY. The first upload from an installation id
 * registers the hash of its secret; every upload after that must present a secret
 * hashing to the same thing. So a stranger can register a NEW installation — the
 * write endpoint is open by design, because anyone with the URL takes part — and
 * can never take over an existing one. That is exactly what the no-overwrite rule
 * needs from an identity: "the same device" has to mean something a second device
 * cannot claim.
 *
 * WHY NOT REQUIRE ENROLMENT INSTEAD. Because a device that has to be registered
 * before it can collect is a device that cannot be handed to a participant in a
 * hall with no signal, and that is the normal case rather than the exception. The
 * trade is stated in the runbook.
 *
 * THE COMPARISON IS TIMING-SAFE. A secret checked with `===` leaks its prefix to
 * anyone who can time the response, and while guessing 32 random bytes a byte at a
 * time is not the likely attack on a study, a constant-time compare costs one line.
 */
export async function registerDevice(
  db: FirebaseFirestore.Firestore,
  study: string,
  raw: string,
): Promise<Caller> {
  const at = raw.indexOf(".");
  if (at <= 0 || at === raw.length - 1) {
    throw new RelayError(401, "auth", "that device credential is not the right shape");
  }
  const installId = raw.slice(0, at);
  const secret = raw.slice(at + 1);
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(installId) || secret.length < 32) {
    throw new RelayError(401, "auth", "that device credential is not the right shape");
  }

  const digest = createHash("sha256").update(secret).digest("hex");
  const ref = db.doc(paths.device(study, installId));

  const known = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        deviceId: installId,
        study,
        secretHash: digest,
        selfRegistered: true,
        enrolledAt: FieldValue.serverTimestamp(),
        revokedAt: null,
      });
      return { secretHash: digest, revokedAt: null as unknown };
    }
    const data = snap.data() as { secretHash?: string; revokedAt?: unknown };
    return { secretHash: data.secretHash ?? "", revokedAt: data.revokedAt ?? null };
  });

  if (known.revokedAt) {
    throw new RelayError(403, "auth", "this device has been withdrawn from the study");
  }
  if (!timingSafeMatch(known.secretHash, digest)) {
    /**
     * Another device is already this installation.
     *
     * Almost always an id collision or a restored backup rather than anything
     * deliberate, but the response is the same either way: the sittings stay on
     * the device, and the message says what to do rather than what happened.
     */
    throw new RelayError(
      403,
      "auth",
      "another device is already registered under this installation id, so this one cannot file sittings under it. The sittings are safe on the device — hand them over as a file.",
    );
  }

  return { uid: installId, device: true, anonymous: true };
}

function timingSafeMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AuthOptions {
  /**
   * Whether a device that signed itself in anonymously may pass.
   *
   * TRUE ONLY FOR FILING SITTINGS, and the asymmetry is the whole point. A
   * participant opens the URL on any iPad and takes part; requiring an owner to
   * register each device first is a barrier to taking part, and taking part is
   * the thing this exists for. Filing a sitting costs a Firestore write.
   *
   * THE RELAY DOES NOT PASS THIS. A model call spends the study's money, and an
   * endpoint that made one for anyone holding an anonymous token would be a page
   * on the open web wired to an OpenAI bill. So the relay and the transcriber
   * still require an enrolled device or a granted role, and a caller who may
   * file a sitting is not thereby a caller who may spend anything.
   */
  allowAnonymous?: boolean;
}

/**
 * Who is asking, and whether they are anybody.
 *
 * Three ways in. A tester link, which is a bounded credential carried by a URL
 * and belongs to nobody. A signed-in account, where a verified token is still
 * not a permission: Google sign-in is open to the world by design, so anyone can
 * arrive holding a valid token for this project, and a role is how the study says
 * it knows you. Or — where the caller is allowed to be anonymous — an iPad that
 * signed itself in, which is how a participant with the URL takes part.
 */
export async function authenticate(header: string | undefined, options: AuthOptions = {}): Promise<Caller> {
  if (header?.startsWith("Link ")) return spendLink(header.slice(5).trim());

  /**
   * A self-registered device, and only where anonymous callers are permitted.
   *
   * The relay does not permit them, so this scheme cannot buy a model call however
   * well-formed the credential is: filing a sitting costs a Firestore write, and a
   * model call spends the study's money.
   */
  if (header?.startsWith("Device ")) {
    if (!options.allowAnonymous) {
      throw new RelayError(403, "auth", "a device credential cannot be used for this");
    }
    return registerDevice(research(), STUDY, header.slice(7).trim());
  }

  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new RelayError(401, "auth", "this request carried no credential");

  let decoded;
  try {
    decoded = await auth().verifyIdToken(token);
  } catch {
    throw new RelayError(401, "auth", "that credential is not valid");
  }

  if (mayCall({ device: decoded["device"], role: decoded["role"] })) {
    return { uid: decoded.uid, device: decoded["device"] === true, anonymous: false };
  }

  /**
   * An iPad that signed itself in.
   *
   * Checked against the sign-in provider rather than the absence of a role,
   * because "no role" is also what a stranger's ordinary Google account looks
   * like, and those two should not be treated alike: one is a participant's
   * device, the other is a person who has wandered in. Only the first is a
   * device, and only where the caller was allowed to be anonymous at all.
   */
  const provider = (decoded.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider;
  if (options.allowAnonymous && provider === "anonymous") {
    return { uid: decoded.uid, device: true, anonymous: true };
  }

  throw new RelayError(
    403,
    "auth",
    "you are signed in, but this account has no role on this study. An owner grants one before it can make model calls.",
  );
}

/**
 * A spending ceiling, per caller and per day.
 *
 * Not a security boundary — an authenticated caller is already trusted — but a
 * blast radius. A loop in a page, a device left on a windowsill, or a study
 * that quietly runs ten times longer than anyone expected all end the same way
 * without this, and the first anyone hears of it is the invoice.
 */
export async function meter(caller: Caller): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = research().doc(`${paths.audit(STUDY)}_relay/${day}_${caller.uid}`);
  const used = await research().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = ((snap.data()?.["calls"] as number | undefined) ?? 0) + 1;
    tx.set(ref, { calls: count, uid: caller.uid, day, at: FieldValue.serverTimestamp() }, { merge: true });
    return count;
  });
  if (used > CALLS_PER_CALLER_PER_DAY) {
    throw new RelayError(429, "rate_limit", `${used - 1} calls today is the limit for one caller`);
  }
}

/**
 * The provenance row, in Firestore.
 *
 * Written here rather than on the device because this is where the truth is:
 * what was actually sent, which snapshot answered, how long it took, what it
 * cost, and whether it failed. A device's account of a call it did not make is
 * a guess.
 */
async function recordCall(caller: Caller, call: ModelCall): Promise<void> {
  try {
    await research()
      .collection(`${paths.audit(STUDY)}_modelCalls`)
      .add({ ...call, uid: caller.uid, device: caller.device, at: FieldValue.serverTimestamp() });
  } catch (error) {
    // A provenance row that cannot be written must not cost a participant the
    // answer they are waiting for. It is logged and the call proceeds.
    logger.error("relay: could not write the provenance row", error);
  }
}

export const llmRelay = onRequest(
  { secrets: [OPENAI_API_KEY], cors: false, maxInstances: 20, timeoutSeconds: 120 },
  async (req, res) => {
    const origin = req.headers.origin;
    if (cors(req, res)) return;
    /**
     * What is deployed here, and would this caller's page be let in.
     *
     * The two questions that have actually cost time. A rejected origin gets
     * no CORS headers, so the browser refuses the request before sending it:
     * the relay logs nothing, and the page reports the model as unreachable.
     * From the outside, "the allowlist is wrong", "the old build is deployed"
     * and "the model is down" look identical.
     *
     * This makes them one curl apart. Nothing here is sensitive — a commit
     * hash and whether an origin is on a list — and it deliberately says
     * nothing about the key, the configs, or any caller but the one asking.
     */
    if (req.method === "GET") {
      const asked = typeof origin === "string" ? origin : null;
      res.status(200).json({
        service: "llmRelay",
        source: BUILD,
        origin: asked,
        originAllowed: asked === null ? null : ALLOWED_ORIGIN.test(asked),
      });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: { kind: "unknown", message: "post a prompt here" } });
      return;
    }

    const started = Date.now();
    let caller: Caller | null = null;
    try {
      caller = await authenticate(req.headers.authorization);
      await meter(caller);

      const parsed = relayRequest.safeParse(req.body);
      if (!parsed.success) {
        throw new RelayError(400, "unknown", `that is not a request this relay understands: ${parsed.error.message}`);
      }
      const { prompt, modelConfigKey, protocolKey, schema } = parsed.data;

      const config = configFor(modelConfigKey, caller);
      if (config.provider !== "openai") {
        throw new RelayError(400, "unknown", `this relay serves OpenAI; '${modelConfigKey}' asks for ${config.provider}`);
      }

      const calls: ModelCall[] = [];
      const gateway = new Gateway({
        adapters: [new OpenAiAdapter({ apiKey: OPENAI_API_KEY.value() })],
        onCall: (call) => {
          const at = calls.findIndex((c) => c.callId === call.callId);
          if (at >= 0) calls[at] = call;
          else calls.push(call);
        },
      });

      const result = await gateway.call<Record<string, unknown>>({
        sessionId: `relay_${caller.uid}`,
        protocolKey,
        stage: "relay",
        prompt: { promptKey: protocolKey, promptVersion: "relay", ...prompt, variables: {} },
        config,
        ...(schema ? { jsonSchema: schema } : {}),
      });

      for (const call of calls) await recordCall(caller, call);

      res.status(200).json({
        text: result.raw,
        modelServed: calls[calls.length - 1]?.modelServed ?? null,
        usage: calls[calls.length - 1]?.usage ?? null,
      });
    } catch (error) {
      if (error instanceof RelayError) {
        res.status(error.status).json({ error: { kind: error.kind, message: error.message, retryable: error.retryable } });
        return;
      }
      // A provider failure the gateway gave up on. The message is passed
      // through so the device can apply the protocol's declared fallback for
      // the right reason — a safety refusal and a flat network are not the
      // same event and must not look like one.
      const kind = (error as { kind?: string }).kind ?? "unknown";
      const retryable = (error as { retryable?: boolean }).retryable ?? false;
      logger.error("relay: the call failed", { kind, protocol: (req.body as { protocolKey?: string })?.protocolKey });
      res.status(502).json({ error: { kind, message: (error as Error).message, retryable } });
    } finally {
      logger.info("relay", { uid: caller?.uid ?? null, ms: Date.now() - started });
    }
  },
);
