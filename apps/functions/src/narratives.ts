import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { paths } from "@myself/firebase";
import { STUDY, research } from "./apps.js";
import { RelayError, type Caller } from "./relay-policy.js";
import { authenticate, cors } from "./relay.js";

/**
 * Storing a narrative run.
 *
 * docs/08 §9.3 settled the shape against a real export of 27 participants from
 * the Streamlit app: narratives get their OWN DOCUMENT rather than a field on
 * the sitting, because they arrive later and only where there is connectivity
 * — attaching one must not mean re-uploading 54 kB of survey log over a school
 * wifi, and an analysis that does not want narratives should not pay to read
 * them. A run measured 12.3 kB at the median, so one document is never close
 * to the limit and there is no chunking path here.
 *
 * Three things the original did that this deliberately does not:
 *
 * ONE COPY OF THE CONVERSATION. The export carried both `chat_history` and
 * `chat_history_single_string` — the same content twice, about a fifth of the
 * payload, and two things that can disagree. The flattened version is derived
 * on read.
 *
 * NO TYPE WRAPPERS. `{"S": "…"}` is an artefact of the export having passed
 * through DynamoDB, not something the data means.
 *
 * A FAILURE IS A FAILURE. One run in 27 produced no scenario, because the
 * original writes an apology string into the scenario slot when generation
 * fails. The records here carry `fallback_applied` and the slot stays empty,
 * so an analyst reads an absence rather than inferring one.
 */

/**
 * What a page may send.
 *
 * The records are the participant's, so this is generous about their content
 * and strict about their shape: a run that cannot be stored because one field
 * was unexpected would lose everything the participant said, which is the one
 * outcome worse than storing something odd.
 */
const record = z.object({
  recordId: z.string().min(1),
  sessionId: z.string().min(1),
  protocolKey: z.string().min(1),
  protocolVersion: z.string().min(1),
  stageKey: z.string().min(1),
  seq: z.number().int().min(0),
  source: z.enum(["participant", "model", "system"]),
  kind: z.string().min(1),
  text: z.string().max(20_000).nullable(),
  data: z.record(z.unknown()).nullable(),
  refersTo: z.string().nullable(),
  modelCallId: z.string().nullable(),
  at: z.string(),
});

export const narrativeSave = z.object({
  sessionId: z.string().min(1).max(120),
  protocolKey: z.string().min(1),
  protocolVersion: z.string().min(1),
  /** A finished run is 30-odd records; the cap is a guard, not a budget. */
  records: z.array(record).max(500),
  finished: z.boolean().default(false),
  /** Seconds from the first screen, as the original recorded it. */
  elapsedSeconds: z.number().min(0).optional(),
});

/**
 * Whether this run counts as research data.
 *
 * A tester following a link is not a consented participant, and their run must
 * never reach the research dataset by default — but it is still worth keeping,
 * because it is how the module gets judged before fielding. So it is stored
 * and marked, and the marking comes from HOW THEY AUTHENTICATED rather than
 * from anything the page claims: a caller holding a tester link is a tester,
 * and no page can say otherwise.
 */
export function provenanceOf(caller: Caller): "test" | "study" {
  return caller.uid.startsWith("link_") ? "test" : "study";
}

export const saveNarrative = onRequest(
  { cors: false, maxInstances: 20, timeoutSeconds: 60 },
  async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: { kind: "unknown", message: "post a narrative run here" } });
      return;
    }

    try {
      const caller = await authenticate(req.headers.authorization);
      const parsed = narrativeSave.safeParse(req.body);
      if (!parsed.success) {
        throw new RelayError(400, "unknown", `that is not a narrative run: ${parsed.error.issues[0]?.message ?? ""}`);
      }
      const run = parsed.data;

      /**
       * Written whole on every turn rather than appended to.
       *
       * The records are an ordered log the runner already holds complete, so
       * one `set` is idempotent and a retry cannot interleave. It also means a
       * participant who closes the tab halfway has left everything they said
       * up to that point, which append-on-finish would have lost — and half a
       * run abandoned at the rating screen is itself a finding.
       */
      await research()
        .doc(paths.narrative(STUDY, run.sessionId))
        .set(
          {
            sessionId: run.sessionId,
            protocolKey: run.protocolKey,
            protocolVersion: run.protocolVersion,
            provenance: provenanceOf(caller),
            uid: caller.uid,
            records: run.records,
            recordCount: run.records.length,
            finished: run.finished,
            ...(run.elapsedSeconds === undefined ? {} : { elapsedSeconds: run.elapsedSeconds }),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

      res.status(200).json({ saved: run.records.length, sessionId: run.sessionId });
    } catch (error) {
      if (error instanceof RelayError) {
        res.status(error.status).json({ error: { kind: error.kind, message: error.message } });
        return;
      }
      logger.error("saveNarrative failed", error);
      res.status(500).json({ error: { kind: "unknown", message: "could not store that run" } });
    }
  },
);
