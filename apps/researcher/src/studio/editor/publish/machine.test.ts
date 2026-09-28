import { describe, expect, it } from "vitest";
import type { ChangeSummary, Issue } from "@myself/studio";
import {
  blocker,
  chosenVersion,
  classifyPublishError,
  failureTitle,
  inFlight,
  initialPublishState,
  NOTE_MAX,
  noteProblem,
  publishReducer,
  type PublishEvent,
  type PublishInputs,
  type PublishState,
} from "./machine.js";

const warning: Issue = { severity: "warning", code: "w", message: "Worth a look", location: { kind: "question", itemKey: "a.b" } };
const error: Issue = { severity: "error", code: "e", message: "Must fix", location: { kind: "question", itemKey: "a.c" } };

const changes = (bump: "major" | "minor" | "patch" | null): ChangeSummary => ({
  bump,
  entries: bump ? [{ kind: "question.changed", itemKey: "a.b", bump, breaking: false, message: "Changed a.b" }] : [],
  counts: { added: 0, removed: 0, archived: 0, changed: bump ? 1 : 0, moved: 0 },
});

const inputs = (over: Partial<PublishInputs> = {}): PublishInputs => ({
  revision: 12,
  issues: [],
  summary: changes("major"),
  latest: "7.1.0",
  liveVersion: "7.1.0",
  ...over,
});

const run = (events: PublishEvent[], from: PublishState = initialPublishState()) => events.reduce(publishReducer, from);
const ready = (over: Partial<PublishInputs> = {}): PublishEvent => ({ type: "prepared", outcome: { kind: "ready", inputs: inputs(over) } });

describe("before publishing", () => {
  it("stops, saying why, when the latest changes couldn't be saved", () => {
    for (const kind of ["conflict", "error", "offline"] as const) {
      const s = run([{ type: "prepared", outcome: { kind, message: "Because." } }]);
      expect(s.step).toBe("stopped");
      expect(s.stop).toEqual({ kind: "save", reason: kind, message: "Because." });
    }
  });

  it("stops on any error, listing the errors", () => {
    const s = run([ready({ issues: [warning, error] })]);
    expect(s.step).toBe("stopped");
    expect(s.stop).toEqual({ kind: "errors", errors: [error] });
  });

  it("stops when nothing has changed since the live version", () => {
    const s = run([ready({ summary: changes(null) })]);
    expect(s.stop).toEqual({ kind: "nothing", liveVersion: "7.1.0" });
  });

  it("asks for the warnings to be reviewed before going on", () => {
    let s = run([ready({ issues: [warning] })]);
    expect(s.step).toBe("checks");
    s = publishReducer(s, { type: "next" });
    expect(s.step).toBe("checks");
    expect(s.attempted).toBe(true);
    expect(blocker(s)).toMatch(/reviewed these warnings/);
    s = run([{ type: "review", reviewed: true }, { type: "next" }], s);
    expect(s.step).toBe("changes");
  });

  it("skips the checks step when there is nothing to review", () => {
    const s = run([ready()]);
    expect(s.step).toBe("changes");
    expect(publishReducer(s, { type: "back" }).step).toBe("changes");
  });
});

describe("choosing the version and writing the note", () => {
  const atVersion = () => run([ready({ summary: changes("minor") }), { type: "next" }]);

  it("defaults to the smallest bump the changes need, and never accepts a smaller one", () => {
    let s = atVersion();
    expect(s.step).toBe("version");
    expect(s.bump).toBe("minor");
    expect(chosenVersion(s)).toBe("7.2.0");
    s = publishReducer(s, { type: "choose", bump: "patch" });
    expect(s.bump).toBe("minor");
    s = publishReducer(s, { type: "choose", bump: "major" });
    expect(chosenVersion(s)).toBe("8.0.0");
  });

  it("requires a release note of a useful length", () => {
    let s = run([{ type: "next" }], atVersion());
    expect(s.step).toBe("note");
    s = run([{ type: "note", text: "Too short" }, { type: "next" }], s);
    expect(s.step).toBe("note");
    expect(blocker(s)).toMatch(/at least 10 characters/);
    s = run([{ type: "note", text: "Reworded the gaming questions after the pilot." }, { type: "next" }], s);
    expect(s.step).toBe("confirm");
    expect(noteProblem("x".repeat(NOTE_MAX + 1))).toMatch(/Keep the release note/);
    expect(noteProblem("   ")).toMatch(/Write a release note/);
  });

  it("goes back a step at a time, keeping what was entered", () => {
    const s = run([{ type: "next" }, { type: "note", text: "Reworded the gaming questions." }, { type: "next" }, { type: "back" }, { type: "back" }], atVersion());
    expect(s.step).toBe("version");
    expect(s.note).toBe("Reworded the gaming questions.");
  });
});

const confirmed = () =>
  run([ready(), { type: "next" }, { type: "next" }, { type: "note", text: "Reworded the gaming questions." }, { type: "next" }]);

describe("publishing", () => {
  it("publishes only from the confirm step, and can't be closed while in flight", () => {
    expect(publishReducer(run([ready()]), { type: "publish" }).step).toBe("changes");
    const s = publishReducer(confirmed(), { type: "publish" });
    expect(s.step).toBe("publishing");
    expect(s.attempt).toBe(1);
    expect(inFlight(s)).toBe(true);
  });

  it("claims success only once the live pointer is seen", () => {
    let s = run([{ type: "publish" }, { type: "published", result: { version: "8.0.0", hash: "sha256:abc", alreadyPublished: false } }], confirmed());
    expect(s.step).toBe("confirming");
    expect(inFlight(s)).toBe(true);
    expect(publishReducer(s, { type: "confirmed", live: true }).step).toBe("live");
    s = publishReducer(s, { type: "confirmed", live: false });
    expect(s.step).toBe("unconfirmed");
    expect(inFlight(s)).toBe(false);
  });

  it("treats a failure to read the pointer back as unconfirmed, not failed", () => {
    const s = run(
      [
        { type: "publish" },
        { type: "published", result: { version: "8.0.0", hash: "sha256:abc", alreadyPublished: false } },
        { type: "failed", failure: { kind: "offline", message: "No network" } },
      ],
      confirmed(),
    );
    expect(s.step).toBe("unconfirmed");
  });

  it("retries the same publish after a network failure", () => {
    let s = run([{ type: "publish" }, { type: "failed", failure: { kind: "offline", message: "No network" } }], confirmed());
    expect(s.step).toBe("failed");
    s = publishReducer(s, { type: "retry" });
    expect(s.step).toBe("publishing");
    expect(s.attempt).toBe(2);
  });

  it("does not retry a conflict: someone else's changes need reviewing first", () => {
    const s = run([{ type: "publish" }, { type: "failed", failure: { kind: "conflict", message: "Saved since" } }, { type: "retry" }], confirmed());
    expect(s.step).toBe("failed");
  });

  it("goes back to the version step, above the taken number, when a version is taken", () => {
    const s = run([{ type: "publish" }, { type: "failed", failure: { kind: "version_taken", version: "8.0.0", message: "Taken" } }, { type: "revise" }], confirmed());
    expect(s.step).toBe("version");
    expect(chosenVersion(s)).toBe("9.0.0");
  });

  it("raises the required bump when the server says the version is too small", () => {
    const start = run([ready({ summary: changes("minor") }), { type: "next" }, { type: "next" }, { type: "note", text: "Updated the welcome text." }, { type: "next" }]);
    expect(chosenVersion(start)).toBe("7.2.0");
    const s = run(
      [{ type: "publish" }, { type: "failed", failure: { kind: "bump_too_small", required: "major", minimumVersion: "8.0.0", message: "Too small" } }, { type: "revise" }],
      start,
    );
    expect(s.step).toBe("version");
    expect(s.required).toBe("major");
    expect(chosenVersion(s)).toBe("8.0.0");
  });

  it("starts again from saving, keeping the note", () => {
    const s = run([{ type: "restart" }], confirmed());
    expect(s.step).toBe("preparing");
    expect(s.run).toBe(1);
    expect(s.note).toBe("Reworded the gaming questions.");
  });
});

describe("reading a refused publish", () => {
  it("follows the server's structured details", () => {
    expect(classifyPublishError({ code: "aborted", message: "x", details: { kind: "conflict", currentRevision: 14 } }).kind).toBe("conflict");
    expect(classifyPublishError({ code: "failed-precondition", message: "x", details: { kind: "invalid", issues: [error], gate: ["gate says no"] } })).toEqual({
      kind: "invalid",
      issues: [error],
      gate: ["gate says no"],
      message: "x",
    });
    expect(classifyPublishError({ code: "already-exists", message: "x", details: { kind: "version_taken", version: "8.0.0" } }).kind).toBe("version_taken");
    expect(classifyPublishError({ code: "failed-precondition", message: "x", details: { kind: "bump_too_small", required: "major", minimumVersion: "8.0.0" } })).toMatchObject({
      kind: "bump_too_small",
      minimumVersion: "8.0.0",
    });
    expect(classifyPublishError({ code: "permission-denied", message: "x", details: { kind: "forbidden", needed: "publisher" } }).kind).toBe("forbidden");
  });

  it("falls back on the code, and never calls a timeout a clean failure", () => {
    expect(classifyPublishError({ code: "unavailable", message: "x", details: null }).kind).toBe("offline");
    expect(classifyPublishError({ code: "deadline-exceeded", message: "x", details: null }).kind).toBe("uncertain");
    expect(classifyPublishError({ code: "internal", message: "x", details: null }).kind).toBe("other");
  });

  it("says nothing was published for every failure the server reports as refused", () => {
    const kinds = ["conflict", "forbidden", "offline", "other"] as const;
    for (const kind of kinds) expect(failureTitle({ kind, message: "" })).toMatch(/Nothing was published/);
    expect(failureTitle({ kind: "invalid", issues: [], gate: [], message: "" })).toMatch(/Nothing was published/);
    expect(failureTitle({ kind: "version_taken", version: "8.0.0", message: "" })).toMatch(/Nothing was published: r8\.0\.0/);
    expect(failureTitle({ kind: "uncertain", message: "" })).not.toMatch(/Nothing was published/);
  });
});
