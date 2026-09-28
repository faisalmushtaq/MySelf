import { describe, expect, it, vi } from "vitest";
import { extractDraft, outline, validateDraft, type Issue, type StudioDraft } from "@myself/studio";
import { bundledManifests } from "../releases.js";
import { describeRefusedDraft, placeOfIssue } from "./publish.js";

vi.mock("firebase-functions/logger", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn(), write: vi.fn() }));

/**
 * The sentence a refused publish comes back with. Validation's messages are
 * short and don't name their place (the editor shows each under it), so the
 * refusal — one sentence on its own — says where.
 */

const draftOf = (version: string): StudioDraft => extractDraft(bundledManifests.find((b) => b.manifest.release.version === version)!.raw);
const issue = (location: Issue["location"], message = "Add the question text", severity: Issue["severity"] = "error"): Issue => ({
  severity,
  code: "test",
  message,
  location,
});

describe("a refused publish", () => {
  const draft = draftOf("7.1.0");

  it("says where the first error is: the question's ID", () => {
    const d = structuredClone(draft);
    const q = outline(d).sections.flatMap((s) => s.blocks).find((b) => b.tier === "editable" && b.questions.length > 0)!.questions[0]!;
    // Blank a question's text, as the editor would.
    const item = (d.instruments[q.refKey] as unknown as { forms: { items: { key: string; stem: { text: string } }[] }[] }).forms[0]!.items.find(
      (i) => i.key === q.key,
    )!;
    item.stem.text = "";
    const errors = validateDraft(d).filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(describeRefusedDraft(errors, d)).toBe(`This draft can't be published: ${errors[0]!.message} (${q.itemKey})`);
  });

  it("names a section by its title, a block by its name, and the screens in words", () => {
    const section = draft.composition.sections[0]!;
    expect(placeOfIssue(issue({ kind: "section", sectionKey: section.key, field: "title" }), draft)).toBe(`section “${section.title}”`);
    const block = outline(draft).sections.flatMap((s) => s.blocks).find((b) => b.tier === "locked")!;
    expect(placeOfIssue(issue({ kind: "block", sectionKey: "x", refKey: block.refKey }), draft)).toBe(`block “${block.name}”`);
    expect(placeOfIssue(issue({ kind: "welcome", field: "participantCode.pattern" }), draft)).toBe("start screen");
    expect(placeOfIssue(issue({ kind: "completion" }), draft)).toBe("completion screen");
    expect(placeOfIssue(issue({ kind: "survey" }), draft)).toBeNull();
  });

  it("counts the errors, ignores warnings, and leaves a place-less error as it is", () => {
    const issues = [
      issue({ kind: "question", itemKey: "kss.q1" }, "Something to note", "warning"),
      issue({ kind: "survey" }, "Add a title"),
      issue({ kind: "question", itemKey: "kss.q2" }),
    ];
    expect(describeRefusedDraft(issues, draft)).toBe("This draft can't be published: there are 2 problems to fix first, starting with: Add a title");
    expect(describeRefusedDraft([issues[2]!], draft)).toBe("This draft can't be published: Add the question text (kss.q2)");
  });
});
