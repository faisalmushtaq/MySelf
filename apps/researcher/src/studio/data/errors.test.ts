import { describe, expect, it } from "vitest";
import { StudioCallError, authErrorMessage, classifySaveError, readErrorMessage, toStudioCallError } from "./errors.js";

/** What the Firebase Functions SDK rejects with: a FirebaseError with a prefixed code and optional details. */
function fnError(code: string, message: string, details?: unknown) {
  return Object.assign(new Error(message), { code: `functions/${code}`, details });
}

describe("callable errors", () => {
  it("strips the prefix and keeps the structured details the functions attach", () => {
    const e = toStudioCallError(
      fnError("failed-precondition", "r8.0.0 has already been published. Choose a later version number.", {
        kind: "version_taken",
        version: "8.0.0",
      }),
    );
    expect(e).toBeInstanceOf(StudioCallError);
    expect(e.code).toBe("failed-precondition");
    expect(e.details).toEqual({ kind: "version_taken", version: "8.0.0" });
    expect(e.message).toBe("r8.0.0 has already been published. Choose a later version number.");
  });

  it("keeps validation issues in the details", () => {
    const issues = [{ severity: "error", code: "question.text_missing", message: "Add the question text.", location: { kind: "question" } }];
    const e = toStudioCallError(fnError("invalid-argument", "The draft has 1 problem to fix.", { kind: "invalid", issues, gate: [] }));
    expect(e.details).toMatchObject({ kind: "invalid", issues });
  });

  it("replaces the bare code the SDK fills in with a sentence", () => {
    for (const [code, message] of [
      ["internal", "internal"],
      ["internal", "INTERNAL"],
      ["unavailable", "unavailable"],
      ["unknown", ""],
    ] as const) {
      const e = toStudioCallError(fnError(code, message));
      expect(e.message).not.toMatch(/^(internal|unavailable|unknown)?$/i);
      expect(e.message.length).toBeGreaterThan(20);
    }
  });

  it("never shows a developer’s network message", () => {
    const e = toStudioCallError(fnError("unavailable", "Failed to fetch"));
    expect(e.message).toMatch(/can’t be reached/);
  });

  it("ignores details that are not one of the agreed shapes", () => {
    expect(toStudioCallError(fnError("permission-denied", "Only publishers can do that.", { foo: 1 })).details).toBeNull();
  });

  it("gives a sentence for errors that are not Firebase errors at all", () => {
    const e = toStudioCallError(new TypeError("x is undefined"));
    expect(e.code).toBe("unknown");
    expect(e.message).toMatch(/Something went wrong/);
  });

  it("passes a StudioCallError through untouched", () => {
    const original = new StudioCallError("Already said.", "aborted", null);
    expect(toStudioCallError(original)).toBe(original);
  });
});

describe("sign-in errors", () => {
  it("explains each failure a person can do something about", () => {
    expect(authErrorMessage({ code: "auth/popup-blocked" })).toMatch(/pop-ups/);
    expect(authErrorMessage({ code: "auth/popup-closed-by-user" })).toMatch(/closed/);
    expect(authErrorMessage({ code: "auth/network-request-failed" })).toMatch(/connection/);
    expect(authErrorMessage({ code: "auth/unauthorized-domain" })).toMatch(/authorised domains/);
  });

  it("says nothing when one sign-in window replaced another", () => {
    expect(authErrorMessage({ code: "auth/cancelled-popup-request" })).toBeNull();
  });

  it("never shows a bare code", () => {
    expect(authErrorMessage({ code: "auth/something-new" })).not.toMatch(/auth\//);
  });
});

describe("save and read errors", () => {
  it("treats an unreachable database as offline", () => {
    expect(classifySaveError({ code: "unavailable" }).kind).toBe("offline");
  });

  it("treats a refusal by the rules as lost permission", () => {
    expect(classifySaveError({ code: "permission-denied" })).toEqual({
      kind: "permission",
      message: "You no longer have permission to edit this survey.",
    });
  });

  it("treats anything else as a failure to retry", () => {
    expect(classifySaveError(new Error("boom")).kind).toBe("other");
  });

  it("names what could not be read", () => {
    expect(readErrorMessage({ code: "permission-denied" }, "the list of surveys")).toBe(
      "Your account isn’t allowed to see the list of surveys.",
    );
    expect(readErrorMessage({ code: "failed-precondition" }, "the activity log")).toMatch(/index/);
  });
});
