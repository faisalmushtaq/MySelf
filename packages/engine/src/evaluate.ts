import type { LogicExpr } from "@myself/schema";
import type { AnswerStore, AnswerValue } from "./answers.js";

/**
 * Total, side-effect-free evaluation of the logic AST against an AnswerStore.
 * Unanswered targets make comparison predicates false (never throw): display
 * logic over missing answers means "condition not met", matching Qualtrics
 * semantics and keeping evaluation order-independent.
 */

type Target = {
  item: { instrument: string; item: string; revision: number };
  part?: number | string | undefined;
};

function targetValue(store: AnswerStore, target: Target): AnswerValue | undefined {
  const rec = store.get(target.item);
  if (!rec || rec.status !== "answered") return undefined;
  return rec.value;
}

function partText(value: AnswerValue | undefined, part: number | string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.kind === "text") return value.value;
  if (value.kind === "fields" && part !== undefined) return value.values[String(part)];
  return undefined;
}

function scalar(value: AnswerValue | undefined): number | string | undefined {
  if (!value) return undefined;
  switch (value.kind) {
    case "choice":
      return value.code;
    case "number":
      return value.value;
    case "text":
      return value.value;
    case "date":
      return value.iso;
    default:
      return undefined;
  }
}

export function evaluate(expr: LogicExpr, store: AnswerStore): boolean {
  switch (expr.op) {
    case "all":
      return expr.args.every((a) => evaluate(a, store));
    case "any":
      return expr.args.some((a) => evaluate(a, store));
    case "not":
      return !evaluate(expr.arg, store);
    case "answered":
      return store.isAnswered(expr.target.item);
    case "not_empty": {
      const v = targetValue(store, expr.target);
      const text = partText(v, expr.target.part);
      if (text !== undefined) return text.trim().length > 0;
      return scalar(v) !== undefined;
    }
    case "selected": {
      const v = targetValue(store, expr.target);
      if (!v) return false;
      if (v.kind === "choice") return v.code === expr.code;
      if (v.kind === "multi") return v.codes.includes(expr.code);
      return false;
    }
    case "not_selected": {
      // "Not selected" is only meaningful once the question was answered:
      // an unanswered question is neither selected nor not-selected.
      const v = targetValue(store, expr.target);
      if (!v) return false;
      if (v.kind === "choice") return v.code !== expr.code;
      if (v.kind === "multi") return !v.codes.includes(expr.code);
      return false;
    }
    case "in_group": {
      const v = targetValue(store, expr.target);
      if (v?.kind !== "group_rank") return false;
      return v.assignments[expr.code]?.group === expr.group;
    }
    case "eq": {
      const s = scalar(targetValue(store, expr.target));
      return s !== undefined && s === expr.value;
    }
    case "ne": {
      const s = scalar(targetValue(store, expr.target));
      return s !== undefined && s !== expr.value;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const s = scalar(targetValue(store, expr.target));
      if (typeof s !== "number") return false;
      if (expr.op === "gt") return s > expr.value;
      if (expr.op === "gte") return s >= expr.value;
      if (expr.op === "lt") return s < expr.value;
      return s <= expr.value;
    }
  }
}
