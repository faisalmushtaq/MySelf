import { checkProtocol, narrativeProtocol, type NarrativeProtocol } from "@myself/narrative";

/**
 * The protocol the survey sends, when the module runs inside it (D-54).
 *
 * The survey used to tell the module only a protocol key, which it looked up in
 * the list bundled with it. A version published from the dashboard can carry a
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
 */

export const READY = "mystory:ready";
export const REFUSED = "mystory:refused";
export const PROTOCOL_MESSAGE = "myself:narrative-protocol";

/** How long to wait for a protocol the survey said it would send. It is sent the moment the survey hears we are ready. */
export const PROTOCOL_PATIENCE_MS = 15_000;

export type HostProtocol = { ok: true; protocol: NarrativeProtocol } | { ok: false; problem: string };

/** Check what the survey sent: the same schema and checks the release builder ran. */
export function acceptHostProtocol(raw: unknown, expectedKey: string | null): HostProtocol {
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
 * a child is asked.
 */
export function receiveHostProtocol(
  target: Window,
  options: { sessionId: string | null; expectedKey: string | null; patienceMs?: number },
): Promise<HostProtocol> {
  return new Promise((resolve) => {
    const finish = (result: HostProtocol) => {
      target.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target.parent) return;
      const data = event.data as { type?: unknown; protocol?: unknown } | null;
      if (data === null || typeof data !== "object" || data.type !== PROTOCOL_MESSAGE) return;
      finish(acceptHostProtocol(data.protocol, options.expectedKey));
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
