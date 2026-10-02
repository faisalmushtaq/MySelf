import type { ItemDefinition, LogicExpr } from "@myself/schema";
import type { StudioDraft } from "./contract.js";
import { findQuestion, shortText, StudioOpError } from "./model.js";
import { splitItemKey } from "./walk.js";
import { SLUG_PATTERN } from "./keys.js";

/**
 * Show-if conditions as the editor presents them: a flat list of rules joined
 * by "all" or "any", each a question, a test and a value.
 *
 * The engine's logic language (@myself/schema logic.ts) can say more than this
 * — nested groups, parts of multi-part answers, groups of a sort. Anything the
 * simple form cannot show exactly is shown read-only in plain English instead
 * (`fromLogic` returns null), never approximated: an editor that rewrote a
 * condition it had only half understood would change who sees a question.
 */

export type ConditionTest =
  | "selected"
  | "not_selected"
  | "answered"
  | "not_answered"
  | "equals"
  | "not_equals"
  | "greater_than"
  | "at_least"
  | "less_than"
  | "at_most";

export interface SimpleCondition {
  /** `<instrument>.<key>` of an earlier question. */
  itemKey: string;
  test: ConditionTest;
  /** The option code, for "selected" and "not_selected". */
  code?: number;
  /** The value compared against, for "equals" … "at_most". */
  value?: number | string;
}

export type ConditionJoin = "all" | "any";

/** How each test reads in the editor's menu. */
export const TEST_LABELS: Readonly<Record<ConditionTest, string>> = {
  selected: "is",
  not_selected: "is not",
  answered: "is answered",
  not_answered: "is not answered",
  equals: "equals",
  not_equals: "does not equal",
  greater_than: "is more than",
  at_least: "is at least",
  less_than: "is less than",
  at_most: "is at most",
};

type Target = { item: { instrument: string; item: string; revision: number } };

function targetOf(itemKey: string): Target {
  const { instrument, key } = splitItemKey(itemKey);
  if (!SLUG_PATTERN.test(instrument) || !SLUG_PATTERN.test(key)) {
    throw new StudioOpError(`A condition refers to “${itemKey}”, which is not a question ID.`, "invalid");
  }
  // The engine looks answers up by instrument and key; the revision is part of
  // the reference's shape but not of the lookup.
  return { item: { instrument, item: key, revision: 1 } };
}

function leafToLogic(c: SimpleCondition): LogicExpr {
  const target = targetOf(c.itemKey);
  const needCode = (): number => {
    if (typeof c.code !== "number" || !Number.isInteger(c.code)) {
      throw new StudioOpError("Choose which option the condition is about.", "invalid");
    }
    return c.code;
  };
  const needValue = (): number | string => {
    if (c.value === undefined || c.value === "" || (typeof c.value === "number" && !Number.isFinite(c.value))) {
      throw new StudioOpError("Enter the value the answer is compared with.", "invalid");
    }
    return c.value;
  };
  const needNumber = (): number => {
    const v = needValue();
    if (typeof v !== "number") throw new StudioOpError("Only a number can be compared as more or less than.", "invalid");
    return v;
  };
  switch (c.test) {
    case "selected":
      return { op: "selected", target, code: needCode() };
    case "not_selected":
      return { op: "not_selected", target, code: needCode() };
    case "answered":
      return { op: "answered", target };
    case "not_answered":
      return { op: "not", arg: { op: "answered", target } };
    case "equals":
      return { op: "eq", target, value: needValue() };
    case "not_equals":
      return { op: "ne", target, value: needValue() };
    case "greater_than":
      return { op: "gt", target, value: needNumber() };
    case "at_least":
      return { op: "gte", target, value: needNumber() };
    case "less_than":
      return { op: "lt", target, value: needNumber() };
    case "at_most":
      return { op: "lte", target, value: needNumber() };
  }
}

/**
 * The engine expression for a list of rules. One rule is written bare rather
 * than wrapped in a one-item group, which is how the library writes them too.
 */
export function toLogic(conditions: SimpleCondition[], join: ConditionJoin): LogicExpr {
  if (conditions.length === 0) {
    throw new StudioOpError("A condition needs at least one rule. To show the question to everyone, remove the condition.", "invalid");
  }
  const args = conditions.map(leafToLogic);
  if (args.length === 1) return args[0]!;
  return join === "all" ? { op: "all", args } : { op: "any", args };
}

function leafFromLogic(expr: LogicExpr): SimpleCondition | null {
  if (expr.op === "not") {
    if (expr.arg.op === "answered" && expr.arg.target.part === undefined) {
      return { itemKey: keyOf(expr.arg.target), test: "not_answered" };
    }
    return null;
  }
  // An age judged on the day of the sitting (D-51) has no rule in the builder:
  // it is shown read-only, in words.
  if (expr.op === "all" || expr.op === "any" || expr.op === "in_group" || expr.op === "not_empty" || expr.op === "age_gte") return null;
  // A test on one part of a multi-part answer has no simple form.
  if (expr.target.part !== undefined) return null;
  const itemKey = keyOf(expr.target);
  switch (expr.op) {
    case "answered":
      return { itemKey, test: "answered" };
    case "selected":
      return { itemKey, test: "selected", code: expr.code };
    case "not_selected":
      return { itemKey, test: "not_selected", code: expr.code };
    case "eq":
      return { itemKey, test: "equals", value: expr.value };
    case "ne":
      return { itemKey, test: "not_equals", value: expr.value };
    case "gt":
      return { itemKey, test: "greater_than", value: expr.value };
    case "gte":
      return { itemKey, test: "at_least", value: expr.value };
    case "lt":
      return { itemKey, test: "less_than", value: expr.value };
    case "lte":
      return { itemKey, test: "at_most", value: expr.value };
  }
}

/**
 * The simple form of an expression, or null when it cannot be shown exactly as
 * a flat list of rules (the editor then shows it read-only, described in words).
 */
export function fromLogic(expr: LogicExpr | null | undefined): { join: ConditionJoin; conditions: SimpleCondition[] } | null {
  if (!expr) return null;
  if (expr.op === "all" || expr.op === "any") {
    const conditions: SimpleCondition[] = [];
    for (const arg of expr.args) {
      const c = leafFromLogic(arg);
      if (!c) return null;
      conditions.push(c);
    }
    return conditions.length > 0 ? { join: expr.op, conditions } : null;
  }
  const c = leafFromLogic(expr);
  return c ? { join: "all", conditions: [c] } : null;
}

function keyOf(target: { item: { instrument: string; item: string } }): string {
  return `${target.item.instrument}.${target.item.item}`;
}

/** Every question an expression depends on, each once, in the order first mentioned. */
export function conditionTargets(expr: LogicExpr | null | undefined): string[] {
  const out: string[] = [];
  const walk = (e: LogicExpr) => {
    if (e.op === "all" || e.op === "any") e.args.forEach(walk);
    else if (e.op === "not") walk(e.arg);
    else {
      const k = keyOf(e.target);
      if (!out.includes(k)) out.push(k);
    }
  };
  if (expr) walk(expr);
  return out;
}

/** The tests that make sense for a question's type, in the order the editor offers them. */
export function testsFor(item: Pick<ItemDefinition, "responseType">): ConditionTest[] {
  switch (item.responseType) {
    case "single_choice":
    case "multi_choice":
      return ["selected", "not_selected", "answered", "not_answered"];
    case "numeric":
    case "slider":
    case "ladder":
      return ["equals", "not_equals", "greater_than", "at_least", "less_than", "at_most", "answered", "not_answered"];
    case "info":
      return [];
    default:
      return ["answered", "not_answered"];
  }
}

/**
 * A condition in plain English, e.g. `Shown only if “Do you have your own
 * smartphone?” is “Yes”`. Uses the draft's wording and option labels, so the
 * sentence says what a participant would actually have been asked.
 */
export function describeCondition(expr: LogicExpr, draft: StudioDraft): string {
  return `Shown only if ${phrase(expr, draft, false)}`;
}

function phrase(expr: LogicExpr, draft: StudioDraft, nested: boolean): string {
  switch (expr.op) {
    case "all":
    case "any": {
      const inner = expr.args.map((a) => phrase(a, draft, true)).join(expr.op === "all" ? " and " : " or ");
      return nested && expr.args.length > 1 ? `(${inner})` : inner;
    }
    case "not":
      if (expr.arg.op === "answered") return `${questionRef(draft, keyOf(expr.arg.target))} is not answered`;
      return `it is not true that ${phrase(expr.arg, draft, true)}`;
    default:
      return leafPhrase(expr, draft);
  }
}

function leafPhrase(expr: Exclude<LogicExpr, { op: "all" | "any" | "not" }>, draft: StudioDraft): string {
  const itemKey = keyOf(expr.target);
  const q = questionRef(draft, itemKey);
  const item = questionItem(draft, itemKey);
  const multi = item?.responseType === "multi_choice";
  const label = (code: number) => `“${optionLabel(draft, item, code)}”`;
  const value = (v: number | string) =>
    typeof v === "number" && item && "scale" in item ? label(v) : typeof v === "string" ? `“${v}”` : String(v);
  switch (expr.op) {
    case "answered":
      return `${q} is answered`;
    case "not_empty":
      return expr.target.part !== undefined ? `${q} (${partLabel(item, expr.target.part)}) is filled in` : `${q} has an answer`;
    case "selected":
      return multi ? `${q} includes ${label(expr.code)}` : `${q} is ${label(expr.code)}`;
    case "not_selected":
      // The engine treats an unanswered question as neither selected nor not
      // selected, so the sentence says "answered" — otherwise a researcher would
      // expect participants who skipped it to see the question too.
      return multi ? `${q} is answered without ${label(expr.code)}` : `${q} is answered with something other than ${label(expr.code)}`;
    case "in_group":
      return `${q} puts ${label(expr.code)} in “${groupLabel(item, expr.group)}”`;
    case "eq":
      return `${q} is ${value(expr.value)}`;
    case "ne":
      return `${q} is answered and is not ${value(expr.value)}`;
    case "gt":
      return `${q} is more than ${expr.value}`;
    case "gte":
      return `${q} is ${expr.value} or more`;
    case "lt":
      return `${q} is less than ${expr.value}`;
    case "lte":
      return `${q} is ${expr.value} or less`;
    case "age_gte":
      return `the participant is ${expr.years} or older on the day of the sitting, going by ${q}`;
  }
}

function questionItem(draft: StudioDraft, itemKey: string): ItemDefinition | null {
  return findQuestion(draft, itemKey)?.item ?? draft.archived.find((a) => a.itemKey === itemKey)?.item ?? null;
}

function questionRef(draft: StudioDraft, itemKey: string): string {
  const live = findQuestion(draft, itemKey);
  if (live) return `“${shortText(live.item.stem.text)}”`;
  const archived = draft.archived.find((a) => a.itemKey === itemKey);
  if (archived) return `“${shortText(archived.item.stem.text)}” (archived)`;
  return `question ${itemKey} (no longer in this survey)`;
}

function optionLabel(draft: StudioDraft, item: ItemDefinition | null, code: number): string {
  const scale = item && "scale" in item ? draft.scales[item.scale] : undefined;
  return scale?.options.find((o) => o.code === code)?.label ?? `option ${code}`;
}

function partLabel(item: ItemDefinition | null, part: number | string): string {
  if (item?.responseType === "form_fields") return item.fields.find((f) => f.key === part)?.label ?? String(part);
  return String(part);
}

function groupLabel(item: ItemDefinition | null, group: string): string {
  if (item?.responseType === "rank_group") return item.groups.find((g) => g.key === group)?.label ?? group;
  return group;
}
