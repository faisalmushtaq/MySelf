import { createHash } from "node:crypto";
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

  // Not a device and has no role: `configFor` therefore gives it only what a
  // published release froze, which is the right ceiling for a stranger.
  return { uid, device: true };
}

/**
 * Who is asking, and whether they are anybody.
 *
 * Two ways in. A tester link, which is a bounded credential carried by a URL
 * and belongs to nobody. Or a signed-in account, where a verified token is
 * still not a permission: Google sign-in is open to the world by design, so
 * anyone can arrive holding a valid token for this project, and if that were
 * enough a page on the open web would be a stranger's route to the study's
 * model budget. A signed-in caller must be an enrolled device or carry a role
 * an owner granted.
 */
export async function authenticate(header: string | undefined): Promise<Caller> {
  if (header?.startsWith("Link ")) return spendLink(header.slice(5).trim());

  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new RelayError(401, "auth", "sign in, or enrol this device, before asking for a model call");

  let decoded;
  try {
    decoded = await auth().verifyIdToken(token);
  } catch {
    throw new RelayError(401, "auth", "that credential is not valid");
  }

  const device = decoded["device"] === true;
  if (!mayCall({ device: decoded["device"], role: decoded["role"] })) {
    throw new RelayError(
      403,
      "auth",
      "you are signed in, but this account has no role on this study. An owner grants one before it can make model calls.",
    );
  }
  return { uid: decoded.uid, device };
}

/**
 * A spending ceiling, per caller and per day.
 *
 * Not a security boundary — an authenticated caller is already trusted — but a
 * blast radius. A loop in a page, a device left on a windowsill, or a study
 * that quietly runs ten times longer than anyone expected all end the same way
 * without this, and the first anyone hears of it is the invoice.
 */
async function meter(caller: Caller): Promise<void> {
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
