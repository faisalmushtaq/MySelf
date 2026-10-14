import { describe, expect, it } from "vitest";
import { addQuestion, moveSection, updateQuestion } from "@myself/studio";
import { liveDraft } from "../node/fixture.js";
import {
  conditionSummary,
  dependentsOf,
  keyProblem,
  parseNumber,
  refusal,
  requiredChoice,
  suggestedKey,
  suggestedVariable,
  variableProblem,
} from "./settings.js";

describe("required, as the panel shows it", () => {
  it("shows soft and optional both as Not required, and remembers which is stored", () => {
    expect(requiredChoice({ required: "hard" })).toEqual({ value: "hard", storedOptional: false });
    expect(requiredChoice({ required: "soft" })).toEqual({ value: "soft", storedOptional: false });
    expect(requiredChoice({ required: "optional" })).toEqual({ value: "soft", storedOptional: true });
    expect(requiredChoice({})).toEqual({ value: "soft", storedOptional: false });
  });
});

describe("numbers typed into settings", () => {
  it("parses, bounds and allows leaving an optional setting empty", () => {
    expect(parseNumber("12")).toEqual({ ok: true, value: 12 });
    expect(parseNumber(" 2.5 ")).toEqual({ ok: true, value: 2.5 });
    expect(parseNumber("", { optional: true })).toEqual({ ok: true, value: null });
    expect(parseNumber("")).toEqual({ ok: false, message: "Enter a number." });
    expect(parseNumber("2.5", { integer: true })).toEqual({ ok: false, message: "Enter a whole number." });
    expect(parseNumber("130", { max: 120 })).toEqual({ ok: false, message: "Enter 120 or less." });
    expect(parseNumber("abc").ok).toBe(false);
  });
});

describe("question IDs and reporting labels", () => {
  const d = liveDraft();
  const reserved = { itemKeys: new Set(["ybm_studio.old_question"]), variables: new Set(["old_column"]) };
  const added = addQuestion(d, { sectionKey: "sleep", typeId: "short_text", text: "What time do you go to bed?", reserved });

  it("accepts a new ID and its own current one", () => {
    expect(keyProblem(added.draft, added.itemKey, "bedtime", reserved)).toBeNull();
    expect(keyProblem(added.draft, added.itemKey, added.itemKey.split(".")[1]!, reserved)).toBeNull();
  });

  it("refuses IDs the model would refuse, before they are sent", () => {
    expect(keyProblem(added.draft, added.itemKey, "", reserved)).toMatch(/needs an ID/);
    expect(keyProblem(added.draft, added.itemKey, "Bedtime", reserved)).toMatch(/lowercase/);
    expect(keyProblem(added.draft, added.itemKey, "old_question", reserved)).toMatch(/already used/);
    const second = addQuestion(added.draft, { sectionKey: "sleep", typeId: "short_text", text: "And wake up?" });
    expect(keyProblem(second.draft, second.itemKey, added.itemKey.split(".")[1]!, reserved)).toMatch(/already used/);
    // …and the model agrees.
    expect(() => updateQuestion(second.draft, second.itemKey, { key: added.itemKey.split(".")[1]! }, { reserved })).toThrow();
  });

  it("refuses a reporting label used now or by any published version", () => {
    const current = "bed_time";
    expect(variableProblem(added.draft, current, current, reserved)).toBeNull();
    expect(variableProblem(added.draft, current, "old_column", reserved)).toMatch(/already a column/);
    expect(variableProblem(added.draft, current, "kss", reserved)).toBeNull();
    expect(variableProblem(added.draft, current, "smartphone_own", reserved)).toMatch(/already a column/);
    expect(variableProblem(added.draft, current, "a".repeat(33), reserved)).toMatch(/at most 32/);
  });

  it("suggests an ID from the wording and a label from the ID", () => {
    const key = suggestedKey(added.draft, added.itemKey, "How many hours do you sleep?", reserved);
    expect(key).toBe("many_hours_sleep");
    expect(suggestedVariable(added.draft, key, "whatever", reserved)).toBe("many_hours_sleep");
  });
});

describe("what depends on a question", () => {
  const d = liveDraft();

  it("finds conditions that use its answer", () => {
    const deps = dependentsOf(d, "ybm_smartphone.own");
    expect(deps.questions.map((q) => q.itemKey)).toContain("ybm_smartphone.age_smartphone");
  });

  it("finds text that inserts its answer, including the finish screen", () => {
    const deps = dependentsOf(d, "ybm_identity.first_name");
    expect(deps.pipes.map((p) => p.text)).toContain("The finish screen");
    const games = dependentsOf(d, "ybm_gaming.top_games");
    expect(games.pipes.map((p) => p.itemKey)).toContain("ybm_gaming.game_time_1");
  });

  it("finds answer checks and option limits that read it", () => {
    const deps = dependentsOf(d, "ybm_identity.dob");
    expect(deps.checks.map((c) => c.itemKey)).toEqual(
      expect.arrayContaining(["ybm_identity.ps_birth_month", "ybm_smartphone.age_smartphone", "ybm_smartphone.age_sm"]),
    );
  });

  it("sums up what depends on it in words", () => {
    const q = { itemKey: "a.b", text: "x" };
    expect(conditionSummary({ questions: [q], sections: [], blocks: [] })).toBe("Used in the conditions of 1 question");
    expect(conditionSummary({ questions: [q, q, q], sections: [{ sectionKey: "s", title: "S" }], blocks: [] })).toBe(
      "Used in the conditions of 3 questions and 1 section",
    );
    expect(conditionSummary({ questions: [], sections: [], blocks: [] })).toBeNull();
  });

  it("finds section conditions", () => {
    const social = d.composition.sections.find((s) => s.key === "social_media")!;
    const on = JSON.stringify(social.displayIf);
    const used = /"instrument":"([a-z_]+)","item":"([a-z_0-9]+)"/.exec(on)!;
    const deps = dependentsOf(d, `${used[1]}.${used[2]}`);
    expect(deps.sections.map((s) => s.sectionKey)).toContain("social_media");
  });
});

describe("asking the model first", () => {
  it("returns the model's own refusal, or null when it would go ahead", () => {
    const d = liveDraft();
    expect(refusal(() => moveSection(d, "welcome", 1))).toMatch(/asked before/);
    expect(refusal(() => moveSection(d, "gaming", 5))).toBeNull();
  });
});
