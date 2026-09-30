/**
 * What passes between the survey and the embedded MyStory module.
 *
 * The survey opens the module in an iframe with the sitting's details in the
 * URL. Then, by message:
 *
 *   module → survey  `mystory:ready`       the module has loaded and is listening
 *   survey → module  `myself:narrative-protocol`  the protocol to run (D-54)
 *   module → survey  `mystory:refused`     it will not run what it was sent, and why
 *   module → survey  `mystory:finished`    done or stopped; the survey moves on
 *
 * WHY THE PROTOCOL IS SENT. The module used to be told only a protocol key,
 * which it looked up in the list bundled with it. A version published from the
 * dashboard can carry a protocol edited there, which no bundled list has, so
 * the survey now sends the exact protocol frozen into its release. The module
 * runs it only when it passes the same schema and checks, and otherwise
 * refuses to start rather than run something else in its place.
 *
 * `protocolFromHost=1` in the URL tells the module a protocol is coming, so it
 * waits for one instead of starting on its own list. A module opened by an older
 * survey, which sends none, carries on as it always did.
 */

export const MODULE_READY = "mystory:ready";
export const MODULE_REFUSED = "mystory:refused";
export const MODULE_FINISHED = "mystory:finished";
export const PROTOCOL_MESSAGE = "myself:narrative-protocol";

export interface HandoverOptions {
  moduleUrl: string;
  protocol: string;
  sessionId: string;
  releaseHash: string;
  firstName?: string | undefined;
  /** Whether the survey will send the protocol by message. */
  sendsProtocol: boolean;
}

/** The address the module is opened at. */
export function handoverUrl(options: HandoverOptions): URL {
  const url = new URL(`${options.moduleUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("embed", "1");
  url.searchParams.set("view", "participant");
  url.searchParams.set("start", "1");
  url.searchParams.set("protocol", options.protocol);
  url.searchParams.set("sessionId", options.sessionId);
  url.searchParams.set("releaseHash", options.releaseHash);
  if (options.sendsProtocol) url.searchParams.set("protocolFromHost", "1");
  // Silence means nobody, and the module is written to read correctly with
  // no name. Only sent when the study actually collected one.
  if (options.firstName) url.searchParams.set("name", options.firstName);
  return url;
}

export type ModuleMessage =
  | { kind: "ready" }
  | { kind: "refused"; problem: string }
  | { kind: "finished"; reason: string };

/**
 * What a message from the module says, or null when it is not one to act on.
 *
 * Only the module's own origin is believed, and only about this sitting. A
 * page in an iframe is not the only thing that can post here — an extension,
 * another frame, the page itself — and a stray message that advanced the
 * survey would skip a section without anybody doing anything.
 */
export function readModuleMessage(
  event: { origin: string; data: unknown },
  expected: { origin: string; sessionId: string },
): ModuleMessage | null {
  if (event.origin !== expected.origin) return null;
  const data = event.data as { type?: unknown; reason?: unknown; problem?: unknown; sessionId?: unknown } | null;
  if (data === null || typeof data !== "object") return null;
  if (data.sessionId && data.sessionId !== expected.sessionId) return null;
  if (data.type === MODULE_READY) return { kind: "ready" };
  if (data.type === MODULE_REFUSED) {
    return { kind: "refused", problem: typeof data.problem === "string" ? data.problem : "no reason given" };
  }
  if (data.type === MODULE_FINISHED) {
    return { kind: "finished", reason: typeof data.reason === "string" ? data.reason : "finished" };
  }
  return null;
}
