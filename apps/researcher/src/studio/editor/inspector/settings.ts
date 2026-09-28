import type { ItemDefinition, LogicExpr } from "@myself/schema";
import {
  allItemKeys,
  allVariables,
  conditionTargets,
  generateItemKey,
  generateVariable,
  liveQuestions,
  MAX_VARIABLE_LENGTH,
  placements,
  SLUG_PATTERN,
  splitItemKey,
  type ReservedIds,
  type StudioDraft,
} from "@myself/studio";
import { questionName } from "../outline/model.js";

/**
 * The pure side of the settings panel: what a question's settings are, what
 * depends on it, and whether a new ID or reporting label would be accepted —
 * checked here first, the way ops.ts checks them, so typing an ID that is
 * already taken shows a message under the box instead of a refusal per keystroke.
 */

// ---------------------------------------------------------------------------
// Required
// ---------------------------------------------------------------------------

/**
 * How a question's "required" setting is shown. The participant app treats
 * "soft" and "optional" the same (it asks "Leave this one blank?" either way,
 * never blocks), so both read as "Not required" — and an "optional" question
 * is left as "optional" until someone deliberately makes it required, rather
 * than silently rewritten, which would show up as a change in the next version.
 */
export function requiredChoice(item: { required?: ItemDefinition["required"] | undefined }): { value: "hard" | "soft"; storedOptional: boolean } {
  const required = item.required ?? "soft";
  return { value: required === "hard" ? "hard" : "soft", storedOptional: required === "optional" };
}

// ---------------------------------------------------------------------------
// Numbers typed into settings
// ---------------------------------------------------------------------------

export type ParsedNumber = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * A number from a settings box. Empty is null ("no limit") when the setting may
 * be left out, and an error when it must have a value.
 */
export function parseNumber(
  text: string,
  opts: { integer?: boolean; min?: number; max?: number; optional?: boolean } = {},
): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed === "") return opts.optional ? { ok: true, value: null } : { ok: false, message: "Enter a number." };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, message: "Enter a number, for example 10." };
  if (opts.integer && !Number.isInteger(n)) return { ok: false, message: "Enter a whole number." };
  if (opts.min !== undefined && n < opts.min) return { ok: false, message: `Enter ${opts.min} or more.` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, message: `Enter ${opts.max} or less.` };
  return { ok: true, value: n };
}

// ---------------------------------------------------------------------------
// ID and reporting label
// ---------------------------------------------------------------------------

/** Keys another question of the same instrument has, now, archived or in any published version. */
function takenKeys(draft: StudioDraft, itemKey: string, reserved: ReservedIds | undefined): Set<string> {
  const { instrument } = splitItemKey(itemKey);
  const out = new Set<string>();
  for (const k of [...allItemKeys(draft), ...(reserved?.itemKeys ?? [])]) {
    const s = splitItemKey(k);
    if (s.instrument === instrument && k !== itemKey) out.add(s.key);
  }
  return out;
}

/** Why a new question ID would be refused, or null when it would be accepted. */
export function keyProblem(draft: StudioDraft, itemKey: string, next: string, reserved: ReservedIds | undefined): string | null {
  if (next === splitItemKey(itemKey).key) return null;
  if (next === "") return "A question needs an ID.";
  if (next.length > 64) return "An ID can be at most 64 characters.";
  if (!SLUG_PATTERN.test(next)) {
    return "Use only lowercase letters, numbers and underscores, starting with a letter — for example sleep_hours.";
  }
  if (takenKeys(draft, itemKey, reserved).has(next)) {
    return `“${next}” is already used by another question in this block, now or in a published version. Choose another.`;
  }
  return null;
}

function takenVariables(draft: StudioDraft, current: string, reserved: ReservedIds | undefined): Set<string> {
  const out = new Set([...allVariables(draft), ...(reserved?.variables ?? [])]);
  out.delete(current);
  return out;
}

/** Why a new reporting label would be refused, or null when it would be accepted. */
export function variableProblem(draft: StudioDraft, current: string, next: string, reserved: ReservedIds | undefined): string | null {
  if (next === current) return null;
  if (next === "") return "A question needs a reporting label: it is its column name in the data.";
  if (next.length > MAX_VARIABLE_LENGTH) return `A reporting label can be at most ${MAX_VARIABLE_LENGTH} characters (the limit of Stata and SPSS).`;
  if (!SLUG_PATTERN.test(next)) {
    return "Use only lowercase letters, numbers and underscores, starting with a letter — for example sleep_hours.";
  }
  if (takenVariables(draft, current, reserved).has(next)) {
    return `“${next}” is already a column, now or in a published version. Every column in the data needs its own name.`;
  }
  return null;
}

/** An ID made from the question's wording, unique in its block. */
export function suggestedKey(draft: StudioDraft, itemKey: string, text: string, reserved: ReservedIds | undefined): string {
  return generateItemKey(text, takenKeys(draft, itemKey, reserved));
}

/** A reporting label made from the question's ID, unique in the survey. */
export function suggestedVariable(draft: StudioDraft, key: string, current: string, reserved: ReservedIds | undefined): string {
  return generateVariable(key, takenVariables(draft, current, reserved));
}

// ---------------------------------------------------------------------------
// What depends on a question
// ---------------------------------------------------------------------------

export interface Dependents {
  /** Questions shown only depending on this one's answer. */
  questions: { itemKey: string; text: string }[];
  sections: { sectionKey: string; title: string }[];
  blocks: { sectionKey: string; componentIndex: number; name: string }[];
  /** Questions or screens whose text inserts this one's answer. */
  pipes: { itemKey: string | null; text: string }[];
  /** Answer checks and option limits that read this answer. */
  checks: { itemKey: string; text: string }[];
}

function mentions(expr: LogicExpr | undefined, itemKey: string): boolean {
  return !!expr && conditionTargets(expr).includes(itemKey);
}

function pipesMention(display: unknown, itemKey: string): boolean {
  const pipes = (display as { pipes?: Record<string, { item?: { instrument: string; item: string } }> } | undefined)?.pipes;
  if (!pipes) return false;
  return Object.values(pipes).some((p) => p.item && `${p.item.instrument}.${p.item.item}` === itemKey);
}

/** Everything in the survey that reads a question's answer. */
export function dependentsOf(draft: StudioDraft, itemKey: string): Dependents {
  const out: Dependents = { questions: [], sections: [], blocks: [], pipes: [], checks: [] };
  const seen = new Set<string>();
  for (const q of liveQuestions(draft)) {
    if (seen.has(q.itemKey)) continue;
    seen.add(q.itemKey);
    const item = q.item;
    const text = questionName(item.stem.text, 60);
    if (mentions(item.displayIf, itemKey)) out.questions.push({ itemKey: q.itemKey, text });
    const texts: unknown[] = [item.stem, item.lede, item.moreInfo?.body];
    if (item.responseType === "checkbox_set") texts.push(...item.statements.map((s) => s.text));
    if (texts.some((t) => pipesMention(t, itemKey))) out.pipes.push({ itemKey: q.itemKey, text });
    const checks =
      (item.crossChecks ?? []).some((c) => `${c.against.instrument}.${c.against.item}` === itemKey) ||
      (item.responseType === "single_choice" && item.limitOptions
        ? `${item.limitOptions.from.instrument}.${item.limitOptions.from.item}` === itemKey
        : false);
    if (checks) out.checks.push({ itemKey: q.itemKey, text });
  }
  draft.composition.sections.forEach((section) => {
    if (mentions(section.displayIf, itemKey)) out.sections.push({ sectionKey: section.key, title: section.title });
  });
  for (const p of placements(draft)) {
    const component = draft.composition.sections[p.sectionIndex]?.components[p.componentIndex];
    if (component && mentions(component.displayIf, itemKey)) {
      out.blocks.push({ sectionKey: p.sectionKey, componentIndex: p.componentIndex, name: p.def?.name ?? p.instrument });
    }
  }
  for (const [key, screen] of Object.entries(draft.composition.screens)) {
    if (pipesMention(screen.title, itemKey) || pipesMention(screen.body, itemKey)) {
      out.pipes.push({ itemKey: null, text: key === "finish" ? "The finish screen" : key === "review" ? "The review screen" : `The screen “${key}”` });
    }
  }
  return out;
}

/** "Used in the conditions of 3 questions and 1 section", or null when nothing depends on it. */
export function conditionSummary(d: Pick<Dependents, "questions" | "sections" | "blocks">): string | null {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts = [
    d.questions.length ? count(d.questions.length, "question") : null,
    d.sections.length ? count(d.sections.length, "section") : null,
    d.blocks.length ? count(d.blocks.length, "block") : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Used in the conditions of ${list}`;
}

// ---------------------------------------------------------------------------
// Asking the model first
// ---------------------------------------------------------------------------

/**
 * What the model would say to an operation, without applying it: null if it
 * would be carried out, else its refusal in the researcher's words. Used for
 * the few buttons (moving a section or block) whose refusals depend on the
 * whole survey's order — consent first, protected blocks whole — so the button
 * can be disabled with the reason rather than offered and then refused.
 */
export function refusal(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
