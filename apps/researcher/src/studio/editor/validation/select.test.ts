import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, outline, validateDraft, type Issue, type IssueLocation } from "@myself/studio";
import { groupIssues, selectionFor } from "./select.js";

const r710 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8"));
const draft = extractDraft(r710);
const o = outline(draft);

const issue = (location: IssueLocation, severity: Issue["severity"] = "error"): Issue => ({ severity, code: "test", message: "Something", location });

describe("where “Go to” goes", () => {
  it("opens the question for a question's or an option's issue", () => {
    expect(selectionFor(issue({ kind: "question", itemKey: "kss.q1", sectionKey: "sleep", field: "stem" }))).toEqual({ kind: "question", itemKey: "kss.q1" });
    expect(selectionFor(issue({ kind: "option", itemKey: "kss.q1", optionCode: 4, field: "options" }))).toEqual({ kind: "question", itemKey: "kss.q1" });
  });

  it("finds a block by its instrument within the section", () => {
    const sdq = o.sections.find((s) => s.key === "wellbeing")!.blocks[1]!;
    expect(selectionFor(issue({ kind: "block", sectionKey: "wellbeing", refKey: sdq.refKey }), o)).toEqual({
      kind: "block",
      sectionKey: "wellbeing",
      componentIndex: 1,
    });
    // Without the outline, or a block no longer there, the section is the nearest place.
    expect(selectionFor(issue({ kind: "block", sectionKey: "wellbeing", refKey: sdq.refKey }))).toEqual({ kind: "section", sectionKey: "wellbeing" });
    expect(selectionFor(issue({ kind: "block", sectionKey: "wellbeing", refKey: "gone@1.0/en-GB/self/standard" }), o)).toEqual({
      kind: "section",
      sectionKey: "wellbeing",
    });
  });

  it("opens sections, the start and completion screens, and settings for the survey as a whole", () => {
    expect(selectionFor(issue({ kind: "section", sectionKey: "sleep", field: "title" }))).toEqual({ kind: "section", sectionKey: "sleep" });
    expect(selectionFor(issue({ kind: "welcome", field: "participantCode.pattern" }))).toEqual({ kind: "welcome" });
    expect(selectionFor(issue({ kind: "completion", field: "screens.finish.body" }))).toEqual({ kind: "completion" });
    expect(selectionFor(issue({ kind: "survey" }))).toEqual({ kind: "settings" });
  });
});

describe("grouping issues for the panel", () => {
  it("puts errors before warnings, each in the order a participant meets them", () => {
    const issues: Issue[] = [
      issue({ kind: "survey" }),
      issue({ kind: "question", itemKey: "ybm_gaming.social_pct", sectionKey: "gaming" }, "warning"),
      issue({ kind: "completion" }),
      issue({ kind: "question", itemKey: "kss.q1", sectionKey: "sleep", field: "stem" }),
      issue({ kind: "option", itemKey: "kss.q1", optionCode: 2 }),
      issue({ kind: "welcome" }),
      issue({ kind: "section", sectionKey: "sleep", field: "title" }),
    ];
    const grouped = groupIssues(issues, o);
    expect(grouped.errors.map((g) => g.label)).toEqual([
      "Start screen",
      "Section: Sleep",
      "“How sleepy are you feeling right now?” (kss.q1)",
      "Completion screen",
      "The whole survey",
    ]);
    expect(grouped.errors[2]!.issues).toHaveLength(2);
    expect(grouped.errors[2]!.context).toBe("Sleep");
    expect(grouped.warnings.map((g) => g.id)).toEqual(["q:ybm_gaming.social_pct"]);
  });

  it("groups the live survey's own warnings under their questions", () => {
    const grouped = groupIssues(validateDraft(draft), o);
    expect(grouped.errors).toEqual([]);
    expect(grouped.warnings.length).toBeGreaterThan(0);
    for (const g of grouped.warnings) expect(g.label).toMatch(/\((ybm_[a-z_]+\.[a-z0-9_]+)\)$/);
  });
});
