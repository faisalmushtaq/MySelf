import { describe, expect, it } from "vitest";
import type { ChangeEntry, ChangeKind } from "@myself/studio";
import { changeGroups } from "./common.js";

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
