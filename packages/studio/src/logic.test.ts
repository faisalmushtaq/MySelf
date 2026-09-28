import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { logicExpr, type LogicExpr } from "@myself/schema";
import { extractDraft } from "./draft.js";
import {
  conditionTargets,
  describeCondition,
  fromLogic,
  testsFor,
  toLogic,
  type SimpleCondition,
} from "./logic.js";
import { findQuestion, StudioOpError } from "./model.js";
import { updateQuestion } from "./ops.js";

const r710 = JSON.parse(readFileSync(resolve(__dirname, "../../../releases/ybm_nd2026_standard_r7.1.0.manifest.json"), "utf8"));
const draft = extractDraft(r710);

describe("toLogic and fromLogic", () => {
  const everyTest: SimpleCondition[] = [
    { itemKey: "ybm_smartphone.own", test: "selected", code: 1 },
    { itemKey: "ybm_smartphone.own", test: "not_selected", code: 2 },
    { itemKey: "ybm_smartphone.own", test: "answered" },
    { itemKey: "ybm_smartphone.own", test: "not_answered" },
    { itemKey: "ybm_social_media.abstain_days", test: "equals", value: 3 },
    { itemKey: "ybm_social_media.abstain_days", test: "not_equals", value: 3 },
    { itemKey: "ybm_social_media.abstain_days", test: "greater_than", value: 3 },
    { itemKey: "ybm_social_media.abstain_days", test: "at_least", value: 3 },
    { itemKey: "ybm_social_media.abstain_days", test: "less_than", value: 3 },
    { itemKey: "ybm_social_media.abstain_days", test: "at_most", value: 3 },
  ];

  it.each(everyTest)("round-trips a single $test rule, written bare", (condition) => {
    const expr = toLogic([condition], "all");
    expect(() => logicExpr.parse(expr)).not.toThrow();
    expect(expr.op).not.toBe("all");
    expect(fromLogic(expr)).toEqual({ join: "all", conditions: [condition] });
  });

  it("round-trips a list of rules joined by all or any", () => {
    for (const join of ["all", "any"] as const) {
      const expr = toLogic(everyTest, join);
      expect(expr.op).toBe(join);
      expect(fromLogic(expr)).toEqual({ join, conditions: everyTest });
    }
  });

  it("writes 'not answered' as not(answered), which the engine evaluates", () => {
    expect(toLogic([{ itemKey: "ybm_smartphone.own", test: "not_answered" }], "all")).toEqual({
      op: "not",
      arg: { op: "answered", target: { item: { instrument: "ybm_smartphone", item: "own", revision: 1 } } },
    });
  });

  it("reads the live survey's section condition as a simple 'any' of two rules", () => {
    const section = draft.composition.sections.find((s) => s.key === "social_media")!;
    expect(fromLogic(section.displayIf)).toEqual({
      join: "any",
      conditions: [
        { itemKey: "ybm_smartphone.sm_use", test: "selected", code: 1 },
        { itemKey: "ybm_smartphone.sm_use_confirm", test: "selected", code: 1 },
      ],
    });
  });

  it("returns null for anything a flat list of rules cannot show exactly", () => {
    const target = { item: { instrument: "a", item: "b", revision: 1 } };
    const complex: LogicExpr[] = [
      { op: "in_group", target, group: "have", code: 1 },
      { op: "not_empty", target },
      { op: "selected", target: { ...target, part: "x" }, code: 1 },
      { op: "all", args: [{ op: "any", args: [{ op: "answered", target }] }] },
      { op: "not", arg: { op: "selected", target, code: 1 } },
    ];
    for (const expr of complex) expect(fromLogic(expr)).toBeNull();
    expect(fromLogic(undefined)).toBeNull();
    // The live survey's per-app questions are shown by group: read-only.
    expect(fromLogic(findQuestion(draft, "ybm_social_media.time_facebook")!.item.displayIf)).toBeNull();
  });

  it("refuses a rule that is missing what it compares", () => {
    expect(() => toLogic([], "all")).toThrow(StudioOpError);
    expect(() => toLogic([{ itemKey: "ybm_smartphone.own", test: "selected" }], "all")).toThrow(/which option/);
    expect(() => toLogic([{ itemKey: "x.y", test: "equals" }], "all")).toThrow(/value/);
    expect(() => toLogic([{ itemKey: "x.y", test: "at_least", value: "3" }], "all")).toThrow(/number/);
    expect(() => toLogic([{ itemKey: "not an id", test: "answered" }], "all")).toThrow(/not a question ID/);
  });
});

describe("describeCondition", () => {
  it("says who sees a question in the survey's own words and option labels", () => {
    const expr = findQuestion(draft, "ybm_smartphone.age_smartphone")!.item.displayIf!;
    expect(describeCondition(expr, draft)).toBe("Shown only if “Do you have your own smartphone?” is “Yes”");
  });

  it("joins rules with and / or", () => {
    const section = draft.composition.sections.find((s) => s.key === "social_media")!;
    expect(describeCondition(section.displayIf!, draft)).toBe(
      "Shown only if “Do you currently use social media?” is “Yes” or “Just to check — do you use any of these?” is “Yes”",
    );
  });

  it("is precise about the engine's treatment of unanswered questions", () => {
    const expr = findQuestion(draft, "ybm_gaming.top_games")!.item.displayIf!;
    expect(describeCondition(expr, draft)).toBe(
      "Shown only if “Roughly how many hours do you play video games in a typical…” " +
        "is answered with something other than “I do not play video games”",
    );
    expect(describeCondition(toLogic([{ itemKey: "ybm_smartphone.own", test: "not_answered" }], "all"), draft)).toBe(
      "Shown only if “Do you have your own smartphone?” is not answered",
    );
  });

  it("describes group, part and numeric conditions", () => {
    const byGroup = findQuestion(draft, "ybm_social_media.time_facebook")!.item.displayIf!;
    expect(describeCondition(byGroup, draft)).toBe(
      "Shown only if “Which of these apps do you have on your phone?” puts “Facebook” in “I have these apps on my phone”",
    );
    const byPart = findQuestion(draft, "ybm_gaming.game_time_1")!.item.displayIf!;
    expect(describeCondition(byPart, draft)).toMatch(/\(Game 1\) is filled in$/);
    const numeric = toLogic([{ itemKey: "ybm_social_media.abstain_days", test: "at_least", value: 7 }], "all");
    expect(describeCondition(numeric, draft)).toMatch(/” is 7 or more$/);
  });

  it("names a question that is no longer there rather than inventing its wording", () => {
    const expr = toLogic([{ itemKey: "ybm_studio.gone", test: "answered" }], "all");
    expect(describeCondition(expr, draft)).toBe("Shown only if question ybm_studio.gone (no longer in this survey) is answered");
  });

  it("follows the draft's current wording", () => {
    const edited = updateQuestion(draft, "ybm_smartphone.own", { stem: { text: "Is there a smartphone that is yours?" } }).draft;
    const expr = findQuestion(edited, "ybm_smartphone.age_smartphone")!.item.displayIf!;
    expect(describeCondition(expr, edited)).toBe("Shown only if “Is there a smartphone that is yours?” is “Yes”");
  });
});

describe("conditionTargets and testsFor", () => {
  it("lists each question a condition depends on once", () => {
    const expr = toLogic(
      [
        { itemKey: "ybm_smartphone.own", test: "selected", code: 1 },
        { itemKey: "ybm_smartphone.sm_use", test: "answered" },
        { itemKey: "ybm_smartphone.own", test: "not_answered" },
      ],
      "any",
    );
    expect(conditionTargets(expr)).toEqual(["ybm_smartphone.own", "ybm_smartphone.sm_use"]);
    expect(conditionTargets(null)).toEqual([]);
  });

  it("offers the tests that make sense for each kind of question", () => {
    expect(testsFor({ responseType: "single_choice" })).toEqual(["selected", "not_selected", "answered", "not_answered"]);
    expect(testsFor({ responseType: "multi_choice" })).toContain("selected");
    expect(testsFor({ responseType: "numeric" })).toEqual([
      "equals",
      "not_equals",
      "greater_than",
      "at_least",
      "less_than",
      "at_most",
      "answered",
      "not_answered",
    ]);
    expect(testsFor({ responseType: "slider" })).toContain("at_most");
    expect(testsFor({ responseType: "ladder" })).toContain("greater_than");
    expect(testsFor({ responseType: "text_short" })).toEqual(["answered", "not_answered"]);
    expect(testsFor({ responseType: "date" })).toEqual(["answered", "not_answered"]);
    expect(testsFor({ responseType: "info" })).toEqual([]);
  });
});
