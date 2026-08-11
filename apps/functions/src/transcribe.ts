import { FieldValue } from "firebase-admin/firestore";
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
 * WHAT IS KEPT. The text. That is the whole answer. The audio is held in this
 * function's memory for the length of one request, sent to the provider, and
 * dropped — it is never written to Firestore, never written to Storage, never
 * logged. A recording of a child's voice is biometric data of the most
 * identifiable kind, and the safest place for it is nowhere. What ends up in
 * the record is the same sentence that would have been there if they had typed
 * it, and it is marked as spoken so an analyst knows how it arrived.
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

/** What the page sends: one clip, and what container it is in. */
const request = z.object({
  audio: z.string().min(32).max(Math.ceil(MAX_BYTES * 1.4)),
  mimeType: z.string().min(4).max(80),
  protocolKey: z.string().min(1).max(120),
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
  if (!extension) throw new RelayError(400, "unknown", `this relay cannot transcribe ${base}`);
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
  fields: { bytes: number; ms: number; ok: boolean; characters: number },
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
        throw new RelayError(400, "unknown", "that is not a recording this relay understands");
      }
      const extension = extensionFor(parsed.data.mimeType);
      const audio = Buffer.from(parsed.data.audio, "base64");
      bytes = audio.byteLength;
      if (bytes === 0) throw new RelayError(400, "unknown", "that recording was empty");
      if (bytes > MAX_BYTES) throw new RelayError(413, "unknown", "that recording is longer than this accepts");

      const form = new FormData();
      form.append("file", new Blob([audio], { type: parsed.data.mimeType }), `speech.${extension}`);
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
        throw new RelayError(502, "unknown", "that could not be written down just now", true);
      }

      const { text } = (await response.json()) as { text?: string };
      const said = (text ?? "").trim();
      await recordTranscription(caller, { bytes, ms: Date.now() - started, ok: true, characters: said.length });
      res.status(200).json({ text: said });
    } catch (error) {
      if (caller) void recordTranscription(caller, { bytes, ms: Date.now() - started, ok: false, characters: 0 });
      if (error instanceof RelayError) {
        res.status(error.status).json({ error: { kind: error.kind, message: error.message, retryable: error.retryable } });
        return;
      }
      logger.error("transcribe: the call failed");
      res.status(502).json({ error: { kind: "unknown", message: "that could not be written down just now", retryable: true } });
    } finally {
      // No text, no bytes of audio, no clip — only that it happened and for how
      // long. Logs are the one place this could leak by accident.
      logger.info("transcribe", { uid: caller?.uid ?? null, ms: Date.now() - started });
    }
  },
);
