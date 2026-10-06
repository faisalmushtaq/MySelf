import { describe, expect, it } from "vitest";
import { StudioCallError } from "../../data/errors.js";
import { saveError } from "./SaveModuleDialog.js";

/** A refused "Save to library", in words: above all, someone saving a newer version first (docs/16 §12.6). */
describe("a refused save to the library", () => {
  it("says plainly that someone saved a newer version first, and what to do", () => {
    const e = new StudioCallError("Someone saved a newer version…", "aborted", { kind: "conflict", currentRevision: 4 });
    const said = saveError(e, "Sleep habits", 3);
    expect(said.conflict).toBe(true);
    expect(said.title).toBe("Someone saved a newer version first");
    expect(said.body).toMatch(/“Sleep habits” is now at version 4.*nothing was saved/);
    expect(said.body).toMatch(/take the update/);
  });

  it("names a taken ID, an invalid piece, and a missing role", () => {
    expect(saveError(new StudioCallError("taken", "already-exists", { kind: "invalid", issues: [], gate: [] }), "Pets", null).title).toBe("That module ID is taken");
    const issues = [{ severity: "error" as const, code: "piece.locked", message: "Licensed content can’t be saved", location: { kind: "survey" as const } }];
    const invalid = saveError(new StudioCallError("This can't be saved…", "invalid-argument", { kind: "invalid", issues, gate: [] }), "Pets", null);
    expect(invalid.issues).toEqual(issues);
    expect(saveError(new StudioCallError("no", "permission-denied", null), "Pets", null).body).toMatch(/editor access/);
    expect(saveError(new Error("boom"), "Pets", null).body).toMatch(/couldn’t be saved/);
  });
});
