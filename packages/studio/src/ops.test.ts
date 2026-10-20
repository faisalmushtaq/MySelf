import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { refKeyOf } from "@myself/release/gate";
import type { ReleaseManifest } from "@myself/schema";
import { QUESTION_TYPES, type QuestionTypeId } from "./catalogue.js";
import type { StudioDraft } from "./contract.js";
import { emptyDraft, extractDraft, previewRelease } from "./draft.js";
import { describeCondition } from "./logic.js";
import { findQuestion, outline, scaleOf, StudioOpError, studioTypeOf } from "./model.js";
import * as ops from "./ops.js";
import { liveQuestions } from "./walk.js";

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"));
const actor = { by: "researcher@example.org", at: "2026-09-28T12:00:00.000Z" };

/**
 * The live survey, deep-frozen: any operation that wrote to the draft it was
 * given, instead of a copy, would throw here.
 */
function live(): StudioDraft {
  return deepFreeze(extractDraft(r730));
}

function blank(): StudioDraft {
  return deepFreeze(emptyDraft({ surveyId: "pilot_2027", study: "pilot", title: "Pilot" }));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Freezes exactly as the server would, and returns the frozen release. */
function publishable(draft: StudioDraft): ReleaseManifest {
  const preview = previewRelease(draft);
  expect(preview.error).toBeNull();
  expect(preview.failures).toEqual([]);
  return preview.manifest!;
}

/** Question IDs in the order the frozen release administers them. */
function administered(manifest: ReleaseManifest): string[] {
  const out: string[] = [];
  for (const section of manifest.composition.sections) {
    for (const c of section.components) {
      if (c.kind !== "instrument" && c.kind !== "module") continue;
      const def = manifest.instruments[refKeyOf(c.ref)] as { forms: { items: { key: string }[] }[] };
      for (const key of c.items ?? def.forms[0]!.items.map((i) => i.key)) out.push(`${c.ref.instrument}.${key}`);
    }
  }
  return out;
}

function sectionOf(manifest: ReleaseManifest, itemKey: string): string | undefined {
  const [instrument, key] = itemKey.split(".");
  for (const section of manifest.composition.sections) {
    for (const c of section.components) {
      if (c.kind !== "instrument" && c.kind !== "module") continue;
      if (c.ref.instrument !== instrument) continue;
      const def = manifest.instruments[refKeyOf(c.ref)] as { forms: { items: { key: string }[] }[] };
      if ((c.items ?? def.forms[0]!.items.map((i) => i.key)).includes(key!)) return section.key;
    }
  }
  return undefined;
}

function refusal(fn: () => unknown): StudioOpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StudioOpError) return error;
    throw error;
  }
  throw new Error("expected the operation to be refused");
}

const creatable = QUESTION_TYPES.filter((t) => t.canCreate).map((t) => t.id);

// ---------------------------------------------------------------------------

describe("adding questions", () => {
  it.each(creatable)("adds a %s question to the live survey, which still freezes cleanly", (typeId) => {
    const before = live();
    const { draft, itemKey } = ops.addQuestion(before, { sectionKey: "gaming", typeId, text: "What is your favourite game?" });
    expect(itemKey).toBe("ybm_studio.favourite_game");
    const q = findQuestion(draft, itemKey)!;
    expect(studioTypeOf(q.item, scaleOf(draft, itemKey))).toBe(typeId);
    expect(q.placements).toEqual([expect.objectContaining({ sectionKey: "gaming", componentIndex: 1, indexInPlacement: 0 })]);
    const manifest = publishable(draft);
    const order = administered(manifest);
    expect(order.indexOf(itemKey)).toBe(order.indexOf("ybm_gaming.social_pct") + 1);
    expect(order[order.indexOf(itemKey) + 1]).toBe("stai5_s.upset");
    // A time grid needs the engine that renders it (0.5.0).
    expect(manifest.release.engineVersion).toBe(typeId === "time_grid" ? "0.5.0" : "0.2.0");
    expect(findQuestion(before, itemKey)).toBeNull();
  });

  it("adds every type to one blank survey with a distinct ID and variable each", () => {
    let draft = blank();
    const keys: string[] = [];
    for (const typeId of creatable) {
      const added = ops.addQuestion(draft, { sectionKey: "welcome", typeId });
      draft = deepFreeze(added.draft);
      keys.push(added.itemKey);
    }
    expect(new Set(keys).size).toBe(creatable.length);
    expect(keys.slice(0, 3)).toEqual(["pilot_studio.new_question", "pilot_studio.new_question_2", "pilot_studio.new_question_3"]);
    const variables = liveQuestions(draft).map((q) => q.item.variable);
    expect(new Set(variables).size).toBe(variables.length);
    const manifest = publishable(draft);
    expect(administered(manifest)).toEqual(["pilot_studio.welcome", ...keys]);
  });

  it("puts a question written after an editable module's question into that module, right after it", () => {
    const { draft, itemKey } = ops.addQuestion(live(), {
      sectionKey: "phones",
      typeId: "yes_no",
      text: "Do you have a tablet?",
      afterItemKey: "ybm_smartphone.own",
    });
    expect(itemKey).toBe("ybm_smartphone.have_tablet");
    const manifest = publishable(draft);
    const order = administered(manifest);
    expect(order.slice(order.indexOf("ybm_smartphone.own"), order.indexOf("ybm_smartphone.own") + 3)).toEqual([
      "ybm_smartphone.own",
      "ybm_smartphone.have_tablet",
      "ybm_smartphone.age_smartphone",
    ]);
    // Into the module's whole-form placement, so nothing needs a newer app.
    expect(manifest.release.engineVersion).toBe("0.1.0");
  });

  it("puts a question written after a licensed questionnaire's question straight after that block", () => {
    const { draft, itemKey } = ops.addQuestion(live(), {
      sectionKey: "wellbeing",
      typeId: "short_text",
      text: "Anything else about how you've been feeling?",
      afterItemKey: "sdq25_s.q3",
    });
    expect(itemKey.startsWith("ybm_studio.")).toBe(true);
    const order = administered(publishable(draft));
    expect(order[order.indexOf("sdq25_s.q25") + 1]).toBe(itemKey);
    expect(order[order.indexOf(itemKey) + 1]).toBe("rcads25.q1");
    // A second one after the same block joins the Studio placement already there.
    const again = ops.addQuestion(draft, { sectionKey: "wellbeing", typeId: "short_text", afterItemKey: "sdq25_s.q1" });
    const next = administered(publishable(again.draft));
    expect(next.slice(next.indexOf("sdq25_s.q25") + 1, next.indexOf("rcads25.q1"))).toEqual([again.itemKey, itemKey]);
    expect(outline(again.draft).sections.find((s) => s.key === "wellbeing")!.blocks).toHaveLength(4);
  });

  it("never gives out an ID or variable a published version used", () => {
    const reserved = { itemKeys: new Set(["ybm_studio.pets"]), variables: new Set(["pets", "pets_2"]) };
    const { draft, itemKey } = ops.addQuestion(live(), { sectionKey: "gaming", typeId: "number", text: "Pets?", reserved });
    expect(itemKey).toBe("ybm_studio.pets_2");
    expect(findQuestion(draft, itemKey)!.item.variable).toBe("pets_3");
    publishable(draft);
  });

  it("refuses types that can't be created and sections that don't exist", () => {
    expect(refusal(() => ops.addQuestion(live(), { sectionKey: "gaming", typeId: "ladder" })).code).toBe("invalid");
    expect(refusal(() => ops.addQuestion(live(), { sectionKey: "nowhere", typeId: "info" })).code).toBe("not_found");
    expect(
      refusal(() => ops.addQuestion(live(), { sectionKey: "gaming", typeId: "info", afterItemKey: "ybm_smartphone.own" })).message,
    ).toMatch(/is not in the section “Gaming”/);
  });
});

// ---------------------------------------------------------------------------

describe("moving questions", () => {
  it("moves a question to another section without changing its ID", () => {
    const before = live();
    const { draft } = ops.moveQuestion(before, "ybm_demographics.gender", { sectionKey: "gaming", index: 8 });
    const manifest = publishable(draft);
    const order = administered(manifest);
    expect(order).toContain("ybm_demographics.gender");
    expect(order.indexOf("ybm_demographics.gender")).toBe(order.indexOf("ybm_gaming.social_pct") + 1);
    expect(sectionOf(manifest, "ybm_demographics.gender")).toBe("gaming");
    expect(order.filter((k) => k === "ybm_demographics.gender")).toHaveLength(1);
    // The placement it left now lists what it still shows.
    const aboutYou = draft.composition.sections.find((s) => s.key === "about_you")!;
    expect(aboutYou.components[1]).toMatchObject({ items: ["ethnicity", "medication"] });
    // Same question, same ID, same variable, in every export.
    expect(findQuestion(draft, "ybm_demographics.gender")!.item).toEqual(findQuestion(before, "ybm_demographics.gender")!.item);
  });

  it("moves a module's only question into another section, removing the placement it leaves", () => {
    const added = ops.addSection(live(), { title: "Looking ahead", index: 8 });
    const { draft } = ops.moveQuestion(added.draft, "ybm_future_self.message", { sectionKey: added.sectionKey, index: 0 });
    const manifest = publishable(draft);
    expect(sectionOf(manifest, "ybm_future_self.message")).toBe("looking_ahead");
    expect(draft.composition.sections.find((s) => s.key === "right_now")!.components).toHaveLength(2);
  });

  it("reorders within a placement, and back again to exactly where it was", () => {
    const before = live();
    const { draft } = ops.moveQuestion(before, "ybm_screen_attitudes.control", { sectionKey: "social_media", index: 31 });
    const order = administered(publishable(draft));
    expect(order.slice(order.indexOf("ybm_screen_attitudes.dependent"), order.indexOf("doomscroll4.q1"))).toEqual([
      "ybm_screen_attitudes.dependent",
      "ybm_screen_attitudes.addicted",
      "ybm_screen_attitudes.impact_positive",
      "ybm_screen_attitudes.impact_negative",
      "ybm_screen_attitudes.impact_essential",
      "ybm_screen_attitudes.impact_avoid",
      "ybm_screen_attitudes.control",
    ]);
    // A whole-form placement is reordered through its form: no subset needed.
    expect(publishable(draft).release.engineVersion).toBe("0.1.0");
    const back = ops.reorderQuestion(deepFreeze(draft), "ybm_screen_attitudes.control", 0).draft;
    expect(back).toEqual(before);
  });

  it("refuses to put a question in the middle of another block", () => {
    const error = refusal(() => ops.moveQuestion(live(), "ybm_screen_attitudes.control", { sectionKey: "social_media", index: 2 }));
    expect(error.message).toMatch(/can't go in the middle of/);
    expect(error.message).toMatch(/before or after/);
  });

  it("gives a question its own placement at a boundary between blocks", () => {
    const { draft } = ops.moveQuestion(live(), "ybm_smartphone.age_smartphone", { sectionKey: "social_media", index: 25 });
    const order = administered(publishable(draft));
    expect(order.indexOf("ybm_smartphone.age_smartphone")).toBe(order.indexOf("ybm_social_media.family_control") + 1);
    expect(order.indexOf("ybm_screen_attitudes.control")).toBe(order.indexOf("ybm_smartphone.age_smartphone") + 1);
    const blocks = outline(draft).sections.find((s) => s.key === "social_media")!.blocks;
    expect(blocks.map((b) => b.instrument)).toEqual(["ybm_social_media", "ybm_smartphone", "ybm_screen_attitudes", "doomscroll4"]);
    expect(blocks[1]).toMatchObject({ subset: true, questions: [expect.objectContaining({ itemKey: "ybm_smartphone.age_smartphone" })] });
  });

  it("refuses to move a licensed questionnaire's question on its own, but moves its whole block", () => {
    const error = refusal(() => ops.moveQuestion(live(), "ehi_sf.writing", { sectionKey: "sleep", index: 0 }));
    expect(error.code).toBe("locked");
    expect(error.message).toMatch(/Move the whole block instead/);
    expect(refusal(() => ops.reorderQuestion(live(), "ehi_sf.writing", 2)).code).toBe("locked");
    const { draft } = ops.moveBlock(live(), { sectionKey: "hands_and_ladders", componentIndex: 0 }, { sectionKey: "sleep", index: 1 });
    const manifest = publishable(draft);
    expect(sectionOf(manifest, "ehi_sf.writing")).toBe("sleep");
    expect(administered(manifest).slice(administered(manifest).indexOf("kss.q1"), administered(manifest).indexOf("kss.q1") + 2)).toEqual([
      "kss.q1",
      "ehi_sf.writing",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("licensed questionnaires", () => {
  it("refuses rewording, but lets a question be made required", () => {
    const error = refusal(() => ops.updateQuestion(live(), "sdq25_s.q1", { stem: { text: "I am nice." } }));
    expect(error.code).toBe("locked");
    expect(error.message).toMatch(/^You can't change its wording: “Strengths/);
    expect(refusal(() => ops.updateQuestion(live(), "sdq25_s.q1", { displayIf: null, variable: "x" })).code).toBe("locked");
    const { draft } = ops.updateQuestion(live(), "sdq25_s.q1", { required: "hard", reportingCategory: "Wellbeing" });
    expect(findQuestion(draft, "sdq25_s.q1")!.item).toMatchObject({ required: "hard", reportingCategory: "Wellbeing" });
    publishable(draft);
  });

  it("can be unlocked with a reason, reworded, published, and locked again", () => {
    expect(refusal(() => ops.unlockModule(live(), "sdq25_s", { ...actor, reason: "too short" })).message).toMatch(/why its wording needs to change/);
    const unlocked = ops.unlockModule(live(), "sdq25_s", { ...actor, reason: "Rewording for this age group, agreed by the team." }).draft;
    const { draft } = ops.updateQuestion(unlocked, "sdq25_s.q1", { stem: { text: "I try to be kind to other people." } });
    expect(findQuestion(draft, "sdq25_s.q1")!.item.stem.text).toBe("I try to be kind to other people.");
    publishable(draft);
    const relocked = ops.relockModule(draft, "sdq25_s").draft;
    expect(refusal(() => ops.updateQuestion(relocked, "sdq25_s.q1", { stem: { text: "Again" } })).code).toBe("locked");
    expect(findQuestion(relocked, "sdq25_s.q1")!.item.stem.text).toBe("I try to be kind to other people.");
  });

  it("refuses archiving one question; removing the block archives it whole, and a restore brings it back whole", () => {
    expect(refusal(() => ops.archiveQuestion(live(), "sdq25_s.q7", actor)).message).toMatch(/Remove the whole block instead/);
    const before = live();
    const removed = ops.removeBlock(before, "wellbeing", 1, actor);
    expect(removed.archived).toHaveLength(25);
    expect(removed.archived[0]).toBe("sdq25_s.q1");
    const manifest = publishable(removed.draft);
    expect(administered(manifest).some((k) => k.startsWith("sdq25_s."))).toBe(false);
    const restored = ops.restoreQuestion(deepFreeze(removed.draft), "sdq25_s.q7");
    expect(restored.restored).toHaveLength(25);
    expect(restored.draft).toEqual(before);
  });

  it("refuses option edits on a list a licensed questionnaire shares, until the question has its own copy", () => {
    const added = ops.addQuestion(live(), { sectionKey: "wellbeing", typeId: "single_choice", text: "Same again?" });
    const shared = ops.updateQuestion(added.draft, added.itemKey, { scale: "scale.sdq_3pt" }).draft;
    expect(findQuestion(shared, added.itemKey)!.item).toMatchObject({ scale: "scale.sdq_3pt", scaleVersion: "1.0.0" });
    const error = refusal(() => ops.addOption(shared, added.itemKey, { label: "Sometimes" }));
    expect(error.code).toBe("locked");
    expect(error.message).toMatch(/Give this question its own copy of the options first/);
    const forked = ops.forkScale(shared, added.itemKey);
    expect(forked.scaleKey).toBe("scale.ybm_studio_same_again_2");
    const withOption = ops.addOption(forked.draft, added.itemKey, { label: "Sometimes" });
    expect(withOption.code).toBe(3); // the SDQ codes 0–2
    expect(withOption.draft.scales["scale.sdq_3pt"]).toEqual(live().scales["scale.sdq_3pt"]);
    publishable(withOption.draft);
  });
});

// ---------------------------------------------------------------------------

describe("protected modules", () => {
  const reason = "Rewording the name question; the answers and linkage stay the same.";

  it("lets the consent wording change without an unlock (D-61), and refuses the identity wording until unlocked with a reason", () => {
    publishable(ops.updateQuestion(live(), "ybm_intro_consent.intro", { stem: { text: "Yorkshire Brain Map workshop" } }).draft);
    expect(refusal(() => ops.unlockModule(live(), "ybm_intro_consent", { ...actor, reason })).code).toBe("invalid");
    const error = refusal(() => ops.updateQuestion(live(), "ybm_identity.first_name", { stem: { text: "Given name" } }));
    expect(error.code).toBe("protected");
    expect(error.message).toMatch(/unlock it first/);
    // Notes for analysts change nothing a participant sees.
    publishable(ops.updateQuestion(live(), "ybm_identity.first_name", { researcherNote: "Checked." }).draft);
    expect(refusal(() => ops.unlockModule(live(), "ybm_identity", { ...actor, reason: "because" })).message).toMatch(/at least 20/);
    expect(refusal(() => ops.unlockModule(live(), "ybm_smartphone", { ...actor, reason })).code).toBe("invalid");
    const unlocked = ops.unlockModule(live(), "ybm_identity", { ...actor, reason }).draft;
    expect(unlocked.unlocked["ybm_identity"]).toEqual({ instrument: "ybm_identity", by: actor.by, at: actor.at, reason });
    const edited = ops.updateQuestion(unlocked, "ybm_identity.first_name", { stem: { text: "Your first name" } }).draft;
    publishable(edited);
    const relocked = ops.relockModule(edited, "ybm_identity").draft;
    expect(refusal(() => ops.updateQuestion(relocked, "ybm_identity.first_name", { stem: { text: "Hi" } })).code).toBe("protected");
  });

  it("refuses moving the consent anywhere but first, and moving or hiding a protected block", () => {
    expect(refusal(() => ops.moveBlock(live(), { sectionKey: "welcome", componentIndex: 0 }, { sectionKey: "gaming", index: 0 })).code).toBe(
      "protected",
    );
    const identity = outline(live()).sections.find((x) => x.blocks.some((b) => b.instrument === "ybm_identity"))!;
    const condition = { op: "answered" as const, target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } } };
    expect(refusal(() => ops.updateSection(live(), identity.key, { displayIf: condition })).code).toBe("protected");
    expect(refusal(() => ops.removeBlock(live(), identity.key, identity.blocks.find((b) => b.instrument === "ybm_identity")!.componentIndex, actor)).code).toBe("protected");
  });

  it("keeps the identity questions' IDs, variables and types even when unlocked", () => {
    const unlocked = deepFreeze(ops.unlockModule(live(), "ybm_identity", { ...actor, reason: "Clarifying the wording for Year 7 pupils." }).draft);
    expect(refusal(() => ops.updateQuestion(unlocked, "ybm_identity.ps_house_digit", { key: "house" })).code).toBe("linkage");
    expect(refusal(() => ops.updateQuestion(unlocked, "ybm_identity.ps_house_digit", { variable: "house" })).message).toMatch(
      /participant code is built from/,
    );
    expect(refusal(() => ops.updateQuestion(unlocked, "ybm_identity.first_name", { variable: "given_name" })).message).toMatch(
      /read by its variable name, “first_name”/,
    );
    expect(refusal(() => ops.updateQuestion(unlocked, "ybm_identity.dob", { identifying: false })).code).toBe("linkage");
    expect(refusal(() => ops.changeQuestionType(unlocked, "ybm_identity.ps_birth_month", "dropdown")).code).toBe("linkage");
    expect(refusal(() => ops.archiveQuestion(unlocked, "ybm_identity.ps_postcode_letters", actor)).code).toBe("linkage");
    expect(refusal(() => ops.removeBlock(unlocked, "about_you", 0, actor)).code).toBe("linkage");
    expect(refusal(() => ops.addOption(unlocked, "ybm_identity.ps_birth_month", { label: "Smarch" })).code).toBe("linkage");
    // Wording is what the unlock was for.
    const reworded = ops.updateQuestion(unlocked, "ybm_identity.ps_house_digit", { stem: { text: "The first number of your house" } }).draft;
    publishable(reworded);
  });
});

// ---------------------------------------------------------------------------

describe("archiving, restoring and deleting", () => {
  it("archives a question from the middle of a block and restores it exactly", () => {
    const before = live();
    const archived = ops.archiveQuestion(before, "ybm_smartphone.age_smartphone", actor).draft;
    const manifest = publishable(archived);
    expect(administered(manifest)).not.toContain("ybm_smartphone.age_smartphone");
    expect(archived.archived).toEqual([
      expect.objectContaining({ itemKey: "ybm_smartphone.age_smartphone", sectionKey: "phones", archivedBy: actor.by, archivedAt: actor.at }),
    ]);
    const restored = ops.restoreQuestion(deepFreeze(archived), "ybm_smartphone.age_smartphone");
    expect(restored.restored).toEqual(["ybm_smartphone.age_smartphone"]);
    expect(restored.draft).toEqual(before);
  });

  it("archives a module's only question, removing the module, and restores it exactly", () => {
    const before = live();
    const archived = ops.archiveQuestion(before, "ybm_future_self.message", actor).draft;
    expect(Object.keys(archived.instruments)).not.toContain("ybm_future_self@1.0/en-GB/self/standard");
    publishable(archived);
    expect(ops.restoreQuestion(deepFreeze(archived), "ybm_future_self.message").draft).toEqual(before);
  });

  it("restores a whole removed block in its own order, whichever question comes back first", () => {
    const before = live();
    const removed = deepFreeze(ops.removeBlock(before, "gaming", 0, actor).draft);
    let draft = removed;
    for (const key of ["game_time_3", "hours_week", "social_pct", "top_games", "game_time_5", "game_time_1", "game_time_4", "game_time_2"]) {
      draft = deepFreeze(ops.restoreQuestion(draft, `ybm_gaming.${key}`).draft);
    }
    expect(draft).toEqual(before);
  });

  it("restores into another section at the end", () => {
    const archived = ops.archiveQuestion(live(), "ybm_smartphone.age_smartphone", actor).draft;
    const { draft } = ops.restoreQuestion(archived, "ybm_smartphone.age_smartphone", { sectionKey: "gaming" });
    const order = administered(publishable(draft));
    expect(order.indexOf("ybm_smartphone.age_smartphone")).toBe(order.indexOf("ybm_gaming.social_pct") + 1);
    expect(refusal(() => ops.restoreQuestion(archived, "ybm_smartphone.age_smartphone", { sectionKey: "nowhere" })).code).toBe("not_found");
  });

  it("archives and restores a Studio question in a blank survey", () => {
    const added = ops.addQuestion(blank(), { sectionKey: "welcome", typeId: "yes_no", text: "Any pets?" });
    expect(added.itemKey).toBe("pilot_studio.pets");
    const archived = ops.archiveQuestion(deepFreeze(added.draft), added.itemKey, actor).draft;
    publishable(archived);
    expect(ops.restoreQuestion(archived, added.itemKey).draft).toEqual(added.draft);
  });

  it("keeps an archived question restorable when the rest of its module is deleted", () => {
    const added = ops.addQuestion(blank(), { sectionKey: "welcome", typeId: "date", text: "When were you born?" });
    const archived = ops.archiveQuestion(added.draft, "pilot_studio.welcome", actor).draft;
    const deleted = ops.deleteQuestion(archived, added.itemKey, { published: new Set() }).draft;
    expect(deleted.instruments).toEqual({});
    const restored = ops.restoreQuestion(deleted, "pilot_studio.welcome").draft;
    expect(restored).toEqual(blank());
  });

  it("refuses to delete a published question, and says to archive it", () => {
    const error = refusal(() => ops.deleteQuestion(live(), "ybm_smartphone.own", { published: new Set(["ybm_smartphone.own"]) }));
    expect(error.code).toBe("published");
    expect(error.message).toMatch(/Archive it instead/);
  });

  it("deletes a question never published, with its own option list, leaving conditions on it for validation", () => {
    const added = ops.addQuestion(live(), { sectionKey: "gaming", typeId: "multiple_choice", text: "Which consoles?" });
    const other = ops.addOtherOption(added.draft, added.itemKey);
    const deleted = ops.deleteQuestion(other.draft, added.itemKey, { published: new Set() }).draft;
    expect(findQuestion(deleted, added.itemKey)).toBeNull();
    expect(added.itemKey).toBe("ybm_studio.consoles");
    expect(added.draft.scales["scale.ybm_studio_consoles"]).toBeDefined();
    expect(deleted.scales["scale.ybm_studio_consoles"]).toBeUndefined();
    // The follow-up still points at it: validation reports that; nothing is silently stripped.
    expect(findQuestion(deleted, other.followUpItemKey)!.item.displayIf).toBeDefined();
    expect(previewRelease(deleted).failures.join("\n")).toMatch(/refers to 'ybm_studio.consoles'/);
  });
});

// ---------------------------------------------------------------------------

describe("options", () => {
  it("never reuses a retired or published value", () => {
    const withRetired: StudioDraft = {
      ...extractDraft(r730),
      retiredCodes: { "scale.yes_no": [{ code: 3, label: "Maybe", retiredAt: actor.at }] },
    };
    const added = ops.addOption(deepFreeze(withRetired), "ybm_smartphone.own", { label: "Not sure" }, { publishedCodes: new Set([1, 2, 4]) });
    expect(added.code).toBe(5);
    expect(added.draft.scales["scale.yes_no"]!.options.map((o) => o.code)).toEqual([1, 2, 5]);
    publishable(added.draft);
  });

  it("retires a published value it removes, so the next option skips it", () => {
    const added = ops.addQuestion(live(), { sectionKey: "gaming", typeId: "single_choice", text: "Favourite console?" });
    const removed = ops.removeOption(added.draft, added.itemKey, 3, { published: true, at: actor.at }).draft;
    expect(removed.retiredCodes["scale.ybm_studio_favourite_console"]).toEqual([{ code: 3, label: "Option 3", retiredAt: actor.at }]);
    expect(ops.addOption(removed, added.itemKey, { label: "Handheld" }).code).toBe(4);
    publishable(removed);
    // An unpublished value is simply gone.
    const unpublished = ops.removeOption(added.draft, added.itemKey, 3, { published: false, at: actor.at }).draft;
    expect(unpublished.retiredCodes).toEqual({});
    expect(refusal(() => ops.removeOption(unpublished, added.itemKey, 2, { published: false, at: actor.at })).message).toMatch(
      /at least two options/,
    );
  });

  it("reorders options without changing their values, and edits labels", () => {
    const added = ops.addQuestion(live(), { sectionKey: "gaming", typeId: "dropdown", text: "Platform?" });
    const moved = ops.moveOption(added.draft, added.itemKey, 3, 0).draft;
    expect(scaleOf(moved, added.itemKey)!.options.map((o) => [o.code, o.label])).toEqual([
      [3, "Option 3"],
      [1, "Option 1"],
      [2, "Option 2"],
    ]);
    const relabelled = ops.updateOption(moved, added.itemKey, 3, { label: "PC", description: "Desktop or laptop" }).draft;
    expect(scaleOf(relabelled, added.itemKey)!.options[0]).toMatchObject({ code: 3, label: "PC", description: "Desktop or laptop" });
    publishable(relabelled);
  });

  it("adds 'Other' with a follow-up asked only when it is chosen", () => {
    const added = ops.addQuestion(live(), { sectionKey: "gaming", typeId: "multiple_choice", text: "Which consoles do you use?" });
    const { draft, code, followUpItemKey } = ops.addOtherOption(added.draft, added.itemKey);
    expect(code).toBe(4);
    expect(scaleOf(draft, added.itemKey)!.options.at(-1)).toMatchObject({ code: 4, label: "Other", kind: "other_specify" });
    expect(followUpItemKey).toBe("ybm_studio.consoles_use_other");
    const followUp = findQuestion(draft, followUpItemKey)!.item;
    expect(followUp).toMatchObject({ responseType: "text_short", stem: { text: "Please tell us what" }, variable: "consoles_use_other" });
    expect(describeCondition(followUp.displayIf!, draft)).toBe("Shown only if “Which consoles do you use?” includes “Other”");
    const order = administered(publishable(draft));
    expect(order[order.indexOf(added.itemKey) + 1]).toBe(followUpItemKey);
    expect(refusal(() => ops.addOtherOption(draft, added.itemKey)).message).toMatch(/already has an “Other” option/);
    expect(refusal(() => ops.addOtherOption(draft, followUpItemKey)).code).toBe("invalid");
  });

  it("gives a question its own copy of a shared list", () => {
    const before = live();
    const { draft, scaleKey } = ops.forkScale(before, "ybm_smartphone.sm_use");
    expect(scaleKey).toBe("scale.ybm_smartphone_sm_use");
    expect(draft.scales[scaleKey]).toEqual({ ...before.scales["scale.yes_no"], key: scaleKey });
    const edited = ops.updateOption(draft, "ybm_smartphone.sm_use", 1, { label: "Yes, I do" }).draft;
    expect(scaleOf(edited, "ybm_smartphone.own")!.options[0]!.label).toBe("Yes");
    expect(scaleOf(edited, "ybm_smartphone.sm_use")!.options[0]!.label).toBe("Yes, I do");
    publishable(edited);
    // A list only one question uses is already its own.
    expect(ops.forkScale(draft, "ybm_smartphone.sm_use").scaleKey).toBe(scaleKey);
  });
});

// ---------------------------------------------------------------------------

describe("copying, re-keying and changing type", () => {
  it("copies a question straight after itself with a new ID and variable, sharing its options", () => {
    const first = ops.duplicateQuestion(live(), "ybm_smartphone.own");
    expect(first.itemKey).toBe("ybm_smartphone.own_2");
    const second = ops.duplicateQuestion(first.draft, "ybm_smartphone.own");
    expect(second.itemKey).toBe("ybm_smartphone.own_3");
    const copy = findQuestion(second.draft, "ybm_smartphone.own_2")!.item;
    expect(copy).toMatchObject({ variable: "smartphone_own_2", revision: 1, scale: "scale.yes_no" });
    expect(copy.legacyVariable).toBeUndefined();
    expect(findQuestion(second.draft, "ybm_smartphone.own_3")!.item.variable).toBe("smartphone_own_3");
    const order = administered(publishable(second.draft));
    expect(order.slice(order.indexOf("ybm_smartphone.own"), order.indexOf("ybm_smartphone.own") + 4)).toEqual([
      "ybm_smartphone.own",
      "ybm_smartphone.own_3",
      "ybm_smartphone.own_2",
      "ybm_smartphone.age_smartphone",
    ]);
    expect(refusal(() => ops.duplicateQuestion(live(), "kss.q1")).code).toBe("locked");
  });

  it("carries every reference along when an unpublished question is re-keyed", () => {
    const { draft, itemKey } = ops.updateQuestion(live(), "ybm_smartphone.sm_use", { key: "uses_social_media" });
    expect(itemKey).toBe("ybm_smartphone.uses_social_media");
    const section = draft.composition.sections.find((s) => s.key === "social_media")!;
    expect(JSON.stringify(section.displayIf)).toContain('"item":"uses_social_media"');
    expect(JSON.stringify(draft)).not.toContain('"item":"sm_use"');
    publishable(draft);
    const published = new Set(["ybm_smartphone.sm_use"]);
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.sm_use", { key: "x" }, { published })).code).toBe("published");
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.sm_use", { variable: "x" }, { published })).code).toBe("published");
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.sm_use", { variable: "smartphone_own" })).message).toMatch(/already used/);
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.sm_use", { key: "own" })).message).toMatch(/already used/);
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.sm_use", { key: "Bad Key" })).code).toBe("invalid");
  });

  it("keeps an edit type-correct", () => {
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.own", { maxChars: 10 } as ops.QuestionPatch)).message).toMatch(
      /has no “maxChars” setting/,
    );
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.own", { responseType: "info" } as ops.QuestionPatch)).message).toMatch(
      /change its type/,
    );
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.own", { stem: null } as ops.QuestionPatch)).message).toMatch(
      /can be changed but not removed/,
    );
    const cleared = ops.updateQuestion(live(), "ybm_social_media.abstain_days", { lede: null, max: 365 }).draft;
    expect(findQuestion(cleared, "ybm_social_media.abstain_days")!.item).not.toHaveProperty("lede");
    publishable(cleared);
  });

  it("changes an unpublished question's type in place, keeping its ID, wording and condition", () => {
    const { draft } = ops.changeQuestionType(live(), "ybm_smartphone.age_smartphone", "number");
    const item = findQuestion(draft, "ybm_smartphone.age_smartphone")!.item;
    expect(item).toMatchObject({ responseType: "numeric", variable: "smartphone_age", required: "soft" });
    expect(item.stem.text).toMatch(/^At what age did you get your first smartphone/);
    expect(item.displayIf).toEqual(findQuestion(live(), "ybm_smartphone.age_smartphone")!.item.displayIf);
    publishable(draft);
    // A choice question keeps its options when it becomes another choice type.
    const dropdown = ops.changeQuestionType(live(), "ybm_smartphone.age_smartphone", "dropdown").draft;
    expect(findQuestion(dropdown, "ybm_smartphone.age_smartphone")!.item).toMatchObject({
      presentation: "dropdown",
      scale: "scale.age_adoption_smartphone",
    });
    publishable(dropdown);
  });

  it("refuses to change a published question's type, and replaces it with a new question instead", () => {
    const published = new Set(["ybm_smartphone.age_smartphone"]);
    const error = refusal(() => ops.changeQuestionType(live(), "ybm_smartphone.age_smartphone", "number", { published }));
    expect(error.code).toBe("published");
    expect(error.message).toMatch(/replace it with a new question/);
    const replaced = ops.replaceWithNewType(live(), "ybm_smartphone.age_smartphone", "number", { ...actor });
    expect(replaced.itemKey).toBe("ybm_smartphone.age_smartphone_2");
    expect(replaced.archivedItemKey).toBe("ybm_smartphone.age_smartphone");
    expect(replaced.draft.archived.map((a) => a.itemKey)).toEqual(["ybm_smartphone.age_smartphone"]);
    const order = administered(publishable(replaced.draft));
    expect(order[order.indexOf("ybm_smartphone.own") + 1]).toBe("ybm_smartphone.age_smartphone_2");
    expect(findQuestion(replaced.draft, replaced.itemKey)!.item).toMatchObject({ responseType: "numeric", variable: "smartphone_age_2" });
  });
});

// ---------------------------------------------------------------------------

describe("sections, blocks and screens", () => {
  it("adds a section that is invalid until a question is put in it", () => {
    const added = ops.addSection(live(), { title: "Your pets", index: 2 });
    expect(added.sectionKey).toBe("your_pets");
    expect(previewRelease(added.draft).error).toMatch(/components/);
    const filled = ops.addQuestion(added.draft, { sectionKey: "your_pets", typeId: "yes_no", text: "Do you have a pet?" });
    const manifest = publishable(filled.draft);
    expect(manifest.composition.sections.map((s) => s.key).slice(1, 4)).toEqual(["about_you", "your_pets", "hands_and_ladders"]);
    expect(ops.addSection(filled.draft, { title: "Your pets" }).sectionKey).toBe("your_pets_2");
    expect(refusal(() => ops.addSection(live(), { title: "  " })).code).toBe("invalid");
  });

  it("renames, reorders and removes sections", () => {
    const renamed = ops.updateSection(live(), "gaming", { title: "Video games" }).draft;
    expect(outline(renamed).sections.find((s) => s.key === "gaming")!.title).toBe("Video games");
    const moved = ops.moveSection(renamed, "gaming", 8).draft;
    expect(moved.composition.sections.at(-1)!.key).toBe("gaming");
    publishable(moved);
    expect(refusal(() => ops.removeSection(live(), "gaming")).message).toMatch(/Move them to another section or archive them first/);
    const added = ops.addSection(live(), { title: "Spare" });
    expect(ops.removeSection(added.draft, "spare").draft).toEqual(live());
  });

  it("sets and clears a block condition, allowed on a licensed questionnaire", () => {
    const condition = { op: "selected" as const, target: { item: { instrument: "ybm_smartphone", item: "sm_use", revision: 1 } }, code: 1 };
    const set = ops.setBlockCondition(live(), "social_media", 2, condition).draft;
    expect(set.composition.sections.find((s) => s.key === "social_media")!.components[2]!.displayIf).toEqual(condition);
    publishable(set);
    expect(ops.setBlockCondition(set, "social_media", 2, null).draft).toEqual(live());
  });

  it("edits the welcome, finish and settings", () => {
    expect(refusal(() => ops.updateWelcome(live(), { participantCode: { pattern: "^[A-Z" } })).message).toMatch(/not a pattern/);
    const welcome = ops.updateWelcome(live(), {
      participantCode: { hint: "Three letters, then four numbers", placeholder: null },
      studyLabel: "Leeds · 2027",
      contact: { note: "Ask a researcher if anything is unclear." },
    }).draft;
    expect(welcome.composition.participantCode).toMatchObject({ hint: "Three letters, then four numbers", variable: "val_id" });
    expect(welcome.composition.participantCode).not.toHaveProperty("placeholder");
    expect(welcome.composition.contact).toMatchObject({ email: "brainpop@leeds.ac.uk", note: "Ask a researcher if anything is unclear." });
    const finish = ops.updateScreen(welcome, "finish", { body: "Thank you so much." }).draft;
    expect(finish.composition.screens["finish"]!.title!.pipes).toBeDefined();
    expect(finish.composition.screens["finish"]!.body).toEqual({ text: "Thank you so much." });
    const settings = ops.updateSettings(finish, { title: "YBM 2027", allowBackNavigation: false, effort: { confirmSkip: false } }).draft;
    expect(settings.composition.effort).toMatchObject({ confirmSkip: false, skipRunCheckIn: 3 });
    const manifest = publishable(settings);
    expect(manifest.composition.studyLabel).toBe("Leeds · 2027");
    expect(refusal(() => ops.updateSettings(live(), { title: " " })).code).toBe("invalid");
  });

  it("keeps coding notes out of the release", () => {
    const noted = ops.setQuestionNotes(live(), "kss.q1", { codingNotes: "9 = extremely sleepy" }).draft;
    expect(noted.notes).toEqual({ "kss.q1": { codingNotes: "9 = extremely sleepy" } });
    expect(JSON.stringify(publishable(noted))).not.toContain("extremely sleepy");
    expect(ops.setQuestionNotes(noted, "kss.q1", { codingNotes: null }).draft.notes).toEqual({});
  });
});

// ---------------------------------------------------------------------------

describe("the edited survey as a whole", () => {
  it("survives a long sequence of edits and still freezes cleanly", () => {
    let draft = live();
    const step = (next: StudioDraft) => (draft = deepFreeze(next));
    const types: QuestionTypeId[] = ["short_text", "rating", "multiple_choice"];
    for (const typeId of types) step(ops.addQuestion(draft, { sectionKey: "phones", typeId, afterItemKey: "ybm_smartphone.age_sm" }).draft);
    step(ops.moveQuestion(draft, "ybm_smartphone.new_question", { sectionKey: "gaming", index: 0 }).draft);
    step(ops.archiveQuestion(draft, "ybm_smartphone.new_question_2", actor).draft);
    step(ops.moveBlock(draft, { sectionKey: "right_now", componentIndex: 2 }, { sectionKey: "welcome", index: 1 }).draft);
    const manifest = publishable(draft);
    expect(sectionOf(manifest, "ybm_smartphone.new_question")).toBe("gaming");
    expect(sectionOf(manifest, "ybm_future_self.message")).toBe("welcome");
    expect(administered(manifest)).toHaveLength(147 + 2);
  });
});

// ---------------------------------------------------------------------------
// Holes found in review: each test failed before the fix it names.
// ---------------------------------------------------------------------------

describe("consent comes first", () => {
  const consentFirst = (draft: StudioDraft) => {
    const order = administered(publishable(draft));
    const last = order.map((k) => k.startsWith("ybm_intro_consent.")).lastIndexOf(true);
    return last >= 0 && order.slice(0, last).every((k) => k.startsWith("ybm_intro_consent."));
  };

  it("refuses every way of asking something before the consent", () => {
    const before = (fn: () => unknown) => {
      const error = refusal(fn);
      expect(error.code).toBe("protected");
      expect(error.message).toMatch(/asked before “YBM introduction and consent”/);
    };
    before(() => ops.moveSection(live(), "gaming", 0));
    before(() => ops.moveBlock(live(), { sectionKey: "gaming", componentIndex: 0 }, { sectionKey: "welcome", index: 0 }));
    before(() => ops.moveQuestion(live(), "ybm_smartphone.own", { sectionKey: "welcome", index: 0 }));
    const first = ops.addSection(live(), { title: "Before anything", index: 0 });
    before(() => ops.addQuestion(first.draft, { sectionKey: first.sectionKey, typeId: "short_text" }));
    const archived = ops.archiveQuestion(first.draft, "ybm_smartphone.own", actor).draft;
    before(() => ops.restoreQuestion(archived, "ybm_smartphone.own", { sectionKey: first.sectionKey }));
    // Restoring it where it was is fine.
    publishable(ops.restoreQuestion(ops.removeSection(archived, first.sectionKey).draft, "ybm_smartphone.own").draft);
  });

  it("still allows anything after it, and keeps the consent first though its wording is open (D-61)", () => {
    const after = ops.moveQuestion(live(), "ybm_smartphone.own", { sectionKey: "welcome", index: 3 }).draft;
    expect(consentFirst(after)).toBe(true);
    expect(refusal(() => ops.unlockModule(live(), "ybm_intro_consent", { ...actor, reason: "Not needed any more for the consent." })).code).toBe("invalid");
    expect(refusal(() => ops.moveSection(live(), "gaming", 0)).code).toBe("protected");
  });
});

describe("changing type always gives the type asked for", () => {
  const creatableTypes = QUESTION_TYPES.filter((t) => t.canCreate).map((t) => t.id);

  it.each(creatableTypes)("turns a %s question into every other type, each reading back as asked and freezing cleanly", (from) => {
    const added = ops.addQuestion(live(), { sectionKey: "gaming", typeId: from, text: "Pick one" });
    for (const to of creatableTypes) {
      const { draft } = ops.changeQuestionType(deepFreeze(added.draft), added.itemKey, to);
      expect(studioTypeOf(findQuestion(draft, added.itemKey)!.item, scaleOf(draft, added.itemKey)), `${from} → ${to}`).toBe(to);
      publishable(draft);
    }
  });

  it("gives a Yes/No question new options when it becomes single choice or a rating (the Yes/No list would keep it Yes/No)", () => {
    const { draft } = ops.changeQuestionType(live(), "ybm_smartphone.own", "rating");
    expect(scaleOf(draft, "ybm_smartphone.own")!.options).toHaveLength(5);
    // The shared Yes/No list is untouched for everyone else.
    expect(draft.scales["scale.yes_no"]).toEqual(live().scales["scale.yes_no"]);
    expect(scaleOf(draft, "ybm_smartphone.sm_use")!.key).toBe("scale.yes_no");
  });
});

describe("participant-code questions keep their options", () => {
  it("refuses pointing one at another option list, even when unlocked", () => {
    const unlocked = ops.unlockModule(live(), "ybm_identity", { ...actor, reason: "Clarifying the wording for Year 7 pupils." }).draft;
    const error = refusal(() => ops.updateQuestion(unlocked, "ybm_identity.ps_birth_month", { scale: "scale.yes_no" }));
    expect(error.code).toBe("linkage");
    expect(error.message).toMatch(/participant code is built from/);
  });
});

describe("the archive is not a way round the tiers", () => {
  it("refuses editing a licensed questionnaire's options through a question sharing them after its block is removed", () => {
    const added = ops.addQuestion(live(), { sectionKey: "wellbeing", typeId: "single_choice", text: "Same again?" });
    const shared = ops.updateQuestion(added.draft, added.itemKey, { scale: "scale.sdq_3pt" }).draft;
    const removed = deepFreeze(ops.removeBlock(shared, "wellbeing", 1, actor).draft);
    const error = refusal(() => ops.updateOption(removed, added.itemKey, 0, { label: "Changed" }));
    expect(error.code).toBe("locked");
    expect(error.message).toMatch(/\(archived\) in “Strengths and Difficulties/);
    // Its own copy can change, and the questionnaire comes back as licensed.
    const forked = ops.forkScale(removed, added.itemKey);
    expect(forked.scaleKey).not.toBe("scale.sdq_3pt");
    const edited = ops.updateOption(forked.draft, added.itemKey, 0, { label: "Changed" }).draft;
    const restored = ops.restoreQuestion(edited, "sdq25_s.q1").draft;
    expect(restored.scales["scale.sdq_3pt"]).toEqual(live().scales["scale.sdq_3pt"]);
    publishable(restored);
  });

  it("refuses deleting one archived question of a licensed questionnaire, or of a protected module", () => {
    const removed = ops.removeBlock(live(), "wellbeing", 1, actor).draft;
    const error = refusal(() => ops.deleteQuestion(removed, "sdq25_s.q3", { published: new Set() }));
    expect(error.code).toBe("locked");
    expect(error.message).toMatch(/Strengths and Difficulties/);
    expect(ops.restoreQuestion(removed, "sdq25_s.q1").restored).toHaveLength(25);

    // The consent is the study's own (D-61): its archived questions can be deleted without an unlock.
    const archived = ops.archiveQuestion(live(), "ybm_intro_consent.intro", actor).draft;
    expect(ops.deleteQuestion(archived, "ybm_intro_consent.intro", { published: new Set() }).draft.archived).toEqual([]);
  });
});

describe("options belong to the right questions", () => {
  it("gives a question sharing its list its own copy before adding “Other”", () => {
    const before = live();
    const { draft, scaleKey, followUpItemKey } = ops.addOtherOption(before, "ybm_smartphone.own");
    expect(scaleKey).not.toBe("scale.yes_no");
    expect(scaleOf(draft, "ybm_smartphone.own")!.options.map((o) => o.label)).toEqual(["Yes", "No", "Other"]);
    // Every other Yes/No question is exactly as it was.
    expect(draft.scales["scale.yes_no"]).toEqual(before.scales["scale.yes_no"]);
    expect(findQuestion(draft, followUpItemKey)!.item.displayIf).toBeDefined();
    publishable(draft);
  });

  it("retires a removed value when a question using the list was published, even though its own copy's key never was", () => {
    const forked = ops.forkScale(live(), "ybm_smartphone.sm_use");
    const added = ops.addOption(forked.draft, "ybm_smartphone.sm_use", { label: "Sometimes" });
    const published = new Set(["ybm_smartphone.sm_use"]);
    const removed = ops.removeOption(added.draft, "ybm_smartphone.sm_use", 2, { published, at: actor.at }).draft;
    expect(removed.retiredCodes[forked.scaleKey]).toEqual([{ code: 2, label: "No", retiredAt: actor.at }]);
    expect(ops.addOption(removed, "ybm_smartphone.sm_use", { label: "Never" }).code).toBe(4);
    // A set that names none of the list's questions retires nothing.
    const unpublished = ops.removeOption(added.draft, "ybm_smartphone.sm_use", 2, { published: new Set(["kss.q1"]), at: actor.at }).draft;
    expect(unpublished.retiredCodes[forked.scaleKey]).toBeUndefined();
  });
});

describe("small holes", () => {
  it("treats only the named modules as protected, never an inherited property", () => {
    expect(refusal(() => ops.unlockModule(live(), "constructor", { ...actor, reason: "a long enough reason to be accepted" })).message).toMatch(
      /is not locked/,
    );
    expect(refusal(() => ops.updateQuestion(live(), "ybm_smartphone.age_smartphone", { scale: "constructor" })).code).toBe("not_found");
  });

  it("keeps an archived neighbour's place when the question beside it is re-keyed", () => {
    const archived = ops.archiveQuestion(live(), "ybm_smartphone.age_smartphone", actor).draft;
    const renamed = ops.updateQuestion(archived, "ybm_smartphone.own", { key: "own_phone" }).draft;
    const order = administered(publishable(ops.restoreQuestion(renamed, "ybm_smartphone.age_smartphone").draft));
    expect(order.indexOf("ybm_smartphone.age_smartphone")).toBe(order.indexOf("ybm_smartphone.own_phone") + 1);
  });
});
