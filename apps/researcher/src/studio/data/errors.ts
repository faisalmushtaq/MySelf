import type { StudioErrorDetails } from "@myself/studio";

/**
 * Turning what Firebase throws into something a researcher can act on.
 *
 * Firebase errors carry a code ("functions/permission-denied",
 * "auth/popup-blocked") and a message written for developers. Nothing here
 * ever shows a code on its own: each is mapped to a sentence that says what
 * happened and what to do next. A message the Studio's own functions wrote is
 * kept, because those are already written for the person reading them.
 */

/** A refused callable, with the structured details the functions attach. */
export class StudioCallError extends Error {
  constructor(
    message: string,
    /** The Firebase Functions error code without its prefix, e.g. "permission-denied", "aborted". */
    public readonly code: string,
    public readonly details: StudioErrorDetails | null,
  ) {
    super(message);
    this.name = "StudioCallError";
  }
}

/** The `code` a Firebase error carries, if it is one. */
export function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
}

const DETAIL_KINDS = new Set(["invalid", "conflict", "version_taken", "bump_too_small", "not_found", "forbidden"]);

export function isStudioErrorDetails(value: unknown): value is StudioErrorDetails {
  return !!value && typeof value === "object" && DETAIL_KINDS.has((value as { kind?: unknown }).kind as string);
}

const CALL_MESSAGES: Record<string, string> = {
  unauthenticated: "Your sign-in has expired. Sign in again, then try once more.",
  "permission-denied": "Your account doesn’t have permission to do that.",
  "not-found": "That no longer exists. Someone may have removed it.",
  "already-exists": "That already exists.",
  aborted: "Someone else changed this at the same moment. Nothing was changed; try again.",
  unavailable: "The Studio’s server can’t be reached. Check your connection and try again.",
  "deadline-exceeded":
    "The server took too long to answer. It may still have finished, so check before trying again.",
  "resource-exhausted": "The Studio is busy. Wait a minute, then try again.",
  "invalid-argument": "The server didn’t accept that request.",
  "failed-precondition": "That can’t be done in the survey’s current state.",
  internal: "Something went wrong on the server. Try again, and if it keeps happening, tell the study’s technical lead.",
  unknown: "Something went wrong. Try again, and if it keeps happening, tell the study’s technical lead.",
};

/**
 * Whether a server message is worth showing as it is. The SDK fills in the
 * bare code ("internal", "INTERNAL") when the server said nothing useful, and a
 * network failure produces a developer message about fetch; both are replaced.
 */
function meaningful(message: string, code: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (m.toLowerCase() === code.toLowerCase()) return false;
  if (m.toLowerCase().replace(/_/g, "-") === code) return false;
  if (/^(internal|unknown|unavailable)$/i.test(m)) return false;
  if (/fetch|network|cors|xmlhttprequest/i.test(m)) return false;
  return true;
}

/** Any error from a callable, as a StudioCallError with a plain-English message. */
export function toStudioCallError(error: unknown): StudioCallError {
  if (error instanceof StudioCallError) return error;
  const raw = codeOf(error) ?? "unknown";
  const code = raw.startsWith("functions/") ? raw.slice("functions/".length) : raw;
  const detailsRaw = (error as { details?: unknown } | null)?.details;
  const details = isStudioErrorDetails(detailsRaw) ? detailsRaw : null;
  const server = messageOf(error);
  // Codes where the server's own words are the useful part: it knows which
  // version was taken, which role was needed, what failed validation.
  const keepServer = code !== "internal" && code !== "unknown" && code !== "unavailable" && meaningful(server, code);
  const message = keepServer ? server : (CALL_MESSAGES[code] ?? CALL_MESSAGES["unknown"]!);
  return new StudioCallError(message, code, details);
}

/** Sign-in failures, in words. Returns null for ones that need no message (a second popup superseding the first). */
export function authErrorMessage(error: unknown): string | null {
  const code = codeOf(error) ?? "";
  switch (code) {
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this site, then press Sign in again.";
    case "auth/popup-closed-by-user":
      return "The sign-in window was closed before you finished. Press Sign in when you’re ready.";
    case "auth/cancelled-popup-request":
      return null;
    case "auth/network-request-failed":
      return "Couldn’t reach Google to sign you in. Check your internet connection and try again.";
    case "auth/unauthorized-domain":
      return "This web address isn’t allowed to sign in to the study’s Firebase project. An administrator needs to add it to the project’s authorised domains (Firebase console → Authentication → Settings).";
    case "auth/user-disabled":
      return "This account has been disabled for the study. Ask the study’s technical lead why.";
    case "auth/internal-error":
      return "Google sign-in didn’t complete. Try again in a moment.";
    default:
      return "Sign-in didn’t work. Try again, and if it keeps happening, tell the study’s technical lead.";
  }
}

/** Why a Firestore read failed, in words. `what` names the thing, e.g. "the list of surveys". */
export function readErrorMessage(error: unknown, what: string): string {
  const code = (codeOf(error) ?? "").replace(/^firestore\//, "");
  switch (code) {
    case "permission-denied":
      return `Your account isn’t allowed to see ${what}.`;
    case "unavailable":
      return `Couldn’t reach the database to load ${what}. Check your connection; this updates by itself when you’re back online.`;
    case "failed-precondition":
      return `The database isn’t set up to list ${what} yet (it needs an index). Tell the study’s technical lead.`;
    case "unauthenticated":
      return "Your sign-in has expired. Sign in again.";
    default:
      return `Couldn’t load ${what}. Try again.`;
  }
}

export type SaveErrorKind = "offline" | "permission" | "other";

/** How a failed draft save should be handled — see save-machine.ts. */
export function classifySaveError(error: unknown): { kind: SaveErrorKind; message: string } {
  const code = (codeOf(error) ?? "").replace(/^firestore\//, "");
  if (code === "unavailable") return { kind: "offline", message: "You’re offline." };
  if (code === "permission-denied" || code === "unauthenticated") {
    return { kind: "permission", message: "You no longer have permission to edit this survey." };
  }
  if (code === "resource-exhausted") return { kind: "other", message: "The database is busy, so the draft couldn’t be saved." };
  if (code === "deadline-exceeded") return { kind: "other", message: "Saving took too long and was stopped." };
  return { kind: "other", message: "The draft couldn’t be saved." };
}
