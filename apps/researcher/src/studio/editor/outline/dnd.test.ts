import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDraft, moveBlock, moveQuestion, moveSection, outline, StudioOpError, type Outline, type StudioDraft } from "@myself/studio";
import { applyMove, describeMoved, keyboardBlockMove, keyboardQuestionMove, keyboardSectionMove, moveLabel, planDrop, type MoveOp } from "./dnd.js";

const r710 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8"));
const draft = extractDraft(r710);
const o = outline(draft);
const counts = draft.composition.sections.map((s) => s.components.length);

/** Apply a planned move with the model's own operation, as the outline does. */
function apply(d: StudioDraft, move: MoveOp): StudioDraft {
  switch (move.op) {
    case "question":
      return moveQuestion(d, move.itemKey, move.to).draft;
    case "block":
      return moveBlock(d, move.from, move.to).draft;
    case "section":
      return moveSection(d, move.sectionKey, move.toIndex).draft;
  }
}

function sectionQuestions(out: Outline, sectionKey: string): string[] {
  return out.sections.find((s) => s.key === sectionKey)!.blocks.flatMap((b) => b.questions.map((q) => q.itemKey));
}

const gaming = sectionQuestions(o, "gaming");
const social = sectionQuestions(o, "social_media");

describe("dropping a question", () => {
  it("counts positions without the question being moved, so a drop just below a neighbour lands there", () => {
    const plan = planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "question", itemKey: gaming[1]!, edge: "after" });
    expect(plan).toEqual({ move: { op: "question", itemKey: gaming[0], to: { sectionKey: "gaming", index: 1 } }, refusal: null });
    const after = sectionQuestions(outline(apply(draft, plan!.move!)), "gaming");
    expect(after.slice(0, 2)).toEqual([gaming[1], gaming[0]]);
  });

  it("does nothing when dropped where it already is", () => {
    const drag = { kind: "question", itemKey: gaming[3]! } as const;
    expect(planDrop(o, counts, drag, { kind: "question", itemKey: gaming[3]!, edge: "before" })).toEqual({ move: null, refusal: null });
    expect(planDrop(o, counts, drag, { kind: "question", itemKey: gaming[3]!, edge: "after" })).toEqual({ move: null, refusal: null });
    expect(planDrop(o, counts, drag, { kind: "question", itemKey: gaming[4]!, edge: "before" })).toEqual({ move: null, refusal: null });
    expect(planDrop(o, counts, drag, { kind: "question", itemKey: gaming[2]!, edge: "after" })).toEqual({ move: null, refusal: null });
  });

  it("moves upwards within a section to the position dropped at", () => {
    const plan = planDrop(o, counts, { kind: "question", itemKey: gaming[5]! }, { kind: "question", itemKey: gaming[1]!, edge: "before" })!;
    expect(plan.move).toEqual({ op: "question", itemKey: gaming[5], to: { sectionKey: "gaming", index: 1 } });
    expect(sectionQuestions(outline(apply(draft, plan.move!)), "gaming")[1]).toBe(gaming[5]);
  });

  it("moves into another section at the gap dropped on", () => {
    const plan = planDrop(o, counts, { kind: "question", itemKey: "ybm_demographics.gender" }, { kind: "question", itemKey: gaming[7]!, edge: "after" })!;
    expect(plan.move).toEqual({ op: "question", itemKey: "ybm_demographics.gender", to: { sectionKey: "gaming", index: 8 } });
    expect(sectionQuestions(outline(apply(draft, plan.move!)), "gaming").at(-1)).toBe("ybm_demographics.gender");
  });

  it("drops onto a section header at the end of that section, and onto an add row at the end of its block", () => {
    const header = planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "section", sectionKey: "phones", edge: "inside" })!;
    expect(header.move).toEqual({ op: "question", itemKey: gaming[0], to: { sectionKey: "phones", index: 5 } });
    const add = planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "add", sectionKey: "social_media", componentIndex: 0 })!;
    expect(add.move).toEqual({ op: "question", itemKey: gaming[0], to: { sectionKey: "social_media", index: 25 } });
    expect(add.refusal).toBeNull();
  });

  it("drops before or after a whole block when over its header", () => {
    const before = planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "before" })!;
    expect(before.move).toEqual({ op: "question", itemKey: gaming[0], to: { sectionKey: "wellbeing", index: 7 } });
    const after = planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "after" })!;
    expect(after.move!.op === "question" && after.move!.to.index).toBe(32);
    expect(before.refusal).toBeNull();
    expect(after.refusal).toBeNull();
  });

  it("says in advance that the middle of another block is refused — and the model agrees", () => {
    const plan = planDrop(o, counts, { kind: "question", itemKey: "ybm_screen_attitudes.control" }, { kind: "question", itemKey: social[2]!, edge: "before" })!;
    expect(plan.refusal).toMatch(/can’t go in the middle of “YBM social-media use/);
    expect(() => apply(draft, plan.move!)).toThrow(StudioOpError);
  });

  it("is not a target for the start screen or the end rows", () => {
    expect(planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "start" })).toBeNull();
    expect(planDrop(o, counts, { kind: "question", itemKey: gaming[0]! }, { kind: "end" })).toBeNull();
  });
});

describe("dropping a block", () => {
  it("moves a licensed block into another section after the question dropped on", () => {
    const plan = planDrop(o, counts, { kind: "block", sectionKey: "hands_and_ladders", componentIndex: 0 }, { kind: "question", itemKey: "kss.q1", edge: "after" })!;
    expect(plan.move).toEqual({ op: "block", from: { sectionKey: "hands_and_ladders", componentIndex: 0 }, to: { sectionKey: "sleep", index: 1 } });
    const moved = outline(apply(draft, plan.move!));
    expect(sectionQuestions(moved, "sleep")[1]).toBe("ehi_sf.writing");
  });

  it("counts components after the block is taken out when moving within its section", () => {
    const drag = { kind: "block", sectionKey: "wellbeing", componentIndex: 0 } as const;
    const plan = planDrop(o, counts, drag, { kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "after" })!;
    expect(plan.move).toEqual({ op: "block", from: { sectionKey: "wellbeing", componentIndex: 0 }, to: { sectionKey: "wellbeing", index: 1 } });
    const moved = outline(apply(draft, plan.move!)).sections.find((s) => s.key === "wellbeing")!;
    expect(moved.blocks.map((b) => b.instrument)).toEqual(["sdq25_s", "swemwbs", "rcads25"]);
    expect(planDrop(o, counts, drag, { kind: "block", sectionKey: "wellbeing", componentIndex: 1, edge: "before" })!.move).toBeNull();
  });

  it("goes to the end of a section dropped on its header", () => {
    const plan = planDrop(o, counts, { kind: "block", sectionKey: "sleep", componentIndex: 0 }, { kind: "section", sectionKey: "right_now", edge: "inside" })!;
    expect(plan.move).toEqual({ op: "block", from: { sectionKey: "sleep", componentIndex: 0 }, to: { sectionKey: "right_now", index: 3 } });
  });
});

describe("dropping a section", () => {
  it("moves before or after the section dropped on", () => {
    const up = planDrop(o, counts, { kind: "section", sectionKey: "gaming" }, { kind: "section", sectionKey: "sleep", edge: "before" })!;
    expect(up.move).toEqual({ op: "section", sectionKey: "gaming", toIndex: 3 });
    const down = planDrop(o, counts, { kind: "section", sectionKey: "sleep" }, { kind: "section", sectionKey: "right_now", edge: "after" })!;
    expect(down.move).toEqual({ op: "section", sectionKey: "sleep", toIndex: 8 });
    expect(outline(apply(draft, down.move!)).sections.at(-1)!.key).toBe("sleep");
    expect(planDrop(o, counts, { kind: "section", sectionKey: "sleep" }, { kind: "section", sectionKey: "sleep", edge: "before" })!.move).toBeNull();
    expect(planDrop(o, counts, { kind: "section", sectionKey: "sleep" }, { kind: "question", itemKey: "kss.q1", edge: "before" })!.move).toBeNull();
    expect(planDrop(o, counts, { kind: "section", sectionKey: "sleep" }, { kind: "end" })!.move).toEqual({ op: "section", sectionKey: "sleep", toIndex: 8 });
  });
});

describe("moving with Alt+Arrow", () => {
  it("steps a question past its neighbour", () => {
    const phones = sectionQuestions(o, "phones");
    expect(keyboardQuestionMove(o, phones[0]!, 1)).toEqual({ op: "question", itemKey: phones[0], to: { sectionKey: "phones", index: 1 } });
    expect(keyboardQuestionMove(o, phones[2]!, -1)).toEqual({ op: "question", itemKey: phones[2], to: { sectionKey: "phones", index: 1 } });
  });

  it("crosses into the next or previous section at the edge", () => {
    const move = keyboardQuestionMove(o, gaming[0]!, -1)!;
    expect(move).toEqual({ op: "question", itemKey: gaming[0], to: { sectionKey: "social_media", index: 36 } });
    expect(sectionQuestions(outline(apply(draft, move)), "social_media").at(-1)).toBe(gaming[0]);
    expect(keyboardQuestionMove(o, gaming[7]!, 1)).toEqual({ op: "question", itemKey: gaming[7], to: { sectionKey: "right_now", index: 0 } });
  });

  it("steps past a whole block rather than into the middle of it", () => {
    const aboutYou = sectionQuestions(o, "about_you");
    const eeg = aboutYou.at(-1)!;
    const move = keyboardQuestionMove(o, eeg, -1)!;
    expect(move).toEqual({ op: "question", itemKey: eeg, to: { sectionKey: "about_you", index: 8 } });
    expect(sectionQuestions(outline(apply(draft, move)), "about_you")[8]).toBe(eeg);
  });

  it("stops at the start and end of the survey", () => {
    const first = sectionQuestions(o, "welcome")[0]!;
    const last = sectionQuestions(o, "right_now").at(-1)!;
    expect(keyboardQuestionMove(o, first, -1)).toBeNull();
    expect(keyboardQuestionMove(o, last, 1)).toBeNull();
  });

  it("steps a block within its section and across sections", () => {
    expect(keyboardBlockMove(o, counts, "wellbeing", 1, -1)).toEqual({ op: "block", from: { sectionKey: "wellbeing", componentIndex: 1 }, to: { sectionKey: "wellbeing", index: 0 } });
    expect(keyboardBlockMove(o, counts, "wellbeing", 1, 1)).toEqual({ op: "block", from: { sectionKey: "wellbeing", componentIndex: 1 }, to: { sectionKey: "wellbeing", index: 2 } });
    expect(keyboardBlockMove(o, counts, "sleep", 0, -1)).toEqual({ op: "block", from: { sectionKey: "sleep", componentIndex: 0 }, to: { sectionKey: "hands_and_ladders", index: 2 } });
    expect(keyboardBlockMove(o, counts, "sleep", 0, 1)).toEqual({ op: "block", from: { sectionKey: "sleep", componentIndex: 0 }, to: { sectionKey: "wellbeing", index: 0 } });
    expect(keyboardBlockMove(o, counts, "right_now", 2, 1)).toBeNull();
    const moved = apply(draft, keyboardBlockMove(o, counts, "wellbeing", 1, 1)!);
    expect(outline(moved).sections.find((s) => s.key === "wellbeing")!.blocks.map((b) => b.instrument)).toEqual(["swemwbs", "rcads25", "sdq25_s"]);
  });

  it("steps a section, within bounds", () => {
    expect(keyboardSectionMove(o, "sleep", -1)).toEqual({ op: "section", sectionKey: "sleep", toIndex: 2 });
    expect(keyboardSectionMove(o, "welcome", -1)).toBeNull();
    expect(keyboardSectionMove(o, "right_now", 1)).toBeNull();
  });
});

describe("saying where it went", () => {
  it("reads the new position from the outline after the move", () => {
    const move = keyboardQuestionMove(o, sectionQuestions(o, "phones")[0]!, 1)!;
    const after = outline(apply(draft, move));
    expect(describeMoved(after, move)).toMatch(/^Moved “.+” to position 2 of 5 in Phones and social media$/);
    const block = keyboardBlockMove(o, counts, "wellbeing", 1, 1)!;
    expect(describeMoved(outline(apply(draft, block)), block)).toBe("Moved “Strengths and Difficulties Questionnaire…” to position 3 of 3 in How you've been feeling");
    const section = keyboardSectionMove(o, "sleep", -1)!;
    expect(describeMoved(outline(apply(draft, section)), section)).toBe("Moved the section “Sleep” to position 3 of 9");
  });
});

// REVIEW FIX: the history merges consecutive same-label steps made within
// 1.2 s. Moves were all "Move question", so moving two questions in quick
// succession was one undo step. The label now names what moved.
describe("naming a move for undo", () => {
  it("gives moves of different things different labels, and repeated moves of one thing the same", () => {
    const first = keyboardQuestionMove(o, gaming[0]!, 1)!;
    const moved = outline(apply(draft, first));
    const again = keyboardQuestionMove(moved, gaming[0]!, 1)!;
    const other = keyboardQuestionMove(o, gaming[2]!, 1)!;
    // gaming[0] and gaming[2] start with the same 35 characters: the ID tells them apart.
    expect(moveLabel(o, first)).toBe(`Move “Roughly how many hours do you…” (${gaming[0]})`);
    expect(moveLabel(moved, again)).toBe(moveLabel(o, first));
    expect(moveLabel(o, other)).not.toBe(moveLabel(o, first));
    expect(moveLabel(o, keyboardBlockMove(o, counts, "wellbeing", 1, 1)!)).toBe("Move “Strengths and Difficulties…”");
    expect(moveLabel(o, keyboardSectionMove(o, "sleep", -1)!)).toBe("Move section “Sleep”");
  });

  it("carries out a move with the model's operation", () => {
    const move = keyboardSectionMove(o, "sleep", -1)!;
    expect(applyMove(draft, move).composition.sections.map((s) => s.key).indexOf("sleep")).toBe(2);
  });
});
