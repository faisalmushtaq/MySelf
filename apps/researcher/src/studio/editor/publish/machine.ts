import { compareVersions } from "@myself/release/gate";
import { suggestBump, type Bump, type ChangeSummary, type Issue, type StudioErrorDetails } from "@myself/studio";
import { atLeastBump, checkChoice, defaultBump, largerBump } from "./version.js";

/**
 * Publishing, as a state machine.
 *
 * Publishing is the one action in the Studio that reaches children's screens,
 * so the dialog's behaviour is pinned down here, purely, and tested: which
 * step follows which, what has to be true to go on, and — above all — what a
 * failure means. The server's publish is one transaction (docs/16 §5.5), so a
 * refused publish published NOTHING, and every failure here says so; success
 * is claimed only once the public pointer has been read back naming the new
 * version, and a publish that went through but has not been seen yet is said
 * to be exactly that.
 *
 *   preparing ─► checks ─► changes ─► version ─► note ─► confirm ─► publishing ─► confirming ─► live
 *       │          (only with warnings)                                 │               └──► unconfirmed
 *       └─► stopped (save failed · errors · nothing to publish)         └─► failed ─► (retry · revise · close)
 */

export type PublishStep =
  | "preparing"
  | "checks"
  | "changes"
  | "version"
  | "note"
  | "confirm"
  | "publishing"
  | "confirming"
  | "live"
  | "unconfirmed"
  | "failed"
  | "stopped";

/** The steps a publisher moves through, in order, for the step indicator. */
export const STEPS = ["checks", "changes", "version", "note", "confirm"] as const;
export type FormStep = (typeof STEPS)[number];

export const STEP_TITLES: Record<FormStep, string> = {
  checks: "Checks",
  changes: "Changes",
  version: "Version",
  note: "Release note",
  confirm: "Confirm",
};

export const NOTE_MIN = 10;
export const NOTE_MAX = 2000;

/** How the save before publishing ended. */
export type PrepareOutcome =
  | { kind: "ready"; inputs: PublishInputs }
  | { kind: "conflict" | "error" | "offline" | "context"; message: string };

/** Everything the dialog decides with, taken once the latest changes are saved. */
export interface PublishInputs {
  /** The saved revision checked here — the one the server must still hold. */
  revision: number;
  issues: Issue[];
  summary: ChangeSummary;
  /** Highest version ever published; null for a survey never published. */
  latest: string | null;
  /** The live version, for "nothing has changed since r7.1.0". */
  liveVersion: string | null;
}

export type Stop =
  | { kind: "save"; reason: "conflict" | "error" | "offline" | "context"; message: string }
  | { kind: "errors"; errors: Issue[] }
  | { kind: "nothing"; liveVersion: string | null };

export type Failure =
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; issues: Issue[]; gate: string[]; message: string }
  | { kind: "version_taken"; version: string; message: string }
  | { kind: "bump_too_small"; required: Bump; minimumVersion: string; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "offline"; message: string }
  /** The server may have finished (it timed out): check before trying again. */
  | { kind: "uncertain"; message: string }
  | { kind: "other"; message: string };

export interface Published {
  version: string;
  hash: string;
  alreadyPublished: boolean;
}

export interface PublishState {
  step: PublishStep;
  inputs: PublishInputs | null;
  /** The smallest bump allowed: from the changes, raised if the server says so. */
  required: Bump | null;
  /** The highest version known to be taken: from the survey, raised if the server says so. */
  latest: string | null;
  bump: Bump | null;
  /** "I've reviewed these warnings." */
  reviewed: boolean;
  note: string;
  /** Set when the person tried to go on without doing what the step needs. */
  attempted: boolean;
  stop: Stop | null;
  failure: Failure | null;
  published: Published | null;
  /** Bumped on every fresh start, so the save-and-check effect runs again. */
  run: number;
  /** Bumped on every publish attempt, so the publishing effect runs once per attempt. */
  attempt: number;
}

export type PublishEvent =
  | { type: "prepared"; outcome: PrepareOutcome }
  | { type: "review"; reviewed: boolean }
  | { type: "choose"; bump: Bump }
  | { type: "note"; text: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "publish" }
  | { type: "published"; result: Published }
  | { type: "failed"; failure: Failure }
  | { type: "confirmed"; live: boolean }
  /** After a failure nothing was published: send the same request again. */
  | { type: "retry" }
  /** After a version was refused: back to choosing one. */
  | { type: "revise" }
  /** Start again from saving. */
  | { type: "restart" };

export function initialPublishState(): PublishState {
  return {
    step: "preparing",
    inputs: null,
    required: null,
    latest: null,
    bump: null,
    reviewed: false,
    note: "",
    attempted: false,
    stop: null,
    failure: null,
    published: null,
    run: 0,
    attempt: 0,
  };
}

export function warningsOf(s: Pick<PublishState, "inputs">): Issue[] {
  return s.inputs?.issues.filter((i) => i.severity === "warning") ?? [];
}

/** What is wrong with a release note, or null. */
export function noteProblem(text: string): string | null {
  const n = text.trim().length;
  if (n === 0) return "Write a release note: what changed and why.";
  if (n < NOTE_MIN) return `A release note needs at least ${NOTE_MIN} characters, so it says what changed.`;
  if (text.length > NOTE_MAX) return `Keep the release note to ${NOTE_MAX.toLocaleString("en-GB")} characters (it's ${text.length.toLocaleString("en-GB")}).`;
  return null;
}

/** The version the current choice publishes as ("8.0.0"), or null if there is no valid choice. */
export function chosenVersion(s: Pick<PublishState, "latest" | "bump" | "required">): string | null {
  const check = checkChoice(s.latest, s.bump, s.required);
  return check.ok ? check.version : null;
}

/** Why the current step can't be left forwards yet, or null when it can. */
export function blocker(s: PublishState): string | null {
  switch (s.step) {
    case "checks":
      return warningsOf(s).length > 0 && !s.reviewed ? "Tick “I’ve reviewed these warnings” to go on." : null;
    case "version": {
      const check = checkChoice(s.latest, s.bump, s.required);
      return check.ok ? null : check.message;
    }
    case "note":
      return noteProblem(s.note);
    default:
      return null;
  }
}

/** Closing now would abandon something in flight. */
export function inFlight(s: Pick<PublishState, "step">): boolean {
  return s.step === "publishing" || s.step === "confirming";
}

const FORWARD: Partial<Record<PublishStep, PublishStep>> = {
  checks: "changes",
  changes: "version",
  version: "note",
  note: "confirm",
};

function backFrom(s: PublishState): PublishStep {
  switch (s.step) {
    case "changes":
      return warningsOf(s).length > 0 ? "checks" : "changes";
    case "version":
      return "changes";
    case "note":
      return "version";
    case "confirm":
      return "note";
    default:
      return s.step;
  }
}

function maxVersion(a: string | null, b: string): string {
  if (a === null) return b;
  try {
    return compareVersions(b.replace(/^r/, ""), a.replace(/^r/, "")) > 0 ? b : a;
  } catch {
    return a;
  }
}

export function publishReducer(s: PublishState, e: PublishEvent): PublishState {
  switch (e.type) {
    case "prepared": {
      if (s.step !== "preparing") return s;
      const o = e.outcome;
      if (o.kind !== "ready") return { ...s, step: "stopped", stop: { kind: "save", reason: o.kind, message: o.message } };
      const errors = o.inputs.issues.filter((i) => i.severity === "error");
      if (errors.length > 0) return { ...s, inputs: o.inputs, step: "stopped", stop: { kind: "errors", errors } };
      const required = suggestBump(o.inputs.summary);
      if (required === null) return { ...s, inputs: o.inputs, step: "stopped", stop: { kind: "nothing", liveVersion: o.inputs.liveVersion } };
      const warnings = o.inputs.issues.some((i) => i.severity === "warning");
      return {
        ...s,
        inputs: o.inputs,
        required,
        latest: o.inputs.latest,
        bump: defaultBump(required),
        reviewed: false,
        attempted: false,
        step: warnings ? "checks" : "changes",
        stop: null,
      };
    }
    case "review":
      return s.step === "checks" ? { ...s, reviewed: e.reviewed } : s;
    case "choose":
      // A smaller bump than the changes need is never chosen, whatever asks.
      return s.step === "version" && atLeastBump(e.bump, s.required) ? { ...s, bump: e.bump } : s;
    case "note":
      return s.step === "note" ? { ...s, note: e.text.slice(0, NOTE_MAX + 200) } : s;
    case "next": {
      const to = FORWARD[s.step];
      if (!to) return s;
      if (blocker(s)) return { ...s, attempted: true };
      return { ...s, step: to, attempted: false };
    }
    case "back":
      return { ...s, step: backFrom(s), attempted: false };
    case "publish":
      if (s.step !== "confirm" || blocker({ ...s, step: "version" }) || noteProblem(s.note)) return s;
      return { ...s, step: "publishing", failure: null, attempt: s.attempt + 1 };
    case "published":
      return s.step === "publishing" ? { ...s, step: "confirming", published: e.result } : s;
    case "failed":
      if (s.step === "publishing") return { ...s, step: "failed", failure: e.failure };
      // The publish went through; only reading it back failed. Not a failure.
      if (s.step === "confirming") return { ...s, step: "unconfirmed" };
      return s;
    case "confirmed":
      return s.step === "confirming" ? { ...s, step: e.live ? "live" : "unconfirmed" } : s;
    case "retry":
      // Safe to repeat: the server returns the stored result for a version
      // already published from the same revision (docs/16 §5.5), so a retry
      // after a lost answer cannot publish twice.
      return s.step === "failed" && (s.failure?.kind === "offline" || s.failure?.kind === "other" || s.failure?.kind === "uncertain")
        ? { ...s, step: "publishing", failure: null, attempt: s.attempt + 1 }
        : s;
    case "revise": {
      if (s.step !== "failed" || !s.failure) return s;
      if (s.failure.kind === "version_taken") {
        return { ...s, step: "version", latest: maxVersion(s.latest, s.failure.version), failure: null, attempted: false };
      }
      if (s.failure.kind === "bump_too_small") {
        const required = s.required ? largerBump(s.required, s.failure.required) : s.failure.required;
        return { ...s, step: "version", required, bump: s.bump ? largerBump(s.bump, required) : required, failure: null, attempted: false };
      }
      return s;
    }
    case "restart":
      return { ...initialPublishState(), run: s.run + 1, note: s.note };
  }
}

/**
 * A refused publish, sorted by what the person can do about it. The server's
 * structured details decide; the code only fills in where there are none.
 */
export function classifyPublishError(
  error: { code?: string; message?: string; details?: StudioErrorDetails | null },
  /** `navigator.onLine` when the call failed; false means the browser knows it has no connection. */
  online = true,
): Failure {
  const message = error.message?.trim() || "The server refused the publish.";
  const d = error.details ?? null;
  // REVIEW FIX: the Functions SDK reports a request that never got an answer
  // (no connection) as "internal", not "unavailable", so being offline showed
  // "Something went wrong on the server" instead of saying so. When the
  // browser itself says it is offline, the request never left: say that.
  if (!d && !online && (error.code === "internal" || error.code === "unknown" || error.code === "unavailable")) {
    return { kind: "offline", message };
  }
  if (d) {
    switch (d.kind) {
      case "conflict":
        return { kind: "conflict", message };
      case "invalid":
        return { kind: "invalid", issues: d.issues ?? [], gate: d.gate ?? [], message };
      case "version_taken":
        return { kind: "version_taken", version: d.version, message };
      case "bump_too_small":
        return { kind: "bump_too_small", required: d.required, minimumVersion: d.minimumVersion, message };
      case "forbidden":
        return { kind: "forbidden", message };
      case "not_found":
        return { kind: "other", message };
    }
  }
  switch (error.code) {
    case "unavailable":
      return { kind: "offline", message };
    case "deadline-exceeded":
      return { kind: "uncertain", message };
    case "permission-denied":
    case "unauthenticated":
      return { kind: "forbidden", message };
    case "aborted":
      return { kind: "conflict", message };
    default:
      return { kind: "other", message };
  }
}

/** The headline for a failure. Every one but `uncertain` says plainly that nothing was published. */
export function failureTitle(f: Failure): string {
  switch (f.kind) {
    case "conflict":
      return "Nothing was published: someone saved the draft since you started";
    case "invalid":
      return "Nothing was published: the server found problems";
    case "version_taken":
      return `Nothing was published: r${f.version.replace(/^r/, "")} is already taken`;
    case "bump_too_small":
      return "Nothing was published: the version number is too small for these changes";
    case "forbidden":
      return "Nothing was published: your account can’t publish";
    case "offline":
      return "Nothing was published — you appear to be offline";
    case "uncertain":
      return "The server took too long to answer";
    case "other":
      return "Nothing was published";
  }
}
