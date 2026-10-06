/**
 * What passes between the survey and the embedded MyStory module.
 *
 * The survey opens the module in an iframe with the sitting's details in the
 * URL. Then, by message:
 *
 *   module → survey  `mystory:ready`       the module has loaded and is listening
 *   survey → module  `myself:narrative-protocol`  the protocol to run, and the iPad's credential
 *   module → survey  `mystory:refused`     it will not run what it was sent, and why
 *   module → survey  `mystory:finished`    done or stopped; the survey moves on
 *
 * WHY THE PROTOCOL IS SENT. The module used to be told only a protocol key,
 * which it looked up in the list bundled with it. A version published from
 * Studio can carry a protocol edited there, which no bundled list has, so
 * the survey now sends the exact protocol frozen into its release. The module
 * runs it only when it passes the same schema and checks, and otherwise
 * refuses to start rather than run something else in its place.
 *
 * `protocolFromHost=1` in the URL tells the module a protocol is coming, so it
 * waits for one instead of starting on its own list. A module opened by an older
 * survey, which sends none, carries on as it always did.
 *
 * THE iPAD'S CREDENTIAL GOES WITH THE PROTOCOL (D-55, docs/09 §5). The research
 * team decided any participant's iPad may use the model for MyStory, under daily
 * limits, so the module needs something the relay accepts — and a child has no
 * account to sign in with. The survey already has the credential it files its
 * sittings with (`syncTarget()`), so it hands the module that, as
 * `deviceCredential`, in the same message as the protocol. Three rules:
 *
 *   NEVER IN THE URL. A URL is kept in history, server logs and referrers, and
 *   the frame's URL is visible to anything that can read the page's DOM. A
 *   message is gone once it is delivered.
 *
 *   ADDRESSED TO THE MODULE'S ORIGIN, so a frame that has navigated anywhere
 *   else receives nothing.
 *
 *   ONLY TO THE FRAME THAT ASKED. `mystory:ready` is believed from the module's
 *   origin; the answer goes only when the window that said it is this step's
 *   own frame. On GitHub Pages the survey and the module are one origin, so the
 *   origin alone would let any other page of that site ask.
 *
 * A build that files nowhere has no credential, sends none, and the module asks
 * for sign-in exactly as it did before.
 */

import type { SyncTarget } from "./device.js";

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

/**
 * The iPad's credential as the module takes it: `<installId>.<secret>`.
 *
 * `syncTarget()` gives the whole `Authorization` value (`Device …`), because
 * that is what an upload sends; the module adds the scheme itself, as the relay
 * adapter does for a link key. Null for a build that files nowhere, or for a
 * credential of any other kind, which the module would have no use for.
 */
export function moduleCredential(target: Pick<SyncTarget, "credential"> | null): string | null {
  if (!target?.credential.startsWith("Device ")) return null;
  const raw = target.credential.slice("Device ".length).trim();
  return raw.length > 0 ? raw : null;
}

/** The message the module is answered with when it says it is ready. */
export interface ProtocolMessage {
  type: typeof PROTOCOL_MESSAGE;
  protocol: unknown;
  /** The iPad's `<installId>.<secret>`, when this build has one (D-55). */
  deviceCredential?: string;
}

/**
 * What to send, or null when there is nothing to.
 *
 * Nothing without a protocol: the module only waits for this message when the
 * URL said one is coming (`sendsProtocol`), and the release gate refuses a
 * narrative position whose protocol is not frozen, so in a real release there
 * always is one.
 */
export function protocolMessage(definition: unknown, deviceCredential: string | null): ProtocolMessage | null {
  if (definition === undefined) return null;
  return { type: PROTOCOL_MESSAGE, protocol: definition, ...(deviceCredential ? { deviceCredential } : {}) };
}

/** As much of the module's frame as answering it needs. */
export interface ModuleFrame {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Answer the module's `mystory:ready`: the protocol, and the iPad's credential
 * when there is one. Returns whether anything was sent.
 *
 * Every time it says so, so a module that reloads is sent it again — which is
 * also how a reloaded module gets the credential back, since it keeps it only in
 * memory. The frame is looked up AFTER the credential is read, and the asker
 * checked against it then, because reading the credential is asynchronous and
 * the frame may have been replaced while it was.
 */
export async function answerReady(options: {
  /** `event.source` of the ready message. */
  asker: unknown;
  /** This step's own frame, as it is now. */
  frame: () => ModuleFrame | null | undefined;
  moduleOrigin: string;
  definition: unknown;
  credential: Promise<string | null>;
}): Promise<boolean> {
  if (!options.asker || options.asker !== options.frame()) return false;
  // A credential that cannot be read is not a reason to withhold the protocol:
  // the module then runs as it did before, asking for sign-in.
  const credential = await options.credential.catch(() => null);
  const message = protocolMessage(options.definition, credential);
  const frame = options.frame();
  if (!message || !frame || frame !== options.asker) return false;
  frame.postMessage(message, options.moduleOrigin);
  return true;
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
