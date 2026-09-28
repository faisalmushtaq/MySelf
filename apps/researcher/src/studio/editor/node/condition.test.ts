import { describe, expect, it } from "vitest";
import type { LogicExpr } from "@myself/schema";
import { findQuestion, liveQuestions, setBlockCondition, updateQuestion, updateSection, validateDraft } from "@myself/studio";
import {
  buildLogic,
  earlierQuestions,
  emptyRule,
  parseCondition,
  retarget,
  ruleFor,
  ruleProblem,
  sameLogic,
  testNeeds,
  valueInput,
  withTest,
  type RuleRow,
} from "./condition.js";
import { liveDraft } from "./fixture.js";

const target = (instrument: string, item: string) => ({ item: { instrument, item, revision: 1 } });

describe("earlier questions a condition may use", () => {
  const d = liveDraft();
  const live = liveQuestions(d);

  it("offers only questions asked before this one, never itself or later ones", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.age_smartphone" });
    const keys = earlier.map((q) => q.itemKey);
    expect(keys).toContain("ybm_smartphone.own");
    expect(keys).not.toContain("ybm_smartphone.age_smartphone");
    expect(keys).not.toContain("ybm_smartphone.sm_use");
    const self = live.find((q) => q.itemKey === "ybm_smartphone.age_smartphone")!;
    for (const q of earlier) expect(q.number - 1).toBeLessThan(self.position);
  });

  it("leaves out information screens, which have no answer", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "kss.q1" });
    expect(earlier.some((q) => q.itemKey === "ybm_intro_consent.intro")).toBe(false);
    expect(earlier.some((q) => q.itemKey === "ybm_identity.first_name")).toBe(true);
    expect(earlier.every((q) => q.tests.length > 0)).toBe(true);
  });

  it("numbers questions as the survey does and names their section", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.age_smartphone" });
    const own = earlier.find((q) => q.itemKey === "ybm_smartphone.own")!;
    expect(own.number).toBe(live.find((q) => q.itemKey === "ybm_smartphone.own")!.position + 1);
    expect(own.sectionTitle).toBe("Phones and social media");
  });

  it("for a section, offers everything before its first question", () => {
    const earlier = earlierQuestions(d, { kind: "section", sectionKey: "social_media" });
    const keys = earlier.map((q) => q.itemKey);
    expect(keys).toContain("ybm_smartphone.sm_use");
    expect(keys.some((k) => k.startsWith("ybm_social_media."))).toBe(false);
  });

  it("for a block, offers earlier blocks of the same section but not its own questions", () => {
    const earlier = earlierQuestions(d, { kind: "block", sectionKey: "wellbeing", componentIndex: 1 });
    const keys = earlier.map((q) => q.itemKey);
    expect(keys).toContain("swemwbs.optimistic");
    expect(keys.some((k) => k.startsWith("sdq25_s."))).toBe(false);
  });

  it("offers nothing to the very first question", () => {
    expect(earlierQuestions(d, { kind: "question", itemKey: "ybm_intro_consent.intro" })).toEqual([]);
  });
});

describe("rules to and from the stored condition", () => {
  const d = liveDraft();

  it("reads a stored condition as rules and writes it back unchanged", () => {
    const expr = findQuestion(d, "ybm_smartphone.age_smartphone")!.item.displayIf!;
    const parsed = parseCondition(expr);
    expect(parsed.kind).toBe("simple");
    if (parsed.kind !== "simple") return;
    expect(parsed.state.rows[0]).toMatchObject({ itemKey: "ybm_smartphone.own", test: "selected", code: 1 });
    expect(sameLogic(buildLogic(parsed.state), expr)).toBe(true);
  });

  it("shows nested groups as too complex rather than approximating them", () => {
    const nested: LogicExpr = {
      op: "all",
      args: [
        { op: "answered", target: target("ybm_smartphone", "own") },
        { op: "any", args: [{ op: "selected", target: target("ybm_smartphone", "sm_use"), code: 1 }] },
      ],
    };
    expect(parseCondition(nested).kind).toBe("complex");
    expect(parseCondition(undefined).kind).toBe("none");
  });

  it("writes nothing while a rule is half filled in", () => {
    const own = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.age_smartphone" }).find((q) => q.itemKey === "ybm_smartphone.own")!;
    const complete = ruleFor(d, own);
    expect(ruleProblem(complete)).toBeNull();
    const half: RuleRow = { ...emptyRule() };
    expect(ruleProblem(half)).toMatch(/question/);
    expect(buildLogic({ join: "all", rows: [complete, half] })).toBeNull();
    expect(buildLogic({ join: "all", rows: [complete] })).toMatchObject({ op: "selected", code: 1 });
  });

  it("joins several rules with All or Any", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.age_sm" });
    const own = ruleFor(d, earlier.find((q) => q.itemKey === "ybm_smartphone.own")!);
    const sm = ruleFor(d, earlier.find((q) => q.itemKey === "ybm_smartphone.sm_use")!);
    expect(buildLogic({ join: "any", rows: [own, sm] })).toMatchObject({ op: "any", args: [{ op: "selected" }, { op: "selected" }] });
  });

  it("needs a number for a comparison, and says so", () => {
    const hours = earlierQuestions(d, { kind: "question", itemKey: "ybm_future_self.message" }).find((q) => q.itemKey === "ybm_social_media.abstain_days")!;
    let row = withTest(d, ruleFor(d, hours), "at_least");
    expect(testNeeds(row.test)).toBe("value");
    expect(valueInput(row)).toBe("number");
    expect(ruleProblem(row)).toBe("Enter a number.");
    row = { ...row, value: "two" };
    expect(ruleProblem(row)).toMatch(/number/);
    row = { ...row, value: "7" };
    expect(buildLogic({ join: "all", rows: [row] })).toMatchObject({ op: "gte", value: 7 });
  });

  it("resets the option when the rule moves to another question, and keeps it when only the test changes", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.age_sm" });
    const own = earlier.find((q) => q.itemKey === "ybm_smartphone.own")!;
    const gender = earlier.find((q) => q.itemKey === "ybm_demographics.gender")!;
    const row = { ...ruleFor(d, own), code: 2 };
    expect(withTest(d, row, "not_selected").code).toBe(2);
    expect(withTest(d, row, "answered").code).toBeNull();
    const moved = retarget(d, row, gender);
    expect(moved.itemKey).toBe("ybm_demographics.gender");
    expect(moved.test).toBe("selected");
    expect(moved.code).toBe(d.scales[(findQuestion(d, "ybm_demographics.gender")!.item as { scale: string }).scale]!.options[0]!.code);
  });

  it("builds conditions the model accepts and validation passes, on questions, sections and blocks", () => {
    const earlier = earlierQuestions(d, { kind: "question", itemKey: "ybm_smartphone.sm_use" });
    const logic = buildLogic({ join: "all", rows: [ruleFor(d, earlier.find((q) => q.itemKey === "ybm_smartphone.own")!)] })!;
    let next = updateQuestion(d, "ybm_smartphone.sm_use", { displayIf: logic }).draft;
    const gaming = buildLogic({
      join: "all",
      rows: [ruleFor(next, earlierQuestions(next, { kind: "section", sectionKey: "gaming" }).find((q) => q.itemKey === "ybm_smartphone.own")!)],
    })!;
    next = updateSection(next, "gaming", { displayIf: gaming }).draft;
    next = setBlockCondition(next, "right_now", 1, gaming).draft;
    const logicIssues = validateDraft(next).filter((i) => i.code.startsWith("logic."));
    expect(logicIssues).toEqual([]);
  });
});
