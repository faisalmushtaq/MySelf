import { HttpsError, type FunctionsErrorCode } from "firebase-functions/v2/https";
import type { Bump, Issue, IssueLocation, StudioErrorDetails, StudioRole } from "@myself/studio";
import type { z } from "zod";

/**
 * How a Studio function says no.
 *
 * Every refusal is an HttpsError whose `details` is a `StudioErrorDetails`
 * from the contract, so the editor can show the exact problem — the issues,
 * the revision that beat you to it, the lowest version allowed — rather than
 * parse a sentence. The message is written for the researcher reading it, and
 * the Studio shows it as it is (apps/researcher data/errors.ts keeps a
 * function's own message for every code but internal, unknown and unavailable).
 */

export function refusal(code: FunctionsErrorCode, message: string, details: StudioErrorDetails): HttpsError {
  return new HttpsError(code, message, details);
}

/** One blocking problem, located at the survey as a whole unless said otherwise. */
export function problem(code: string, message: string, location: IssueLocation = { kind: "survey" }): Issue {
  return { severity: "error", code, message, location };
}

export const refuse = {
  unauthenticated: (needed: StudioRole): HttpsError =>
    refusal("unauthenticated", "Sign in with your Google account to use MySelf Studio.", { kind: "forbidden", needed }),

  forbidden: (needed: StudioRole, message: string): HttpsError => refusal("permission-denied", message, { kind: "forbidden", needed }),

  notFound: (what: string, message: string): HttpsError => refusal("not-found", message, { kind: "not_found", what }),

  conflict: (currentRevision: number): HttpsError =>
    refusal(
      "aborted",
      `Someone saved the draft (now revision ${currentRevision}) after you last loaded it, so nothing was changed. Reload the draft, check it, and try again.`,
      { kind: "conflict", currentRevision },
    ),

  versionTaken: (version: string): HttpsError =>
    refusal("already-exists", `Version ${version} has already been published. Choose a higher version number.`, {
      kind: "version_taken",
      version,
    }),

  bumpTooSmall: (required: Bump, minimumVersion: string, message: string): HttpsError =>
    refusal("invalid-argument", message, { kind: "bump_too_small", required, minimumVersion }),

  /** A refusal that is a list of problems: validation, the gate, or one rule with a code. */
  invalid: (message: string, issues: Issue[], gate: string[] = [], code: FunctionsErrorCode = "failed-precondition"): HttpsError =>
    refusal(code, message, { kind: "invalid", issues, gate }),
};

/**
 * A request, checked. Anything that does not match is refused as
 * `invalid-argument` with one issue per field, in words, before a single
 * document is read: every path a function builds is built from values that
 * passed this.
 */
export function parseRequest<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data as z.output<S>;
  const issues = parsed.error.issues.slice(0, 20).map((i) => {
    const field = i.path.join(".");
    return problem("request.invalid", field ? `${field}: ${i.message}` : i.message, { kind: "survey", ...(field ? { field } : {}) });
  });
  const summary = issues.map((i) => i.message).join("; ");
  throw refuse.invalid(`The request was not accepted: ${summary}`, issues, [], "invalid-argument");
}
