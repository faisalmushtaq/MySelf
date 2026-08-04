import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { Gateway, OpenAiAdapter, type ModelCall } from "@myself/llm";
import { paths } from "@myself/firebase";
import { STUDY, auth, research } from "./apps.js";
import {
  ALLOWED_ORIGIN,
  CALLS_PER_CALLER_PER_DAY,
  RelayError,
  configFor,
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

async function authenticate(header: string | undefined): Promise<Caller> {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new RelayError(401, "auth", "sign in, or enrol this device, before asking for a model call");
  try {
    const decoded = await auth().verifyIdToken(token);
    return { uid: decoded.uid, device: decoded["device"] === true };
  } catch {
    throw new RelayError(401, "auth", "that credential is not valid");
  }
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
    // Set explicitly rather than with the built-in cors option, so the pages
    // that may call this are a list somebody wrote down.
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGIN.test(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "authorization, content-type");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
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
