import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import { paths } from "@myself/firebase";
import { STUDY, research } from "./apps.js";
import { RelayError, type Caller } from "./relay-policy.js";
import { authenticate, cors, meter } from "./relay.js";

/**
 * Speaking instead of typing.
 *
 * A young person who finds writing hard should not be shut out of a method
 * whose entire subject is what they have to say. So they can talk, and what
 * they said arrives in the message box as text they can read and correct
 * before they send it.
 *
 * WHY THE AUDIO COMES HERE. The browser's own recogniser was the easy route
 * and it is the wrong one: Safari transcribes by sending audio to Apple and
 * Chrome by sending it to Google, so a study that used it would be handing
 * children's voices to a processor nobody named in the approval, on terms
 * nobody read. The study already has one model provider, already names it, and
 * already holds the key in Secret Manager. The audio goes there and nowhere
 * else.
 *
 * WHAT IS KEPT. The recording and the text, both, on the researcher's
 * instruction and under their REC approval. The first version of this kept
 * only the text; the study needs the audio — for checking a transcript against
 * what was actually said, and because how something is said is data a
 * transcript throws away.
 *
 * That makes this the most sensitive thing the platform stores. A child's
 * voice identifies them in a way no answer does, so the clip is written to a
 * bucket path NO CLIENT CAN READ: Storage rules refuse every read and write on
 * it, and the only way in is a researcher through the admin SDK. It is laid
 * out one prefix per session so a participant's audio can be listened to,
 * exported and — the operation that actually matters — deleted as one thing.
 *
 * THE TWO HALVES RUN AT ONCE. The bytes are already in memory, so the upload
 * and the transcription start together rather than one after the other: the
 * participant waits for the slower of the two, not the sum. If transcription
 * fails, the recording is still saved and the failure is reported, because
 * losing what somebody said is worse than making them type it again.
 */

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

/**
 * The transcription model, fixed here rather than sent by the caller.
 *
 * Same principle as the relay: a page says what it wants done, never what to
 * do it with. There is no config key for this one because there is nothing for
 * a protocol to choose — it is not a stage of the method, it is an input
 * device, and a study's findings do not turn on it.
 */
const MODEL = "gpt-4o-mini-transcribe";

/**
 * British English, told rather than guessed.
 *
 * Auto-detection on a short clip from a child with a strong regional accent is
 * where these models produce confident nonsense in the wrong language. The
 * cohort is in Yorkshire.
 */
const LANGUAGE = "en";

/**
 * Twenty-five seconds of Opus is a few tens of kilobytes; this ceiling is
 * about four minutes of it. It exists so a forged request cannot post a
 * gigabyte at a function that would try to base64-decode it.
 */
const MAX_BYTES = 4_000_000;

/** What the page sends: one clip, what container it is in, and whose run. */
const request = z.object({
  audio: z.string().min(32).max(Math.ceil(MAX_BYTES * 1.4)),
  mimeType: z.string().min(4).max(80),
  protocolKey: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(120),
  seconds: z.number().min(0).max(600).optional(),
});

/**
 * The container the browser actually produced.
 *
 * iOS Safari records `audio/mp4`, Chrome and Firefox `audio/webm`. The
 * provider takes both but reads the FILE EXTENSION to decide which, so a
 * wrongly named file is rejected as corrupt with no useful message. Mapped
 * explicitly, and anything unrecognised is refused rather than guessed at.
 */
const EXTENSIONS: Record<string, string> = {
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

export function extensionFor(mimeType: string): string {
  // "audio/webm;codecs=opus" is what MediaRecorder reports.
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  const extension = EXTENSIONS[base];
  if (!extension) {
    logger.error("transcribe: a container this cannot read", { mimeType: base });
    throw new RelayError(400, "unknown", "Your phone recorded that in a way I can\u2019t read. You can type your answer instead.");
  }
  return extension;
}

/**
 * A row saying a transcription happened, and nothing of what was said.
 *
 * The text belongs in the narrative record with the rest of the conversation,
 * where it is governed with everything else. Here there is only the shape of
 * the event: who, how long the clip was, which model, whether it worked. That
 * is what a spending question and an incident question both need, and it is
 * all they need.
 */
async function recordTranscription(
  caller: Caller,
  fields: { bytes: number; ms: number; ok: boolean; characters: number; path?: string },
): Promise<void> {
  try {
    await research()
      .collection(`${paths.audit(STUDY)}_transcriptions`)
      .add({
        ...fields,
        model: MODEL,
        uid: caller.uid,
        device: caller.device,
        at: FieldValue.serverTimestamp(),
      });
  } catch (error) {
    logger.error("transcribe: could not write the provenance row", error);
  }
}

/**
 * The recording, in the bucket.
 *
 * Written with the admin SDK, which Storage rules do not apply to — and the
 * rules refuse every client read and write on this prefix, so a researcher
 * going through the console or a signed export is the only way back to it. The
 * clip id is a UUID rather than a counter: a guessable object name is a
 * guessable object name even behind rules.
 */
async function keepRecording(
  sessionId: string,
  clipId: string,
  extension: string,
  mimeType: string,
  audio: Buffer,
  caller: Caller,
): Promise<string> {
  const path = paths.voiceNote(STUDY, sessionId, clipId, extension);
  /**
   * Which bucket, said out loud.
   *
   * `.bucket()` with no argument takes the default out of the environment, and
   * on a project whose Storage was switched on recently that default can be
   * the name Firebase used to use — `<project>.appspot.com` — while the bucket
   * that actually exists is `<project>.firebasestorage.app`. The write then
   * fails with "bucket does not exist" naming a bucket nobody chose, and since
   * this half is deliberately allowed to fail without taking the transcript
   * with it, the only sign would be a missing `path` in an audit row.
   *
   * So the name is resolved here, overridable, and logged when the write
   * fails. Guessing between the two would be worse than either: a study's
   * audio must land where the researcher thinks it is landing.
   */
  const bucket = process.env["MYSELF_VOICE_BUCKET"];
  const target = bucket ? getStorage().bucket(bucket) : getStorage().bucket();
  await target
    .file(path)
    .save(audio, {
      contentType: mimeType,
      resumable: false,
      metadata: {
        // Enough to know whose run it belongs to and how it got here, without
        // putting a word of what was said on the object.
        metadata: { study: STUDY, sessionId, uid: caller.uid, clipId },
      },
    });
  return path;
}

/** The provider's own transcription of one clip. */
async function transcribeClip(audio: Buffer, mimeType: string, extension: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `speech.${extension}`);
  form.append("model", MODEL);
  form.append("language", LANGUAGE);
  form.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_API_KEY.value()}` },
    body: form,
  });
  if (!response.ok) {
    // The provider's own message is not passed to the page: it can quote
    // request content back, and this request's content is a child's voice.
    logger.error("transcribe: the provider refused", { status: response.status });
    throw new RelayError(502, "unknown", "I couldn\u2019t turn that into words just now. Try again, or type it instead.", true);
  }
  const { text } = (await response.json()) as { text?: string };
  return (text ?? "").trim();
}

export const transcribe = onRequest(
  { secrets: [OPENAI_API_KEY], cors: false, maxInstances: 10, timeoutSeconds: 120, memory: "512MiB" },
  async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== "POST") {
      res.status(405).json({ error: { kind: "unknown", message: "post a recording here" } });
      return;
    }

    const started = Date.now();
    let caller: Caller | null = null;
    let bytes = 0;
    try {
      caller = await authenticate(req.headers.authorization);
      // The same daily ceiling as a model call, and deliberately the same
      // counter: a loop that records instead of prompting is the same bill.
      await meter(caller);

      const parsed = request.safeParse(req.body);
      if (!parsed.success) {
        /**
         * WHICH field, in the log — and only the field.
         *
         * The old message said "that is not a recording this relay
         * understands", which told a child nothing and told me nothing
         * either: any of five fields could have failed and the reply named
         * none of them. The names and codes go to the log; the VALUES never
         * do, because one of those fields is a recording of somebody's voice.
         */
        logger.error("transcribe: the request did not validate", {
          issues: parsed.error.issues.map((i) => ({ at: i.path.join("."), code: i.code })),
        });
        throw new RelayError(400, "unknown", "Something went wrong sending that. Try again, or type your answer instead.");
      }
      const extension = extensionFor(parsed.data.mimeType);
      const audio = Buffer.from(parsed.data.audio, "base64");
      bytes = audio.byteLength;
      if (bytes === 0) throw new RelayError(400, "unknown", "I didn\u2019t catch any sound there. Try again, or type your answer instead.");
      if (bytes > MAX_BYTES) throw new RelayError(413, "unknown", "That was a bit too long to send. Try a shorter one, or type your answer.");

      /**
       * Both at once.
       *
       * The bytes are in memory either way, so keeping the recording and
       * writing it down are started together and the participant waits for the
       * slower of the two rather than for their sum. `allSettled`, not `all`,
       * because these two must not be able to take each other down: a
       * transcription the provider refused should still leave the recording
       * saved, and a bucket that would not accept the file should still return
       * the words so the conversation can go on.
       */
      const clipId = randomUUID();
      const [kept, written] = await Promise.allSettled([
        keepRecording(parsed.data.sessionId, clipId, extension, parsed.data.mimeType, audio, caller),
        transcribeClip(audio, parsed.data.mimeType, extension),
      ]);

      if (kept.status === "rejected") {
        // The bucket name is in here because the usual cause is the wrong one
        // being defaulted to, and the provider's error names it without
        // saying that is what went wrong.
        logger.error("transcribe: the recording could not be kept", {
          bucket: process.env["MYSELF_VOICE_BUCKET"] ?? process.env["STORAGE_BUCKET"] ?? "(default)",
          reason: String((kept.reason as Error | undefined)?.message ?? kept.reason),
        });
      }
      const path = kept.status === "fulfilled" ? kept.value : null;
      const said = written.status === "fulfilled" ? written.value : null;

      await recordTranscription(caller, {
        bytes,
        ms: Date.now() - started,
        ok: said !== null,
        characters: said?.length ?? 0,
        ...(path ? { path } : {}),
      });

      if (said === null) {
        // The recording is safe; only the words are missing. Said plainly, so
        // the page can offer typing without implying the answer was lost.
        res.status(502).json({
          error: {
            kind: "unknown",
            message: "I\u2019ve kept your recording, but I couldn\u2019t turn it into words. Could you type what you said?",
            retryable: true,
          },
          ...(path ? { clipId, seconds: parsed.data.seconds ?? null, kept: true } : {}),
        });
        return;
      }

      res.status(200).json({ text: said, clipId, kept: path !== null, seconds: parsed.data.seconds ?? null });
    } catch (error) {
      if (caller) void recordTranscription(caller, { bytes, ms: Date.now() - started, ok: false, characters: 0 });
      if (error instanceof RelayError) {
        res.status(error.status).json({ error: { kind: error.kind, message: error.message, retryable: error.retryable } });
        return;
      }
      logger.error("transcribe: the call failed");
      res.status(502).json({
        error: { kind: "unknown", message: "I couldn\u2019t turn that into words just now. Try again, or type it instead.", retryable: true },
      });
    } finally {
      // No text, no bytes of audio, no clip — only that it happened and for how
      // long. Logs are the one place this could leak by accident.
      logger.info("transcribe", { uid: caller?.uid ?? null, ms: Date.now() - started });
    }
  },
);
