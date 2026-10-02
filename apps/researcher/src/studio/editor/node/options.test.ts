import { describe, expect, it } from "vitest";
import {
  addOption,
  addOtherOption,
  addQuestion,
  findQuestion,
  forkScale,
  liveQuestions,
  removeOption,
  unlockModule,
  updateOption,
  type StudioDraft,
} from "@myself/studio";
import { liveDraft } from "./fixture.js";
import {
  dropIndex,
  kindLabel,
  listPublished,
  moveIndex,
  newOptionLabel,
  optionsAccess,
  otherBlocked,
  relabelWarning,
  removalConsequence,
  removeBlocked,
  sharedWith,
} from "./options.js";

/** Whether the model itself would let an option of this question be edited. */
function modelAllows(d: StudioDraft, itemKey: string, code: number): boolean {
  try {
    updateOption(d, itemKey, code, { label: "Probe" });
    return true;
  } catch {
    return false;
  }
}

function scaled(d: StudioDraft) {
  const seen = new Set<string>();
  return liveQuestions(d).filter((q) => "scale" in q.item && !seen.has(q.itemKey) && seen.add(q.itemKey));
}

describe("whether a question's options can be edited", () => {
  it("agrees with the model for every choice question of the live survey", () => {
    const d = liveDraft();
    const questions = scaled(d);
    expect(questions.length).toBeGreaterThan(100);
    for (const q of questions) {
      const code = d.scales[(q.item as { scale: string }).scale]!.options[0]!.code;
      expect({ itemKey: q.itemKey, editable: optionsAccess(d, q.itemKey).editable }).toEqual({ itemKey: q.itemKey, editable: modelAllows(d, q.itemKey, code) });
    }
  });

  it("still agrees once the identity module is unlocked (linkage stays fixed)", () => {
    const d = unlockModule(liveDraft(), "ybm_identity", { by: "t", at: "2026-09-28T00:00:00Z", reason: "Rewording a hint, linkage unaffected." }).draft;
    for (const q of scaled(d)) {
      const code = d.scales[(q.item as { scale: string }).scale]!.options[0]!.code;
      expect({ itemKey: q.itemKey, editable: optionsAccess(d, q.itemKey).editable }).toEqual({ itemKey: q.itemKey, editable: modelAllows(d, q.itemKey, code) });
    }
    const month = optionsAccess(d, "ybm_identity.ps_birth_month");
    expect(month.editable).toBe(false);
    if (!month.editable) expect(month.why).toBe("linkage");
  });

  it("says why, in the researcher's words", () => {
    const d = liveDraft();
    const sdq = optionsAccess(d, "sdq25_s.q1");
    expect(sdq.editable).toBe(false);
    if (!sdq.editable) {
      expect(sdq.why).toBe("locked");
      expect(sdq.reason).toMatch(/licence/);
      expect(sdq.canFork).toBe(false);
    }
    const consent = optionsAccess(d, "ybm_demographics.ethnicity");
    expect(consent.editable).toBe(true);
  });

  it("offers a copy of the list when it is shared with something that can't change", () => {
    let d = liveDraft();
    // A Studio question given the SDQ's list shares it with a licensed questionnaire.
    const added = addQuestion(d, { sectionKey: "wellbeing", typeId: "single_choice", text: "How are you?" });
    d = added.draft;
    d = structuredClone(d);
    const item = liveQuestions(d).find((q) => q.itemKey === added.itemKey)!.item as { scale: string };
    const sdqScale = (liveQuestions(d).find((q) => q.itemKey === "sdq25_s.q1")!.item as { scale: string }).scale;
    item.scale = sdqScale;
    const access = optionsAccess(d, added.itemKey);
    expect(access.editable).toBe(false);
    if (!access.editable) {
      expect(access.why).toBe("shared");
      expect(access.canFork).toBe(true);
    }
    const forked = forkScale(d, added.itemKey).draft;
    expect(optionsAccess(forked, added.itemKey).editable).toBe(true);
  });
});

describe("sharing and publishing", () => {
  it("lists the other questions using the same list", () => {
    const d = liveDraft();
    const shared = sharedWith(d, "ybm_smartphone.own");
    expect(shared.live).toHaveLength(4);
    expect(shared.live).not.toContain("ybm_smartphone.own");
    expect(shared.live).toContain("ybm_demographics.medication");
  });

  it("counts a list as published when any question using it was", () => {
    const d = liveDraft();
    expect(listPublished(d, "ybm_smartphone.own", new Set(["ybm_social_media.family_control"]))).toBe(true);
    expect(listPublished(d, "ybm_smartphone.own", new Set(["kss.q1"]))).toBe(false);
  });

  it("warns what a published value meant when an option is reworded", () => {
    const published = new Map([[2, "Sometimes"]]);
    expect(relabelWarning(published, { code: 2, label: "Often" })).toBe(
      "Answers already recorded as 2 meant “Sometimes”. If the meaning has changed, add a new option instead, so old and new answers aren't mixed.",
    );
    expect(relabelWarning(published, { code: 2, label: "Sometimes " })).toBeNull();
    expect(relabelWarning(undefined, { code: 2, label: "Often" })).toBeNull();
  });

  it("explains that a removed published value is retired and never reused", () => {
    const published = new Map([[3, "Hardly ever"]]);
    expect(removalConsequence({ code: 3, label: "Rarely" }, true, published)).toMatch(/recorded as 3 meant “Hardly ever”.*retired/);
    expect(removalConsequence({ code: 3, label: "Rarely" }, false, undefined)).toMatch(/Nobody has answered/);
    // Whether anything was published under this list isn't known (a list of its own, or still loading).
    expect(removalConsequence({ code: 3, label: "Rarely" }, true, undefined)).toMatch(/^Any answers already recorded as 3 keep their meaning, “Rarely”\..*retired/);
  });

  // REVIEW FIX: an option added since the list was last published was said to
  // have recorded answers ("Answers already recorded as 5 meant …").
  it("doesn't claim answers were recorded under a value added since the last publish, but says it is still retired", () => {
    const text = removalConsequence({ code: 5, label: "Other" }, true, new Map([[1, "Yes"], [2, "No"]]));
    expect(text).not.toMatch(/meant/);
    expect(text).toMatch(/added after this list was last published, so no answers are recorded as 5 yet/);
    expect(text).toMatch(/5 is retired anyway/);
    // …which is what the model does: a published list's removed value is retired, however new.
    const published = new Set(["ybm_demographics.gender"]);
    const added = addOption(liveDraft(), "ybm_demographics.gender", { label: "Other" });
    const scaleKey = (findQuestion(added.draft, "ybm_demographics.gender")!.item as { scale: string }).scale;
    const removed = removeOption(added.draft, "ybm_demographics.gender", added.code, { published, at: "2026-09-28T00:00:00Z" }).draft;
    expect(removed.retiredCodes[scaleKey]?.map((r) => r.code)).toContain(added.code);
  });
});

describe("option rows", () => {
  it("won't remove below two options", () => {
    expect(removeBlocked({ options: [{ code: 1, label: "a" }, { code: 2, label: "b" }] })).toMatch(/at least two/);
    expect(removeBlocked({ options: [{ code: 1, label: "a" }, { code: 2, label: "b" }, { code: 3, label: "c" }] })).toBeNull();
  });

  it("labels a new option without repeating one", () => {
    expect(newOptionLabel({ options: [{ code: 1, label: "Option 3" }, { code: 2, label: "b" }] })).toBe("Option 4");
    expect(newOptionLabel({ options: [{ code: 1, label: "a" }, { code: 2, label: "b" }] })).toBe("Option 3");
  });

  it("moves by keyboard within the list and stops at the ends", () => {
    expect(moveIndex(0, -1, 4)).toBeNull();
    expect(moveIndex(3, 1, 4)).toBeNull();
    expect(moveIndex(1, 1, 4)).toBe(2);
  });

  it("turns a drop above or below a row into moveOption's index", () => {
    // [a, b, c, d]: drag a (0) below c (2) → a lands at index 2 once taken out.
    expect(dropIndex(0, 2, true)).toBe(2);
    expect(dropIndex(0, 2, false)).toBe(1);
    // Drag d (3) above b (1) → index 1.
    expect(dropIndex(3, 1, false)).toBe(1);
    expect(dropIndex(3, 1, true)).toBe(2);
  });

  it("names each kind of option plainly", () => {
    expect(kindLabel("decline")).toBe("Prefer not to say");
    expect(kindLabel(undefined)).toBe("Normal");
  });

  it("offers “Other” only where the model would add it", () => {
    let d = liveDraft();
    expect(otherBlocked(d, "sdq25_s.q1")).toMatch(/licensed/);
    expect(otherBlocked(d, "ybm_demographics.gender")).toBeNull();
    d = addOtherOption(d, "ybm_demographics.gender").draft;
    expect(otherBlocked(d, "ybm_demographics.gender")).toMatch(/already/);
    expect(otherBlocked(d, "ybm_social_media.abstain_days")).toMatch(/single- and multiple-choice/);
  });
});
