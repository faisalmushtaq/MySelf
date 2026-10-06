import { describe, expect, it } from "vitest";
import type { ChangeEntry, ChangeKind } from "@myself/studio";
import { changeGroups, describeAudit } from "./common.js";

const entry = (kind: ChangeKind | string, message: string): ChangeEntry => ({ kind: kind as ChangeKind, bump: "major", breaking: false, message });

describe("a change summary, grouped", () => {
  it("lists MyStory's changes under their own heading, after the sections and before the screens", () => {
    const groups = changeGroups({
      entries: [entry("completion.changed", "Changed the finishing screen."), entry("mystory.added", "MyStory added (np.phone_wellbeing@0.1.1)."), entry("section.added", "Added the section “Sleep”.")],
    });
    expect(groups.map((g) => g.title)).toEqual(["Sections", "MyStory", "Start and finish screens"]);
    expect(groups[1]!.entries.map((e) => e.message)).toEqual(["MyStory added (np.phone_wellbeing@0.1.1)."]);
  });

  it("never leaves a change out, whatever its kind", () => {
    expect(changeGroups({ entries: [entry("something.new", "A change of a kind nobody grouped.")] })).toEqual([
      { title: "Other changes", entries: [entry("something.new", "A change of a kind nobody grouped.")] },
    ]);
  });
});

describe("the activity log's study-space rows (D-56)", () => {
  const row = (action: string, detail: Record<string, unknown>) =>
    ({ at: "2026-10-06T10:00:00Z", actor: "u_owner", actorEmail: "owner@leeds.test", action, surveyId: null, subject: "future", detail }) as never;

  it("says who created, closed, reopened or renamed a study space", () => {
    expect(describeAudit(row("study.created", { title: "Perspectives of the future" }))).toBe(
      "owner@leeds.test created this study space, “Perspectives of the future”.",
    );
    expect(describeAudit(row("study.updated", { status: { from: "open", to: "closed" }, title: { from: "A", to: "A" } }))).toBe(
      "owner@leeds.test closed this study space.",
    );
    expect(describeAudit(row("study.updated", { status: { from: "closed", to: "open" }, title: { from: "A", to: "B" } }))).toBe(
      "owner@leeds.test reopened this study space and named it “B”.",
    );
  });
});
