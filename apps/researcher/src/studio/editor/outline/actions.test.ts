import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addQuestion,
  addSection,
  archiveQuestion,
  deleteQuestion,
  duplicateQuestion,
  extractDraft,
  liveQuestions,
  moveBlock,
  moveQuestion,
  moveSection,
  outline,
  removeBlock,
  removeSection,
  restoreQuestion,
  unlockModule,
  type StudioDraft,
} from "@myself/studio";
import { archivedActions, blockActions, questionActions, sectionActions, type ActionFacts, type ActionSpec } from "./actions.js";
import { keyboardBlockMove, keyboardQuestionMove, keyboardSectionMove } from "./dnd.js";

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"));
const live = () => extractDraft(r730);
const actor = { by: "tester@example.org", at: "2026-09-28T12:00:00.000Z" };
const everything = new Set(liveQuestions(live()).map((q) => q.itemKey));

function facts(draft: StudioDraft, published: ReadonlySet<string> = everything): ActionFacts {
  return { draft, outline: outline(draft), counts: draft.composition.sections.map((s) => s.components.length), published };
}

const find = (items: ActionSpec[], id: string) => items.find((i) => i.id === id)!;

/** Whether an operation goes through, for comparing with what the menu offers. */
function works(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

describe("a question's menu offers exactly what the model allows", () => {
  const draft = live();
  const withNew = addQuestion(draft, { sectionKey: "gaming", typeId: "short_text", text: "Favourite snack?" });
  const cases: [string, StudioDraft, string][] = [
    ["a licensed questionnaire's question", draft, "sdq25_s.q3"],
    ["a protected consent question", draft, liveQuestions(draft)[0]!.itemKey],
    ["a participant-code question, even unlocked", unlockModule(draft, "ybm_identity", { ...actor, reason: "Checking linkage handling in a test." }).draft, "ybm_identity.ps_house_digit"],
    ["a published study question", draft, "ybm_gaming.social_pct"],
    ["a new, never-published question", withNew.draft, withNew.itemKey],
  ];

  it.each(cases)("%s", (_name, d, itemKey) => {
    const items = questionActions(itemKey, facts(d));
    const published = everything;
    expect(!find(items, "duplicate").disabled).toBe(works(() => duplicateQuestion(d, itemKey)));
    expect(!find(items, "archive").disabled).toBe(works(() => archiveQuestion(d, itemKey, actor)));
    expect(!find(items, "delete").disabled).toBe(works(() => deleteQuestion(d, itemKey, { published })));
    const up = keyboardQuestionMove(outline(d), itemKey, -1);
    const down = keyboardQuestionMove(outline(d), itemKey, 1);
    // An offered move goes through; a withheld one would have been refused.
    if (!find(items, "move-up").disabled && up?.op === "question") expect(works(() => moveQuestion(d, itemKey, up.to))).toBe(true);
    if (find(items, "move-down").disabled && down?.op === "question") expect(works(() => moveQuestion(d, itemKey, down.to))).toBe(false);
    for (const item of items) if (item.disabled) expect(item.disabled.length).toBeGreaterThan(20);
  });

  it("says why a published question can't be deleted, and what to do instead", () => {
    const items = questionActions("ybm_gaming.social_pct", facts(live()));
    expect(find(items, "delete").disabled).toMatch(/^Archive instead/);
    expect(find(items, "archive").disabled).toBeUndefined();
  });

  // REVIEW FIX: a published licensed question's Delete said "Archive instead",
  // while its Archive item was disabled too.
  it("never advises archiving where Archive itself is unavailable", () => {
    const unlocked = unlockModule(live(), "ybm_identity", { ...actor, reason: "Checking linkage handling in a test." }).draft;
    for (const [d, itemKey] of [
      [live(), "sdq25_s.q3"],
      [live(), liveQuestions(live())[0]!.itemKey],
      [unlocked, "ybm_identity.ps_house_digit"],
    ] as const) {
      const items = questionActions(itemKey, facts(d));
      expect(find(items, "archive").disabled).toBeTruthy();
      expect(find(items, "delete").disabled).not.toMatch(/Archive instead/);
      expect(find(items, "delete").disabled).toBe(find(items, "archive").disabled);
    }
    expect(find(questionActions("sdq25_s.q3", facts(live())), "delete").disabled).toMatch(/Remove the whole block instead/);
  });

  it("points a licensed question's moves at its block", () => {
    const items = questionActions("sdq25_s.q3", facts(live()));
    expect(find(items, "move-up").disabled).toMatch(/Move the whole block instead/);
    expect(find(items, "move-to-section").disabled).toMatch(/licensed questionnaire/);
  });
});

// REVIEW FIX: moves were offered on tier alone, but the model also refuses to
// put anything in front of the ethics-protected consent. These were offered
// and then refused with an error toast.
describe("moves the model would refuse are not offered", () => {
  it("won't offer to move a section in front of the consent section", () => {
    const d = moveSection(live(), "hands_and_ladders", 1).draft;
    const items = sectionActions("hands_and_ladders", facts(d));
    const up = keyboardSectionMove(outline(d), "hands_and_ladders", -1)!;
    expect(up.op === "section" && works(() => moveSection(d, "hands_and_ladders", up.toIndex))).toBe(false);
    expect(find(items, "move-up").disabled).toMatch(/before “YBM introduction and consent”/);
    expect(find(items, "move-down").disabled).toBeUndefined();
  });

  it("won't offer to move a question added to the Welcome section above the consent", () => {
    const added = addQuestion(live(), { sectionKey: "welcome", typeId: "short_text", text: "Your school?" });
    const items = questionActions(added.itemKey, facts(added.draft, new Set()));
    const up = keyboardQuestionMove(outline(added.draft), added.itemKey, -1)!;
    expect(up.op === "question" && works(() => moveQuestion(added.draft, added.itemKey, up.to))).toBe(false);
    expect(find(items, "move-up").disabled).toMatch(/consent/);
    expect(find(items, "move-down").disabled).toBeUndefined();
  });

  it("offers a move exactly when the model allows it, for every row of the live survey", () => {
    const d = moveSection(live(), "hands_and_ladders", 1).draft;
    const f = facts(d);
    const o = f.outline;
    for (const [dir, id] of [[-1, "move-up"], [1, "move-down"]] as const) {
      for (const s of o.sections) {
        const move = keyboardSectionMove(o, s.key, dir);
        const offered = !find(sectionActions(s.key, f), id).disabled;
        expect([s.key, offered]).toEqual([s.key, !!move && move.op === "section" && works(() => moveSection(d, s.key, move.toIndex))]);
        for (const b of s.blocks) {
          const bm = keyboardBlockMove(o, f.counts, s.key, b.componentIndex, dir);
          const bOffered = !find(blockActions(s.key, b.componentIndex, f), id).disabled;
          expect([s.key, b.componentIndex, bOffered]).toEqual([
            s.key,
            b.componentIndex,
            !!bm && bm.op === "block" && works(() => moveBlock(d, bm.from, bm.to)),
          ]);
        }
      }
    }
  });
});

describe("an archived question that can't go back where it was", () => {
  it("disables Restore with the model's reason and still offers Restore into section…", () => {
    // Archive a question, then empty and delete its section.
    const added = addSection(live(), { title: "Spare" });
    const q = addQuestion(added.draft, { sectionKey: added.sectionKey, typeId: "number", text: "How many pets?" });
    const archived = archiveQuestion(q.draft, q.itemKey, actor).draft;
    const gone = removeSection(archived, added.sectionKey).draft;
    expect(works(() => restoreQuestion(gone, q.itemKey))).toBe(false);
    const items = archivedActions(q.itemKey, facts(gone, new Set()));
    expect(find(items, "restore").disabled).toMatch(/no longer in the survey/);
    expect(find(items, "restore-into").disabled).toBeUndefined();
  });
});

describe("a section's menu", () => {
  it("fixes a section holding a protected module in place", () => {
    const d = live();
    const items = sectionActions("about_you", facts(d));
    expect(find(items, "move-up").disabled).toMatch(/protected/);
    expect(works(() => moveSection(d, "about_you", 0))).toBe(false);
  });

  it("allows deleting only an empty section", () => {
    const d = live();
    expect(find(sectionActions("gaming", facts(d)), "remove-section").disabled).toMatch(/Only an empty section/);
    const added = addSection(d, { title: "Spare" });
    const items = sectionActions(added.sectionKey, facts(added.draft));
    expect(find(items, "remove-section").disabled).toBeUndefined();
    expect(works(() => removeSection(added.draft, added.sectionKey))).toBe(true);
  });

  it("offers moves only where there is somewhere to go", () => {
    const d = live();
    const first = sectionActions("welcome", facts(d));
    expect(find(first, "move-up").disabled).toBeTruthy();
    const last = sectionActions("right_now", facts(d));
    expect(find(last, "move-down").disabled).toMatch(/Already the last section/);
    expect(find(last, "move-up").disabled).toBeUndefined();
    const up = keyboardSectionMove(outline(d), "right_now", -1);
    expect(up?.op === "section" && works(() => moveSection(d, "right_now", up.toIndex))).toBe(true);
  });
});

describe("a block's menu", () => {
  it("lets a licensed block move and be removed, whole", () => {
    const d = live();
    const items = blockActions("wellbeing", 1, facts(d));
    expect(find(items, "move-up").disabled).toBeUndefined();
    expect(find(items, "remove-block").disabled).toBeUndefined();
    const move = keyboardBlockMove(outline(d), facts(d).counts, "wellbeing", 1, -1)!;
    expect(move.op === "block" && works(() => moveBlock(d, move.from, move.to))).toBe(true);
    expect(works(() => removeBlock(d, "wellbeing", 1, actor))).toBe(true);
  });

  it("keeps a protected block where it is until it is unlocked", () => {
    const d = live();
    const items = blockActions("welcome", 0, facts(d));
    expect(find(items, "move-down").disabled).toMatch(/protected/);
    expect(find(items, "remove-block").disabled).toMatch(/protected/);
    expect(works(() => removeBlock(d, "welcome", 0, actor))).toBe(false);
  });

  it("never removes the participant-code questions, unlocked or not", () => {
    const d = unlockModule(live(), "ybm_identity", { ...actor, reason: "Checking linkage handling in a test." }).draft;
    expect(find(blockActions("about_you", 0, facts(d)), "remove-block").disabled).toMatch(/participant code/);
    expect(works(() => removeBlock(d, "about_you", 0, actor))).toBe(false);
  });
});

describe("an archived question's menu", () => {
  it("restores, and deletes for good only what was never published", () => {
    const d = live();
    const added = addQuestion(d, { sectionKey: "gaming", typeId: "number", text: "How many consoles?" });
    const archivedNew = archiveQuestion(added.draft, added.itemKey, actor).draft;
    const fresh = archivedActions(added.itemKey, facts(archivedNew));
    expect(find(fresh, "delete-archived").disabled).toBeUndefined();
    expect(works(() => deleteQuestion(archivedNew, added.itemKey, { published: everything }))).toBe(true);

    const archivedOld = archiveQuestion(d, "ybm_gaming.social_pct", actor).draft;
    const old = archivedActions("ybm_gaming.social_pct", facts(archivedOld));
    expect(find(old, "delete-archived").disabled).toMatch(/published/);
    expect(find(old, "restore").disabled).toBeUndefined();
    expect(works(() => restoreQuestion(archivedOld, "ybm_gaming.social_pct"))).toBe(true);
  });

  it("keeps a licensed questionnaire's archived questions together", () => {
    const removed = removeBlock(live(), "sleep", 0, actor).draft;
    const items = archivedActions("kss.q1", facts(removed, new Set()));
    expect(find(items, "delete-archived").disabled).toMatch(/licensed questionnaire/);
    expect(works(() => deleteQuestion(removed, "kss.q1", { published: new Set() }))).toBe(false);
    expect(find(items, "restore").label).toMatch(/whole questionnaire/);
  });
});

describe("the library in the menus (D-57)", () => {
  it("offers “Add from library…” on every section", () => {
    const d = live();
    for (const s of outline(d).sections) expect(find(sectionActions(s.key, facts(d)), "add-from-library").disabled).toBeUndefined();
  });

  it("saves only editable blocks to the library, and says why not otherwise", () => {
    const d = live();
    expect(find(blockActions("gaming", 0, facts(d)), "save-to-library").disabled).toBeUndefined();
    expect(find(blockActions("wellbeing", 1, facts(d)), "save-to-library").disabled).toMatch(/validated questionnaire is in the library already/);
    expect(find(blockActions("welcome", 0, facts(d)), "save-to-library").disabled).toMatch(/ethics approval/);
    // Unlocked or not, the consent and identity modules belong to their study.
    const unlocked = unlockModule(d, "ybm_identity", { ...actor, reason: "Testing what the library menu offers here." }).draft;
    expect(find(blockActions("about_you", 0, facts(unlocked)), "save-to-library").disabled).toMatch(/isn’t saved to the library/);
  });
});
