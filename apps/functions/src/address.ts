import { applicationDefault } from "firebase-admin/app";
import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { paths } from "@myself/firebase";
import { research } from "./apps.js";
import {
  ADDRESS_LIMITS,
  addressFrom,
  addressRequest,
  outcomeOf,
  searchText,
  suggestionsFrom,
  suggestParams,
  withinLimits,
  type FoundAddress,
  type Kind,
  type Suggestion,
} from "./address-policy.js";
import { authenticate, cors, refuse } from "./relay.js";
import { isParticipantDevice, RelayError } from "./relay-policy.js";
import { studyForRequest } from "./studies.js";

/**
 * The address finder (D-81).
 *
 * The address screen opens on "Start typing your address" (D-80). When the
 * iPad is online it asks here as the child types, and this asks Ideal
 * Postcodes, so the child can pick their whole address, postcode and all, from
 * West Yorkshire's addresses only. The key stays in Secret Manager
 * (`ideal-postcodes-key`, infra/firebase/set-address-key.sh), read when first
 * needed; Ideal Postcodes sees what was typed and nothing else: not the child,
 * the iPad or the school.
 *
 * Every failure is quiet. No key yet, no credit, a limit reached, no reply:
 * the answer is "unavailable", and the iPad carries on with the street search
 * it has on board, which is what it does offline anyway.
 */

type Answer =
  | { status: "suggestions"; suggestions: Suggestion[] }
  | { status: "picked"; address: FoundAddress }
  | { status: "not-found" }
  | { status: "unavailable" };

const SECRET = process.env["MYSELF_ADDRESS_SECRET"] ?? "ideal-postcodes-key";
const KEY_FOR = 10 * 60_000;
let key: { value: string | null; at: number } | null = null;

/**
 * The key, from Secret Manager, kept for ten minutes. Read at run time rather
 * than declared with `defineSecret`, so a deploy before the key is stored still
 * succeeds and the finder simply answers "unavailable" until it is.
 */
async function readKey(): Promise<string | null> {
  if (key && Date.now() - key.at < KEY_FOR) return key.value;
  const project = process.env["GCLOUD_PROJECT"] ?? process.env["GOOGLE_CLOUD_PROJECT"];
  let value: string | null = null;
  try {
    const { access_token } = await applicationDefault().getAccessToken();
    const res = await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${SECRET}/versions/latest:access`, {
      headers: { authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = ((await res.json()) as { payload?: { data?: string } }).payload?.data;
      value = data ? Buffer.from(data, "base64").toString("utf8").trim() || null : null;
    } else if (res.status !== 404) {
      logger.warn("address finder: could not read the key", { status: res.status });
    }
  } catch (error) {
    logger.warn("address finder: could not read the key", { error: String(error).slice(0, 200) });
  }
  key = { value, at: Date.now() };
  return value;
}

/** Asks Ideal Postcodes; null if it did not answer in time. */
async function ask(apiKey: string, path: string, params: Record<string, string> = {}): Promise<{ status: number; body: unknown } | null> {
  const base = (process.env["MYSELF_ADDRESS_API"] ?? "https://api.ideal-postcodes.co.uk").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}${path}?${new URLSearchParams({ api_key: apiKey, ...params })}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    logger.warn("address finder: Ideal Postcodes did not answer", { error: String(error).replaceAll(apiKey, "[key]").slice(0, 200) });
    return null;
  }
}

/** One more suggestion or lookup for this caller and the study today, if both are within their limits. */
async function allowed(study: string, uid: string, kind: Kind): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const mine = research().doc(`${paths.audit(study)}_address/${day}_${uid}`);
  const all = research().doc(`${paths.audit(study)}_address/${day}_study`);
  const field = kind === "lookup" ? "lookups" : "suggestions";
  return research().runTransaction(async (tx) => {
    const [m, s] = await tx.getAll(mine, all);
    const used = Number(m?.data()?.[field] ?? 0);
    const usedByStudy = Number(s?.data()?.[field] ?? 0);
    const verdict = withinLimits(kind, used, usedByStudy, ADDRESS_LIMITS);
    if (verdict !== "yes") {
      tx.set(all, { refused: FieldValue.increment(1), day }, { merge: true });
      return false;
    }
    tx.set(mine, { [field]: used + 1, day, at: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(all, { [field]: usedByStudy + 1, day, at: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

async function suggest(apiKey: string, query: string): Promise<Answer> {
  for (const narrow of ["districts", "areas"] as const) {
    const answer = await ask(apiKey, "/v1/autocomplete/addresses", suggestParams(query, narrow));
    if (!answer) return { status: "unavailable" };
    const outcome = outcomeOf(answer.status, answer.body);
    if (outcome.kind === "refused-filter" && narrow === "districts") continue;
    if (outcome.kind !== "found") {
      if (outcome.kind === "unavailable") logger.error("address finder: Ideal Postcodes refused", { status: answer.status, reason: outcome.reason });
      return { status: "unavailable" };
    }
    const result = (answer.body as { result?: { hits?: unknown } }).result;
    return { status: "suggestions", suggestions: suggestionsFrom(result?.hits) };
  }
  return { status: "unavailable" };
}

async function pick(apiKey: string, id: string): Promise<Answer> {
  const answer = await ask(apiKey, `/v1/autocomplete/addresses/${encodeURIComponent(id)}/gbr`);
  if (!answer) return { status: "unavailable" };
  const outcome = outcomeOf(answer.status, answer.body);
  if (outcome.kind === "not-found") return { status: "not-found" };
  if (outcome.kind !== "found") {
    if (outcome.kind === "unavailable") logger.error("address finder: Ideal Postcodes refused", { status: answer.status, reason: outcome.reason });
    return { status: "unavailable" };
  }
  const address = addressFrom((answer.body as { result?: unknown }).result);
  return address ? { status: "picked", address } : { status: "not-found" };
}

export const findAddress = onRequest({ cors: false, maxInstances: 20, timeoutSeconds: 20, memory: "256MiB" }, async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: { kind: "unknown", message: "post a search here" } });
    return;
  }
  try {
    const parsed = addressRequest.safeParse(req.body);
    if (!parsed.success) throw new RelayError(400, "unknown", "that is not a request the address finder understands");
    const study = await studyForRequest(research(), parsed.data.study);
    // A participant's iPad on its own credential, as for MyStory (D-55), or a signed-in researcher.
    const caller = await authenticate(req.headers.authorization, { allowDeviceCredential: true, study });
    if (isParticipantDevice(caller) && study.status === "closed") {
      res.status(200).json({ status: "unavailable" } satisfies Answer);
      return;
    }
    const apiKey = await readKey();
    if (!apiKey) {
      res.status(200).json({ status: "unavailable" } satisfies Answer);
      return;
    }
    let answer: Answer;
    if ("search" in parsed.data) {
      const query = searchText(parsed.data.search);
      if (!query) throw new RelayError(400, "unknown", "type at least three letters or numbers");
      answer = (await allowed(study.study, caller.uid, "suggestion")) ? await suggest(apiKey, query) : { status: "unavailable" };
    } else {
      answer = (await allowed(study.study, caller.uid, "lookup")) ? await pick(apiKey, parsed.data.pick) : { status: "unavailable" };
    }
    // Nothing typed and nothing found is ever logged: only that the finder answered.
    res.status(200).json(answer);
  } catch (error) {
    if (error instanceof RelayError) {
      refuse(res, error);
      return;
    }
    logger.error("address finder: failed", { error: String(error).slice(0, 200) });
    res.status(200).json({ status: "unavailable" } satisfies Answer);
  }
});
