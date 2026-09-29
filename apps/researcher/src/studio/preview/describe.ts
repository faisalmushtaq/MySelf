import type { LogicExpr } from "@myself/schema";

/**
 * A show-if condition in plain English, for the preview's path panel.
 *
 * TEMPORARY FALLBACK. @myself/studio is gaining its own `describeCondition`
 * (logic.ts), written for the editor's logic builder; once that lands the
 * preview should use it through `model-adapter.ts`, so a condition reads the
 * same in the editor and in the preview. Until then this covers every
 * operator the engine evaluates, in the words a researcher would use, with
 * option labels rather than codes.
 */

export interface DescribeContext {
  /** The question as a short quotation, e.g. “Do you have your own phone?”. */
  questionLabel: (itemKey: string) => string;
  /** An option's label, or null when the question has no such option. */
  optionLabel: (itemKey: string, code: number) => string | null;
  /** Whether the question allows several answers, which changes "is" to "includes". */
  isMulti: (itemKey: string) => boolean;
}

const quote = (text: string) => `“${text}”`;

export function describeCondition(expr: LogicExpr, ctx: DescribeContext): string {
  return describe(expr, ctx, null);
}

function describe(expr: LogicExpr, ctx: DescribeContext, parent: "all" | "any" | "not" | null): string {
  switch (expr.op) {
    case "all":
    case "any": {
      if (expr.args.length === 1) return describe(expr.args[0]!, ctx, parent);
      const joined = expr.args.map((a) => describe(a, ctx, expr.op)).join(expr.op === "all" ? " and " : " or ");
      // Brackets only where "and" and "or" meet, which is the one place a
      // sentence without them can be read two ways.
      return parent && parent !== expr.op ? `(${joined})` : joined;
    }
    case "not":
      return `it is not the case that ${describe(expr.arg, ctx, "not")}`;
    default:
      return describeTest(expr, ctx);
  }
}

function describeTest(expr: Exclude<LogicExpr, { op: "all" | "any" | "not" }>, ctx: DescribeContext): string {
  const key = `${expr.target.item.instrument}.${expr.target.item.item}`;
  const q = ctx.questionLabel(key);
  const part = expr.target.part;
  const option = (code: number) => {
    const label = ctx.optionLabel(key, code);
    return label === null ? `option ${code}` : quote(label);
  };
  const value = (v: number | string) => {
    // A choice compared with eq/ne compares its code, so say the option.
    if (typeof v === "number") {
      const label = ctx.optionLabel(key, v);
      if (label !== null) return quote(label);
    }
    return typeof v === "string" ? quote(v) : String(v);
  };

  switch (expr.op) {
    case "answered":
      return `${q} is answered`;
    case "not_empty":
      return part === undefined ? `${q} has an answer` : `${quote(String(part))} in ${q} is filled in`;
    case "selected":
      return ctx.isMulti(key) ? `${q} includes ${option(expr.code)}` : `${q} is ${option(expr.code)}`;
    case "not_selected":
      return ctx.isMulti(key)
        ? `${q} is answered without ${option(expr.code)}`
        : `${q} is answered with something other than ${option(expr.code)}`;
    case "in_group":
      return `${q} puts ${option(expr.code)} in ${quote(expr.group)}`;
    case "eq":
      return `${q} is ${value(expr.value)}`;
    case "ne":
      return `${q} is answered with something other than ${value(expr.value)}`;
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
