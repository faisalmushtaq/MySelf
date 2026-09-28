import { describe, expect, it } from "vitest";
import { findQuestion, updateOption, updateQuestion, updateSection } from "@myself/studio";
import { liveDraft } from "./fixture.js";
import { neighbourOf } from "./options.js";
import { unlessUnchanged } from "./unchanged.js";

/**
 * REVIEW FIX: an edit that changes nothing must hand back the draft it was
 * given, so the editor records no empty undo step and autosave writes nothing
 * (the editor's `apply` ignores an identical draft).
 */
describe("edits that change nothing", () => {
  const itemKey = "ybm_smartphone.own";
  const item = (d: ReturnType<typeof liveDraft>) => findQuestion(d, itemKey)?.item;

  it("keeps the draft when a space is typed into an empty optional box", () => {
    const d = liveDraft();
    expect(findQuestion(d, itemKey)!.item.hint).toBeUndefined();
    // What the help-text box sends for "  ": remove the hint, which isn't there.
    const after = updateQuestion(d, itemKey, { hint: null }).draft;
    expect(after).not.toBe(d); // the model always returns a copy…
    expect(unlessUnchanged(d, after, item)).toBe(d); // …which is recognised as no change
  });

  it("keeps the draft when an option label gains only a trailing space (stored trimmed)", () => {
    const d = liveDraft();
    const scaleKey = (findQuestion(d, itemKey)!.item as { scale: string }).scale;
    const option = d.scales[scaleKey]!.options[0]!;
    const after = updateOption(d, itemKey, option.code, { label: `${option.label} ` }).draft;
    expect(unlessUnchanged(d, after, (x) => x.scales[scaleKey])).toBe(d);
  });

  it("keeps the draft for a section title that only gained a trailing space", () => {
    const d = liveDraft();
    const after = updateSection(d, "sleep", { title: `${d.composition.sections.find((s) => s.key === "sleep")!.title} ` }).draft;
    expect(unlessUnchanged(d, after, (x) => x.composition.sections.find((s) => s.key === "sleep")?.title)).toBe(d);
  });

  it("passes a real change through", () => {
    const d = liveDraft();
    const after = updateQuestion(d, itemKey, { hint: "Any phone counts." }).draft;
    expect(unlessUnchanged(d, after, item)).toBe(after);
  });
});

describe("list rows", () => {
  it("moves focus to the next row when one is removed, else the one before", () => {
    const rows = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(neighbourOf(rows, 0)).toBe("b");
    expect(neighbourOf(rows, 1)).toBe("c");
    expect(neighbourOf(rows, 2)).toBe("b");
    expect(neighbourOf([{ key: "a" }], 0)).toBeNull();
  });
});
