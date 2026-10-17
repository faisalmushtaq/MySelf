import { z } from "zod";

/**
 * The wire format between a device and the study, defined once.
 *
 * WHY THIS IS NOT IN EITHER END. It was in both. The participant app declared the
 * request it sends and hand-rolled a validator for the response; the function
 * declared the request it accepts and shaped the response by hand. Two descriptions
 * of one protocol, in two packages, with nothing making them agree — and the failure
 * mode is not a crash. A device that sends a field the server ignores, or reads a
 * field the server stopped sending, syncs "successfully" and confirms sittings the
 * study does not have. That is the one failure this platform cannot afford, because
 * it ends with a device deleting data nobody holds.
 *
 * So both ends import these. A change that breaks the contract now fails to compile
 * on the side that did not change, which is where it should fail.
 *
 * GENEROUS ABOUT PAYLOADS, STRICT ABOUT SHAPE. A sitting refused because one event
 * payload had an unexpected key would lose everything a child answered, which is
 * worse than storing something odd. So payloads are opaque here and the reader
 * interprets them — and a device that knows about an event type this deployment does
 * not must still be able to hand it over.
 */

/**
 * What a session id may be: letters, digits, `_` and `-`, at most 120 of them.
 *
 * WHY THIS IS STRICT WHEN PAYLOADS ARE NOT. The id the device chose is used as a
 * Firestore document id and a Storage path segment (`studies/{study}/sessions/{id}`,
 * its chunks, its narrative, its voice notes), so a `/` in it is not an odd value but
 * a different path: `ses_victim/chunks/0006` addresses another sitting's chunk, and was
 * used to overwrite one. `.` and `..` are refused for the same reason. Every id a
 * device or the MyStory lab makes (`ses_<ULID>`, `lab_<base36>`) fits, so nothing
 * honest is turned away.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/** Whether a value is a session id that is safe to use as a path segment. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** A session id, as every endpoint that takes one accepts it. */
export const sessionIdField = z
  .string()
  .regex(SESSION_ID_PATTERN, "a session id is 1 to 120 letters, digits, underscores or hyphens");

/** One event, exactly as the device wrote it. */
export const deviceEventUpload = z.object({
  seq: z.number().int().min(0),
  type: z.string().min(1).max(80),
  itemKey: z.string().max(200).optional(),
  payload: z.record(z.unknown()).optional(),
  tWall: z.string().min(1).max(40),
  tMono: z.number(),
});

/**
 * One sitting.
 *
 * The caps are guards rather than budgets: a full YBM sitting is about 900 events and
 * 54 kB, so nothing legitimate comes close. 20,000 events is a sitting left open for
 * a fortnight, which the chunk spill exists to store rather than refuse.
 */
export const sittingUploadItem = z.object({
  sessionId: sessionIdField,
  studyCode: z.string().min(1).max(120),
  releaseKey: z.string().min(1).max(120),
  releaseHash: z.string().min(1).max(200),
  startedAt: z.string().min(1).max(40),
  completedAt: z.string().max(40).optional(),
  complete: z.boolean(),
  events: z.array(deviceEventUpload).max(20_000),
});

export const sittingUpload = z.object({
  /**
   * Which device these came off.
   *
   * Taken from the CREDENTIAL when the caller is a device, and read from the body only
   * when a member of the research team is importing a handover file — where the
   * originating iPad is a fact about the data that would otherwise be lost. A device
   * cannot claim to be a different device: the server overrides this with the
   * installation id it verified.
   */
  deviceId: z.string().min(1).max(120).optional(),
  /**
   * What this device believed the time was when it sent this.
   *
   * WHY THE STUDY WANTS IT. Every wall-clock timestamp in the dataset — when a
   * sitting started, when each answer was given — comes from the iPad's own clock,
   * and nothing else records whether that clock was right. An iPad restored from a
   * backup, or one that has been off a network for a fortnight, can come up hours
   * out, and the result is a sitting dated to the wrong day with nothing in the data
   * to say so. Pairing the device's clock with the server's at a moment both
   * observed is the only way to find that out, and it costs one field.
   *
   * IT CANNOT BE INFERRED WITHOUT THIS. `receivedAt` minus the last event's `tWall`
   * looks like it would do, but a device that held a morning's sittings for three
   * days offline — the normal case here — is indistinguishable from one whose clock
   * is three days behind. Only a clock read at the moment of the request separates
   * them.
   *
   * OPTIONAL, because an older build that does not send it must still be accepted.
   * A sitting refused over a diagnostic field would lose everything a child
   * answered, which is the trade this whole contract is written to avoid. It is also
   * never trusted for anything: response timing comes from the monotonic clock, and
   * this is recorded as an observation, not used as a time.
   */
  sentAt: z.string().min(1).max(40).optional(),
  /**
   * Which study these sittings belong to (D-56, docs/16 §11.3).
   *
   * The study a sitting STARTED in, which the device recorded then — not the one
   * the iPad happens to be on when it uploads, because an iPad switched to another
   * survey still has the last one's sittings to send. One study per request: the
   * device sends one sitting at a time, so it always knows which.
   *
   * OPTIONAL, and absent means the deployment's default study, which is what every
   * upload before this field meant. Loose here and strict in the function, which
   * checks it against the pattern and the registry and says in words what is wrong;
   * a shape refusal here would only say "invalid".
   */
  study: z.string().min(1).max(64).optional(),
  sittings: z.array(sittingUploadItem).min(1).max(50),
});

/**
 * One sitting's fate, so a device knows what it may stop holding.
 *
 * `events` is the count the server wrote, read back off its own split — not echoed
 * from the request. That is what makes it worth checking: a client compares it with
 * what it sent, and a truncated upload cannot report itself as whole.
 */
export const sittingOutcome = z.object({
  sessionId: z.string(),
  stored: z.boolean(),
  events: z.number().int().min(0),
  chunks: z.number().int().min(0),
  quarantined: z.boolean(),
  reason: z.string().optional(),
  /**
   * Whether posting this sitting again could ever store it, when it was not stored.
   *
   * `false` means never: the sitting is permanently invalid as it stands (nested too
   * deep, a list directly inside a list, an empty or reserved `__name__` field, an
   * answer over the size limit, text that is not valid Unicode), `reason` says which,
   * and a device should stop retrying it and show that reason to whoever can act on
   * it — while still keeping the sitting. `true` or absent means a passing failure
   * worth retrying. Optional, so a server that does not send it reads as before.
   */
  retryable: z.boolean().optional(),
});

export const sittingsResponse = z.object({
  stored: z.number().int().min(0),
  outcomes: z.array(sittingOutcome),
});

export type DeviceEventUpload = z.infer<typeof deviceEventUpload>;
export type SittingUploadItem = z.infer<typeof sittingUploadItem>;
export type SittingUpload = z.infer<typeof sittingUpload>;
export type SittingOutcome = z.infer<typeof sittingOutcome>;
export type SittingsResponse = z.infer<typeof sittingsResponse>;

/**
 * Whether the study took everything this device sent.
 *
 * Shared rather than living in the client, because it is the rule that decides
 * whether a sitting may be deleted from an iPad — and a rule that important should be
 * readable in one place and testable without a browser.
 *
 * The event count is the check. It is the one thing the server reports that a
 * truncated or partly-written upload cannot fake, and comparing it is the whole
 * guarantee: without it a short upload reads as a success on both ends and the
 * missing events are discovered by nobody.
 */
export function confirmationProblem(outcome: SittingOutcome, sentEvents: number): string | null {
  if (!outcome.stored) return outcome.reason ?? "the server did not store this sitting";
  if (outcome.events !== sentEvents) {
    return `the server stored ${outcome.events} of the ${sentEvents} events this sitting holds`;
  }
  return null;
}
