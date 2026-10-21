import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDraft, extractDraft } from "./draft.js";
import {
  ALLOWED_FIELDS_BY_TIER,
  allItemKeys,
  allVariables,
  editTier,
  fieldAllowed,
  findQuestion,
  IDENTITY_VARIABLES,
  identityRoleOf,
  LINKAGE_ITEM_KEYS,
  outline,
  PROTECTED_MODULES,
  scaleOf,
  scaleUsage,
  shortText,
} from "./model.js";
import { archiveQuestion, unlockModule } from "./ops.js";
import { liveQuestions } from "./walk.js";

const r730 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.3.0.manifest.json"), "utf8"));
const draft = extractDraft(r730);
const actor = { by: "researcher@example.org", at: "2026-09-28T12:00:00.000Z" };

describe("editability tiers", () => {
  it("locks licensed instruments, whether their licence says no or only with permission", () => {
    expect(editTier(draft, "sdq25_s")).toBe("locked");
    expect(editTier(draft, "ehi_sf")).toBe("locked");
    expect(editTier(draft, "bisbas12_ybm")).toBe("locked"); // "with_permission"
  });

  it("protects identity until unlocked, and leaves consent and the study's modules editable", () => {
    // The consent wording is the study team's to change (D-61).
    expect(editTier(draft, "ybm_intro_consent")).toBe("editable");
    expect(editTier(draft, "ybm_identity")).toBe("protected");
    expect(editTier(draft, "ybm_smartphone")).toBe("editable");
    expect(editTier(draft, "ybm_studio")).toBe("editable"); // not created yet
    const unlocked = unlockModule(draft, "ybm_identity", { ...actor, reason: "Rewording a hint; linkage is unaffected." }).draft;
    expect(editTier(unlocked, "ybm_identity")).toBe("editable");
  });

  it("lets each tier change only what docs/16 §4.4 allows", () => {
    expect(fieldAllowed("locked", "required")).toBe(true);
    expect(fieldAllowed("locked", "presentation")).toBe(true);
    expect(fieldAllowed("locked", "stem")).toBe(false);
    expect(fieldAllowed("locked", "displayIf")).toBe(false);
    expect(fieldAllowed("protected", "reportingCategory")).toBe(true);
    expect(fieldAllowed("protected", "required")).toBe(false);
    expect(fieldAllowed("editable", "stem")).toBe(true);
    // Plus the date of birth's age limits, each survey's own (D-65).
    expect(ALLOWED_FIELDS_BY_TIER.protected).toEqual(["researcherNote", "reportingCategory", "provenance", "minAgeYears", "maxAgeYears", "minYear", "maxYear"]);
    expect(fieldAllowed("protected", "minAgeYears")).toBe(true);
    expect(fieldAllowed("protected", "stem")).toBe(false);
    expect(Object.keys(PROTECTED_MODULES)).toEqual(["ybm_identity"]);
  });
});

describe("the identity questions", () => {
  it("names the four participant-code questions ingest reads, all identifying", () => {
    expect(LINKAGE_ITEM_KEYS).toHaveLength(4);
    for (const itemKey of LINKAGE_ITEM_KEYS) {
      const q = findQuestion(draft, itemKey);
      expect(q, itemKey).not.toBeNull();
      expect(q!.item.identifying).toBe(true);
      expect(identityRoleOf(itemKey, q!.item)).toBe("linkage");
    }
  });

  it("names the variables identity capture reads, all present and identifying", () => {
    for (const variable of IDENTITY_VARIABLES) {
      const q = liveQuestions(draft).find((x) => x.item.variable === variable);
      expect(q?.instrument, variable).toBe("ybm_identity");
      expect(q!.item.identifying).toBe(true);
      expect(identityRoleOf(q!.itemKey, q!.item)).toBe("identity");
    }
    expect(identityRoleOf("ybm_smartphone.own", { variable: "smartphone_own" })).toBeNull();
  });
});

describe("outline", () => {
  const o = outline(draft);

  it("lists the live survey as a participant meets it", () => {
    expect(o.sections.map((s) => s.key)).toEqual([
      "welcome",
      "about_you",
      "hands_and_ladders",
      "sleep",
      "wellbeing",
      "phones",
      "social_media",
      "gaming",
      "right_now",
    ]);
    const blocks = o.sections.flatMap((s) => s.blocks);
    const questions = blocks.flatMap((b) => b.questions);
    expect(blocks).toHaveLength(18);
    expect(questions).toHaveLength(147);
    expect(questions.map((q) => q.position)).toEqual(questions.map((_, i) => i));
    expect(o.sections.find((s) => s.key === "social_media")?.hasCondition).toBe(true);
    expect(blocks.every((b) => !b.subset)).toBe(true);
  });

  it("marks each block and question with its tier and type", () => {
    const blocks = o.sections.flatMap((s) => s.blocks);
    expect(blocks.find((b) => b.instrument === "sdq25_s")).toMatchObject({ tier: "locked", kind: "instrument", componentIndex: 1 });
    expect(blocks.find((b) => b.instrument === "ybm_intro_consent")?.tier).toBe("editable");
    expect(blocks.find((b) => b.instrument === "ybm_identity")?.tier).toBe("protected");
    const q = (itemKey: string) => blocks.flatMap((b) => b.questions).find((x) => x.itemKey === itemKey)!;
    expect(q("ybm_smartphone.own")).toMatchObject({ studioType: "yes_no", tier: "editable", required: "soft", indexInPlacement: 0 });
    expect(q("ehi_sf.writing").studioType).toBe("rating");
    expect(q("ybm_identity.ps_birth_month").studioType).toBe("single_choice");
    expect(q("ybm_social_media.apps_owned").studioType).toBe("rank_group");
    expect(q("ybm_gaming.top_games").studioType).toBe("form_fields");
    expect(q("macarthur_ssy.family").studioType).toBe("ladder");
    expect(q("ybm_intro_consent.consent").studioType).toBe("consent");
    expect(q("ybm_identity.first_name")).toMatchObject({ identifying: true, required: "hard" });
    expect(q("ybm_smartphone.age_smartphone").hasCondition).toBe(true);
  });

  it("carries the welcome and completion screens", () => {
    expect(o.welcome.participantCode?.variable).toBe("val_id");
    expect(o.welcome.contact?.ethicsReference).toBe("PSCETHS-1449");
    expect(o.welcome.studyLabel).toBeNull();
    expect(o.completion.finish?.title?.text).toBe("Thank you, {first_name}!");
    expect(o.completion.review?.kind).toBe("information");
  });

  it("lists archived questions with where they were", () => {
    const archived = archiveQuestion(draft, "ybm_smartphone.age_sm", actor).draft;
    expect(outline(archived).archived).toEqual([
      { itemKey: "ybm_smartphone.age_sm", text: expect.stringMatching(/^At what age did you start using social media/), sectionKey: "phones" },
    ]);
  });

  it("outlines a blank survey", () => {
    const blank = outline(emptyDraft({ surveyId: "pilot", study: "pilot", title: "Pilot" }));
    expect(blank.sections[0]?.blocks[0]).toMatchObject({ instrument: "pilot_studio", subset: true, tier: "editable" });
  });
});

describe("finding things", () => {
  it("finds a question with where it is shown", () => {
    const q = findQuestion(draft, "ybm_smartphone.sm_use")!;
    expect(q).toMatchObject({ instrument: "ybm_smartphone", key: "sm_use", formItemIndex: 2, refKey: "ybm_smartphone@1.0/en-GB/self/standard" });
    expect(q.placements).toEqual([{ sectionIndex: 5, sectionKey: "phones", componentIndex: 0, indexInPlacement: 2 }]);
    expect(findQuestion(draft, "ybm_smartphone.nope")).toBeNull();
    expect(findQuestion(draft, "nope")).toBeNull();
  });

  it("knows which questions share an option list", () => {
    expect(scaleUsage(draft, "scale.yes_no")).toEqual(
      expect.arrayContaining(["ybm_demographics.medication", "ybm_smartphone.own", "ybm_smartphone.sm_use", "ybm_social_media.family_control"]),
    );
    expect(scaleUsage(draft, "scale.sdq_3pt")).toHaveLength(25);
    expect(scaleOf(draft, "ybm_smartphone.own")?.key).toBe("scale.yes_no");
    expect(scaleOf(draft, "ybm_future_self.message")).toBeNull();
  });

  it("counts archived questions and the participant code among what is taken", () => {
    const archived = archiveQuestion(draft, "ybm_smartphone.age_sm", actor).draft;
    expect(allItemKeys(archived).has("ybm_smartphone.age_sm")).toBe(true);
    expect(allVariables(archived).has("sm_age")).toBe(true);
    expect(allVariables(draft).has("val_id")).toBe(true);
    expect(allItemKeys(draft).size).toBe(147);
  });

  it("shortens long text on a word", () => {
    expect(shortText("Short enough")).toBe("Short enough");
    expect(shortText("Roughly how many hours do you play video games in a typical week?")).toBe(
      "Roughly how many hours do you play video games in a typical…",
    );
  });
});
