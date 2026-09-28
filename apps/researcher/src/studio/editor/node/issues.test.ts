import { describe, expect, it } from "vitest";
import { findQuestion, scaleUsage, updateOption, updateQuestion, updateScreen, validateDraft, type Issue } from "@myself/studio";
import { liveDraft } from "./fixture.js";
import { blockIssues, focusSelectors, GENERAL, issuesAt, leadIssue, questionField, questionIssues, rescueSelectors, screenIssues, sectionIssues } from "./issues.js";

describe("issues sorted to fields", () => {
  it("puts a question's missing text on its stem field", () => {
    const d = updateQuestion(liveDraft(), "ybm_smartphone.own", { stem: { text: "" } }).draft;
    const fields = questionIssues(validateDraft(d), "ybm_smartphone.own");
    expect(fields.byField.get("stem")?.map((i) => i.code)).toContain("question.text_missing");
  });

  it("shows an option problem on every question sharing the list, not only the one it is reported at", () => {
    // scale.yes_no is shared by five questions; its problems are reported at the first.
    let d = liveDraft();
    const users = scaleUsage(d, "scale.yes_no");
    expect(users.length).toBe(5);
    const owner = users[0]!;
    const other = users[3]!;
    // An empty label can't be typed through the op, so write it into the list directly.
    d = structuredClone(d);
    d.scales["scale.yes_no"]!.options[1]!.label = " ";
    const issues = validateDraft(d);
    const atOwner = questionIssues(issues, owner, users);
    expect(atOwner.byOption.get(2)?.some((i) => i.code === "options.label_missing")).toBe(true);
    const atOther = questionIssues(issues, other, users);
    expect(atOther.byOption.get(2)?.some((i) => i.code === "options.label_missing")).toBe(true);
    // Without the list's users, the other question would not see it.
    expect(questionIssues(issues, other).byOption.get(2)).toBeUndefined();
  });

  it("reports a relabelled published option at the option's code", () => {
    const d = updateOption(liveDraft(), "ybm_demographics.medication", 2, { label: "Nope" }).draft;
    const published = new Map([["scale.yes_no", new Map([[1, "Yes"], [2, "No"]])]]);
    const issues = validateDraft(d, { publishedScaleCodes: published });
    const users = scaleUsage(d, "scale.yes_no");
    const fields = questionIssues(issues, "ybm_smartphone.own", users);
    expect(fields.byOption.get(2)?.map((i) => i.code)).toContain("options.relabelled");
  });

  it("orders errors before warnings", () => {
    const warn = (field: string): Issue => ({ severity: "warning", code: "w", message: "w", location: { kind: "question", itemKey: "a.b", field } });
    const err = (field: string): Issue => ({ severity: "error", code: "e", message: "e", location: { kind: "question", itemKey: "a.b", field } });
    const fields = questionIssues([warn("stem"), err("stem")], "a.b");
    expect(leadIssue(fields.byField.get("stem"))?.severity).toBe("error");
  });

  it("names question fields by their first part, and options as the list", () => {
    expect(questionField({ kind: "question", field: "fields.game_1" })).toBe("fields");
    expect(questionField({ kind: "option" })).toBe("options");
    expect(questionField({ kind: "question" })).toBe(GENERAL);
  });

  it("keeps start-screen and completion fields whole, and finds a missing screen under its body", () => {
    const d = updateScreen(liveDraft(), "finish", { body: "Thanks {nickname}" }).draft;
    const fields = screenIssues(validateDraft(d), "completion");
    expect(issuesAt(fields, "screens.finish.body").map((i) => i.code)).toContain("pipe.unresolved");
    const missing: Issue = { severity: "error", code: "x", message: "x", location: { kind: "completion", field: "screens.finish" } };
    expect(issuesAt(screenIssues([missing], "completion"), "screens.finish.body")).toEqual([missing]);
  });

  it("finds a section's and a block's issues by their keys", () => {
    const d = structuredClone(liveDraft());
    d.composition.sections[3]!.title = "";
    const issues = validateDraft(d);
    const key = d.composition.sections[3]!.key;
    expect(sectionIssues(issues, key).byField.get("title")?.[0]?.code).toBe("section.title_missing");
    const block: Issue = { severity: "error", code: "b", message: "b", location: { kind: "block", sectionKey: "sleep", refKey: "kss@1.0", field: "displayIf" } };
    expect(blockIssues([block], "sleep", "kss@1.0").byField.get("displayIf")).toEqual([block]);
    expect(blockIssues([block], "wellbeing", "kss@1.0").all).toEqual([]);
  });

  it("stays quiet about questions that validate", () => {
    const d = liveDraft();
    const q = findQuestion(d, "kss.q1");
    expect(q).not.toBeNull();
    expect(questionIssues(validateDraft(d), "kss.q1").all).toEqual([]);
  });
});

describe("focus selectors for a jump", () => {
  it("tries the whole field, a list row, then the list", () => {
    expect(focusSelectors("fields.game_1")).toEqual([
      '[data-field="fields.game_1"]',
      '[data-field="fields"] [data-row-key="game_1"]',
      '[data-field="fields"]',
    ]);
  });

  it("finds an option by its code", () => {
    expect(focusSelectors("options:3")[0]).toBe('[data-option-code="3"]');
    expect(focusSelectors("option.12")[0]).toBe('[data-option-code="12"]');
  });

  it("falls back from a participant-code field to the block of them", () => {
    const s = focusSelectors("participantCode.pattern");
    expect(s[0]).toBe('[data-field="participantCode.pattern"]');
    expect(s[s.length - 1]).toBe('[data-field="participantCode"]');
  });
});

// REVIEW FIX: focus that an action would drop to the top of the page goes back
// to the nearest field still on screen, else the centre editor's heading.
describe("where lost focus goes back to", () => {
  it("tries the fields around the lost control, innermost first, then the heading", () => {
    expect(rescueSelectors({ panel: ".ste-centre", fields: ["moreInfo.label", "moreInfo"] })).toEqual([
      '.ste-centre [data-field="moreInfo.label"]',
      '.ste-centre [data-field="moreInfo"]',
      ".ste-centre [data-editor-heading]",
    ]);
  });

  it("goes to the centre's heading from a settings-panel button that belongs to no field (Archive)", () => {
    expect(rescueSelectors({ panel: ".ste-right", fields: [] })).toEqual([".ste-centre [data-editor-heading]"]);
  });

  it("quotes field names inside the selector", () => {
    expect(rescueSelectors({ panel: ".ste-centre", fields: ['a"b'] })[0]).toBe(String.raw`.ste-centre [data-field="a\"b"]`);
  });
});
