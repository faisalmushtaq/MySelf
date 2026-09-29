import type { ScoringDefinition } from "@myself/schema";

/**
 * What a scoring definition refers to that is not there.
 *
 * Every step reads either an item of its instrument or an output of an earlier
 * step. A name that is neither is never an error at run time — the executor
 * reads it as "not answered" — so the score is simply always blank. That is how
 * SWEMWBS and STAI-5 scored nothing in r1.0.0–r7.1.0 (D-49), and why the publish
 * gate runs this over every definition a release freezes.
 *
 * `items` are the item keys of the form the release administers; `info` marks
 * the ones that are screens rather than questions.
 */
export function scoringReferenceProblems(
  def: Pick<ScoringDefinition, "instrument" | "steps">,
  items: readonly { key: string; responseType?: string }[],
): string[] {
  const problems: string[] = [];
  const byKey = new Map(items.map((i) => [i.key, i]));
  const outputs = new Set<string>();
  const check = (name: string, step: number) => {
    if (outputs.has(name)) return;
    const item = byKey.get(name);
    if (!item) problems.push(`step ${step + 1} reads '${name}', which is neither a question of '${def.instrument}' nor an earlier output`);
    else if (item.responseType === "info") problems.push(`step ${step + 1} reads '${name}', which is an information screen, not a question`);
  };
  def.steps.forEach((step, i) => {
    if ("items" in step) for (const name of step.items) check(name, i);
    if ("input" in step) check(step.input, i);
    if ("output" in step && step.op !== "recode") outputs.add(step.output);
  });
  return problems;
}
