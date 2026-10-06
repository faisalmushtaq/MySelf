import { FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { paths } from "@myself/firebase";
import { research } from "./apps.js";
import { RelayError, isParticipantDevice, type Caller } from "./relay-policy.js";
import { authenticate, cors, refuse } from "./relay.js";
import { studyForRequest } from "./studies.js";

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
  /**
   * Which release this run belonged to.
   *
   * A protocol key and version say which questions were asked. The release
   * hash says which frozen bundle of instruments, wording and model
   * parameters the sitting around it was collected under — and without it a
   * narrative can be tied to a participant but not to the study as it stood
   * that day. Optional because the standalone lab has no release; a run that
   * came through the survey always has one.
   */
  releaseHash: z.string().max(200).optional(),
  /**
   * Which study the sitting belongs to (D-56), as the survey told MyStory. The
   * run is stored there, beside its sitting; absent means the default study.
   */
  study: z.string().min(1).max(64).optional(),
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

export type NarrativeRun = z.infer<typeof narrativeSave>;

/**
 * Whose session this is, and whether this caller may write to it.
 *
 * Null when it may. Opening `saveNarrative` (and the transcriber) to any
 * participant's iPad (D-55) is what makes this matter: the write used to be
 * reachable only by people the study knew, and is now reachable by any
 * installation somebody with the URL makes. Two rules, the sittings' own:
 *
 *   A RUN BELONGS TO WHOEVER FIRST STORED IT. A run already stored under one
 *   caller is never replaced by another — first writer wins, as for an
 *   installation id and for a sitting. The legitimate writer of a run is always
 *   the same caller: one iPad's credential, one tester link, one account.
 *
 *   A DEVICE'S RUN BELONGS TO ITS OWN SITTING. A device may not attach a run to
 *   a sitting another device filed. The narrative usually arrives first — the
 *   sitting is checkpointed every two minutes — so this catches the case where
 *   it does not; the first rule catches the rest.
 *
 * Both are about the session id, which the module only has because the survey
 * put it in the frame's URL. Neither is a reason to doubt the honest case: an
 * iPad running its own sitting passes both every time.
 */
export function sessionClaimRefusal(
  caller: Caller,
  storedRunUid: unknown,
  sittingDeviceId: unknown,
): string | null {
  if (typeof storedRunUid === "string" && storedRunUid !== caller.uid) {
    return "this conversation is already stored from another device or account, and is not replaced";
  }
  if (caller.device && typeof sittingDeviceId === "string" && sittingDeviceId !== caller.uid) {
    return "this conversation belongs to a sitting another device filed";
  }
  return null;
}

/**
 * What a run must carry before it is stored, from who is storing it.
 *
 * A participant's iPad must say which release its sitting is running (D-55): its
 * credential only reaches the module through the survey, which always knows, so a
 * device's run without one did not come through a survey and has no place in the
 * study's data.
 */
export function narrativeRefusal(caller: Caller, run: NarrativeRun): string | null {
  if (isParticipantDevice(caller) && run.releaseHash === undefined) {
    return "a participant's device must say which version of the survey this conversation belongs to";
  }
  return null;
}

/**
 * Store one run, and refuse one that would replace somebody else's.
 *
 * Exported, with the database passed in, for the integration suite: the
 * ownership rule is decided inside a transaction, and only a real database can
 * show two callers racing for one session id resolve to one owner.
 */
export async function storeNarrative(
  db: FirebaseFirestore.Firestore,
  study: string,
  caller: Caller,
  run: NarrativeRun,
): Promise<void> {
  const refusal = narrativeRefusal(caller, run);
  if (refusal) throw new RelayError(400, "unknown", refusal);

  const ref = db.doc(paths.narrative(study, run.sessionId));
  const sitting = db.doc(paths.session(study, run.sessionId));

  await db.runTransaction(async (tx) => {
    const [held, sat] = await tx.getAll(ref, sitting);
    const claim = sessionClaimRefusal(caller, held?.data()?.["uid"], sat?.data()?.["deviceId"]);
    if (claim) throw new RelayError(409, "auth", claim);

    /**
     * Written whole on every turn rather than appended to.
     *
     * The records are an ordered log the runner already holds complete, so
     * one `set` is idempotent and a retry cannot interleave. It also means a
     * participant who closes the tab halfway has left everything they said
     * up to that point, which append-on-finish would have lost — and half a
     * run abandoned at the rating screen is itself a finding.
     */
    tx.set(
      ref,
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
        ...(run.releaseHash === undefined ? {} : { releaseHash: run.releaseHash }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
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
      /**
       * The sitting's study first (D-56): the run is stored beside its sitting,
       * and the iPad is who it is in that study. A closed study still takes a
       * run, like a sitting, from an iPad it knows.
       */
      const study = await studyForRequest(research(), (req.body as { study?: unknown } | undefined)?.study);

      /**
       * A participant's iPad too, on its own credential (D-55). Storing a run is a
       * Firestore write like filing a sitting, so it spends none of the model
       * limits; what it needs instead is the ownership rule in `storeNarrative`.
       */
      const caller = await authenticate(req.headers.authorization, { allowDeviceCredential: true, study });
      const parsed = narrativeSave.safeParse(req.body);
      if (!parsed.success) {
        throw new RelayError(400, "unknown", `that is not a narrative run: ${parsed.error.issues[0]?.message ?? ""}`);
      }
      const run = parsed.data;

      await storeNarrative(research(), study.study, caller, run);

      res.status(200).json({ saved: run.records.length, sessionId: run.sessionId });
    } catch (error) {
      if (error instanceof RelayError) {
        refuse(res, error);
        return;
      }
      logger.error("saveNarrative failed", error);
      res.status(500).json({ error: { kind: "unknown", message: "could not store that run" } });
    }
  },
);
