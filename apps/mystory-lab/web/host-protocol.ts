import { checkProtocol, narrativeProtocol, type NarrativeProtocol } from "@myself/narrative";

/**
 * The protocol the survey sends, when the module runs inside it.
 *
 * The survey used to tell the module only a protocol key, which it looked up in
 * the list bundled with it. A version published from Studio can carry a
 * protocol edited there, which is in no bundled list, so the survey now sends
 * the exact protocol frozen into its release:
 *
 *   module → survey  `mystory:ready`               (this page has loaded)
 *   survey → module  `myself:narrative-protocol`   `{ protocol }`
 *   module → survey  `mystory:refused`             `{ problem }`, when it will not run it
 *
 * The survey marks the URL `protocolFromHost=1` when it will send one. Then the
 * module runs that protocol or nothing: if it does not parse, fails the
 * protocol's own checks, is not the protocol the URL named, or never arrives,
 * the module says so and refuses to start. It never falls back to its own copy,
 * because a conversation run under a protocol other than the one the release
 * froze is data that says it is something it is not. Opened by an older
 * survey, which sends nothing and does not mark the URL, it behaves as it
 * always did.
 *
 * THE SAME MESSAGE CAN CARRY THE iPAD'S CREDENTIAL (D-55, docs/09 §5):
 * `{ protocol, deviceCredential }`, the `<installId>.<secret>` the survey files
 * its sittings with. It lets a participant's iPad call the model without anybody
 * signing in, under that iPad's daily limits. It comes by message and never in
 * the URL, because a URL is kept in history, logs and referrers. It is believed
 * only from the page that framed this one, and only when that page is on an
 * origin this build trusts (`acceptHostCredential`); otherwise the protocol is
 * still taken and the credential is not. It is held in memory and goes nowhere
 * but the `Authorization` header of the study's own endpoints.
 */

export const READY = "mystory:ready";
export const REFUSED = "mystory:refused";
export const PROTOCOL_MESSAGE = "myself:narrative-protocol";

/** How long to wait for a protocol the survey said it would send. It is sent the moment the survey hears we are ready. */
export const PROTOCOL_PATIENCE_MS = 15_000;

export type HostProtocol =
  | {
      ok: true;
      protocol: NarrativeProtocol;
      /** The iPad's `<installId>.<secret>`, when a trusted survey sent one; otherwise null. */
      deviceCredential: string | null;
    }
  | { ok: false; problem: string };

/**
 * The origins whose survey may hand this module an iPad's credential.
 *
 * This page's own origin, because on GitHub Pages the survey and the module are
 * one site (`faisalmushtaq.github.io/MySelf/` and `…/MySelf/mystory/`), and any
 * named at build time (`MYSELF_MYSTORY_HOST_ORIGINS`, comma-separated) for a
 * survey served from somewhere else. Baked in rather than read from the URL: the
 * URL is written by whoever frames the page, and the question is precisely
 * whether to believe them.
 */
export function trustedHostOrigins(own: string, baked: string): string[] {
  const named = baked
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...new Set([own, ...named])];
}

/**
 * The shape the survey's own credential has: an installation id the relay would
 * accept, a dot, and a base64url secret of at least 32 characters. Anything else
 * is not one, and is dropped rather than sent anywhere.
 */
const DEVICE_CREDENTIAL = /^[A-Za-z0-9_-]{4,120}\.[A-Za-z0-9_-]{32,512}$/;

/**
 * The credential in the survey's message, if it is to be believed.
 *
 * Only from a trusted origin. A page anywhere on the web can frame this module
 * and post to it, and one that could hand it a credential could use it as a free
 * front end to the study's model — the relay would see a page on the study's own
 * origin. With this, a framing page that is not the study's own gets a module that
 * asks for sign-in, which is what it got before.
 */
export function acceptHostCredential(raw: unknown, origin: string, trusted: readonly string[]): string | null {
  if (!trusted.includes(origin)) return null;
  return typeof raw === "string" && DEVICE_CREDENTIAL.test(raw) ? raw : null;
}

/**
 * Whether a run kept on this device may be put back on the screen.
 *
 * Inside the survey, only the run of the sitting this page was opened for. An
 * iPad in a school is handed from child to child, and a run left unfinished by
 * the last one — they skipped the rest, or the battery went — stays on the device
 * for up to a day so a reload can bring it back. Restored by anybody's sitting,
 * the next child would be shown the last one's conversation, and their own would
 * be filed under the last one's session. The lab on its own has no sitting, and
 * restores what it kept as it always did.
 */
export function belongsHere(savedSessionId: string, hostSessionId: string | null): boolean {
  return hostSessionId === null || savedSessionId === hostSessionId;
}

/** Check what the survey sent: the same schema and checks the release builder ran. */
export function acceptHostProtocol(
  raw: unknown,
  expectedKey: string | null,
): { ok: true; protocol: NarrativeProtocol } | { ok: false; problem: string } {
  const parsed = narrativeProtocol.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      problem: `the protocol it sent is not one this module can read (${issue ? `${issue.path.join(".")}: ${issue.message}` : "no detail"})`,
    };
  }
  const problems = checkProtocol(parsed.data);
  if (problems.length > 0) return { ok: false, problem: `the protocol it sent fails its checks: ${problems.join("; ")}` };
  if (expectedKey !== null && parsed.data.key !== expectedKey) {
    return { ok: false, problem: `the survey asked for ${expectedKey} and sent ${parsed.data.key}` };
  }
  return { ok: true, protocol: parsed.data };
}

/** Canonical JSON, so two copies of a protocol compare by content and not by key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Whether two protocols are the same in every respect. */
export function sameProtocol(a: NarrativeProtocol, b: NarrativeProtocol | undefined): boolean {
  return b !== undefined && canonical(a) === canonical(b);
}

/**
 * Say we are ready, and wait for the survey's protocol.
 *
 * Believed only from the page that framed this one: another frame, an
 * extension or the page itself posting a protocol would otherwise decide what
 * a child is asked. The credential that may come with it is held to more: the
 * framing page must also be on a trusted origin (`acceptHostCredential`).
 */
export function receiveHostProtocol(
  target: Window,
  options: {
    sessionId: string | null;
    expectedKey: string | null;
    patienceMs?: number;
    /** Origins whose survey may hand over an iPad's credential (`trustedHostOrigins`). None, none believed. */
    trustedOrigins?: readonly string[];
  },
): Promise<HostProtocol> {
  return new Promise((resolve) => {
    const finish = (result: HostProtocol) => {
      target.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target.parent) return;
      const data = event.data as { type?: unknown; protocol?: unknown; deviceCredential?: unknown } | null;
      if (data === null || typeof data !== "object" || data.type !== PROTOCOL_MESSAGE) return;
      const accepted = acceptHostProtocol(data.protocol, options.expectedKey);
      finish(
        accepted.ok
          ? {
              ...accepted,
              deviceCredential: acceptHostCredential(data.deviceCredential, event.origin, options.trustedOrigins ?? []),
            }
          : accepted,
      );
    };
    const timer = setTimeout(
      () => finish({ ok: false, problem: "the survey said it would send the protocol to run, and it did not arrive" }),
      options.patienceMs ?? PROTOCOL_PATIENCE_MS,
    );
    target.addEventListener("message", onMessage);
    // Carries nothing but that we are listening, so it may go to any origin.
    target.parent.postMessage({ type: READY, sessionId: options.sessionId }, "*");
  });
}
