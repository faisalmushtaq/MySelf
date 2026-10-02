import {
  canonicalJson,
  type ItemDefinition,
  type LogicExpr,
} from "@myself/schema";
import {
  findQuestion,
  fromLogic,
  liveQuestions,
  TEST_LABELS,
  testsFor,
  toLogic,
  type ConditionJoin,
  type ConditionTest,
  type LiveQuestion,
  type SimpleCondition,
  type StudioDraft,
} from "@myself/studio";
import { questionName } from "../outline/model.js";

/**
 * The model behind the condition builder ("Show this question only if…").
 *
 * The builder edits a flat list of rules joined by All or Any — exactly what
 * @myself/studio's logic.ts can write back without loss. While a rule is half
 * filled in it lives only here: the draft keeps the last complete condition
 * until every rule says which question, which test and which value, because a
 * half-written condition is not something the survey can run.
 *
 * Only EARLIER questions are offered. A condition can only use an answer the
 * participant has already given (D-25, D-26), which is also why a survey built
 * this way can never loop: the survey always moves forward.
 */

/** What a condition is attached to. */
export type ConditionSubject =
  | { kind: "question"; itemKey: string }
  | { kind: "section"; sectionKey: string }
  | { kind: "block"; sectionKey: string; componentIndex: number };

export interface EarlierQuestion {
  itemKey: string;
  /** The question's wording, shortened for a menu. */
  text: string;
  sectionKey: string;
  sectionTitle: string;
  responseType: ItemDefinition["responseType"];
  /** Position in the survey, 1-based, as a researcher counts. */
  number: number;
  tests: ConditionTest[];
}

/**
 * The administered position a condition is evaluated at: the subject's first
 * question. A section or block with no questions yet is evaluated where its
 * first question would be, so everything before it counts as earlier.
 */
function bindPosition(draft: StudioDraft, subject: ConditionSubject, live: LiveQuestion[]): number {
  switch (subject.kind) {
    case "question": {
      const q = live.find((x) => x.itemKey === subject.itemKey);
      return q ? q.position : -1;
    }
    case "section": {
      const index = draft.composition.sections.findIndex((s) => s.key === subject.sectionKey);
      if (index < 0) return -1;
      const first = live.find((q) => q.sectionIndex >= index);
      return first ? first.position : live.length;
    }
    case "block": {
      const index = draft.composition.sections.findIndex((s) => s.key === subject.sectionKey);
      if (index < 0) return -1;
      const first = live.find(
        (q) => q.sectionIndex > index || (q.sectionIndex === index && q.componentIndex >= subject.componentIndex),
      );
      return first ? first.position : live.length;
    }
  }
}

/**
 * The questions a condition on `subject` may depend on: those asked before it,
 * each once, that have an answer to test (information screens have none).
 */
export function earlierQuestions(
  draft: StudioDraft,
  subject: ConditionSubject,
  live: LiveQuestion[] = liveQuestions(draft),
): EarlierQuestion[] {
  const bind = bindPosition(draft, subject, live);
  const titles = new Map(draft.composition.sections.map((s) => [s.key, s.title]));
  const seen = new Set<string>();
  const out: EarlierQuestion[] = [];
  for (const q of live) {
    if (q.position >= bind) break;
    if (seen.has(q.itemKey)) continue;
    seen.add(q.itemKey);
    const tests = testsFor(q.item);
    if (tests.length === 0) continue;
    out.push({
      itemKey: q.itemKey,
      text: questionName(q.item.stem.text, 70),
      sectionKey: q.sectionKey,
      sectionTitle: titles.get(q.sectionKey) ?? q.sectionKey,
      responseType: q.item.responseType,
      number: q.position + 1,
      tests,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules as the builder holds them
// ---------------------------------------------------------------------------

export interface RuleRow {
  /** Stable React key for the row, never stored. */
  id: number;
  /** `<instrument>.<key>`, or "" until chosen. */
  itemKey: string;
  test: ConditionTest | "";
  /** The option, for "is" / "is not". */
  code: number | null;
  /** The compared value as typed, for "equals" … "is at most". */
  value: string;
  /** Whether `value` is compared as a number or as text. */
  valueType: "number" | "text";
}

export interface BuilderState {
  join: ConditionJoin;
  rows: RuleRow[];
}

export type ParsedCondition =
  | { kind: "none" }
  | { kind: "simple"; state: BuilderState }
  /** More than the flat builder can show exactly (nested groups, parts of answers): read-only. */
  | { kind: "complex" };

let nextRowId = 1;
export function newRowId(): number {
  return nextRowId++;
}

function rowFrom(c: SimpleCondition): RuleRow {
  return {
    id: newRowId(),
    itemKey: c.itemKey,
    test: c.test,
    code: c.code ?? null,
    value: c.value === undefined ? "" : String(c.value),
    valueType: typeof c.value === "string" ? "text" : "number",
  };
}

/** The builder's view of a stored condition. */
export function parseCondition(expr: LogicExpr | null | undefined): ParsedCondition {
  if (!expr) return { kind: "none" };
  const simple = fromLogic(expr);
  if (!simple) return { kind: "complex" };
  return { kind: "simple", state: { join: simple.join, rows: simple.conditions.map(rowFrom) } };
}

/** What a test needs besides the question. */
export function testNeeds(test: ConditionTest | ""): "code" | "value" | "none" {
  switch (test) {
    case "selected":
    case "not_selected":
      return "code";
    case "equals":
    case "not_equals":
    case "greater_than":
    case "at_least":
    case "less_than":
    case "at_most":
      return "value";
    default:
      return "none";
  }
}

/** The options of a question, in the order participants see them, for the value menu. */
export function optionChoices(draft: StudioDraft, itemKey: string): { code: number; label: string }[] {
  const item = findQuestion(draft, itemKey)?.item;
  if (!item || !("scale" in item)) return [];
  return (draft.scales[item.scale]?.options ?? []).map((o) => ({ code: o.code, label: o.label }));
}

/** A new rule about a question, with the first sensible test and option already chosen. */
export function ruleFor(draft: StudioDraft, question: EarlierQuestion): RuleRow {
  const test = question.tests[0] ?? "answered";
  const first = optionChoices(draft, question.itemKey)[0];
  return {
    id: newRowId(),
    itemKey: question.itemKey,
    test,
    code: testNeeds(test) === "code" ? (first?.code ?? null) : null,
    value: "",
    valueType: "number",
  };
}

/** An empty rule, for "Add rule" before a question is chosen. */
export function emptyRule(): RuleRow {
  return { id: newRowId(), itemKey: "", test: "", code: null, value: "", valueType: "number" };
}

/**
 * The same rule pointed at another question: the test is kept if the new
 * question offers it, and the option or value is reset (the old one belonged
 * to the other question).
 */
export function retarget(draft: StudioDraft, row: RuleRow, question: EarlierQuestion): RuleRow {
  const test = row.test && question.tests.includes(row.test) ? row.test : (question.tests[0] ?? "answered");
  const first = optionChoices(draft, question.itemKey)[0];
  return {
    ...row,
    itemKey: question.itemKey,
    test,
    code: testNeeds(test) === "code" ? (first?.code ?? null) : null,
    value: "",
    valueType: "number",
  };
}

/** A different test on the same question: the option is kept when the new test uses one. */
export function withTest(draft: StudioDraft, row: RuleRow, test: ConditionTest): RuleRow {
  const needs = testNeeds(test);
  const first = optionChoices(draft, row.itemKey)[0];
  return {
    ...row,
    test,
    code: needs === "code" ? (row.code ?? first?.code ?? null) : null,
    value: needs === "value" ? row.value : "",
  };
}

/** What a rule still needs, in words, or null when it is complete. */
export function ruleProblem(row: RuleRow): string | null {
  if (!row.itemKey) return "Choose the question this depends on.";
  if (!row.test) return "Choose what to check.";
  const needs = testNeeds(row.test);
  if (needs === "code" && row.code === null) return "Choose the option.";
  if (needs === "value") {
    if (row.value.trim() === "") return row.valueType === "text" ? "Type the answer to compare with." : "Enter a number.";
    if (row.valueType === "number" && !Number.isFinite(Number(row.value))) return "Enter a number, for example 3 or 2.5.";
  }
  return null;
}

function toSimple(row: RuleRow): SimpleCondition {
  const c: SimpleCondition = { itemKey: row.itemKey, test: row.test as ConditionTest };
  const needs = testNeeds(row.test);
  if (needs === "code" && row.code !== null) c.code = row.code;
  if (needs === "value") c.value = row.valueType === "number" ? Number(row.value) : row.value;
  return c;
}

/**
 * The engine expression for the builder's rules, or null while any rule is
 * incomplete (the stored condition is then left as it was) or there are none.
 */
export function buildLogic(state: BuilderState): LogicExpr | null {
  if (state.rows.length === 0) return null;
  if (state.rows.some((r) => ruleProblem(r) !== null)) return null;
  try {
    return toLogic(state.rows.map(toSimple), state.join);
  } catch {
    return null;
  }
}

/** Whether two conditions say the same thing, so an unchanged builder writes nothing. */
export function sameLogic(a: LogicExpr | null | undefined, b: LogicExpr | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * How a test reads in the rule's menu, for the question it is about.
 *
 * REVIEW FIX: on a multiple-choice question "selected" means the answer
 * INCLUDES the option, whatever else was ticked — the sentence underneath says
 * so, but the menu said "is", which reads as "is exactly". And "not selected"
 * only holds for someone who answered (the engine treats a skipped question as
 * neither), so it says that too.
 */
export function testLabel(test: ConditionTest, responseType: ItemDefinition["responseType"] | undefined): string {
  if (responseType === "multi_choice") {
    if (test === "selected") return "includes";
    if (test === "not_selected") return "is answered without";
  }
  if (responseType === "single_choice" && test === "not_selected") return "is answered, but not";
  return TEST_LABELS[test];
}

/**
 * How the value of a rule is entered: a menu of the question's options, a
 * number, a line of text, or nothing.
 */
export function valueInput(row: RuleRow): "option" | "number" | "text" | "none" {
  const needs = testNeeds(row.test);
  if (needs === "code") return "option";
  if (needs === "value") return row.valueType === "text" ? "text" : "number";
  return "none";
}
